import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {evaluateComparisonV2,baselinePrediction} from '../src/evaluation/comparison-v2.js';
import {chainLine,GENESIS_HASH} from '../src/evaluation/generator.js';
import {conditionSpecs,factorialCells,manifestHash,sha256Hex,v2Conditions} from '../src/evaluation/manifest.js';
import {main as evaluateMain} from '../scripts/evaluate-comparison-v2.mjs';

// All data below is synthetic; nothing here is a study result.
const objs=['o1','o2','o3','o4'];
const baseManifest=()=>({
 schemaVersion:1,kind:'prometheus_study_manifest',studyId:'synth-study',thresholdVersion:'thr-1',
 conditions:[...v2Conditions],horizons:[1000,3000],
 endpoints:{next_look_onset:{definition:'first_fixation_onset_in_window',minFixationMs:100},next_interaction:{definition:'first_user_interaction_in_window'}},
 primaryEndpoint:{endpoint:'next_look_onset',horizonMs:3000,metric:'anticipation_success'},primaryContrast:{candidate:'depth_context',reference:'sam_object_context'},
 practicalDelta:.05,noninferiorityMargins:{coverage:.1,deadlineAccuracy:.1},coverageFloor:.5,deadlineMs:800,maxResultAgeMs:1500,
 samplePlan:{minSessions:6,minEligibleDecisions:20,maxSessions:12,bootstrapIterations:400,seed:7},stoppingRule:{kind:'fixed_sample'},
 exclusionRules:{sessionEndRule:'censor_when_window_exceeds_session_end',trackingLostRule:'exclude_and_report',gazeQualityMinValidFraction:.8},
 multiplicityPolicy:{method:'holm',alpha:.05,confirmatory:[{candidate:'depth_context',reference:'sam_object_context'}]},
 annotationPolicy:{independentAnnotators:2,lookSource:'known_target_task',interactionSource:'user_input',labelsBoundAfterLedgerClose:true},
 calibration:{bins:10,minSamples:20},controls:{gazeShuffleSeed:'ctl-1',minGazeTimeShiftMs:200}
});
const tier={scene_only:0,gaze_crop:.4,sam_object_context:.6,gaze_shuffled:.2,gaze_time_shifted:.2};
function defaultPolicy(cond,{s,j,outcome,candidateIds}){
 const correct=outcome.cls==='event'&&candidateIds.includes(outcome.targetId)&&((s*7+j*3)%10)/10<(tier[cond]??.8);
 const wrong=candidateIds.find(id=>id!==outcome.targetId)??candidateIds[0];
 const first=correct?outcome.targetId:wrong;
 const result={abstained:false,rankedTargetIds:[first],probabilities:null};
 if(cond==='depth_context')result.probabilities=candidateIds.map(id=>id===first?.7:.3/(candidateIds.length-1));
 return {result,latency:200,status:'ok'};
}
const window=(events,cutoff,h)=>events.filter(e=>e.t>cutoff&&e.t<=cutoff+h)[0];

