import {baselineIds,conditionSpecs,endpointNames,factorialCells,factorNames,fail,manifestHash,validateManifest} from './manifest.js';
import {verifyLedgerText} from './generator.js';

export {v1Conditions,v2Conditions,requiredConditions,conditionSpecs,factorialCells,baselineIds} from './manifest.js';

const idPattern=/^[A-Za-z0-9_-]{1,64}$/;
const objectIdPattern=/^[A-Za-z0-9_:-]{1,128}$/;
const shaPattern=/^[a-f0-9]{64}$/;
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(o,keys)=>isObject(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const num=(v,min=0)=>Number.isFinite(v)&&v>=min;
const outcomeKinds=['event','no_event','tracking_lost','session_end_censored'];
const fixedContrasts=[
 ['gaze_crop','scene_only'],['sam_object_context','gaze_crop'],['depth_context','sam_object_context'],['history_context','sam_object_context'],['proactive_context','sam_object_context'],['depth_history_proactive','sam_object_context'],
 ['gaze_shuffled','gaze_crop'],['gaze_time_shifted','gaze_crop'],
 ['spatial_memory_context','history_only_matched'],['sam_mask_foreground','sam_bbox_crop'],
 ['depth_history','sam_object_context'],['depth_proactive','sam_object_context'],['history_proactive','sam_object_context'],
 ['oracle_mask','sam_mask_foreground'],['oracle_gaze','sam_object_context'],['oracle_depth','depth_context'],
 ['sam_object_context','baseline_current_hold'],['sam_object_context','baseline_markov']
];
const metricDefs={
 success:{scope:'event',fn:e=>e.success?1:0},
 deadlineAccuracy:{scope:'event',fn:e=>e.deadlineCorrect?1:0},
 endToEndAccuracy:{scope:'event',fn:e=>e.top1?1:0},
 coverage:{scope:'included',fn:e=>e.usable?1:0}
};

// ---------- small numerics ----------
const ratio=(n,d)=>d?n/d:null;
const mean=v=>v.length?v.reduce((a,b)=>a+b,0)/v.length:null;
function quantile(values,q){
 if(!values.length)return null;const s=[...values].sort((a,b)=>a-b),pos=(s.length-1)*q,lo=Math.floor(pos),hi=Math.ceil(pos);
 return s[lo]+(s[hi]-s[lo])*(pos-lo);
}
function hashSeed(seed,textValue){let v=(seed^0x9e3779b9)>>>0;for(const ch of textValue){v^=ch.charCodeAt(0);v=Math.imul(v,0x85ebca6b);v^=v>>>13;}return v||0x6d2b79f5;}
function random32(seed){let s=seed>>>0;return ()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return (s>>>0)/4294967296;};}
// Resamples sessions (the independent unit); frames/decisions inside a session stay clustered.
function bootstrap(values,iterations,seed,label,alpha){
 if(values.length<2)return {ci:null,p:null};
 const rnd=random32(hashSeed(seed,label)),samples=new Array(iterations);
 for(let b=0;b<iterations;b++){let t=0;for(let i=0;i<values.length;i++)t+=values[Math.floor(rnd()*values.length)];samples[b]=t/values.length;}
 const le=samples.filter(x=>x<=0).length,ge=samples.filter(x=>x>=0).length;
 return {ci:[quantile(samples,alpha/2),quantile(samples,1-alpha/2)],p:Math.min(1,2*(Math.min(le,ge)+1)/(iterations+1))};
}

