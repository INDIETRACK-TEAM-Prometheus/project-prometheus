export const comparisonConditions = Object.freeze([
 'scene_only','gaze_crop','sam_object_context','depth_context','history_context','proactive_context','depth_history_proactive','gaze_shuffled','gaze_time_shifted'
]);

const targetPattern=/^[A-Za-z0-9_:-]{1,128}$/;
const idPattern=/^[A-Za-z0-9_-]{1,64}$/;
const modelPattern=/^[A-Za-z0-9_.:/-]{1,128}$/;
const shaPattern=/^[a-f0-9]{64}$/;
const featureKinds={
 scene_only:['scene'],
 gaze_crop:['scene','gaze_crop'],
 sam_object_context:['scene','gaze_crop','sam_objects'],
 depth_context:['scene','gaze_crop','sam_objects','depth'],
 history_context:['scene','gaze_crop','sam_objects','history'],
 proactive_context:['scene','gaze_crop','sam_objects','proactive'],
 depth_history_proactive:['scene','gaze_crop','sam_objects','depth','history','proactive'],
 gaze_shuffled:['scene','gaze_crop'],
 gaze_time_shifted:['scene','gaze_crop']
};
const pairs=[
 ['gaze_crop','scene_only'],
 ['sam_object_context','gaze_crop'],
 ['depth_context','sam_object_context'],
 ['history_context','sam_object_context'],
 ['proactive_context','sam_object_context'],
 ['depth_history_proactive','sam_object_context'],
 ['gaze_shuffled','gaze_crop'],
 ['gaze_time_shifted','gaze_crop']
];
const pairedMetrics=['currentObjectAccuracy','currentObjectCoverage','nextTargetTop1Accuracy','nextTargetTop3Accuracy','nextTargetCoverage','nextTargetBrier'];

function invalid(){throw Error('invalid comparison dataset');}
function object(value,keys){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));}
function str(value,pattern=idPattern){return typeof value==='string'&&pattern.test(value);}
function finite(value,min=0){return Number.isFinite(value)&&value>=min;}
function sha(value){return str(value,shaPattern);}
function uniqueStrings(values,pattern=idPattern,min=1,max=100000){return Array.isArray(values)&&values.length>=min&&values.length<=max&&values.every(value=>str(value,pattern))&&new Set(values).size===values.length;}
function close(a,b){return Math.abs(a-b)<=1e-6;}
function identity(p,s,scene){return `${p}\u0000${s}\u0000${scene}`;}
function sessionIdentity(p,s){return `${p}\u0000${s}`;}
function target(value,targets){return value===null||targets.has(value);}
function stable(value){return Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;}
function samePrediction(a,b){return JSON.stringify(stable(a))===JSON.stringify(stable(b));}

function validateSharedEvidence(decision){
 const get=(condition,kind)=>decision.conditions[condition].input.evidence.find(item=>item.kind===kind);
 const baseScene=get('scene_only','scene');
 if(comparisonConditions.some(condition=>!samePrediction(baseScene,get(condition,'scene'))))invalid();
 const sharedConditions=['gaze_crop','sam_object_context','depth_context','history_context','proactive_context','depth_history_proactive'];
 const sharedGaze=sharedConditions.map(condition=>get(condition,'gaze_crop'));
 const sharedSam=sharedConditions.slice(1).map(condition=>get(condition,'sam_objects'));
 if(!sharedGaze.every(item=>samePrediction(sharedGaze[0],item))||!sharedSam.every(item=>samePrediction(sharedSam[0],item)))invalid();
}

function validateTargetLabel(label,targets,cutoff,future){
 if(label===null)return;
 if(!object(label,['targetId','observedAtMs'])||!targets.has(label.targetId)||!finite(label.observedAtMs))invalid();
 if(future?label.observedAtMs<=cutoff:label.observedAtMs>cutoff)invalid();
}

