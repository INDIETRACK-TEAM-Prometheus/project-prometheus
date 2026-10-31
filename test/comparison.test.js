import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {comparisonConditions,evaluateComparison} from '../src/evaluation/comparison.js';

const digest=value=>createHash('sha256').update(value).digest('hex');
const model={provider:'test-provider',modelId:'test-model.1',revision:'test-revision',promptSha256:digest('fixed prompt'),temperature:0,maxOutputTokens:128};

function ranked(first){return [first,...['object-a','object-b','object-c'].filter(id=>id!==first)];}
function probabilities(order){const result={};[.7,.2,.1].forEach((probability,index)=>result[order[index]]=probability);return ['object-a','object-b','object-c'].map(id=>result[id]);}
function makeDataset(sessionCount=3){
 const targetIds=['object-a','object-b','object-c'],runConfig={model,cutoffField:'observedUntilMs',perDecisionCostCapUsd:.05,totalCostCapUsd:1,gazeShuffleSeed:'control-seed-1',minGazeTimeShiftMs:20,splitPolicy:'subject_heldout'};
 const splitManifest=[
  {participantId:'train-p',sessionId:'train-s',sceneId:'train-scene',split:'train',sceneSha256s:[digest('train-scene')]},
  {participantId:'validation-p',sessionId:'validation-s',sceneId:'validation-scene',split:'validation',sceneSha256s:[digest('validation-scene')]}
 ],heldoutManifest=[],sessions=[];
 for(let s=0;s<sessionCount;s++){
  const participantId=`p${s+1}`,sessionId=`s${s+1}`,sceneId=`scene${s+1}`,frameHashes=[digest(`${sessionId}-d1-scene`),digest(`${sessionId}-d2-scene`)];
  splitManifest.push({participantId,sessionId,sceneId,split:'test',sceneSha256s:frameHashes});
  heldoutManifest.push({participantId,sessionId,decisionIds:['d1','d2']});
  const gazeSamples=[{sampleId:'g0',observedAtMs:40,processedAtMs:41},{sampleId:'g1',observedAtMs:80,processedAtMs:81},{sampleId:'g2',observedAtMs:180,processedAtMs:181}];
  const decisions=[];
  for(let d=0;d<2;d++){
   const decisionId=d===0?'d1':'d2',frameId=`${sessionId}-frame-${decisionId}`,sceneSha256=frameHashes[d],sceneObservedAtMs=d===0?70:170,observedUntilMs=d===0?100:200,gazeSampleId=d===0?'g1':'g2',currentGaze=gazeSamples.find(sample=>sample.sampleId===gazeSampleId);
   const currentObjectLabel={targetId:d===0?'object-a':'object-b',observedAtMs:d===0?90:190},nextTargetLabel={targetId:d===0?'object-b':'object-c',observedAtMs:d===0?150:250};
   const conditions={};
   for(const [conditionIndex,condition] of comparisonConditions.entries()){
    let gazeSourceSampleId=null,gazeTransform=null;
    if(condition!=='scene_only')gazeSourceSampleId=gazeSampleId;
    if(condition==='gaze_shuffled'){gazeSourceSampleId=d===0?'g0':'g1';gazeTransform={method:'shuffle',seed:runConfig.gazeShuffleSeed};}
    if(condition==='gaze_time_shifted'){gazeSourceSampleId=d===0?'g0':'g1';gazeTransform={method:'backward_time_shift',shiftMs:currentGaze.observedAtMs-gazeSamples.find(sample=>sample.sampleId===gazeSourceSampleId).observedAtMs};}
    const evidence=[{id:`scene-${decisionId}`,kind:'scene',sourceFrameId:frameId,observedAtMs:sceneObservedAtMs,processedAtMs:sceneObservedAtMs+1,sha256:sceneSha256}];
    if(condition!=='scene_only'){
     const source=gazeSamples.find(sample=>sample.sampleId===gazeSourceSampleId);
     const sharedCrop=['gaze_crop','sam_object_context','depth_context','history_context','proactive_context','depth_history_proactive'].includes(condition);
     evidence.push({id:`gaze-${sharedCrop?'shared':condition}-${decisionId}`,kind:'gaze_crop',sourceFrameId:frameId,sourceSampleId:gazeSourceSampleId,observedAtMs:source.observedAtMs,processedAtMs:source.processedAtMs+1,sha256:digest(`crop-${sessionId}-${decisionId}-${gazeSourceSampleId}`)});
    }
    const withSam=['sam_object_context','depth_context','history_context','proactive_context','depth_history_proactive'].includes(condition);
    if(withSam)evidence.push({id:`sam-${decisionId}`,kind:'sam_objects',sourceFrameId:frameId,observedAtMs:sceneObservedAtMs+1,processedAtMs:sceneObservedAtMs+3,sha256:digest(`sam-${decisionId}`)});
    if(['depth_context','depth_history_proactive'].includes(condition))evidence.push({id:`depth-${decisionId}`,kind:'depth',sourceFrameId:frameId,observedAtMs:sceneObservedAtMs+1,processedAtMs:sceneObservedAtMs+3,sha256:digest(`depth-${decisionId}`)});
    if(['history_context','depth_history_proactive'].includes(condition))evidence.push({id:`history-${decisionId}`,kind:'history',sourceFrameId:`old-${frameId}`,observedAtMs:sceneObservedAtMs-20,processedAtMs:sceneObservedAtMs-10,sha256:digest(`history-${decisionId}`)});
    if(['proactive_context','depth_history_proactive'].includes(condition))evidence.push({id:`proactive-${decisionId}`,kind:'proactive',sourceFrameId:frameId,observedAtMs:sceneObservedAtMs+1,processedAtMs:sceneObservedAtMs+4,sha256:digest(`proactive-${decisionId}`)});
    const first={scene_only:'object-a',gaze_crop:d===0?'object-b':'object-a',sam_object_context:d===0?'object-a':'object-c',depth_context:d===0?'object-b':'object-a',history_context:d===0?'object-c':'object-b',proactive_context:d===0?'object-b':'object-c',depth_history_proactive:(s+d)%2?'object-c':'object-b',gaze_shuffled:'object-a',gaze_time_shifted:'object-c'}[condition];
    let next={abstained:condition==='gaze_shuffled'&&s===1&&d===1,rankedTargetIds:[],probabilities:null};
    if(!next.abstained){const order=ranked(first);next={abstained:false,rankedTargetIds:order,probabilities:probabilities(order)};}
    const result={currentObjectId:{scene_only:'object-a',gaze_crop:d===0?'object-a':'object-b',sam_object_context:'object-b',depth_context:d===0?'object-a':'object-c',history_context:d===0?'object-b':'object-a',proactive_context:d===0?'object-a':'object-b',depth_history_proactive:d===0?'object-a':'object-c',gaze_shuffled:s===0?null:'object-a',gaze_time_shifted:d===0?'object-c':'object-b'}[condition],nextTarget:next};
    let call={status:'completed',errorCode:null,startedAtMs:observedUntilMs+10,completedAtMs:observedUntilMs+20+conditionIndex,latencyMs:10+conditionIndex,cacheState:'fresh',cacheSourceDecisionId:null,costUsd:.003,costCapUsd:runConfig.perDecisionCostCapUsd};
    if(condition==='gaze_crop'&&d===1){
     const sourceDecision=decisions[0];result.currentObjectId=sourceDecision.conditions.gaze_crop.result.currentObjectId;result.nextTarget=structuredClone(sourceDecision.conditions.gaze_crop.result.nextTarget);
     call={...call,startedAtMs:observedUntilMs+1,completedAtMs:observedUntilMs+4,latencyMs:3,cacheState:'hit',cacheSourceDecisionId:'d1',costUsd:0};
    }
    conditions[condition]={model:{...model},input:{cutoffMs:observedUntilMs,evidence,gazeSourceSampleId,gazeTransform},result,call};
   }
   decisions.push({decisionId,sceneId,frameId,sceneSha256,sceneObservedAtMs,observedUntilMs,gazeSampleId,currentObjectLabel,nextTargetLabel,conditions});
  }
  sessions.push({participantId,sessionId,gazeSamples,decisions});
 }
 return {schemaVersion:1,kind:'prometheus_ablation_comparison',studyId:'unit-test-study',targetIds,runConfig,splitManifest,heldoutManifest,sessions};
}