// Fixation k starts at 5000k on objs[k%4]; type A decisions (even j) have the next fixation 3000 ms ahead, type B (odd j) 400 ms ahead.
function buildStudy({manifest=baseManifest(),sessionCount=8,decisionsPerSession=6,policy=defaultPolicy,candidatesFor=()=>objs,sessionEndMs=60000,extra=null,gazeValid=()=>0.95,outcomeFor=null}={}){
 const sessions=[],records=[];
 for(let s=0;s<sessionCount;s++){
  const session={participantId:`p${s}`,sessionId:`s${s}`,sessionEndMs,fixations:[],interactions:[],decisions:[]};
  for(let k=0;k<=8;k++){session.fixations.push({objectId:objs[k%4],onsetMs:5000*k,endMs:5000*k+3000});session.interactions.push({objectId:objs[(k+2)%4],atMs:5000*k+3000});}
  const specs=[];
  for(let j=0;j<decisionsPerSession;j++){const k=j+1;specs.push({id:`d${s}_${j}`,j,cutoff:5000*k+(j%2?4600:2000)});}
  if(extra)specs.push(...extra(s));
  for(const spec of specs){
   const outcomes={};
   for(const endpoint of Object.keys(manifest.endpoints)){
    outcomes[endpoint]={};
    const events=endpoint==='next_look_onset'?session.fixations.map(f=>({id:f.objectId,t:f.onsetMs})):session.interactions.map(i=>({id:i.objectId,t:i.atMs}));
    for(const h of manifest.horizons){
     const first=window(events,spec.cutoff,h);
     outcomes[endpoint][h]=outcomeFor?.(s,spec,endpoint,h,first)??(first?{outcome:'event',targetId:first.id,eventAtMs:first.t}:{outcome:'no_event'});
    }
   }
   session.decisions.push({decisionId:spec.id,observedUntilMs:spec.cutoff,gazeValidFraction:gazeValid(s,spec),outcomes:Object.fromEntries(Object.entries(outcomes).map(([e,by])=>[e,Object.fromEntries(Object.entries(by).map(([h,o])=>[String(h),o]))]))});
   const candidateIds=candidatesFor(s,spec);
   for(const h of manifest.horizons)for(const endpoint of Object.keys(manifest.endpoints))for(const cond of manifest.conditions){
    const raw=outcomes[endpoint][h],outcome={cls:raw.outcome,targetId:raw.targetId??null};
    const p=policy(cond,{s,j:spec.j??99,outcome,candidateIds,endpoint,h,spec});
    const ok=p.status==='ok';
    records.push({decisionId:spec.id,participantId:session.participantId,sessionId:session.sessionId,condition:cond,diagnostic:conditionSpecs[cond].diagnostic,endpoint,horizonMs:h,observedUntilMs:spec.cutoff,candidateIds,promptSha256:sha256Hex(`${spec.id}${cond}${endpoint}${h}`),promptBytes:100,artifacts:[],
     gazeSourceSampleId:cond==='scene_only'?null:'g1',gazeTransform:cond==='gaze_shuffled'?{method:'shuffle',seed:'ctl-1'}:cond==='gaze_time_shifted'?{method:'backward_time_shift',shiftMs:300}:cond==='oracle_gaze'?{method:'oracle_gaze'}:null,
     newestInputObservedAtMs:spec.cutoff-50,issuedAtMs:spec.cutoff+100,availableAtMs:ok?spec.cutoff+100+p.latency:null,renderedAtMs:null,latencyMs:p.latency,status:p.status,errorCode:ok?null:'PROVIDER_FAILED',responseSha256:ok||p.status==='parse_failed'?sha256Hex(`r${spec.id}${cond}`):null,result:ok?p.result:null,provider:null,usage:null,costUsd:.01,costSource:'planned_estimate'});
   }
  }
  sessions.push(session);
 }
 return {manifest,records,sessions};
}
function ledgerOf(manifest,records,{closedAtMs=1000,provenance='synthetic',footer=true}={}){
 let prev=GENESIS_HASH;const lines=[];
 const add=(type,payload)=>{const built=chainLine(lines.length,type,prev,payload);prev=built.hash;lines.push(built.text);};
 add('header',{schemaVersion:1,kind:'prometheus_generation_ledger',studyId:manifest.studyId,manifestSha256:manifestHash(manifest),thresholdVersion:manifest.thresholdVersion,provenance,createdAtMs:1,limits:{maxCalls:1e6,budgetUsd:1e4,estimatedCallUsd:.05},plannedCells:records.length});
 for(const r of records)add('record',r);
 if(footer)add('footer',{recordCount:records.length,closedAtMs,callsMade:records.length,spentUsd:records.length*.01});
 return {text:`${lines.join('\n')}\n`,tail:prev};
}
function finish(study,{closedAtMs=1000,boundAtMs=2000,mutateAnnotations}={}){
 const ledger=ledgerOf(study.manifest,study.records,{closedAtMs});
 const annotations={schemaVersion:1,kind:'prometheus_annotations_v2',studyId:study.manifest.studyId,ledgerTailSha256:ledger.tail,boundAtMs,sessions:structuredClone(study.sessions)};
 mutateAnnotations?.(annotations);
 return {manifest:study.manifest,ledgerText:ledger.text,annotations};
}
const score=(study,opts)=>evaluateComparisonV2(finish(study,opts));
const arm=(report,endpoint,h,id)=>report.endpoints[endpoint][h].arms[id];
const throwsCode=(fn,code)=>assert.throws(fn,error=>error.code===code,`expected ${code}`);