// ---------- annotations (separate from the ledger; bound after it closes) ----------
function validateAnnotations(a,m){
 const bad=detail=>{throw fail('ANNOTATIONS_INVALID',detail);};
 if(!exact(a,['schemaVersion','kind','studyId','ledgerTailSha256','boundAtMs','sessions'])||a.schemaVersion!==1||a.kind!=='prometheus_annotations_v2'||a.studyId!==m.studyId||!shaPattern.test(a.ledgerTailSha256)||!num(a.boundAtMs)||!Array.isArray(a.sessions)||!a.sessions.length)bad('top-level fields');
 const minFix=m.endpoints.next_look_onset?.minFixationMs??0,sessionKeys=new Set(),decisionIds=new Set(),sessions=[];
 for(const s of a.sessions){
  if(!exact(s,['participantId','sessionId','sessionEndMs','fixations','interactions','decisions'])||![s.participantId,s.sessionId].every(v=>idPattern.test(v)||false)||!num(s.sessionEndMs,1)||!Array.isArray(s.fixations)||!Array.isArray(s.interactions)||!Array.isArray(s.decisions)||!s.decisions.length)bad('session fields');
  const key=`${s.participantId}\u0000${s.sessionId}`;if(sessionKeys.has(key))bad('duplicate session');sessionKeys.add(key);
  let last=-1;
  for(const f of s.fixations){if(!exact(f,['objectId','onsetMs','endMs'])||!objectIdPattern.test(f.objectId)||!num(f.onsetMs)||f.onsetMs<last||!(f.endMs===null||(num(f.endMs)&&f.endMs-f.onsetMs>=minFix)))bad('fixation');last=f.onsetMs;}
  last=-1;
  for(const i of s.interactions){if(!exact(i,['objectId','atMs'])||!objectIdPattern.test(i.objectId)||!num(i.atMs)||i.atMs<last)bad('interaction');last=i.atMs;}
  const decisions=[];
  for(const d of s.decisions){
   if(!exact(d,['decisionId','observedUntilMs','gazeValidFraction','outcomes'])||!idPattern.test(d.decisionId)||decisionIds.has(d.decisionId)||!num(d.observedUntilMs)||d.observedUntilMs>s.sessionEndMs||!(d.gazeValidFraction===null||(num(d.gazeValidFraction)&&d.gazeValidFraction<=1)))bad(`decision ${d?.decisionId}`);
   decisionIds.add(d.decisionId);
   const wanted=endpointNames.filter(e=>m.endpoints[e]);
   if(!exact(d.outcomes,wanted))bad(`outcomes endpoints ${d.decisionId}`);
   const outcomes={};
   for(const endpoint of wanted){
    if(!exact(d.outcomes[endpoint],m.horizons.map(String)))bad(`outcomes horizons ${d.decisionId}`);
    const events=(endpoint==='next_look_onset'?s.fixations.map(f=>({id:f.objectId,t:f.onsetMs})):s.interactions.map(i=>({id:i.objectId,t:i.atMs})));
    outcomes[endpoint]={};
    for(const h of m.horizons){
     const o=d.outcomes[endpoint][String(h)],inWindow=events.filter(e=>e.t>d.observedUntilMs&&e.t<=d.observedUntilMs+h);
     let cls;
     if(isObject(o)&&o.outcome==='event'){
      if(!exact(o,['outcome','targetId','eventAtMs'])||!objectIdPattern.test(o.targetId)||!num(o.eventAtMs)||o.eventAtMs<=d.observedUntilMs||o.eventAtMs>d.observedUntilMs+h||o.eventAtMs>s.sessionEndMs)bad(`event outcome ${d.decisionId}`);
      const first=inWindow[0];
      if(!first||first.t!==o.eventAtMs||first.id!==o.targetId)throw fail('ANNOTATION_INCONSISTENT',`${d.decisionId} ${endpoint} ${h}: event is not the first ${endpoint==='next_look_onset'?'fixation onset':'interaction'} in the window`);
      cls={cls:'event',targetId:o.targetId,eventAtMs:o.eventAtMs,reclassified:false};
     } else if(exact(o,['outcome'])&&outcomeKinds.includes(o.outcome)&&o.outcome!=='event'){
      if(o.outcome==='no_event'&&inWindow.length)throw fail('ANNOTATION_INCONSISTENT',`${d.decisionId} ${endpoint} ${h}: no_event but an event exists in the window`);
      // Pre-declared censoring: a no_event window that extends past the session end cannot be judged.
      const censor=o.outcome==='no_event'&&d.observedUntilMs+h>s.sessionEndMs;
      cls={cls:censor?'session_end_censored':o.outcome,targetId:null,eventAtMs:null,reclassified:censor};
     } else bad(`outcome ${d.decisionId}`);
     outcomes[endpoint][h]=cls;
    }
   }
   decisions.push({decisionId:d.decisionId,observedUntilMs:d.observedUntilMs,gazeValidFraction:d.gazeValidFraction,outcomes});
  }
  decisions.sort((x,y)=>x.observedUntilMs-y.observedUntilMs||(x.decisionId<y.decisionId?-1:1));
  sessions.push({participantId:s.participantId,sessionId:s.sessionId,sessionEndMs:s.sessionEndMs,fixations:s.fixations,interactions:s.interactions,decisions});
 }
 return sessions;
}