function mutate(dataset,fn){const copy=structuredClone(dataset);fn(copy);return copy;}

test('scores paired conditions, proper multiclass probabilities, latency, lead time and cache cost',()=>{
 const dataset=makeDataset(),report=evaluateComparison(dataset,{seed:17,bootstrapIterations:300,sourceSha256:digest('input')});
 assert.equal(report.source,'offline_scoring_only');assert.equal(report.heldoutSessionCount,3);assert.equal(report.decisionCount,6);assert.equal(report.splitPolicy,'subject_heldout');assert.equal(report.generalizationScope,'subject_held_out');assert.equal(report.t08Status,'not_assessed');
 assert.deepEqual(Object.keys(report.conditionMetrics),comparisonConditions);
 const gaze=report.conditionMetrics.gaze_crop;assert.equal(gaze.currentObject.accuracy,.5);assert.equal(gaze.nextTarget.coverage,1);assert.equal(gaze.latency.byCacheState.fresh.p50Ms,11);assert.equal(gaze.latency.byCacheState.fresh.p95Ms,11);assert.equal(gaze.latency.byCacheState.hit.count,3);assert.equal(gaze.latency.byCacheState.hit.p50Ms,3);assert.equal(gaze.latency.byCacheState.hit.p95Ms,3);assert.equal(gaze.cost.cacheHits,3);
 assert.equal(report.conditionMetrics.scene_only.currentObject.accuracy,.5);assert.equal(report.conditionMetrics.gaze_shuffled.currentObject.coverage,2/3);
 const lead=report.conditionMetrics.gaze_crop.nextTarget.leadTimeMs;assert.equal(lead.count,3);assert.equal(lead.positiveCount,3);
 const expectedBrier=(.14+1.34)/2;assert.ok(Math.abs(report.conditionMetrics.gaze_crop.nextTarget.brier.mean-expectedBrier)<1e-12);
 const paired=report.pairedComparisons.find(row=>row.candidate==='gaze_crop'&&row.reference==='scene_only');assert.equal(paired.metrics.nextTargetTop1Accuracy.pairedSessions,3);assert.equal(paired.metrics.nextTargetTop1Accuracy.pairedDecisions,6);assert.ok(Array.isArray(paired.metrics.nextTargetTop1Accuracy.ci95));assert.equal(paired.pairedErrors.nextTargetTop1.pairedDecisions,6);
 assert.deepEqual(evaluateComparison(dataset,{seed:17,bootstrapIterations:300}).pairedComparisons,report.pairedComparisons);
});