test('happy path: separate endpoints and horizons, improvement_supported on synthetic data, never a Gate pass',()=>{
 const report=score(buildStudy());
 assert.equal(report.dataProvenance,'synthetic');
 assert.equal(report.gateStatus.g5d,'not_evaluated');
 assert.equal(report.sessionCount,8);assert.equal(report.decisionCount,48);
 assert.deepEqual(Object.keys(report.endpoints).sort(),['next_interaction','next_look_onset']);
 for(const endpoint of Object.keys(report.endpoints))assert.deepEqual(Object.keys(report.endpoints[endpoint]),['1000','3000']);
 assert.equal(report.verdict.status,'improvement_supported');
 assert.ok(report.verdict.primary.ci[0]>0.05);
 assert.equal(report.verdict.checks.coverageFloor.ok,true);
 assert.equal(report.statistics.unit,'session');
 // confirmatory only on the primary endpoint/horizon, the rest exploratory
 const confirmatory=report.contrasts.filter(c=>c.confirmatory);
 assert.equal(confirmatory.length,1);
 assert.deepEqual([confirmatory[0].candidate,confirmatory[0].reference,confirmatory[0].endpoint,confirmatory[0].horizonMs],['depth_context','sam_object_context','next_look_onset',3000]);
 assert.ok(report.contrasts.filter(c=>!c.confirmatory).every(c=>c.exploratory===true&&c.multiplicity==='exploratory_unadjusted'));
 assert.ok(report.contrasts.some(c=>c.candidate==='spatial_memory_context'&&c.reference==='history_only_matched'));
 assert.ok(report.contrasts.some(c=>c.candidate==='sam_mask_foreground'&&c.reference==='sam_bbox_crop'));
 // the same ledger scores deterministically
 assert.deepEqual(score(buildStudy()),report);
});

test('manifest hash mismatch is refused: thresholds cannot change after seeing results',()=>{
 const study=buildStudy(),input=finish(study);
 assert.doesNotThrow(()=>evaluateComparisonV2(input));
 for(const patch of [m=>{m.practicalDelta=.01;},m=>{m.coverageFloor=.3;},m=>{m.noninferiorityMargins.coverage=.5;},m=>{m.samplePlan.minSessions=3;}]){
  const relaxed=structuredClone(input.manifest);patch(relaxed);
  throwsCode(()=>evaluateComparisonV2({...input,manifest:relaxed}),'MANIFEST_HASH_MISMATCH');
 }
 const renamed=structuredClone(input.manifest);renamed.thresholdVersion='thr-2';
 throwsCode(()=>evaluateComparisonV2({...input,manifest:renamed}),'MANIFEST_HASH_MISMATCH');
 throwsCode(()=>evaluateComparisonV2({...input,manifest:{...input.manifest,extra:1}}),'MANIFEST_INVALID');
});

test('a late or exactly simultaneous prediction is not an anticipation success; correct-but-late is reported separately',()=>{
 const late=(cond,latency)=>(c,ctx)=>{const p=defaultPolicy(c,ctx);if(c===cond)p.latency=latency;return p;};
 // type B look events occur 400 ms after the cutoff; the call is issued 100 ms after it
 const onTime=score(buildStudy({policy:late('depth_context',200)}));
 const equal=score(buildStudy({policy:late('depth_context',300)}));
 const after=score(buildStudy({policy:late('depth_context',350)}));
 const base=arm(onTime,'next_look_onset',1000,'depth_context');
 assert.ok(base.anticipation.successes>0);
 assert.equal(arm(equal,'next_look_onset',1000,'depth_context').anticipation.successes,0);
 assert.equal(arm(after,'next_look_onset',1000,'depth_context').anticipation.successes,0);
 const lateArm=arm(equal,'next_look_onset',1000,'depth_context');
 assert.equal(lateArm.anticipation.lateCorrect,base.anticipation.successes);
 assert.equal(lateArm.accuracy.top1,base.accuracy.top1);
 assert.equal(lateArm.leadTimeMs.count,0);
 assert.equal(lateArm.anticipation.denominator,'all_eligible_event_decisions');
 // lead time exists only for correct on-time predictions: event at +400, available at +300
 assert.equal(base.leadTimeMs.count,base.anticipation.successes);assert.equal(base.leadTimeMs.mean,100);
});

test('deadline and maximum result age gate success even when the answer is correct and precedes the event',()=>{
 const slow=score(buildStudy({policy:(c,ctx)=>{const p=defaultPolicy(c,ctx);if(c==='depth_context')p.latency=900;return p;}}));
 const a=arm(slow,'next_look_onset',3000,'depth_context');
 assert.equal(a.anticipation.successes,0);
 assert.equal(a.accuracy.deadlineAccuracy,0);
 assert.equal(a.coverage.coverage,0);
 assert.ok(a.accuracy.top1>0);
 assert.equal(slow.verdict.status,'improvement_not_established');
 assert.ok(slow.verdict.reasons.some(r=>r.includes('coverage floor')));
 const m=baseManifest();m.maxResultAgeMs=250;m.deadlineMs=5000;
 const stale=score(buildStudy({manifest:m}));
 assert.equal(arm(stale,'next_look_onset',3000,'depth_context').anticipation.successes,0);
 assert.ok(arm(stale,'next_look_onset',3000,'depth_context').anticipation.staleResults>0);
});