// ---------- causal baselines computed by the scorer itself ----------
export function baselinePrediction(kind,endpoint,session,cutoff){
 const fixations=session.fixations.filter(f=>f.onsetMs<=cutoff),current=fixations.length?fixations[fixations.length-1].objectId:null;
 if(kind==='baseline_current_hold')return current===null?[]:[current];
 const seq=endpoint==='next_look_onset'?fixations.map(f=>f.objectId):session.interactions.filter(i=>i.atMs<=cutoff).map(i=>i.objectId);
 if(!seq.length)return [];
 const last=seq[seq.length-1],counts=new Map();
 for(let i=1;i<seq.length;i++){
  if(seq[i-1]!==last||(endpoint==='next_look_onset'&&seq[i]===last))continue;
  counts.set(seq[i],(counts.get(seq[i])??0)+1);
 }
 return [...counts].sort((a,b)=>b[1]-a[1]||(a[0]<b[0]?-1:1)).slice(0,3).map(x=>x[0]);
}
const currentObject=(session,cutoff)=>{const f=session.fixations.filter(x=>x.onsetMs<=cutoff);return f.length?f[f.length-1].objectId:null;};

function evalCell(rec,outcome,item,m){
 const answered=rec.status==='ok'&&rec.result!==null&&!rec.result.abstained,rank=answered?rec.result.rankedTargetIds:[];
 const isEvent=outcome.cls==='event',avail=rec.availableAtMs;
 const inDeadline=avail!==null&&avail<=item.observedUntilMs+m.deadlineMs;
 const fresh=avail!==null&&avail-rec.newestInputObservedAtMs<=m.maxResultAgeMs;
 const top1=isEvent&&answered&&rank[0]===outcome.targetId,top3=isEvent&&answered&&rank.slice(0,3).includes(outcome.targetId);
 const before=isEvent&&avail!==null&&avail<outcome.eventAtMs;
 const usable=answered&&inDeadline&&fresh,success=top1&&before&&inDeadline&&fresh;
 return {status:rec.status,answered,top1,top3,usable,success,deadlineCorrect:top1&&inDeadline&&fresh,late:top1&&!success,stale:answered&&avail!==null&&!fresh,lead:success?outcome.eventAtMs-avail:null,target:answered?rank[0]:null,probabilities:rec.result?.probabilities??null,candidateIds:rec.candidateIds};
}

// ---------- per-arm report ----------
function decompose(indices,ctx,evs){
 const eligible=indices.length,present=indices.filter(i=>ctx.all[i].candidateIds.includes(ctx.outcomes[i].targetId)),correctPresent=present.filter(i=>evs[i].top1),endToEnd=indices.filter(i=>evs[i].top1);
 return {eligible,candidatePresent:present.length,candidateRecall:ratio(present.length,eligible),reasoningCorrectGivenCandidate:correctPresent.length,reasoningAccuracyGivenCandidate:ratio(correctPresent.length,present.length),endToEndCorrect:endToEnd.length,endToEndAccuracy:ratio(endToEnd.length,eligible)};
}

function calibration(evs,ctx,m){
 const rows=[];
 for(let i=0;i<ctx.all.length;i++){
  if(ctx.outcomes[i].cls!=='event'||evs[i].probabilities===null||!evs[i].answered)continue;
  rows.push({i,conf:Math.max(...evs[i].probabilities),correct:evs[i].top1});
 }
 const brierRows=rows.filter(r=>ctx.all[r.i].candidateIds.includes(ctx.outcomes[r.i].targetId));
 const brier=brierRows.length?{count:brierRows.length,mean:mean(brierRows.map(r=>evs[r.i].probabilities.reduce((s,p,k)=>s+(p-(ctx.all[r.i].candidateIds[k]===ctx.outcomes[r.i].targetId?1:0))**2,0)))}:null;
 const bins=Array.from({length:m.calibration.bins},(_,k)=>({lo:k/m.calibration.bins,hi:(k+1)/m.calibration.bins,count:0,confidenceSum:0,correct:0}));
 for(const r of rows){const b=bins[Math.min(bins.length-1,Math.floor(r.conf*bins.length))];b.count++;b.confidenceSum+=r.conf;b.correct+=r.correct?1:0;}
 const enough=rows.length>=m.calibration.minSamples;
 const ece=enough?bins.reduce((s,b)=>s+(b.count?b.count/rows.length*Math.abs(b.correct/b.count-b.confidenceSum/b.count):0),0):null;
 return {completeProbabilityDecisions:rows.length,brier,ece:{value:ece,status:rows.length===0?'no_probability_outputs':enough?'reported':'insufficient_samples',minSamples:m.calibration.minSamples,bins:bins.map(b=>({lo:b.lo,hi:b.hi,count:b.count,meanConfidence:ratio(b.confidenceSum,b.count),accuracy:ratio(b.correct,b.count)}))}};
}

