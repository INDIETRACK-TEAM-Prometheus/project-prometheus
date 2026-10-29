import test from 'node:test';
import assert from 'node:assert/strict';
import {EvaluationLedger} from '../src/evaluation/ledger.js';
import {runEvaluation} from '../src/evaluation/runner.js';
const make=()=>({frame:{frameId:'f',observedAt:100,processedAt:121,imageData:'data:image/png;base64,iVBORw0KGgo=',sceneText:null,causalStatus:'online_causal',provenanceKind:'synthetic'},gaze:{x:.5,y:.5,observedAt:120,processedAt:121},events:[{eventId:'e',type:'fixated',observedAt:110,endAt:120,processedAt:121,dwellValidMs:10,x:.5,y:.5}],context:{memory:[{evidenceId:'m',text:'previous observation',observedAt:90,processedAt:110,causalStatus:'online_causal'}]},dependencies:{mapId:'map',mapVersion:1,objectIds:[],evidenceIds:['f','e','m'],expiresAt:1000},observedUntil:120});
const align={presentTsEstimateMs:116,frameSyncUncertaintyMs:2,gazeSyncUncertaintyMs:2,alignmentBudgetMs:50};
function group(){const ledger=new EvaluationLedger();ledger.record(make(),align,{issuedAt:130});return {participantId:'p1',sceneId:'s1',split:'test',trace:ledger.export()};}
test('dry run makes twelve cells and fixture sees only each profile and horizon',async()=>{
 const g=group();g.trace.decisions[0].heldOutLabel={future:'secret',scenarioGoal:'secret'};const requests=[];
 const dry=await runEvaluation({groups:[g]});assert.equal(dry.calls,0);assert.equal(dry.cells.length,12);
 const report=await runEvaluation({groups:[g],execute:true,externalTransfer:true,maxCalls:12,estimatedBudgetUsd:.6,reasoner:async request=>{requests.push(request);return {scenarios:[]};}});
 assert.equal(report.source,'fixture');assert.equal(report.completeness.completed,12);assert.equal(report.t08Status,'not_assessed');
 for(let i=0;i<12;i++){const request=requests[i],profile=report.cells[i].profile;assert.equal(request.horizonMs,report.cells[i].horizonMs);assert.equal(JSON.stringify(request).includes('secret'),false);const scene=JSON.parse(request.evidence[0].text);assert.equal('gaze' in scene,profile!=='scene_only');assert.equal(request.evidence.some(e=>e.kind==='gaze'),['full_history','spatial_memory'].includes(profile));assert.equal(request.evidence.some(e=>e.kind==='memory'),profile==='spatial_memory');}
});
test('limits halt before calls and preserve failed cells',async()=>{
 let calls=0;const report=await runEvaluation({groups:[group()],execute:true,externalTransfer:true,maxCalls:10,estimatedBudgetUsd:.1,reasoner:async()=>{calls++;throw Error('private');}});
 assert.equal(calls,2);assert.equal(report.cells.filter(c=>c.status==='failed').length,2);assert.equal(report.cells.filter(c=>c.status==='limit_reached').length,10);assert.equal(JSON.stringify(report).includes('private'),false);
 await assert.rejects(runEvaluation({groups:[group()],execute:true,maxCalls:1,estimatedBudgetUsd:1,reasoner:async()=>({scenarios:[]})}));
});
test('preflights all inputs and split conflicts before any call',async()=>{
 let calls=0;const options={execute:true,externalTransfer:true,maxCalls:12,estimatedBudgetUsd:1,reasoner:async()=>{calls++;return {scenarios:[]};}};const bad=group();bad.trace.decisions[0].alignment.gazeSyncUncertaintyMs=null;await assert.rejects(runEvaluation({...options,groups:[group(),bad]}));const a=group(),b=group();b.split='train';await assert.rejects(runEvaluation({...options,groups:[a,b]}));assert.equal(calls,0);
});
test('wrong response horizon is a failed cell',async()=>{const report=await runEvaluation({groups:[group()],execute:true,externalTransfer:true,maxCalls:1,estimatedBudgetUsd:1,reasoner:async()=>({scenarios:[{horizon_ms:3000}]})});assert.equal(report.cells[0].status,'failed');});