test('censored and tracking-lost decisions are excluded from the denominator and reported',()=>{
 const study=buildStudy({
  sessionEndMs:35000,
  extra:s=>[{id:`late${s}`,j:99,cutoff:34000}],
  outcomeFor:(s,spec,endpoint,h,first)=>spec.id===`d0_2`&&endpoint==='next_look_onset'?{outcome:'tracking_lost'}:undefined
 });
 const report=score(study);
 const look3=report.endpoints.next_look_onset[3000];
 assert.equal(look3.outcomes.tracking_lost,1);
 assert.equal(look3.outcomes.session_end_censored,0);
 // the late decisions have no event in the window: their no_event labels are reclassified to censored (window passes session end)
 const interaction=report.endpoints.next_interaction[3000],look1=report.endpoints.next_look_onset[1000];
 assert.ok(interaction.excluded.reclassifiedNoEventToCensored>0||look1.excluded.reclassifiedNoEventToCensored>0);
 assert.equal(look3.excluded.trackingLost,1);
 const total=Object.values(look3.outcomes).reduce((a,b)=>a+b,0);
 assert.equal(total,report.decisionCount);
 const a=arm(report,'next_look_onset',3000,'depth_context');
 assert.equal(a.eligible,look3.outcomes.event);
 assert.equal(a.included,look3.outcomes.event+look3.outcomes.no_event);
 assert.ok(a.eligible<report.decisionCount);
 assert.equal(a.anticipation.successRate,a.anticipation.successes/look3.outcomes.event);
 // an explicitly labelled event is still scored even when its window ends past the session
 const eventKept=score(buildStudy({sessionEndMs:35000,extra:s=>[{id:`edge${s}`,j:99,cutoff:34600}]}));
 assert.ok(eventKept.endpoints.next_look_onset[1000].outcomes.event>0);
});

test('failures and abstentions stay in the denominator',()=>{
 const baseline=score(buildStudy());
 const failing=score(buildStudy({policy:(c,ctx)=>{const p=defaultPolicy(c,ctx);if(c==='depth_context'&&ctx.j%2===0)return {status:ctx.s%2?'timeout':'provider_failed',latency:200};if(c==='history_context'&&ctx.j===1)return {status:'ok',latency:200,result:{abstained:true,rankedTargetIds:[],probabilities:null}};return p;}}));
 const a=arm(failing,'next_look_onset',3000,'depth_context'),b=arm(baseline,'next_look_onset',3000,'depth_context');
 assert.equal(a.eligible,b.eligible);
 assert.equal(a.statusCounts.timeout+a.statusCounts.provider_failed,a.decisions/2);
 assert.ok(a.anticipation.successes<b.anticipation.successes);
 assert.equal(a.anticipation.successRate,a.anticipation.successes/a.eligible);
 assert.ok(a.coverage.coverage<b.coverage.coverage);
 const h=arm(failing,'next_look_onset',3000,'history_context');
 assert.ok(h.coverage.coverage<1);assert.equal(h.eligible,a.eligible);
});

test('ledger integrity: tampered, truncated, incomplete or mismatched ledgers and annotations are refused',()=>{
 const input=finish(buildStudy());
 const lines=input.ledgerText.slice(0,-1).split('\n');
 const withLines=ls=>({...input,ledgerText:`${ls.join('\n')}\n`});
 const edited=[...lines];edited[10]=edited[10].replace('"status":"ok"','"status":"timeout"');
 throwsCode(()=>evaluateComparisonV2(withLines(edited)),'LEDGER_TAMPERED');
 throwsCode(()=>evaluateComparisonV2(withLines(lines.slice(0,-1))),'LEDGER_UNCLOSED');
 throwsCode(()=>evaluateComparisonV2(withLines([...lines.slice(0,5),...lines.slice(6)])),'LEDGER_TAMPERED');
 throwsCode(()=>evaluateComparisonV2({...input,ledgerText:input.ledgerText.slice(0,-3)}),'LEDGER_TAMPERED');
 // a forger who rewrites the chain changes the tail hash and breaks the annotation binding
 let prev=GENESIS_HASH;const forged=lines.map((l,i)=>{const row=JSON.parse(l);if(i===10)row.payload.status='timeout',row.payload.availableAtMs=null,row.payload.result=null,row.payload.errorCode='X',row.payload.responseSha256=null;const b=chainLine(i,row.type,prev,row.payload);prev=b.hash;return b.text;});
 throwsCode(()=>evaluateComparisonV2(withLines(forged)),'ANNOTATION_LEDGER_MISMATCH');
 throwsCode(()=>evaluateComparisonV2({...input,annotations:{...input.annotations,ledgerTailSha256:'0'.repeat(64)}}),'ANNOTATION_LEDGER_MISMATCH');
 throwsCode(()=>evaluateComparisonV2({...input,annotations:{...input.annotations,boundAtMs:999}}),'ANNOTATION_BEFORE_LEDGER_CLOSE');
 // a cell missing from the ledger (plan consistent with records) is refused, not silently dropped
 const study=buildStudy();study.records.splice(7,1);
 throwsCode(()=>score(study),'LEDGER_INCOMPLETE');
 // annotated decision set must equal the ledger decision set
 const noDecision=buildStudy();
 throwsCode(()=>evaluateComparisonV2(finish(noDecision,{mutateAnnotations:a=>{a.sessions[0].decisions.pop();}})),'DECISION_SET_MISMATCH');
 throwsCode(()=>evaluateComparisonV2(finish(buildStudy(),{mutateAnnotations:a=>{a.sessions[0].decisions[0].observedUntilMs+=1;}})),'LEDGER_INVALID');
});