function validateSplitManifest(rows,policy){
 if(!Array.isArray(rows)||!rows.length||rows.length>100000)invalid();
 const seenRows=new Set(),sceneRows=new Map(),participantSplit=new Map(),sessionSplit=new Map(),sceneSplit=new Map(),hashSplit=new Map();
 for(const row of rows){
  if(!object(row,['participantId','sessionId','sceneId','split','sceneSha256s'])||![row.participantId,row.sessionId,row.sceneId].every(x=>str(x))||!['train','validation','test'].includes(row.split)||!uniqueStrings(row.sceneSha256s,shaPattern))invalid();
  const key=identity(row.participantId,row.sessionId,row.sceneId);if(seenRows.has(key))invalid();seenRows.add(key);sceneRows.set(key,row);
  for(const [map,value,strict] of [[participantSplit,row.participantId,policy==='subject_heldout'],[sessionSplit,row.sessionId,true],[sceneSplit,row.sceneId,true]]){
   const prior=map.get(value);if(strict&&prior!==undefined&&prior!==row.split)invalid();map.set(value,prior??row.split);
  }
  for(const digest of row.sceneSha256s){const prior=hashSplit.get(digest);if(prior!==undefined&&prior!==row.split)invalid();hashSplit.set(digest,row.split);}
 }
 if(['train','validation','test'].some(value=>!rows.some(row=>row.split===value)))invalid();
 return {rows,seenRows,sceneRows,participantSplit,sessionSplit,sceneSplit,hashSplit};
}

function validateManifestAndSessions(data,split){
 const manifest=data.heldoutManifest;
 if(!Array.isArray(manifest)||!manifest.length||manifest.length>10000||!Array.isArray(data.sessions)||data.sessions.length!==manifest.length)invalid();
 const expected=new Map();
 for(const row of manifest){
  if(!object(row,['participantId','sessionId','decisionIds'])||!str(row.participantId)||!str(row.sessionId)||!uniqueStrings(row.decisionIds,idPattern,1,100000))invalid();
  const key=sessionIdentity(row.participantId,row.sessionId);if(expected.has(key))invalid();expected.set(key,new Set(row.decisionIds));
 }
 const testSessions=new Set(split.rows.filter(row=>row.split==='test').map(row=>sessionIdentity(row.participantId,row.sessionId)));
 if(testSessions.size!==expected.size||[...testSessions].some(key=>!expected.has(key)))invalid();
 const sessionMap=new Map();
 for(const session of data.sessions){
  if(!object(session,['participantId','sessionId','gazeSamples','decisions'])||!str(session.participantId)||!str(session.sessionId)||!Array.isArray(session.gazeSamples)||session.gazeSamples.length>100000||!Array.isArray(session.decisions)||!session.decisions.length||session.decisions.length>100000)invalid();
  const key=sessionIdentity(session.participantId,session.sessionId),expectedIds=expected.get(key);if(!expectedIds||sessionMap.has(key))invalid();
  const gazeSamples=new Map();
  for(const sample of session.gazeSamples){
   if(!object(sample,['sampleId','observedAtMs','processedAtMs'])||!str(sample.sampleId)||!finite(sample.observedAtMs)||!finite(sample.processedAtMs)||sample.processedAtMs<sample.observedAtMs||gazeSamples.has(sample.sampleId))invalid();
   gazeSamples.set(sample.sampleId,sample);
  }
  const decisions=new Map(),actualSceneIds=new Set();
  for(const decision of session.decisions){
   if(!object(decision,['decisionId','sceneId','frameId','sceneSha256','sceneObservedAtMs','observedUntilMs','gazeSampleId','currentObjectLabel','nextTargetLabel','conditions'])||![decision.decisionId,decision.sceneId,decision.frameId,decision.gazeSampleId].every(x=>str(x))||!sha(decision.sceneSha256)||!finite(decision.sceneObservedAtMs)||!finite(decision.observedUntilMs)||decision.sceneObservedAtMs>decision.observedUntilMs||!object(decision.conditions,comparisonConditions))invalid();
   if(decisions.has(decision.decisionId))invalid();
   const currentGaze=gazeSamples.get(decision.gazeSampleId);if(!currentGaze||currentGaze.observedAtMs>decision.observedUntilMs||currentGaze.processedAtMs>decision.observedUntilMs)invalid();
   validateTargetLabel(decision.currentObjectLabel,new Set(data.targetIds),decision.observedUntilMs,false);
   validateTargetLabel(decision.nextTargetLabel,new Set(data.targetIds),decision.observedUntilMs,true);
   const assignment=split.sceneRows.get(identity(session.participantId,session.sessionId,decision.sceneId));
   if(assignment?.split!=='test')invalid();
   if(!assignment||!assignment.sceneSha256s.includes(decision.sceneSha256))invalid();
   actualSceneIds.add(decision.sceneId);
   decisions.set(decision.decisionId,{...decision,currentGaze,rawConditions:decision.conditions,conditions:{}});
  }
  if(decisions.size!==expectedIds.size||[...expectedIds].some(id=>!decisions.has(id)))invalid();
  const splitScenes=split.rows.filter(row=>row.participantId===session.participantId&&row.sessionId===session.sessionId&&row.split==='test').map(row=>row.sceneId);
  if(actualSceneIds.size!==splitScenes.length||splitScenes.some(scene=>!actualSceneIds.has(scene)))invalid();
  const normalized={participantId:session.participantId,sessionId:session.sessionId,gazeSamples,decisions};
  sessionMap.set(key,normalized);
 }
 if(sessionMap.size!==expected.size)invalid();
 // Validate each condition only after every same-session decision is available for cache references.
 let costTotal=0;
 for(const session of sessionMap.values())for(const decision of session.decisions.values()){
  for(const condition of comparisonConditions){
   const row=decision.conditions[condition];
   if(row)invalid();
   const raw=decision.rawConditions[condition];
   const normalized=validateCondition(raw,condition,decision,session,data.targetIds,data.runConfig);
   costTotal+=normalized.call.costUsd;
   decision.conditions[condition]=normalized;
  }
  validateSharedEvidence(decision);
  delete decision.rawConditions;
 }
 if(costTotal>data.runConfig.totalCostCapUsd+1e-9)invalid();
 for(const session of sessionMap.values())for(const decision of session.decisions.values())for(const condition of comparisonConditions){
  const row=decision.conditions[condition],call=row.call;
  if(call.cacheState==='hit'){
   const sourceDecision=session.decisions.get(call.cacheSourceDecisionId),sourceCondition=sourceDecision?.conditions[condition];
   if(!sourceDecision||sourceDecision===decision||sourceDecision.observedUntilMs>decision.observedUntilMs||!sourceCondition||sourceCondition.call.status!=='completed'||sourceCondition.call.completedAtMs>call.startedAtMs||!samePrediction(sourceCondition.result,row.result)||call.costUsd!==0)invalid();
  }
 }
 return {sessions:[...sessionMap.values()],decisionCount:[...sessionMap.values()].reduce((sum,session)=>sum+session.decisions.size,0),costTotal};
}