function coverageRisk(evs,ctx){
 const eligible=ctx.eventIdx.length,rows=ctx.eventIdx.filter(i=>evs[i].answered&&evs[i].probabilities!==null).map(i=>({conf:Math.max(...evs[i].probabilities),correct:evs[i].top1})).sort((a,b)=>b.conf-a.conf);
 if(!rows.length)return {status:'no_confidence_scores',eligible,points:[]};
 const points=[];let kept=0,wrong=0;
 for(let k=0;k<rows.length;k++){
  kept++;if(!rows[k].correct)wrong++;
  if(k===rows.length-1||rows[k+1].conf<rows[k].conf)points.push({threshold:rows[k].conf,coverage:kept/eligible,risk:wrong/kept,kept});
 }
 const step=Math.ceil(points.length/200);
 return {status:'reported',eligible,scoredDecisions:rows.length,unscoredAnswered:ctx.eventIdx.filter(i=>evs[i].answered&&evs[i].probabilities===null).length,points:points.filter((_,k)=>k%step===0||k===points.length-1)};
}

function preparation(evs,ctx){
 let preparations=0,prepareHits=0,usefulHits=0,wrong=0,duplicates=0,unevaluable=0;
 for(const order of ctx.sessionOrders){
  let previous=null;
  for(const i of order){
   const e=evs[i];if(!e.answered){continue;}
   preparations++;
   const duplicate=previous!==null&&previous===e.target;previous=e.target;if(duplicate)duplicates++;
   const cls=ctx.outcomes[i].cls;
   if(cls!=='event'&&cls!=='no_event'){unevaluable++;continue;}
   const hit=cls==='event'&&e.top1&&e.status==='ok'&&ctx.avail[i]!==null&&ctx.avail[i]<ctx.outcomes[i].eventAtMs;
   if(hit)prepareHits++;else wrong++;
   if(e.success&&!duplicate)usefulHits++;
  }
 }
 const minutes=ctx.sessionMinutes,eligible=ctx.eventIdx.length;
 return {preparations,prepareHits,usefulHits,wrongPreparations:wrong,duplicateUpdates:duplicates,unevaluablePreparations:unevaluable,sessionMinutes:minutes,prepareHitRate:ratio(prepareHits,eligible),usefulHitRate:ratio(usefulHits,eligible),wrongPreparationsPerMinute:ratio(wrong,minutes),duplicateUpdatesPerMinute:ratio(duplicates,minutes)};
}

function armReport(armId,evs,ctx,m){
 const isBaseline=baselineIds.includes(armId),{eventIdx,noEventIdx,includedIdx}=ctx;
 const events=eventIdx.map(i=>evs[i]),success=events.filter(e=>e.success),top1=events.filter(e=>e.top1),leads=success.map(e=>e.lead);
 const status=Object.fromEntries(['ok','timeout','parse_failed','provider_failed','budget_exhausted'].map(s=>[s,evs.filter(e=>e.status===s).length]));
 const usableIncluded=includedIdx.filter(i=>evs[i].usable);
 const newIdx=eventIdx.filter(i=>ctx.outcomes[i].targetId!==ctx.current[i]);
 const gate=m.exclusionRules.gazeQualityMinValidFraction,g=i=>ctx.all[i].gazeValidFraction;
 return {
  diagnostic:isBaseline?false:conditionSpecs[armId].diagnostic,baseline:isBaseline,
  decisions:evs.length,eligible:eventIdx.length,included:includedIdx.length,statusCounts:status,
  anticipation:{successes:success.length,successRate:ratio(success.length,eventIdx.length),denominator:'all_eligible_event_decisions',lateCorrect:events.filter(e=>e.late).length,staleResults:events.filter(e=>e.stale).length},
  accuracy:{top1:top1.length,top1Rate:ratio(top1.length,eventIdx.length),top3Rate:ratio(events.filter(e=>e.top3).length,eventIdx.length),deadlineAccuracy:ratio(events.filter(e=>e.deadlineCorrect).length,eventIdx.length)},
  coverage:{usableAnswers:usableIncluded.length,coverage:ratio(usableIncluded.length,includedIdx.length),coverageAmongEligible:ratio(eventIdx.filter(i=>evs[i].usable).length,eventIdx.length),falseAlarmRate:ratio(noEventIdx.filter(i=>evs[i].usable).length,noEventIdx.length)},
  leadTimeMs:{basis:'correct_anticipation_only',count:leads.length,mean:mean(leads),p50:quantile(leads,.5),p95:quantile(leads,.95)},
  newObjectTransition:{eligible:newIdx.length,successes:newIdx.filter(i=>evs[i].success).length,successRate:ratio(newIdx.filter(i=>evs[i].success).length,newIdx.length),top1Rate:ratio(newIdx.filter(i=>evs[i].top1).length,newIdx.length)},
  errorDecomposition:isBaseline?null:{
   all:decompose(eventIdx,ctx,evs),
   gazeQualityGated:{minValidFraction:gate,gated:decompose(eventIdx.filter(i=>g(i)!==null&&g(i)>=gate),ctx,evs),belowGate:decompose(eventIdx.filter(i=>g(i)!==null&&g(i)<gate),ctx,evs),unknownQuality:decompose(eventIdx.filter(i=>g(i)===null),ctx,evs)}
  },
  calibration:isBaseline?null:calibration(evs,ctx,m),
  coverageRisk:isBaseline?null:coverageRisk(evs,ctx),
  preparation:preparation(evs,ctx)
 };
}