test('annotations are strict and internally consistent with the declared event definitions',()=>{
 const bad=(mutate,code)=>throwsCode(()=>evaluateComparisonV2(finish(buildStudy(),{mutateAnnotations:mutate})),code);
 bad(a=>{a.extra=1;},'ANNOTATIONS_INVALID');
 bad(a=>{a.sessions[0].decisions[0].outcomes.next_look_onset['3000'].targetId='o9';},'ANNOTATION_INCONSISTENT');
 bad(a=>{const o=a.sessions[0].decisions[0].outcomes.next_look_onset['3000'];o.targetId=o.targetId==='o1'?'o2':'o1';},'ANNOTATION_INCONSISTENT');
 bad(a=>{a.sessions[0].decisions[0].outcomes.next_look_onset['3000']={outcome:'no_event'};},'ANNOTATION_INCONSISTENT');
 bad(a=>{delete a.sessions[0].decisions[0].outcomes.next_interaction;},'ANNOTATIONS_INVALID');
 bad(a=>{a.sessions[0].decisions[0].outcomes.next_look_onset['1000']={outcome:'maybe'};},'ANNOTATIONS_INVALID');
 bad(a=>{a.sessions[0].fixations[0].endMs=50;},'ANNOTATIONS_INVALID');
 bad(a=>{a.sessions[0].decisions[0].gazeValidFraction=1.5;},'ANNOTATIONS_INVALID');
 bad(a=>{a.sessions[1].decisions[0].decisionId=a.sessions[0].decisions[0].decisionId;},'ANNOTATIONS_INVALID');
});

test('underpowered and fixed-sample stopping rule',()=>{
 const m=baseManifest();m.samplePlan.minSessions=10;m.samplePlan.maxSessions=12;
 const report=score(buildStudy({manifest:m}));
 assert.equal(report.verdict.status,'underpowered');
 const e=baseManifest();e.samplePlan.minEligibleDecisions=100;
 assert.equal(score(buildStudy({manifest:e})).verdict.status,'underpowered');
 const tooMany=baseManifest();tooMany.samplePlan.maxSessions=6;
 throwsCode(()=>score(buildStudy({manifest:tooMany})),'STOPPING_RULE_VIOLATION');
 // one session can never support a session-clustered interval
 const m1=baseManifest();m1.samplePlan.minSessions=2;
 const single=score(buildStudy({manifest:m1,sessionCount:1}));
 assert.equal(single.verdict.status,'underpowered');assert.equal(single.verdict.primary.ci,null);
});