function validateCondition(row,condition,decision,session,targetIds,runConfig){
 if(!object(row,['model','input','result','call'])||!object(row.model,['provider','modelId','revision','promptSha256','temperature','maxOutputTokens'])||!Object.keys(runConfig.model).every(key=>row.model[key]===runConfig.model[key])||!object(row.input,['cutoffMs','evidence','gazeSourceSampleId','gazeTransform'])||row.input.cutoffMs!==decision.observedUntilMs||!Array.isArray(row.input.evidence)||!object(row.result,['currentObjectId','nextTarget'])||!object(row.call,['status','errorCode','startedAtMs','completedAtMs','latencyMs','cacheState','cacheSourceDecisionId','costUsd','costCapUsd']))invalid();
 const targets=new Set(targetIds),cutoff=decision.observedUntilMs,evidence=row.input.evidence,expected=featureKinds[condition];
 if(evidence.length<expected.length||evidence.length>expected.length+99)invalid();
 const counts=new Map(),ids=new Set(),sceneEvidence=[];
 for(const item of evidence){
  const base=['id','kind','sourceFrameId','observedAtMs','processedAtMs','sha256'];
  if(item?.kind==='gaze_crop'){
   if(!object(item,[...base,'sourceSampleId']))invalid();
  } else if(!object(item,base))invalid();
  if(!str(item.id)||!str(item.kind)||!str(item.sourceFrameId)||!finite(item.observedAtMs)||!finite(item.processedAtMs)||item.processedAtMs<item.observedAtMs||item.processedAtMs>cutoff||item.observedAtMs>cutoff||!sha(item.sha256)||ids.has(item.id))invalid();
  ids.add(item.id);counts.set(item.kind,(counts.get(item.kind)||0)+1);
  if(item.kind==='scene'){
   if(item.sourceFrameId!==decision.frameId||item.sha256!==decision.sceneSha256||item.observedAtMs!==decision.sceneObservedAtMs)invalid();sceneEvidence.push(item);
  } else if(['gaze_crop','sam_objects','depth','proactive'].includes(item.kind)){
   if(item.sourceFrameId!==decision.frameId)invalid();
   if(item.kind==='gaze_crop'){
    const source=session.gazeSamples.get(item.sourceSampleId);
    if(!source||source.observedAtMs!==item.observedAtMs||source.processedAtMs>item.processedAtMs||item.sourceSampleId!==row.input.gazeSourceSampleId)invalid();
   }
  } else if(item.kind!=='history')invalid();
 }
 if(sceneEvidence.length!==1||expected.some(kind=>kind==='history'?!(counts.get(kind)>=1):counts.get(kind)!==1)||[...counts.keys()].some(kind=>!expected.includes(kind)))invalid();
 if(condition==='scene_only'){
  if(row.input.gazeSourceSampleId!==null||row.input.gazeTransform!==null)invalid();
 } else if(condition==='gaze_shuffled'){
  const transform=row.input.gazeTransform,source=session.gazeSamples.get(row.input.gazeSourceSampleId);
  if(!object(transform,['method','seed'])||transform.method!=='shuffle'||transform.seed!==runConfig.gazeShuffleSeed||!source||row.input.gazeSourceSampleId===decision.gazeSampleId||source.observedAtMs>cutoff||source.processedAtMs>cutoff)invalid();
 } else if(condition==='gaze_time_shifted'){
  const transform=row.input.gazeTransform,source=session.gazeSamples.get(row.input.gazeSourceSampleId),shift=source?decision.currentGaze.observedAtMs-source.observedAtMs:null;
  if(!object(transform,['method','shiftMs'])||transform.method!=='backward_time_shift'||!source||row.input.gazeSourceSampleId===decision.gazeSampleId||source.observedAtMs>=decision.currentGaze.observedAtMs||source.observedAtMs>cutoff||source.processedAtMs>cutoff||!Number.isInteger(transform.shiftMs)||transform.shiftMs<runConfig.minGazeTimeShiftMs||transform.shiftMs!==shift)invalid();
 } else if(row.input.gazeSourceSampleId!==decision.gazeSampleId||row.input.gazeTransform!==null)invalid();
 if(expected.includes('gaze_crop')&&counts.get('gaze_crop')!==1)invalid();
 if(!expected.includes('gaze_crop')&&counts.get('gaze_crop'))invalid();
 if(!target(row.result.currentObjectId,targets))invalid();
 const next=row.result.nextTarget;
 if(!object(next,['abstained','rankedTargetIds','probabilities'])||typeof next.abstained!=='boolean'||!Array.isArray(next.rankedTargetIds)||next.rankedTargetIds.some(id=>!targets.has(id))||new Set(next.rankedTargetIds).size!==next.rankedTargetIds.length||next.rankedTargetIds.length>targetIds.length||(next.abstained?next.rankedTargetIds.length!==0:next.rankedTargetIds.length===0))invalid();
 if(next.probabilities!==null){
  if(next.abstained||!Array.isArray(next.probabilities)||next.probabilities.length!==targetIds.length||next.probabilities.some(p=>!Number.isFinite(p)||p<0||p>1)||!close(next.probabilities.reduce((sum,p)=>sum+p,0),1))invalid();
  const first=targetIds.indexOf(next.rankedTargetIds[0]);if(next.probabilities[first]+1e-6<Math.max(...next.probabilities))invalid();
 }
 const call=row.call;
 if(!['completed','failed'].includes(call.status)||!(call.errorCode===null||str(call.errorCode,/^[A-Z0-9_]{1,80}$/))||!finite(call.startedAtMs)||!finite(call.completedAtMs)||call.completedAtMs<call.startedAtMs||call.startedAtMs<cutoff||!finite(call.latencyMs)||!close(call.completedAtMs-call.startedAtMs,call.latencyMs)||!['fresh','hit'].includes(call.cacheState)||!(call.cacheSourceDecisionId===null||str(call.cacheSourceDecisionId))||!finite(call.costUsd)||!finite(call.costCapUsd,Number.MIN_VALUE)||call.costCapUsd!==runConfig.perDecisionCostCapUsd||call.costUsd>runConfig.perDecisionCostCapUsd+1e-9)invalid();
 if((call.status==='completed'&&call.errorCode!==null)||(call.status==='failed'&&(!call.errorCode||row.result.currentObjectId!==null||!next.abstained))||(call.cacheState==='fresh'&&call.cacheSourceDecisionId!==null)||(call.cacheState==='hit'&&(call.status!=='completed'||call.cacheSourceDecisionId===null)))invalid();
 return {input:row.input,result:row.result,call};
}