// ---------- paired session-level statistics ----------
function sessionValues(evs,metric,ctx){
 const def=metricDefs[metric],acc=new Map();
 for(let i=0;i<ctx.all.length;i++){
  const cls=ctx.outcomes[i].cls;
  if(def.scope==='event'?cls!=='event':!(cls==='event'||cls==='no_event'))continue;
  const s=ctx.all[i].sessionIdx,a=acc.get(s)??[0,0];a[0]+=def.fn(evs[i]);a[1]++;acc.set(s,a);
 }
 return new Map([...acc].map(([s,[a,b]])=>[s,a/b]));
}
function pairedDelta(evsC,evsR,metric,ctx){
 const c=sessionValues(evsC,metric,ctx),r=sessionValues(evsR,metric,ctx),keys=[...c.keys()].filter(s=>r.has(s)).sort((a,b)=>a-b);
 return {deltas:keys.map(s=>c.get(s)-r.get(s)),candidateMean:mean(keys.map(s=>c.get(s))),referenceMean:mean(keys.map(s=>r.get(s)))};
}

function holmAdjust(entries){
 const order=entries.map((e,i)=>({i,p:e.p})).sort((a,b)=>a.p-b.p),k=order.length,adjusted=new Array(k);let running=0;
 order.forEach((o,rank)=>{running=Math.max(running,Math.min(1,(k-rank)*o.p));adjusted[o.i]=running;});
 return adjusted;
}

function factorial(m,primaryCtx,armEvs){
 const cells=Object.keys(factorialCells),missing=cells.filter(c=>!m.conditions.includes(c));
 if(missing.length)return {status:'refused',reason:'factorial_incomplete',missingCells:missing,interactionClaimAllowed:false,note:'depth x history x proactive interaction requires all eight cells in the manifest and ledger'};
 const perCell=Object.fromEntries(cells.map(c=>[c,sessionValues(armEvs[c],'success',primaryCtx)]));
 const sessions=[...perCell[cells[0]].keys()].filter(s=>cells.every(c=>perCell[c].has(s))).sort((a,b)=>a-b);
 const subsets=[[0],[1],[2],[0,1],[0,2],[1,2],[0,1,2]],effects=[];
 for(const subset of subsets){
  const values=sessions.map(s=>cells.reduce((sum,c)=>sum+subset.reduce((sign,f)=>sign*(factorialCells[c][f]?1:-1),1)*perCell[c].get(s),0)/4);
  const name=subset.map(f=>factorNames[f]).join('x'),{ci}=bootstrap(values,m.samplePlan.bootstrapIterations,m.samplePlan.seed,`factorial:${name}`,m.multiplicityPolicy.alpha);
  effects.push({name,order:subset.length,estimate:mean(values),ci,ciLevel:1-m.multiplicityPolicy.alpha,ciExcludesZero:ci!==null&&(ci[0]>0||ci[1]<0),exploratory:true});
 }
 return {status:'computed',sessions:sessions.length,interactionClaimAllowed:true,metric:'anticipation_success',effects,note:'effects use +/-1 coding over session means; exploratory and not Holm-covered unless the manifest says otherwise'};
}