test('improvement_not_established: CI floor, practical delta, noninferiority and coverage floor all gate the verdict',()=>{
 const worse=baseManifest();worse.primaryContrast={candidate:'gaze_crop',reference:'sam_object_context'};worse.multiplicityPolicy.confirmatory=[{...worse.primaryContrast}];
 const r1=score(buildStudy({manifest:worse}));
 assert.equal(r1.verdict.status,'improvement_not_established');
 assert.ok(r1.verdict.primary.meanDelta<0);
 const demanding=baseManifest();demanding.practicalDelta=.9;
 const r2=score(buildStudy({manifest:demanding}));
 assert.equal(r2.verdict.status,'improvement_not_established');assert.ok(r2.verdict.reasons.some(r=>r.includes('practicalDelta')));
 // noninferiority: candidate loses coverage by abstaining on half of the decisions
 const abstainer=(c,ctx)=>{const p=defaultPolicy(c,ctx);if(c==='depth_context'&&ctx.j%2===1)p.result={abstained:true,rankedTargetIds:[],probabilities:null};return p;};
 const ni=baseManifest();ni.noninferiorityMargins={coverage:.05};ni.coverageFloor=.1;
 const r3=score(buildStudy({manifest:ni,policy:abstainer}));
 assert.equal(r3.verdict.checks.noninferiority.coverage.ok,false);
 assert.equal(r3.verdict.status,'improvement_not_established');
 assert.ok(r3.verdict.reasons.some(r=>r.includes('noninferiority')));
 const floor=baseManifest();floor.coverageFloor=.99;
 const r4=score(buildStudy({manifest:floor,policy:abstainer}));
 assert.equal(r4.verdict.checks.coverageFloor.ok,false);
});

test('A06 error decomposition: candidate recall, reasoning given candidate, gaze-quality gate, end-to-end',()=>{
 const study=buildStudy({
  candidatesFor:(s,spec)=>{
   const k=Number(spec.id.split('_')[1]);void k;
   // drop the true next object from the candidate set on decision 0 of every session (look targets objs[(j+2)%4])
   return spec.id.endsWith('_0')?objs.filter(id=>id!==objs[(k+2)%4]):objs;
  },
  gazeValid:(s,spec)=>spec.id.endsWith('_1')?0.5:spec.id.endsWith('_2')?null:0.95
 });
 const a=arm(score(study),'next_look_onset',3000,'depth_context'),d=a.errorDecomposition;
 assert.equal(d.all.eligible,48);
 assert.ok(d.all.candidateRecall<1&&d.all.candidatePresent===48-8);
 assert.equal(d.all.candidateRecall,40/48);
 assert.ok(d.all.reasoningAccuracyGivenCandidate>=d.all.endToEndAccuracy);
 assert.equal(d.all.endToEndCorrect,a.accuracy.top1);
 assert.equal(d.gazeQualityGated.gated.eligible+d.gazeQualityGated.belowGate.eligible+d.gazeQualityGated.unknownQuality.eligible,48);
 assert.equal(d.gazeQualityGated.belowGate.eligible,8);assert.equal(d.gazeQualityGated.unknownQuality.eligible,8);
 assert.equal(d.gazeQualityGated.minValidFraction,.8);
});

test('baselines: current-object hold and causal first-order Markov are computed by the scorer; new-object subset is separate',()=>{
 const report=score(buildStudy());
 const hold=arm(report,'next_look_onset',3000,'baseline_current_hold'),markov=arm(report,'next_look_onset',3000,'baseline_markov');
 assert.equal(hold.baseline,true);
 assert.equal(hold.accuracy.top1,0);
 assert.equal(hold.newObjectTransition.eligible,hold.eligible);
 // fixation cycle o1,o2,o3,o4: the Markov state has been seen before only from k=4 (decisions j=3..5 of 6 per session)
 assert.equal(markov.accuracy.top1,8*3);
 assert.equal(markov.anticipation.successes,24);
 assert.ok(markov.coverage.coverage<1);
 assert.ok(report.endpoints.next_look_onset[3000].arms.sam_object_context.newObjectTransition.eligible>0);
 assert.ok(report.contrasts.some(c=>c.reference==='baseline_current_hold'));
 const session={fixations:[{objectId:'o1',onsetMs:0,endMs:900},{objectId:'o2',onsetMs:1000,endMs:1900},{objectId:'o1',onsetMs:2000,endMs:2900},{objectId:'o3',onsetMs:3000,endMs:3900}],interactions:[{objectId:'o2',atMs:500},{objectId:'o4',atMs:1500},{objectId:'o2',atMs:2500},{objectId:'o1',atMs:3500}]};
 // cutoff 2500: the o1->o3 transition (onset 3000) lies in the future and must not be used
 assert.deepEqual(baselinePrediction('baseline_markov','next_look_onset',session,2500),['o2']);
 assert.deepEqual(baselinePrediction('baseline_markov','next_look_onset',session,3500),[]);
 const cycle={fixations:[['o1',0],['o2',1000],['o1',2000],['o3',3000],['o1',4000],['o2',5000],['o1',6000]].map(([objectId,onsetMs])=>({objectId,onsetMs,endMs:onsetMs+500})),interactions:[]};
 assert.deepEqual(baselinePrediction('baseline_markov','next_look_onset',cycle,6500),['o2','o3']);
 assert.deepEqual(baselinePrediction('baseline_current_hold','next_look_onset',session,2500),['o1']);
 assert.deepEqual(baselinePrediction('baseline_markov','next_look_onset',session,500),[]);
 assert.deepEqual(baselinePrediction('baseline_markov','next_interaction',session,2600),['o4']);
 assert.deepEqual(baselinePrediction('baseline_markov','next_interaction',session,1000),[]);
});

