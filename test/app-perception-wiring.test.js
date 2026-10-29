import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoordinator,createAlignedHandoff,mapSessionEvidence,resolveWorldFrame} from '../src/app.js';
import {MemoryService} from '../src/memory/index.js';
import {RuntimeFacade} from '../src/runtime/facade.js';

test('actual attention handoff enforces consent and alignment and uses final frozen frame',async()=>{
 let allowed=false,calls=[];const pipeline={submit:input=>{calls.push(input);return {accepted:true};}};
 const handoff=createAlignedHandoff({isAllowed:()=>allowed,getPipeline:()=>pipeline,encode:()=> 'data:image/png;base64,iVBORw0KGgo=',now:()=>200});
 const memory=await MemoryService.open({sessionId:'bridge',now:0}),runtime=new RuntimeFacade({sessionId:'bridge',now:()=>200});
 const app=createCoordinator({controller:{start:async()=>({}),stop(){}},memory,runtime,onAligned:handoff});await app.start();
 const frame=t=>({frameId:`f${t}`,renderTsMs:t-4,presentTsEstimateMs:t-2,displayUncertaintyMs:1,viewport:{width:1,height:1},evidence:{id:`f${t}`,observedAt:t-4,bytes:4,rgba:Uint8Array.from([1,2,3,4])}});
 const sample=t=>({valid:true,viewportXY:{x:.5,y:.5},timestampMs:t,processedMs:t,syncUncertaintyMs:1,sceneAssociationEligible:true,timestampKind:'browser_capture_estimate'});
 for(const t of [10,90])await app.acceptSample(sample(t),frame(t));await app.acceptSample({valid:false,processedMs:100},null);assert.equal(calls.length,0);
 allowed=true;for(const t of [110,190])await app.acceptSample(sample(t),frame(t));await app.acceptSample({valid:false,processedMs:200},null);
 assert.equal(calls.length,1);assert.equal(calls[0].frame.frameId,'f190');assert.equal(calls[0].frame.observedAt,186);assert.equal(calls[0].gaze.observedAt,190);assert.equal(calls[0].event.endAt,190);
 await app.acceptSample({...sample(210),syncUncertaintyMs:null},frame(210));await app.acceptSample({valid:false,processedMs:220},null);assert.equal(calls.length,1);
 app.pause();assert.equal((await app.acceptSample(sample(230),frame(230))).reason,'paused');app.resume();await app.stop();await memory.close();
});

test('completed coordinator event reaches perception, memory and reasoner boundary with aligned frame',async()=>{
 const {PerceptionPipeline}=await import('../src/runtime/perception.js');
 let captured,segmented=0;const memory=await MemoryService.open({sessionId:'bridge-live',clock:()=>220});
 const local=new RuntimeFacade({sessionId:'local',now:()=>220});
 const pipeline=new PerceptionPipeline({memory,runtime:{submit:input=>{captured=input;return {accepted:true};}},now:()=>220,segment:async()=>{segmented++;return {masks:[]};}});pipeline.start('remote');
 const handoff=createAlignedHandoff({isAllowed:()=>true,getPipeline:()=>pipeline,encode:()=> 'data:image/png;base64,iVBORw0KGgo=',now:()=>220});
 const app=createCoordinator({controller:{start:async()=>({}),stop(){}},memory,runtime:local,onAligned:handoff});await app.start();
 const frame=t=>({frameId:`f${t}`,renderTsMs:t-4,presentTsEstimateMs:t-2,displayUncertaintyMs:1,viewport:{width:1,height:1},evidence:{id:`f${t}`,observedAt:t-4,bytes:4,rgba:Uint8Array.from([1,2,3,4])}});
 const sample=t=>({valid:true,viewportXY:{x:.5,y:.5},timestampMs:t,processedMs:t,syncUncertaintyMs:1,sceneAssociationEligible:true,timestampKind:'browser_capture_estimate'});
 await app.acceptSample(sample(10),frame(10));await app.acceptSample(sample(90),frame(90));await app.acceptSample({valid:false,processedMs:100},null);
 await pipeline.current;assert.equal(segmented,1);assert.equal(captured.frame.frameId,'f90');assert.equal(captured.frame.observedAt,86);assert.equal(captured.gaze.observedAt,90);assert.equal(captured.observedUntil,90);assert.equal(captured.events[0].endAt,90);
 await pipeline.stop();await app.stop();await memory.close();
});

