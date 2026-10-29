import test from 'node:test';
import assert from 'node:assert/strict';
import {EvaluationLedger,projectProfile} from '../src/evaluation/ledger.js';
const make=()=>({frame:{frameId:'f',observedAt:100,processedAt:121,imageData:'data:image/png;base64,iVBORw0KGgo=',sceneText:null,causalStatus:'online_causal',provenanceKind:'synthetic'},gaze:{x:.5,y:.5,observedAt:120,processedAt:121},events:[{eventId:'e',type:'fixated',observedAt:110,endAt:120,processedAt:121,dwellValidMs:10,x:.5,y:.5,candidateObjectIds:[]}],context:{memory:[{evidenceId:'m',text:'previous observation',observedAt:90,processedAt:110,causalStatus:'online_causal'}]},dependencies:{mapId:'map',mapVersion:1,objectIds:[],evidenceIds:['f','e','m'],expiresAt:1000},observedUntil:120});
const align={presentTsEstimateMs:116,frameSyncUncertaintyMs:2,gazeSyncUncertaintyMs:2,alignmentBudgetMs:50};
test('records immutable same-cutoff projections, with no fabricated gaze in scene-only',()=>{
 const ledger=new EvaluationLedger(),input=make();assert.equal(ledger.record(input,align,{issuedAt:130}).stored,true);input.gaze.x=.9;
 const entry=ledger.export().decisions[0];assert.equal(entry.input.gaze.x,.5);assert.equal(entry.decisionStatus,'accepted_not_issued');
 const profiles=['scene_only','current_gaze','full_history','spatial_memory'].map(p=>projectProfile(entry,p));
 assert.ok(profiles.every(p=>p.observedUntil===120&&p.horizonMs===1000&&p.frame.frameId==='f'&&p.replayStatus==='not_executed'));
 assert.equal('gaze' in profiles[0],false);assert.equal('events' in profiles[1],false);assert.equal('events' in profiles[2],true);assert.equal('memory' in profiles[2],false);assert.equal('memory' in profiles[3],true);
});
test('rejects future, ground truth, eye data and unverified timing',()=>{
 for(const change of [x=>x.events[0].endAt=121,x=>x.frame.groundTruth='x',x=>x.gaze.eyeImage='x',x=>x.context.memory[0].observedAt=121,x=>x.scenarioGoal='x']){const input=make();change(input);assert.throws(()=>new EvaluationLedger().record(input,align,{issuedAt:130}));}
 assert.throws(()=>new EvaluationLedger().record(make(),{...align,gazeSyncUncertaintyMs:null},{issuedAt:130}));
});
test('bounds, eviction, oversized entry and deletion are explicit',()=>{
 const ledger=new EvaluationLedger({maxBytes:100000,maxDecisions:1});ledger.record(make(),align,{issuedAt:130});const next=make();next.frame.frameId='f2';ledger.record(next,align,{issuedAt:130});assert.equal(ledger.export().evictions.lastReason,'capacity_eviction');
 const small=new EvaluationLedger({maxBytes:10});assert.equal(small.record(make(),align,{issuedAt:130}).reason,'entry_exceeds_byte_limit');ledger.clear();assert.equal(ledger.export().decisions.length,0);
});

test('app trace only records matching consented frames and clears them on deletion',async()=>{
 const {createResearchTrace}=await import('../src/app.js');let enabled=false;const ledger=new EvaluationLedger();const trace=createResearchTrace({isEnabled:()=>enabled,ledger});const input=make(),proof={renderAt:100,presentAt:116,gazeAt:120,frameUncertaintyMs:2,gazeUncertaintyMs:2,budgetMs:50,issuedAt:130};const frame={frameId:'f',observedAt:100,imageData:input.frame.imageData};delete input.frame.imageData;
 trace.rememberFrame(frame);assert.equal(trace.decision(input,proof).reason,'consent_required');enabled=true;assert.equal(trace.decision(input,proof).reason,'scene_image_unavailable');
 trace.rememberFrame(frame);assert.equal(trace.decision(input,{...proof,gazeUncertaintyMs:null}).stored,false);trace.rememberFrame(frame);assert.equal(trace.decision(input,proof).stored,true);assert.equal(ledger.export().decisions[0].input.frame.imageData,frame.imageData);
 assert.equal(trace.outcome('f',[{scenario_id:'s',possible_next_action:'look',horizon_ms:1000,grounding_refs:['f'],assumptions:[],status:'active'}]),true);assert.equal(ledger.export().decisions[0].outcome.source,'runtime_published_result');trace.rememberFrame(frame);trace.clear();assert.equal(ledger.export().decisions.length,0);assert.equal(trace.decision(input,proof).reason,'scene_image_unavailable');
});

test('rejects malformed events and ungrounded or duplicate outcomes',()=>{
 for(const change of [x=>x.dependencies.mapVersion=-1,x=>x.events[0].type='unknown',x=>x.events[0].endAt=109,x=>x.events[0].dwellValidMs=11]){const input=make();change(input);assert.throws(()=>new EvaluationLedger().record(input,align,{issuedAt:130}));}
 const ledger=new EvaluationLedger();ledger.record(make(),align,{issuedAt:130});const scenario={scenario_id:'s',possible_next_action:'look',horizon_ms:1000,grounding_refs:['f'],assumptions:[],status:'active'};
 assert.equal(ledger.recordOutcome('f',[{...scenario,grounding_refs:['unknown']}]),false);assert.equal(ledger.recordOutcome('f',[{...scenario,grounding_refs:[]}]),false);assert.equal(ledger.recordOutcome('f',[scenario,scenario]),false);assert.equal(ledger.recordOutcome('f',[]),true);
});
test('projects the same captured bundle at the three evaluation horizons without replay',()=>{
 const ledger=new EvaluationLedger();ledger.record(make(),align,{issuedAt:130});const entry=ledger.export().decisions[0];for(const horizonMs of [1000,3000,5000]){const p=projectProfile(entry,'spatial_memory',{horizonMs});assert.equal(p.horizonMs,horizonMs);assert.equal(p.observedUntil,120);assert.equal(p.replayStatus,'not_executed');}assert.throws(()=>projectProfile(entry,'scene_only',{horizonMs:2000}));
});

test('withdrawn evidence removes research decisions and their outcomes',()=>{
 const ledger=new EvaluationLedger();ledger.record(make(),align,{issuedAt:130});assert.equal(ledger.entries.length,1);
 ledger.withdrawEvidence(['f']);assert.equal(ledger.export().decisions.length,0);assert.equal(ledger.bytes,0);
});


test('published next gaze is stored only within the recorded candidate space',()=>{
 const ledger=new EvaluationLedger(),input=make();input.dependencies.objectIds=['p1:0:object-1'];input.candidates=[{objectId:'p1:0:object-1',bounds:{left:0,top:0,right:2,bottom:2}}];ledger.record(input,align,{issuedAt:130});
 assert.equal(ledger.recordOutcome('f',[],null,{rankedTargetIds:['fabricated']}),false);
 assert.equal(ledger.recordOutcome('f',[],null,{rankedTargetIds:['p1:0:object-1','outside_view']}),true);
 assert.deepEqual(ledger.export().decisions[0].outcome.nextGaze.rankedTargetIds,['p1:0:object-1','outside_view']);
});