test('calibration: Brier and ECE only from complete probability outputs, manifest-fixed bins, coverage-risk',()=>{
 const report=score(buildStudy());
 const depth=arm(report,'next_look_onset',3000,'depth_context'),gaze=arm(report,'next_look_onset',3000,'gaze_crop');
 assert.equal(gaze.calibration.completeProbabilityDecisions,0);
 assert.equal(gaze.calibration.brier,null);assert.equal(gaze.calibration.ece.status,'no_probability_outputs');assert.equal(gaze.coverageRisk.status,'no_confidence_scores');
 const n=depth.calibration.completeProbabilityDecisions,correct=depth.accuracy.top1;
 assert.equal(n,48);
 assert.equal(depth.calibration.ece.bins.length,10);
 // truth is always in the candidate set: correct = .09+3*.01, wrong = (.1-1)^2+.7^2+2*.01
 assert.ok(Math.abs(depth.calibration.brier.mean-(correct*.12+(n-correct)*1.32)/n)<1e-9);
 assert.ok(Math.abs(depth.calibration.ece.value-Math.abs(correct/n-.7))<1e-9);
 assert.equal(depth.calibration.ece.bins[7].count,n);
 assert.equal(depth.coverageRisk.status,'reported');
 const last=depth.coverageRisk.points.at(-1);
 assert.ok(Math.abs(last.risk-(1-correct/n))<1e-9);assert.equal(last.coverage,1);
 const few=baseManifest();few.calibration.minSamples=100;
 assert.equal(arm(score(buildStudy({manifest:few})),'next_look_onset',3000,'depth_context').calibration.ece.status,'insufficient_samples');
 // incomplete probability vectors cannot enter the ledger at all
 const broken=buildStudy();broken.records.find(r=>r.condition==='depth_context'&&r.result?.probabilities).result.probabilities=[.7,.1];
 throwsCode(()=>score(broken),'LEDGER_INVALID');
});

test('preparation metrics: prepare hit, useful hit, wrong preparations per minute, duplicate updates',()=>{
 const report=score(buildStudy());
 const p=arm(report,'next_look_onset',3000,'depth_context').preparation,q=arm(report,'next_look_onset',3000,'scene_only').preparation;
 assert.equal(p.sessionMinutes,8);
 assert.equal(p.preparations,48);
 assert.equal(p.prepareHits+p.wrongPreparations+p.unevaluablePreparations,48);
 assert.ok(p.usefulHits<=p.prepareHits&&p.usefulHits>0);
 assert.ok(Math.abs(p.wrongPreparationsPerMinute-p.wrongPreparations/8)<1e-12);
 assert.equal(q.prepareHits,0);assert.equal(q.wrongPreparations,48);assert.ok(q.duplicateUpdates>0);
 assert.ok(q.duplicateUpdatesPerMinute>0);
});

test('A02/A03 contrasts and diagnostic arms: oracle arms are flagged and excluded from primary claims',()=>{
 const report=score(buildStudy());
 const oracle=report.contrasts.filter(c=>c.candidate.startsWith('oracle_'));
 assert.ok(oracle.length>=3);
 assert.ok(oracle.every(c=>c.diagnostic&&c.excludedFromPrimaryClaims&&!c.confirmatory));
 assert.equal(arm(report,'next_look_onset',3000,'oracle_mask').diagnostic,true);
 assert.equal(arm(report,'next_look_onset',3000,'sam_mask_foreground').diagnostic,false);
 assert.deepEqual(report.conditions.filter(c=>c.diagnostic).map(c=>c.id).sort(),['oracle_depth','oracle_gaze','oracle_mask']);
});