function quantile(values,q){
 if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),position=(sorted.length-1)*q,lo=Math.floor(position),hi=Math.ceil(position);
 return sorted[lo]+(sorted[hi]-sorted[lo])*(position-lo);
}
function mean(values){return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;}
function vectorBrier(probabilities,targetIds,targetId){return probabilities.reduce((sum,p,index)=>sum+(p-(targetIds[index]===targetId?1:0))**2,0);}
function ratio(n,d){return d?n/d:null;}
function latencyStats(rows){const values=rows.map(row=>row.call.latencyMs);return {count:values.length,p50Ms:quantile(values,.5),p95Ms:quantile(values,.95),meanMs:mean(values)};}

function conditionMetrics(sessions,targetIds){
 const output={};
 for(const condition of comparisonConditions){
  const decisions=sessions.flatMap(session=>[...session.decisions.values()]),rows=decisions.map(decision=>({decision,cell:decision.conditions[condition]}));
  const current=rows.filter(({decision})=>decision.currentObjectLabel!==null),currentCovered=current.filter(({cell})=>cell.result.currentObjectId!==null),currentCorrect=current.filter(({decision,cell})=>cell.result.currentObjectId===decision.currentObjectLabel?.targetId);
  const next=rows.filter(({decision})=>decision.nextTargetLabel!==null),answered=next.filter(({cell})=>!cell.result.nextTarget.abstained),top1=answered.filter(({decision,cell})=>cell.result.nextTarget.rankedTargetIds[0]===decision.nextTargetLabel.targetId),top3=answered.filter(({decision,cell})=>cell.result.nextTarget.rankedTargetIds.slice(0,3).includes(decision.nextTargetLabel.targetId));
  const probabilistic=next.filter(({cell})=>cell.result.nextTarget.probabilities!==null),lead=top1.map(({decision,cell})=>decision.nextTargetLabel.observedAtMs-cell.call.completedAtMs);
  const fresh=rows.filter(({cell})=>cell.call.cacheState==='fresh'),hits=rows.filter(({cell})=>cell.call.cacheState==='hit'),costs=rows.map(({cell})=>cell.call.costUsd);
  output[condition]={
   sessions:sessions.length,decisions:rows.length,
   currentObject:{labeled:current.length,covered:currentCovered.length,correct:currentCorrect.length,coverage:ratio(currentCovered.length,current.length),accuracy:ratio(currentCorrect.length,current.length),accuracyWhenCovered:ratio(currentCorrect.length,currentCovered.length)},
   nextTarget:{labeled:next.length,answered:answered.length,coverage:ratio(answered.length,next.length),top1:{correct:top1.length,accuracyAmongAnswered:ratio(top1.length,answered.length),accuracyOverall:ratio(top1.length,next.length)},top3:{correct:top3.length,accuracyAmongAnswered:ratio(top3.length,answered.length),accuracyOverall:ratio(top3.length,next.length)},brier:probabilistic.length?{count:probabilistic.length,mean:mean(probabilistic.map(({decision,cell})=>vectorBrier(cell.result.nextTarget.probabilities,targetIds,decision.nextTargetLabel.targetId)))}:null,leadTimeMs:lead.length?{count:lead.length,mean:mean(lead),p50:quantile(lead,.5),positiveCount:lead.filter(value=>value>0).length,positiveRate:ratio(lead.filter(value=>value>0).length,lead.length)}:{count:0,mean:null,p50:null,positiveCount:0,positiveRate:null}},
   latency:{...latencyStats(rows.map(({cell})=>({call:cell.call}))),byCacheState:{fresh:latencyStats(fresh.map(({cell})=>({call:cell.call}))),hit:latencyStats(hits.map(({cell})=>({call:cell.call})))}},
   cost:{freshCalls:fresh.length,cacheHits:hits.length,totalUsd:costs.reduce((sum,value)=>sum+value,0),meanPerDecisionUsd:mean(costs)}
  };
 }
 return output;
}