// ---------- entry point ----------
export function evaluateComparisonV2({manifest,ledgerText,annotations}={},{sourceSha256s=null}={}){
 const m=validateManifest(manifest),mHash=manifestHash(m);
 const ledger=verifyLedgerText(ledgerText),header=ledger.header;
 if(header.manifestSha256!==mHash)throw fail('MANIFEST_HASH_MISMATCH',`manifest ${mHash} differs from the hash frozen in the ledger ${header.manifestSha256}`);
 if(header.studyId!==m.studyId||header.thresholdVersion!==m.thresholdVersion)throw fail('MANIFEST_HASH_MISMATCH','study or threshold version differs from ledger header');
 const sessions=validateAnnotations(annotations,m);
 if(annotations.ledgerTailSha256!==ledger.tailHash)throw fail('ANNOTATION_LEDGER_MISMATCH','annotations were not bound to this closed ledger');
 if(annotations.boundAtMs<ledger.footer.closedAtMs)throw fail('ANNOTATION_BEFORE_LEDGER_CLOSE','labels bound before the ledger closed');
 const endpoints=endpointNames.filter(e=>m.endpoints[e]);
 const sessionCount=sessions.length;
 if(sessionCount>m.samplePlan.maxSessions)throw fail('STOPPING_RULE_VIOLATION',`${sessionCount} sessions exceed the frozen fixed-sample maximum ${m.samplePlan.maxSessions}`);

 // join ledger records to annotated decisions; every registered cell must exist (failures are denominators)
 const byKey=new Map(),ledgerDecisions=new Set();
 for(const r of ledger.records){
  if(!m.conditions.includes(r.condition)||!m.horizons.includes(r.horizonMs)||!endpoints.includes(r.endpoint))throw fail('LEDGER_INVALID',`record outside manifest: ${r.decisionId} ${r.condition}`);
  const key=`${r.decisionId}|${r.endpoint}|${r.horizonMs}|${r.condition}`;if(byKey.has(key))throw fail('LEDGER_INVALID',`duplicate record ${key}`);
  byKey.set(key,r);ledgerDecisions.add(r.decisionId);
 }
 const all=[];
 sessions.forEach((session,sessionIdx)=>{
  for(const d of session.decisions){
   const item={sessionIdx,session,decisionId:d.decisionId,observedUntilMs:d.observedUntilMs,gazeValidFraction:d.gazeValidFraction,outcomes:d.outcomes,records:{},candidateIds:null,current:currentObject(session,d.observedUntilMs)};
   for(const endpoint of endpoints){item.records[endpoint]={};for(const h of m.horizons){item.records[endpoint][h]={};for(const c of m.conditions){
    const r=byKey.get(`${d.decisionId}|${endpoint}|${h}|${c}`);
    if(!r)throw fail('LEDGER_INCOMPLETE',`missing ${d.decisionId} ${endpoint} ${h} ${c}`);
    if(r.participantId!==session.participantId||r.sessionId!==session.sessionId||r.observedUntilMs!==d.observedUntilMs)throw fail('LEDGER_INVALID',`record/annotation mismatch for ${d.decisionId}`);
    const ids=r.candidateIds.join('\u0000');if(item.candidateIds===null)item.candidateIds=r.candidateIds,item.candidateKey=ids;else if(item.candidateKey!==ids)throw fail('LEDGER_INVALID',`candidate sets differ across conditions for ${d.decisionId}`);
    item.records[endpoint][h][c]=r;
   }}}
   all.push(item);
  }
 });
 const annotated=new Set(all.map(x=>x.decisionId));
 if(annotated.size!==ledgerDecisions.size||[...annotated].some(id=>!ledgerDecisions.has(id)))throw fail('DECISION_SET_MISMATCH','annotated decisions differ from ledger decisions');
 if(ledger.records.length!==all.length*endpoints.length*m.horizons.length*m.conditions.length)throw fail('LEDGER_INCOMPLETE','record count');

 const arms=[...m.conditions,...baselineIds],sessionMinutes=sessions.reduce((s,x)=>s+x.sessionEndMs/60000,0);
 const contrastPairs=new Map();
 for(const [c,r] of [...fixedContrasts,...m.multiplicityPolicy.confirmatory.map(x=>[x.candidate,x.reference])])if(arms.includes(c)&&arms.includes(r))contrastPairs.set(`${c}>${r}`,[c,r]);
 const confirmKeys=new Set(m.multiplicityPolicy.confirmatory.map(x=>`${x.candidate}>${x.reference}`));
 const k=m.multiplicityPolicy.method==='holm'?m.multiplicityPolicy.confirmatory.length:1,alpha=m.multiplicityPolicy.alpha;
 const pe=m.primaryEndpoint,reportEndpoints={},contrasts=[];let verdict=null,interaction=null,primaryCtxForFactorial=null,primaryArmEvs=null;

 for(const endpoint of endpoints)reportEndpoints[endpoint]={};
 for(const endpoint of endpoints)for(const h of m.horizons){
  const outcomes=all.map(x=>x.outcomes[endpoint][h]);
  const ctx={all,outcomes,sessionMinutes,
   eventIdx:[],noEventIdx:[],includedIdx:[],current:all.map(x=>x.current),
   sessionOrders:sessions.map((_,s)=>all.map((x,i)=>x.sessionIdx===s?i:-1).filter(i=>i>=0)),avail:null};
  outcomes.forEach((o,i)=>{if(o.cls==='event')ctx.eventIdx.push(i);if(o.cls==='no_event')ctx.noEventIdx.push(i);if(o.cls==='event'||o.cls==='no_event')ctx.includedIdx.push(i);});
  const armEvs={};
  for(const arm of arms){
   if(baselineIds.includes(arm)){
    armEvs[arm]=all.map((x,i)=>{
     const rank=baselinePrediction(arm,endpoint,x.session,x.observedUntilMs);
     return evalCell({status:'ok',result:{abstained:!rank.length,rankedTargetIds:rank,probabilities:null},availableAtMs:x.observedUntilMs,newestInputObservedAtMs:x.observedUntilMs,candidateIds:null},outcomes[i],x,m);
    });
   } else armEvs[arm]=all.map((x,i)=>evalCell(x.records[endpoint][h][arm],outcomes[i],x,m));
  }
  // availability per decision is arm-specific; preparation() reads it through the arm's own records
  const armReports={};
  for(const arm of arms){
   ctx.avail=all.map((x,i)=>baselineIds.includes(arm)?x.observedUntilMs:x.records[endpoint][h][arm].availableAtMs);
   armReports[arm]=armReport(arm,armEvs[arm],ctx,m);
  }
  const counts=Object.fromEntries(outcomeKinds.map(o=>[o,outcomes.filter(x=>x.cls===o).length]));
  const sessionsWithEvents=new Set(ctx.eventIdx.map(i=>all[i].sessionIdx)).size;
  reportEndpoints[endpoint][h]={outcomes:counts,eligibleDecisions:counts.event,excluded:{trackingLost:counts.tracking_lost,sessionEndCensored:counts.session_end_censored,reclassifiedNoEventToCensored:outcomes.filter(o=>o.reclassified).length},sessionsWithEligibleDecisions:sessionsWithEvents,arms:armReports};
  const isPrimary=endpoint===pe.endpoint&&h===pe.horizonMs;
  const level=[];
  for(const [key,[cand,ref]] of contrastPairs){
   const confirmatory=isPrimary&&confirmKeys.has(key),a=confirmatory?alpha/k:alpha;
   const {deltas,candidateMean,referenceMean}=pairedDelta(armEvs[cand],armEvs[ref],'success',ctx);
   const {ci,p}=bootstrap(deltas,m.samplePlan.bootstrapIterations,m.samplePlan.seed,`${key}:${endpoint}:${h}:success`,a);
   const diagnostic=[cand,ref].some(x=>!baselineIds.includes(x)&&conditionSpecs[x].diagnostic);
   const row={candidate:cand,reference:ref,endpoint,horizonMs:h,metric:'anticipation_success',confirmatory,exploratory:!confirmatory,diagnostic,excludedFromPrimaryClaims:diagnostic,pairedSessions:deltas.length,eligibleDecisions:counts.event,candidateSessionMean:candidateMean,referenceSessionMean:referenceMean,meanDelta:mean(deltas),ci,ciLevel:1-a,ciMethod:ci?'paired session-cluster percentile bootstrap':null,pValue:p,adjustedPValue:null,multiplicity:confirmatory?m.multiplicityPolicy.method:'exploratory_unadjusted'};
   if(confirmatory)level.push(row);
   if(isPrimary&&cand===m.primaryContrast.candidate&&ref===m.primaryContrast.reference){
    row.noninferiority={};
    for(const [metric,margin] of Object.entries(m.noninferiorityMargins)){
     const d=pairedDelta(armEvs[cand],armEvs[ref],metric,ctx),b=bootstrap(d.deltas,m.samplePlan.bootstrapIterations,m.samplePlan.seed,`${key}:${endpoint}:${h}:${metric}`,a);
     row.noninferiority[metric]={margin,pairedSessions:d.deltas.length,meanDelta:mean(d.deltas),ci:b.ci,satisfied:b.ci!==null&&b.ci[0]>-margin};
    }
   }
   contrasts.push(row);
  }
  if(level.length&&m.multiplicityPolicy.method==='holm'){const adj=holmAdjust(level.map(r=>({p:r.pValue??1})));level.forEach((r,i)=>{r.adjustedPValue=r.pValue===null?null:adj[i];});}
  else for(const r of level)r.adjustedPValue=r.pValue;
  if(isPrimary){
   primaryCtxForFactorial=ctx;primaryArmEvs=armEvs;
   const row=contrasts.find(r=>r.confirmatory&&r.candidate===m.primaryContrast.candidate&&r.reference===m.primaryContrast.reference&&r.endpoint===endpoint&&r.horizonMs===h);
   const candidateReport=armReports[m.primaryContrast.candidate],pairedSessions=row.pairedSessions;
   const checks={
    minSessions:{required:m.samplePlan.minSessions,observed:sessionsWithEvents,ok:sessionsWithEvents>=m.samplePlan.minSessions},
    minEligibleDecisions:{required:m.samplePlan.minEligibleDecisions,observed:counts.event,ok:counts.event>=m.samplePlan.minEligibleDecisions},
    ciLowerAbovePracticalDelta:{practicalDelta:m.practicalDelta,ciLower:row.ci?row.ci[0]:null,ok:row.ci!==null&&row.ci[0]>m.practicalDelta},
    noninferiority:Object.fromEntries(Object.entries(row.noninferiority).map(([metric,v])=>[metric,{margin:v.margin,ciLower:v.ci?v.ci[0]:null,ok:v.satisfied}])),
    coverageFloor:{floor:m.coverageFloor,observed:candidateReport.coverage.coverage,ok:candidateReport.coverage.coverage!==null&&candidateReport.coverage.coverage>=m.coverageFloor}
   };
   const powered=checks.minSessions.ok&&checks.minEligibleDecisions.ok&&pairedSessions>=m.samplePlan.minSessions;
   const allOk=checks.ciLowerAbovePracticalDelta.ok&&checks.coverageFloor.ok&&Object.values(checks.noninferiority).every(v=>v.ok);
   const reasons=[];
   if(!powered)reasons.push('fewer sessions or eligible decisions than the frozen sample plan');
   else{if(!checks.ciLowerAbovePracticalDelta.ok)reasons.push('CI lower bound does not exceed practicalDelta');if(!checks.coverageFloor.ok)reasons.push('coverage floor not met');for(const [metric,v] of Object.entries(checks.noninferiority))if(!v.ok)reasons.push(`noninferiority not shown for ${metric}`);}
   verdict={status:!powered?'underpowered':allOk?'improvement_supported':'improvement_not_established',primary:{endpoint,horizonMs:h,candidate:m.primaryContrast.candidate,reference:m.primaryContrast.reference,metric:'anticipation_success',meanDelta:row.meanDelta,ci:row.ci,ciLevel:row.ciLevel},checks,reasons,scope:'synthetic or supplied data only; not a Gate verdict'};
  }
 }
 interaction=factorial(m,primaryCtxForFactorial,primaryArmEvs);
 return {
  schemaVersion:2,kind:'prometheus_comparison_v2_report',source:'offline_scoring_only',dataProvenance:header.provenance,
  studyId:m.studyId,thresholdVersion:m.thresholdVersion,manifestSha256:mHash,ledgerTailSha256:ledger.tailHash,sourceSha256s,
  sessionCount,decisionCount:all.length,ledgerRecordCount:ledger.records.length,
  conditions:m.conditions.map(id=>({id,diagnostic:conditionSpecs[id].diagnostic})),baselines:[...baselineIds],
  primaryEndpoint:m.primaryEndpoint,primaryContrast:m.primaryContrast,
  statistics:{unit:'session',method:'paired session-cluster percentile bootstrap',iterations:m.samplePlan.bootstrapIterations,seed:m.samplePlan.seed,multiplicity:m.multiplicityPolicy.method,alpha,confirmatoryCount:k,note:'frames/decisions are clustered within sessions and are not independent samples; non-confirmatory contrasts are exploratory and unadjusted'},
  endpoints:reportEndpoints,contrasts,verdict,interaction,
  gateStatus:{g5d:'not_evaluated',note:'scoring a ledger never promotes a Gate; synthetic fixtures are labelled synthetic'}
 };
}