test('handoff preserves render and presentation times without double-counting',()=>{
 let result;const pipeline={submit:value=>{result=value;return {accepted:true};}};
 const handoff=createAlignedHandoff({isAllowed:()=>true,getPipeline:()=>pipeline,encode:()=> 'data:image/png;base64,iVBORw0KGgo=',now:()=>121});
 const frame={frameId:'f',renderTsMs:100,presentTsEstimateMs:116,displayUncertaintyMs:2,viewport:{width:1,height:1},evidence:{id:'f',rgba:Uint8Array.from([1,2,3,4])}};
 const gaze={valid:true,viewportXY:{x:.5,y:.5},timestampMs:120,processedMs:120,syncUncertaintyMs:2,sceneAssociationEligible:true,timestampKind:'browser_capture_estimate'};
 assert.equal(handoff({frame,gaze,event:null}).accepted,true);
 assert.equal(result.frame.observedAt,100);assert.equal(result.frame.presentTsEstimateMs,116);assert.equal(result.frame.syncUncertaintyMs,2);
 assert.equal(result.gaze.observedAt-result.frame.presentTsEstimateMs+result.frame.syncUncertaintyMs+result.gaze.syncUncertaintyMs,8);
 assert.equal(handoff({frame:{...frame,displayUncertaintyMs:100},gaze,event:null}).accepted,false);
});

test('attention start pin survives ring eviction, respects pin age, and pause releases it',async()=>{
 let now=10;const memory=await MemoryService.open({sessionId:'pin-lifecycle',clock:()=>now,ringOptions:{maxAgeMs:100,maxBytes:100,maxPins:5,maxPinnedBytes:100,pinAgeMs:500}});const runtime=new RuntimeFacade({sessionId:'pins',now:()=>now});const app=createCoordinator({controller:{start:async()=>({}),stop(){}},memory,runtime});await app.start();
 const frame=t=>({frameId:`f${t}`,renderTsMs:t-4,presentTsEstimateMs:t-2,displayUncertaintyMs:1,viewport:{width:1,height:1},evidence:{id:`f${t}`,observedAt:t-4,bytes:4,rgba:Uint8Array.from([1,2,3,4])}});const sample=t=>({valid:true,viewportXY:{x:.5,y:.5},timestampMs:t,processedMs:t,syncUncertaintyMs:1,sceneAssociationEligible:true,timestampKind:'browser_capture_estimate'});
 for(const t of [10,90,170,250]){now=t;await app.acceptSample(sample(t),frame(t));}await memory.advanceTime(now);assert.equal(memory.ring.ring.has('attention-raw-f10'),false);now=260;const result=await app.acceptSample({valid:false,processedMs:now},null);assert.equal(result.pin,'pinned');assert.equal(memory.ring.get('attention-1').pinnedAt,10);
 for(const t of [300,380,460,540,620,700,780,860]){now=t;await app.acceptSample(sample(t),frame(t));}now=870;const expired=await app.acceptSample({valid:false,processedMs:now},null);assert.equal(expired.pin,'evidence_evicted');assert.equal(expired.reason,'pin_age_limit');
 now=900;await app.acceptSample(sample(now),frame(now));assert.ok(memory.ring.get('attention-3'));app.pause();await app.stop();assert.equal(memory.ring.get('attention-3'),null);await memory.close();
});
test('injected advancing clock permits subsequent attention history',async()=>{
 let now=10;const memory=await MemoryService.open({sessionId:'clock-advances',clock:()=>now});await memory.ingestFrame({id:'f',observedAt:5,bytes:1},now);now=20;await memory.ingestEvent({eventId:'e',type:'fixated',causalStatus:'online_causal',observedAt:5,endAt:10,processedAt:20,dwellValidMs:5},['f'],now);assert.equal((await memory.attentionHistory({observedUntil:10,processedUntil:20})).length,1);await memory.close();
});

test('reloaded page evidence uses one session offset and fresh epoch',()=>{
 const sample={timestampMs:20,processedMs:21},frame={frameId:'f',renderTsMs:10,presentTsEstimateMs:15,evidence:{id:'f',observedAt:10}};const a=mapSessionEvidence(sample,frame,1000,'epoch-a-',null),b=mapSessionEvidence(sample,frame,2000,'epoch-b-',null);assert.equal(a.frame.frameId,'epoch-a-f');assert.equal(b.frame.frameId,'epoch-b-f');assert.equal(b.frame.renderTsMs,2010);assert.equal(b.frame.presentTsEstimateMs,2015);assert.equal(b.sample.timestampMs,2020);assert.equal(b.sample.processedMs,2021);assert.equal(frame.renderTsMs,10);
});

test('world frame resolution preserves exact fractional render time across offset',()=>{
 const original={frameId:'f',renderTsMs:0.1};const world={getHistoricalFrame:id=>id==='f'?original:null};const offset=1000000000.2;const mapped={frameId:'e-f',observedAt:original.renderTsMs+offset};assert.notEqual(mapped.observedAt-offset,original.renderTsMs);assert.equal(resolveWorldFrame(world,mapped,offset,'e-'),original);assert.equal(resolveWorldFrame(world,{...mapped,observedAt:mapped.observedAt+1},offset,'e-'),null);
});