function metricValue(decision,condition,metric,targetIds){
 const label=decision.currentObjectLabel,cell=decision.conditions[condition];
 if(metric.startsWith('currentObject')){
  if(label===null)return null;
  return metric==='currentObjectCoverage'?(cell.result.currentObjectId===null?0:1):(cell.result.currentObjectId===label.targetId?1:0);
 }
 const nextLabel=decision.nextTargetLabel;if(nextLabel===null)return null;
 if(metric==='nextTargetCoverage')return cell.result.nextTarget.abstained?0:1;
 if(metric==='nextTargetTop1Accuracy')return !cell.result.nextTarget.abstained&&cell.result.nextTarget.rankedTargetIds[0]===nextLabel.targetId?1:0;
 if(metric==='nextTargetTop3Accuracy')return !cell.result.nextTarget.abstained&&cell.result.nextTarget.rankedTargetIds.slice(0,3).includes(nextLabel.targetId)?1:0;
 if(metric==='nextTargetBrier')return cell.result.nextTarget.probabilities===null?null:vectorBrier(cell.result.nextTarget.probabilities,targetIds,nextLabel.targetId);
 return null;
}

function hashSeed(seed,text){let value=(seed^0x9e3779b9)>>>0;for(const char of text){value^=char.charCodeAt(0);value=Math.imul(value,0x85ebca6b);value^=value>>>13;}return value||0x6d2b79f5;}
function random32(seed){let state=seed>>>0;return ()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};}
function bootstrapCI(values,iterations,seed,label){
 if(values.length<2)return null;
 const random=random32(hashSeed(seed,label)),samples=new Array(iterations);
 for(let b=0;b<iterations;b++){let total=0;for(let i=0;i<values.length;i++)total+=values[Math.floor(random()*values.length)];samples[b]=total/values.length;}
 return [quantile(samples,.025),quantile(samples,.975)];
}