test('requires exact held-out sessions and condition/model/cutoff/cost pairing',()=>{
 const base=makeDataset();
 const missing=mutate(base,data=>delete data.sessions[0].decisions[0].conditions.scene_only);
 const omitted=mutate(base,data=>data.sessions.pop());
 const wrongCutoff=mutate(base,data=>{data.sessions[0].decisions[0].conditions.scene_only.input.cutoffMs++;});
 const wrongModel=mutate(base,data=>{data.sessions[0].decisions[0].conditions.scene_only.model.modelId='another-model';});
 const wrongCap=mutate(base,data=>{data.sessions[0].decisions[0].conditions.scene_only.call.costCapUsd=.01;});
 const changedSharedGaze=mutate(base,data=>{data.sessions[0].decisions[0].conditions.sam_object_context.input.evidence.find(item=>item.kind==='gaze_crop').sha256=digest('different crop');});
 const crossSplitParticipant=mutate(base,data=>data.splitManifest.push({participantId:'p1',sessionId:'training-session',sceneId:'training-scene',split:'train',sceneSha256s:[digest('training-frame')]}));
 for(const value of [missing,omitted,wrongCutoff,wrongModel,wrongCap,changedSharedGaze,crossSplitParticipant])assert.throws(()=>evaluateComparison(value),/invalid comparison dataset/);
});