test('interaction is claimed only when all eight depth/history/proactive cells exist',()=>{
 const full=score(buildStudy());
 assert.equal(full.interaction.status,'computed');assert.equal(full.interaction.interactionClaimAllowed,true);
 assert.equal(full.interaction.effects.length,7);
 assert.deepEqual(full.interaction.effects.map(e=>e.name),['depth','history','proactive','depthxhistory','depthxproactive','historyxproactive','depthxhistoryxproactive']);
 assert.ok(full.interaction.effects.every(e=>e.exploratory&&Number.isFinite(e.estimate)));
 // main effect of depth: cells with depth vs without (history_context and proactive_context share tier .8, sam_object_context .6)
 const m=baseManifest();m.conditions=m.conditions.filter(c=>!['depth_history','history_proactive'].includes(c));
 const partial=score(buildStudy({manifest:m}));
 assert.equal(partial.interaction.status,'refused');assert.equal(partial.interaction.interactionClaimAllowed,false);
 assert.deepEqual(partial.interaction.missingCells.sort(),['depth_history','history_proactive']);
 assert.equal(partial.interaction.effects,undefined);
 assert.equal(Object.keys(factorialCells).length,8);
});

test('Holm multiplicity: confirmatory family adjusts p-values and widens the primary interval',()=>{
 const m=baseManifest();m.multiplicityPolicy.confirmatory=[{candidate:'depth_context',reference:'sam_object_context'},{candidate:'history_context',reference:'sam_object_context'},{candidate:'proactive_context',reference:'sam_object_context'}];
 const report=score(buildStudy({manifest:m}));
 const confirmatory=report.contrasts.filter(c=>c.confirmatory);
 assert.equal(confirmatory.length,3);
 for(const c of confirmatory){assert.ok(Math.abs(c.ciLevel-(1-.05/3))<1e-12);assert.ok(c.adjustedPValue>=c.pValue-1e-12);assert.equal(c.multiplicity,'holm');}
 assert.equal(report.statistics.confirmatoryCount,3);
 const single=score(buildStudy());
 assert.ok(report.verdict.primary.ci[0]<=single.verdict.primary.ci[0]+1e-12);
 // exploratory rows keep the unadjusted level
 assert.ok(report.contrasts.filter(c=>c.exploratory).every(c=>Math.abs(c.ciLevel-.95)<1e-12));
});

test('bootstrap resamples sessions, not frames: duplicating decisions inside sessions does not tighten the interval',()=>{
 const few=score(buildStudy({decisionsPerSession:6})),many=score(buildStudy({decisionsPerSession:6,sessionCount:8}));
 assert.deepEqual(few.verdict.primary.ci,many.verdict.primary.ci);
 const row=few.contrasts.find(c=>c.confirmatory);
 assert.equal(row.pairedSessions,8);assert.equal(row.ciMethod,'paired session-cluster percentile bootstrap');
 assert.equal(few.statistics.note.includes('not independent samples'),true);
});

test('CLI scores a ledger exclusively, records source hashes and enforces an external manifest hash',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'prom-v2-'));
 try{
  const input=finish(buildStudy());
  const paths={manifest:join(dir,'m.json'),ledger:join(dir,'l.jsonl'),annotations:join(dir,'a.json'),output:join(dir,'r.json')};
  await writeFile(paths.manifest,JSON.stringify(input.manifest));await writeFile(paths.ledger,input.ledgerText);await writeFile(paths.annotations,JSON.stringify(input.annotations));
  const lines=[];
  const args=['--manifest',paths.manifest,'--ledger',paths.ledger,'--annotations',paths.annotations,'--output',paths.output];
  const report=await evaluateMain(args,{stdout:l=>lines.push(l)});
  assert.match(lines[0],/verdict improvement_supported, data provenance synthetic/);
  const written=JSON.parse(await readFile(paths.output,'utf8'));
  assert.equal(written.manifestSha256,manifestHash(input.manifest));
  assert.equal(written.sourceSha256s.ledgerFile,sha256Hex(await readFile(paths.ledger)));
  assert.deepEqual(written.verdict.status,report.verdict.status);
  await assert.rejects(evaluateMain(args,{stdout:()=>{}}),{code:'EEXIST'});
  await assert.rejects(evaluateMain([...args.slice(0,-1),join(dir,'r2.json'),'--expect-manifest-sha256','0'.repeat(64)],{stdout:()=>{}}),error=>error.code==='MANIFEST_HASH_MISMATCH');
  await assert.rejects(evaluateMain(['--manifest',paths.manifest],{stdout:()=>{}}),/Usage/);
  const relaxed=structuredClone(input.manifest);relaxed.practicalDelta=.01;await writeFile(join(dir,'m2.json'),JSON.stringify(relaxed));
  await assert.rejects(evaluateMain(['--manifest',join(dir,'m2.json'),'--ledger',paths.ledger,'--annotations',paths.annotations,'--output',join(dir,'r3.json')],{stdout:()=>{}}),error=>error.code==='MANIFEST_HASH_MISMATCH');
 }finally{await rm(dir,{recursive:true,force:true});}
});