function pairedComparisons(sessions,targetIds,iterations,seed){
 return pairs.map(([candidate,reference])=>{
  const metricReports={};
  for(const metric of pairedMetrics){
   const sessionDeltas=[],candidateMeans=[],referenceMeans=[];let pairedDecisionCount=0;
   for(const session of sessions){const candidateValues=[],referenceValues=[];
    for(const decision of session.decisions.values()){
     const a=metricValue(decision,candidate,metric,targetIds),b=metricValue(decision,reference,metric,targetIds);
     if(a===null||b===null)continue;candidateValues.push(a);referenceValues.push(b);pairedDecisionCount++;
    }
    if(candidateValues.length){const a=mean(candidateValues),b=mean(referenceValues);candidateMeans.push(a);referenceMeans.push(b);sessionDeltas.push(a-b);}
   }
   metricReports[metric]={pairedSessions:sessionDeltas.length,pairedDecisions:pairedDecisionCount,candidateSessionMean:mean(candidateMeans),referenceSessionMean:mean(referenceMeans),meanDelta:mean(sessionDeltas),ci95:bootstrapCI(sessionDeltas,iterations,seed,`${candidate}:${reference}:${metric}`),ciMethod:sessionDeltas.length>=2?'paired session-cluster percentile bootstrap':null};
  }
  const errors={};
  for(const [name,metric] of [['currentObject','currentObjectAccuracy'],['nextTargetTop1','nextTargetTop1Accuracy'],['nextTargetTop3','nextTargetTop3Accuracy']]){
   const table={pairedDecisions:0,bothCorrect:0,candidateOnlyCorrect:0,referenceOnlyCorrect:0,bothWrong:0};
   for(const session of sessions)for(const decision of session.decisions.values()){
    const a=metricValue(decision,candidate,metric,targetIds),b=metricValue(decision,reference,metric,targetIds);if(a===null||b===null)continue;
    table.pairedDecisions++;if(a&&b)table.bothCorrect++;else if(a)table.candidateOnlyCorrect++;else if(b)table.referenceOnlyCorrect++;else table.bothWrong++;
   }
   table.candidateOnlyErrorCount=table.referenceOnlyCorrect;table.referenceOnlyErrorCount=table.candidateOnlyCorrect;errors[name]=table;
  }
  return {candidate,reference,metrics:metricReports,pairedErrors:errors};
 });
}