test('rejects future evidence, future gaze controls and target-bearing model inputs',()=>{
 const base=makeDataset();
 const futureEvidence=mutate(base,data=>{data.sessions[0].decisions[0].conditions.scene_only.input.evidence[0].processedAtMs=101;});
 const futureShuffle=mutate(base,data=>{const row=data.sessions[0].decisions[0].conditions.gaze_shuffled;row.input.gazeSourceSampleId='g2';row.input.evidence.find(item=>item.kind==='gaze_crop').sourceSampleId='g2';row.input.evidence.find(item=>item.kind==='gaze_crop').observedAtMs=180;row.input.evidence.find(item=>item.kind==='gaze_crop').processedAtMs=181;});
 const futureTarget=mutate(base,data=>{data.sessions[0].decisions[0].nextTargetLabel.observedAtMs=100;});
 const answerLeak=mutate(base,data=>{data.sessions[0].decisions[0].conditions.scene_only.input.evidence[0].targetId='object-b';});
 for(const value of [futureEvidence,futureShuffle,futureTarget,answerLeak])assert.throws(()=>evaluateComparison(value),/invalid comparison dataset/);
});

test('requires full-distribution probabilities and validates cache provenance',()=>{
 const base=makeDataset();
 const partialProbabilities=mutate(base,data=>{data.sessions[0].decisions[0].conditions.scene_only.result.nextTarget.probabilities=[.7,.3];});
 const fakeCache=mutate(base,data=>{data.sessions[0].decisions[1].conditions.gaze_crop.call.cacheSourceDecisionId='d2';});
 const mismatchedCacheOutput=mutate(base,data=>{data.sessions[0].decisions[1].conditions.gaze_crop.result.nextTarget.rankedTargetIds=['object-c','object-a','object-b'];});
 for(const value of [partialProbabilities,fakeCache,mismatchedCacheOutput])assert.throws(()=>evaluateComparison(value),/invalid comparison dataset/);
});

test('does not fabricate a confidence interval when fewer than two held-out sessions exist',()=>{
 const report=evaluateComparison(makeDataset(1),{bootstrapIterations:200});
 const comparison=report.pairedComparisons.find(row=>row.candidate==='gaze_crop'&&row.reference==='scene_only');
 assert.equal(comparison.metrics.nextTargetTop1Accuracy.meanDelta,.5);assert.equal(comparison.metrics.nextTargetTop1Accuracy.ci95,null);assert.equal(comparison.metrics.nextTargetTop1Accuracy.ciMethod,null);
});

test('supports explicitly personalized splits while retaining session and scene separation',()=>{
 const dataset=mutate(makeDataset(1),data=>{
  data.runConfig.splitPolicy='personalized_session';
  data.splitManifest[0].participantId='p1';data.splitManifest[1].participantId='p1';
 });
 const report=evaluateComparison(dataset,{bootstrapIterations:200});
 assert.equal(report.splitPolicy,'personalized_session');assert.equal(report.generalizationScope,'within_participant_across_disjoint_sessions');
 const overlappingSession=mutate(dataset,data=>{data.splitManifest[0].sessionId=data.splitManifest.find(row=>row.split==='test').sessionId;});
 assert.throws(()=>evaluateComparison(overlappingSession),/invalid comparison dataset/);
});

test('CLI reads local inputs only, hashes exact bytes and does not overwrite reports',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'prometheus-comparison-'));
 try {
  const input=join(directory,'heldout.json'),output=join(directory,'report.json'),bytes=Buffer.from(JSON.stringify(makeDataset()));await writeFile(input,bytes);
  const cli=fileURLToPath(new URL('../scripts/evaluate-comparison.mjs',import.meta.url));
  const first=spawnSync(process.execPath,[cli,'--input',input,'--output',output,'--seed','3','--bootstrap-iterations','200'],{encoding:'utf8'});
  assert.equal(first.status,0,first.stderr);const report=JSON.parse(await readFile(output,'utf8'));assert.equal(report.sourceSha256,digest(bytes));
  const second=spawnSync(process.execPath,[cli,'--input',input,'--output',output],{encoding:'utf8'});assert.notEqual(second.status,0);
 } finally {await rm(directory,{recursive:true,force:true});}
});