test('participant and scene identities cannot cross splits even with different images',async()=>{
 for(const shared of ['participantId','sceneId']){const a=group(),b=group();b.split='train';b.participantId='p2';b.sceneId='s2';b[shared]=a[shared];b.trace.decisions[0].input.frame.imageData='data:image/png;base64,iVBORw0KGgoAAA==';let calls=0;await assert.rejects(runEvaluation({groups:[a,b],execute:true,externalTransfer:true,maxCalls:12,estimatedBudgetUsd:1,reasoner:async()=>{calls++;return {scenarios:[]};}}),/crosses splits/);assert.equal(calls,0);}
});

test('scores separately supplied test targets and ranked predictions without exposing labels',async()=>{
 const comparisons=[{decision:0,profile:'scene_only',horizonMs:1000,targetId:'b',abstained:false,rankedTargetIds:['a','b','c'],probabilities:[.6,.3,.1]},{decision:0,profile:'current_gaze',horizonMs:1000,targetId:'b',abstained:true,rankedTargetIds:[]}];
 const requests=[];const report=await runEvaluation({groups:[group()],comparisons,execute:true,externalTransfer:true,maxCalls:1,estimatedBudgetUsd:1,reasoner:async r=>{requests.push(r);return {scenarios:[]};}});
 const score=report.nextGazeMetrics.find(m=>m.profile==='scene_only'&&m.horizonMs===1000);assert.equal(score.top1,0);assert.equal(score.top3,1);assert.equal(score.coverage,1);assert.ok(Math.abs(score.uncertainty.meanBrierScore-.86)<1e-10);
 const abstained=report.nextGazeMetrics.find(m=>m.profile==='current_gaze'&&m.horizonMs===1000);assert.equal(abstained.coverage,0);assert.equal(abstained.top1,null);assert.equal(abstained.uncertainty,null);assert.equal(JSON.stringify(requests).includes('targetId'),false);assert.equal(report.t08Status,'not_assessed');
});
test('rejects invalid or non-test comparisons before calls',async()=>{
 const base={decision:0,profile:'scene_only',horizonMs:1000,targetId:'a',abstained:false,rankedTargetIds:['a'],probabilities:[1]};
 for(const c of [{...base,rankedTargetIds:['a','a']},{...base,probabilities:[.5]},{...base,abstained:true}])await assert.rejects(runEvaluation({groups:[group()],comparisons:[c]}),/invalid comparison/);
 const g=group();g.split='train';await assert.rejects(runEvaluation({groups:[g],comparisons:[base]}),/invalid comparison/);
});


test('replay carries candidates but never held-out labels and validates output',async()=>{
 const g=group(), entry=g.trace.decisions[0]; entry.input.dependencies.objectIds=['p1:0:object-1'];entry.input.candidates=[{objectId:'p1:0:object-1',bounds:{left:0,top:0,right:2,bottom:2}}];entry.heldOutLabel={secret:'future'};
 const requests=[];const report=await runEvaluation({groups:[g],execute:true,externalTransfer:true,maxCalls:2,estimatedBudgetUsd:1,reasoner:async request=>{requests.push(request);return {scenarios:[],nextGaze:{rankedTargetIds:['p1:0:object-1']}};}});
 assert.equal(report.cells[0].nextGaze.rankedTargetIds[0],'p1:0:object-1');assert.equal(requests.length,2);assert.ok(requests.every(r=>r.candidates.length===1 && !JSON.stringify(r).includes('future')));
 const bad=await runEvaluation({groups:[g],execute:true,externalTransfer:true,maxCalls:1,estimatedBudgetUsd:1,reasoner:async()=>({scenarios:[],nextGaze:{rankedTargetIds:['fabricated']}})});assert.equal(bad.cells[0].status,'failed');
});