export function evaluateComparison(data,{seed=2026,bootstrapIterations=2000,sourceSha256=null}={}){
 if(!object(data,['schemaVersion','kind','studyId','targetIds','runConfig','splitManifest','heldoutManifest','sessions'])||data.schemaVersion!==1||data.kind!=='prometheus_ablation_comparison'||!str(data.studyId)||!uniqueStrings(data.targetIds,targetPattern,2,2000)||!object(data.runConfig,['model','cutoffField','perDecisionCostCapUsd','totalCostCapUsd','gazeShuffleSeed','minGazeTimeShiftMs','splitPolicy'])||!object(data.runConfig.model,['provider','modelId','revision','promptSha256','temperature','maxOutputTokens'])||![data.runConfig.model.provider,data.runConfig.model.modelId,data.runConfig.model.revision].every(x=>str(x,modelPattern))||!sha(data.runConfig.model.promptSha256)||!Number.isFinite(data.runConfig.model.temperature)||data.runConfig.model.temperature<0||data.runConfig.model.temperature>2||!Number.isInteger(data.runConfig.model.maxOutputTokens)||data.runConfig.model.maxOutputTokens<1||data.runConfig.model.maxOutputTokens>65536||data.runConfig.cutoffField!=='observedUntilMs'||!finite(data.runConfig.perDecisionCostCapUsd,Number.MIN_VALUE)||!finite(data.runConfig.totalCostCapUsd,Number.MIN_VALUE)||!str(data.runConfig.gazeShuffleSeed)||!Number.isInteger(data.runConfig.minGazeTimeShiftMs)||data.runConfig.minGazeTimeShiftMs<1||!['subject_heldout','personalized_session'].includes(data.runConfig.splitPolicy)||!Number.isInteger(seed)||seed<0||seed>0xffffffff||!Number.isInteger(bootstrapIterations)||bootstrapIterations<200||bootstrapIterations>20000||!(sourceSha256===null||sha(sourceSha256)))invalid();
 const targetIds=data.targetIds,split=validateSplitManifest(data.splitManifest,data.runConfig.splitPolicy),normalized=validateManifestAndSessions(data,split);
 const metrics=conditionMetrics(normalized.sessions,targetIds),comparisons=pairedComparisons(normalized.sessions,targetIds,bootstrapIterations,seed);
 return {schemaVersion:1,kind:'prometheus_ablation_report',source:'offline_scoring_only',sourceSha256,studyId:data.studyId,splitPolicy:data.runConfig.splitPolicy,generalizationScope:data.runConfig.splitPolicy==='subject_heldout'?'subject_held_out':'within_participant_across_disjoint_sessions',model:structuredClone(data.runConfig.model),timeCutoff:data.runConfig.cutoffField,costPolicy:{currency:'USD',perDecisionCapUsd:data.runConfig.perDecisionCostCapUsd,totalCapUsd:data.runConfig.totalCostCapUsd,scoredCostUsd:normalized.costTotal},heldoutSessionCount:normalized.sessions.length,decisionCount:normalized.decisionCount,targetCount:targetIds.length,bootstrap:{method:'paired session-cluster percentile bootstrap',seed,iterations:bootstrapIterations,ciLevel:.95},conditionMetrics:metrics,pairedComparisons:comparisons,t08Status:'not_assessed'};
}
