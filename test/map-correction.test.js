import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryService,EphemeralStorage} from '../src/memory/index.js';
import {PerceptionPipeline} from '../src/runtime/perception.js';
const mask={sourceWidth:2,sourceHeight:2,width:2,height:2,bounds:{left:0,top:0,right:2,bottom:2},raster:[1,1,1,1]};
const input=(id,t,version)=>({frame:{frameId:id,observedAt:t,processedAt:t+1,causalStatus:'online_causal',provenanceKind:'synthetic',mapId:'m',mapVersion:version,coordinateFrameId:'world',width:2,height:2,rgba:new Uint8Array(16),imageData:'data:image/png;base64,AA==',syncUncertaintyMs:0,depth:{frameId:id,observedAt:t,processedAt:t+1,causalStatus:'online_causal',width:2,height:2,values:[2,2,2,2],intrinsics:{fx:1,fy:1,cx:0,cy:0},cameraToWorld:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],units:'m',convention:'axial_z',depthSource:'engine_geometry',provenance:'fixture'}},gaze:{frameId:id,observedAt:t+2,processedAt:t+3,causalStatus:'online_causal',x:0.25,y:0.25,syncUncertaintyMs:0}});
test('perception persists supplied correction atomically and retrieval preserves source',async()=>{
 let now=20;const storage=new EphemeralStorage(),memory=await MemoryService.open({sessionId:'maps',storage,clock:()=>now});const output=[],invalidations=[];
 const p=new PerceptionPipeline({segment:async()=>({masks:[mask]}),memory,runtime:{submit:x=>(output.push(x),{accepted:true}),invalidate:x=>invalidations.push(x)},now:()=>now});p.start('maps');p.submit(input('a',10,1));await p.current;
 const objectId=output[0].dependencies.objectIds[0],targetMap={mapId:'m',mapVersion:2,coordinateFrameId:'world'};
 assert.equal((await memory.retrieve({objectId,targetMap})).position.reason,'map_transform_unavailable');
 const next=input('b',30,2);next.mapCorrection={id:'correction',from:{mapId:'m',mapVersion:1,coordinateFrameId:'world'},to:targetMap,matrix:[1,0,0,10,0,1,0,0,0,0,1,0,0,0,0,1],provenance:'synthetic-transform',causalStatus:'online_causal',uncertainty:{translationM:0.1,rotationRad:0.01},observedAt:30,processedAt:34};now=40;p.submit(next);await p.current;
 assert.equal((await memory.retrieve({objectId,targetMap,observedUntil:33})).position.reason,'map_transform_unavailable');
 const result=await memory.retrieve({objectId,targetMap});assert.equal(result.position.status,'ok');assert.equal(result.position.points.gazeHitPointWorld[0],result.lastSeen.gazeHitPointWorld[0]+10);assert.equal(result.lastSeen.mapVersion,1);assert.equal(result.position.points.objectAnchorWorld,undefined);assert.ok(invalidations.some(x=>x.type==='map'));
 const saved=await storage.load('maps');assert.ok(saved.state.memory.events.some(([id,e])=>id==='correction' && e.type==='map_correction'));
 assert.deepEqual(result.position.correction.evidenceIds,['b']);
 await memory.deleteEvidence('b');assert.equal((await memory.retrieve({objectId,targetMap})).position.reason,'map_transform_unavailable');
 await p.stop();await memory.close();
});
test('invalid correction rolls back frame and observations',async()=>{
 let now=20;const memory=await MemoryService.open({sessionId:'invalid',clock:()=>now});const p=new PerceptionPipeline({segment:async()=>({masks:[mask]}),memory,runtime:{submit:()=>({accepted:true}),invalidate:()=>{}},now:()=>now});p.start('invalid');p.submit(input('a',10,1));await p.current;
 const next=input('b',30,2);next.mapCorrection={id:'bad',from:{mapId:'m',mapVersion:1,coordinateFrameId:'world'},to:{mapId:'m',mapVersion:2,coordinateFrameId:'world'},causalStatus:'online_causal',matrix:[1,0,0,10,0,1,0,0,0,0,1,0,0,0,0,1],uncertainty:{translationM:0,rotationRad:0},observedAt:30,processedAt:34};now=40;p.submit(next);await p.current;assert.equal(p.status().lastError,'memory_failed');assert.equal(memory.memory.observations.size,1);assert.equal(memory.ring.ring.has('b'),false);await p.stop();await memory.close();
});

test('zero detections cannot bypass correction destination validation',async()=>{
 let now=20;const memory=await MemoryService.open({sessionId:'empty',clock:()=>now});const p=new PerceptionPipeline({segment:async()=>({masks:[]}),memory,runtime:{submit:()=>({accepted:true}),invalidate:()=>{}},now:()=>now});p.start('empty');p.submit(input('a',10,1));await p.current;
 const next=input('b',30,2);next.mapCorrection={id:'wrong',from:{mapId:'m',mapVersion:1,coordinateFrameId:'world'},to:{mapId:'wrong',mapVersion:2,coordinateFrameId:'world'},matrix:[1,0,0,10,0,1,0,0,0,0,1,0,0,0,0,1],provenance:'fixture',causalStatus:'online_causal',uncertainty:{translationM:0,rotationRad:0},observedAt:30,processedAt:34};now=40;p.submit(next);await p.current;assert.equal(p.status().lastError,'memory_failed');assert.equal(memory.ring.ring.has('b'),false);assert.equal(memory.memory.events.has('wrong'),false);await p.stop();await memory.close();
});

test('withdrawal, eviction, and a later invalid correction do not revive an older transform',async()=>{
 const m=await MemoryService.open({sessionId:'correction-lineage',clock:()=>10,ringOptions:{maxAgeMs:50}});
 const from={mapId:'m',mapVersion:1,coordinateFrameId:'world'},to={mapId:'m',mapVersion:2,coordinateFrameId:'world'};
 await m.observe({observationId:'o',objectId:'object',...from,objectAnchorWorld:[1,0,0],observedAt:1,processedAt:1,evidenceIds:[]});
 const correction={id:'c',from,to,matrix:[1,0,0,10,0,1,0,0,0,0,1,0,0,0,0,1],provenance:'fixture',causalStatus:'online_causal',uncertainty:{translationM:0,rotationRad:0},observedAt:2,processedAt:2};
 await m.ingestPerception({frame:{id:'f',...to,observedAt:2,bytes:1},observations:[],mapCorrection:correction,now:2});
 assert.equal((await m.retrieve({objectId:'object',targetMap:to})).position.status,'ok');
 await m.reviseEvent({...correction,eventId:'later',type:'map_correction',observedAt:3,processedAt:3,causalStatus:'offline',evidenceIds:['f']});
 assert.equal((await m.retrieve({objectId:'object',targetMap:to})).position.reason,'map_transform_unavailable');
 assert.equal((await m.retrieve({objectId:'object',targetMap:to,observedUntil:2})).position.status,'ok');
 await m.advanceTime(52);
 assert.equal((await m.retrieve({objectId:'object',targetMap:to,observedUntil:2})).position.reason,'map_transform_unavailable');
 await m.close();
});
