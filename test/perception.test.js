import test from 'node:test';
import assert from 'node:assert/strict';
import {PerceptionPipeline} from '../src/runtime/perception.js';
import {MemoryService,EphemeralStorage} from '../src/memory/index.js';
import {RuntimeFacade} from '../src/runtime/facade.js';
const makeInput=()=>({frame:{frameId:'f1',observedAt:100,processedAt:101,causalStatus:'online_causal',provenanceKind:'synthetic',mapId:'map',mapVersion:1,coordinateFrameId:'world-map',width:2,height:2,rgba:new Uint8Array([255,0,0,255,255,0,0,255,255,0,0,255,255,0,0,255]),imageData:'data:image/png;base64,AA==',depth:null,syncUncertaintyMs:2},gaze:{frameId:'f1',observedAt:110,processedAt:111,causalStatus:'online_causal',x:0.25,y:0.25,syncUncertaintyMs:2},event:{eventId:'e1',type:'briefly_crossed',causalStatus:'online_causal',observedAt:95,endAt:110,processedAt:111,dwellValidMs:15,x:0.25,y:0.25}});
const mask={sourceWidth:2,sourceHeight:2,width:2,height:2,bounds:{left:0,top:0,right:2,bottom:2},raster:[1,1,1,1]};
const tick=()=>new Promise(r=>setTimeout(r,10));
test('synthetic aligned perception flows through tracker, memory and runtime',async()=>{
  let now=112, bundle, published; const memory=await MemoryService.open({sessionId:'p',storage:new EphemeralStorage(),clock:()=>now});
  const runtime=new RuntimeFacade({sessionId:'p',now:()=>now,minIntervalMs:0,segmenter:{kind:'local_fixture',run:async()=>[]},reasoner:{kind:'local_fixture',run:async b=>{bundle=b; return {scenarios:[{scenario_id:'s',possible_next_action:'observe',horizon_ms:1000,grounding_refs:['e1'],assumptions:[],status:'active'}]};}},publish:r=>{published=r;}});
  runtime.start(); const p=new PerceptionPipeline({segment:async f=>{assert.equal(f.rgba[0],255);now=113;return {masks:[mask]};},memory,runtime,now:()=>now}); p.start('p');
  const input=makeInput(); assert.equal(p.submit(input).accepted,true); input.frame.rgba[0]=0;
  await p.current; await tick(); assert.equal(published?.scenarios.length,1); assert.equal(bundle.events[0].candidateObjectIds.length,1);
  const saved=await memory.retrieve({objectId:bundle.events[0].candidateObjectIds[0],observedUntil:113}); assert.equal(saved.lastSeen.observedAt,100); assert.equal(saved.lastSeen.processedAt,113); assert.equal(saved.glimpses[0].eventId,'e1');
  await p.stop();runtime.stop();await memory.close();
});
test('withholds missing timing, excess uncertainty, future fields and prevents late segment writes after stop',async()=>{
  let finish, calls=0; const memory=await MemoryService.open({sessionId:'p',clock:()=>113}); const runtime={submit:()=>{calls++;}};
  const p=new PerceptionPipeline({segment:()=>new Promise(r=>{finish=r;}),memory,runtime,now:()=>113}); p.start('p');
  for(const edit of [x=>x.gaze.syncUncertaintyMs=null,x=>x.frame.syncUncertaintyMs=50,x=>x.frame.future='secret',x=>x.gaze.observedAt=200]) { const input=makeInput(); edit(input);assert.equal(p.submit(input).accepted,false); }
  assert.equal(p.submit(makeInput()).accepted,true); const stopped=p.stop(); finish({masks:[mask]}); await stopped; assert.equal(calls,0); assert.equal(memory.memory.observations.size,0); await memory.close();
});

test('rejects mismatched server response and invalid masks without writing memory',async()=>{
 const memory=await MemoryService.open({sessionId:'check',clock:()=>113}); const runtime={submit:()=>({accepted:true})};
 let result={model:'sam-3.1',frame:{frameId:'wrong',observedAt:100},masks:[mask]};
 const p=new PerceptionPipeline({segment:async()=>result,segmentKind:'server_provider',memory,runtime,now:()=>113});p.start('check');
 p.submit(makeInput());await p.current;assert.equal(p.status().lastError,'segmentation_mismatch');assert.equal(memory.memory.observations.size,0);
 result={model:'sam-3.1',frame:{frameId:'f1',observedAt:100},masks:[{...mask,raster:[7]}]};p.submit(makeInput());await p.current;
 assert.equal(p.status().lastError,'tracking_failed');assert.equal(memory.memory.observations.size,0); await p.stop();await memory.close();
});
test('map corrections reset identity without inventing motion and invalidate old map',async()=>{
 let now=113; const memory=await MemoryService.open({sessionId:'maps',clock:()=>now});const outputs=[],invalidations=[];
 const runtime={submit:i=>{outputs.push(i);return {accepted:true};},invalidate:x=>invalidations.push(x)};
 const p=new PerceptionPipeline({segment:async()=>({masks:[mask]}),memory,runtime,now:()=>now});p.start('maps');p.submit(makeInput());await p.current;
 now=133;const next=makeInput();next.frame.frameId='f2';next.frame.mapVersion=2;next.frame.observedAt=120;next.frame.processedAt=121;next.gaze.frameId='f2';next.gaze.observedAt=130;next.gaze.processedAt=131;next.event=null;
 p.submit(next);await p.current;assert.equal(outputs.length,2);assert.notEqual(outputs[0].dependencies.objectIds[0],outputs[1].dependencies.objectIds[0]);assert.ok(invalidations.some(x=>x.type==='map'));assert.equal(memory.memory.observations.size,2);
 const observation=(await memory.retrieve({objectId:outputs[1].dependencies.objectIds[0]})).lastSeen;assert.equal(observation.mapVersion,2);assert.equal(observation.objectAnchorWorld,null);await p.stop();await memory.close();
});
test('only latest pending input submits to runtime',async()=>{
 let now=113,release,attempts=0;const memory=await MemoryService.open({sessionId:'latest',clock:()=>now});const outputs=[];const runtime={submit:i=>{outputs.push(i);return {accepted:true};}};
 const p=new PerceptionPipeline({segment:async()=>{if(++attempts===1) await new Promise(r=>{release=r;});return {masks:[mask]};},memory,runtime,now:()=>now});p.start('latest');p.submit(makeInput());
 const later=(id,shift)=>{const x=makeInput();x.frame.frameId=id;x.frame.observedAt+=shift;x.frame.processedAt+=shift;x.gaze.frameId=id;x.gaze.observedAt+=shift;x.gaze.processedAt+=shift;x.event=null;return x;};
 now=133;p.submit(later('f2',10));p.submit(later('f3',20));release();await tick();await p.current; assert.deepEqual(outputs.map(x=>x.frame.frameId),['f3']);assert.equal(p.dropped,1);await p.stop();await memory.close();
});
test('revises earlier attention event against the exact final frame evidence',async()=>{
 const memory=await MemoryService.open({sessionId:'revision',clock:()=>113});await memory.ingestFrame({id:'attention-raw-f1',observedAt:100,bytes:1},113);
 const original=makeInput().event;await memory.ingestEvent(original,['attention-raw-f1'],113);
 let submitted;const runtime={submit:i=>{submitted=i;return {accepted:true};}};const p=new PerceptionPipeline({segment:async()=>({masks:[mask]}),memory,runtime,now:()=>113});p.start('revision');p.submit(makeInput());await p.current;
 assert.equal(submitted.events[0].eventId,'e1:association:1'); const stored=memory.memory.events.get('e1:association:1');assert.equal(stored.supersedesEventId,'e1');assert.deepEqual(stored.evidenceIds,['f1']);assert.equal(stored.observedAt,95);assert.equal(stored.processedAt,113);assert.equal(memory.memory.events.get('e1').evidenceIds[0],'attention-raw-f1');await p.stop();await memory.close();
});
test('pinned historical surface is attributed and unavailable geometry stays null',async()=>{
 const memory=await MemoryService.open({sessionId:'surface',clock:()=>113}); let input, pins=0,releases=0, calls=0;
 const runtime={submit:i=>{input=i;return {accepted:true};}};
 const sample=(frame,pixel,processedAt)=>{ calls++; return {frameId:frame.frameId,observedAt:frame.observedAt,processedAt,coordinateFrameId:frame.coordinateFrameId,point:[pixel[0],pixel[1],2],depthSource:'engine_geometry',units:'m',provenance:'pinned_geometry'}; };
 const p=new PerceptionPipeline({segment:async()=>({masks:[mask]}),memory,runtime,now:()=>113,pinFrame:()=>{pins++;return true;},releaseFrame:()=>{releases++;},sampleSurface:sample});p.start('surface');p.submit(makeInput());await p.current;
 assert.equal(calls,2); assert.equal(pins,1); assert.equal(releases,1); const o=(await memory.retrieve({objectId:input.dependencies.objectIds[0]})).lastSeen;
 assert.deepEqual(o.gazeHitPointWorld,[0.5,0.5,2]); assert.equal(o.objectAnchorWorld,null);assert.equal(o.surfaceProvenance.depthSource,'engine_geometry');assert.equal(o.surfaceProvenance.coordinateFrameId,'world-map');
 await p.stop();await memory.close();
 for(const alter of [x=>x.frameId='wrong',x=>x.coordinateFrameId='wrong',x=>x.depthSource='sensor_depth',x=>x.processedAt=999,x=>x.point=[NaN,0,0],x=>x.units='cm']) {
  const mem=await MemoryService.open({sessionId:'bad',clock:()=>113});let out;const q=new PerceptionPipeline({segment:async()=>({masks:[mask]}),memory:mem,runtime:{submit:i=>{out=i;return {accepted:true};}},now:()=>113,pinFrame:()=>true,releaseFrame:()=>{},sampleSurface:(f,p,t)=>{const x=sample(f,p,t);alter(x);return x;}});q.start('bad');q.submit(makeInput());await q.current;const row=(await mem.retrieve({objectId:out.dependencies.objectIds[0]})).lastSeen;assert.equal(row.surfacePointWorld,null);assert.equal(row.gazeHitPointWorld,null);assert.equal(row.surfaceProvenance,null);assert.equal(row.objectAnchorWorld,null);await q.stop();await mem.close();
 }
});
test('pins are released for replaced pending frames and after stop',async()=>{
 const memory=await MemoryService.open({sessionId:'pins',clock:()=>133});let finish;const held=[]; const released=[];
 const p=new PerceptionPipeline({segment:()=>new Promise(r=>{finish=r;}),memory,runtime:{submit:()=>({accepted:true})},now:()=>133,pinFrame:f=>{held.push(f.frameId);return true;},releaseFrame:f=>released.push(f.frameId),sampleSurface:()=>null});p.start('pins');
 const input=(id,shift)=>{const x=makeInput();x.frame.frameId=id;x.frame.observedAt+=shift;x.frame.processedAt+=shift;x.gaze.frameId=id;x.gaze.observedAt+=shift;x.gaze.processedAt+=shift;x.event=null;return x;};
 p.submit(input('a',0));p.submit(input('b',10));p.submit(input('c',20));assert.deepEqual(released,['b']);const stopped=p.stop();assert.deepEqual(released,['b','c']);finish({masks:[mask]});await stopped;assert.deepEqual(released,['b','c','a']);assert.deepEqual(held,['a','b','c']);await memory.close();
});
test('alignment uses presentation estimate and keeps render and capture timestamps distinct',async()=>{
  let bundle;const memory=await MemoryService.open({sessionId:'timing',clock:()=>125});
  const p=new PerceptionPipeline({segment:async()=>({masks:[mask]}),memory,runtime:{submit:i=>{bundle=i;return {accepted:true};}},now:()=>125,alignmentBudgetMs:8});p.start('timing');
  const input=makeInput(); input.frame.presentTsEstimateMs=116; input.gaze.observedAt=120; input.gaze.processedAt=121; input.event=null;
  assert.equal(p.submit(input).accepted,true);await p.current;assert.equal(bundle.frame.observedAt,100);assert.equal(bundle.gaze.observedAt,120);assert.equal(bundle.observedUntil,120);
  for(const alter of [x=>x.frame.presentTsEstimateMs=121,x=>x.frame.presentTsEstimateMs=99,x=>x.frame.presentTsEstimateMs=null,x=>x.gaze.observedAt=121]) {const invalid=makeInput();invalid.frame.presentTsEstimateMs=116;invalid.gaze.observedAt=120;invalid.gaze.processedAt=122;invalid.event=null;alter(invalid);assert.equal(p.submit(invalid).accepted,false);}
  await p.stop();await memory.close();
});
test('reasoner receives retained gaze transitions across distinct objects plus current event',async()=>{
 let now=113;const memory=await MemoryService.open({sessionId:'flow',clock:()=>now});const bundles=[];
 const runtime=new RuntimeFacade({sessionId:'flow',now:()=>now,minIntervalMs:0,analyzer:{kind:'server_provider',run:async input=>{bundles.push(input);return {scenarios:[]};}}});runtime.start();
 const pipeline=new PerceptionPipeline({segment:async()=>({masks:[mask]}),memory,runtime,now:()=>now});pipeline.start('flow');
 const entry=(number,offset,color,type)=>{const x=makeInput();x.frame.frameId=`f${number}`;x.frame.observedAt+=offset;x.frame.processedAt+=offset;x.frame.rgba=new Uint8Array([...color,255,...color,255,...color,255,...color,255]);x.gaze.frameId=x.frame.frameId;x.gaze.observedAt+=offset;x.gaze.processedAt+=offset;x.event={...x.event,eventId:`e${number}`,type,observedAt:x.event.observedAt+offset,endAt:x.event.endAt+offset,processedAt:x.event.processedAt+offset};return x;};
 for(const [n,offset,color,type] of [[1,0,[255,0,0],'fixated'],[2,20,[0,0,255],'briefly_crossed'],[3,40,[0,255,0],'fixated']]) {now=113+offset;assert.equal(pipeline.submit(entry(n,offset,color,type)).accepted,true);await pipeline.current;await tick();}
 const final=bundles.at(-1);assert.deepEqual(final.events.map(e=>e.eventId),['e1','e2','e3']);assert.deepEqual(final.events.map(e=>e.type),['fixated','briefly_crossed','fixated']);
 assert.equal(new Set(final.events.map(e=>e.candidateObjectIds[0])).size,3);assert.ok(final.events.every(e=>final.dependencies.evidenceIds.includes(e.eventId)));assert.ok(final.events.every(e=>e.endAt<=final.observedUntil && e.processedAt<=now));
 await pipeline.stop();runtime.stop();await memory.close();
});
test('stopping while historical retrieval waits cannot submit history',async()=>{
 const memory=await MemoryService.open({sessionId:'stop-history',clock:()=>113});let release,started;const waiting=new Promise(r=>{started=r;});
 memory.attentionHistory=()=>new Promise(r=>{release=r;started();});let calls=0;const pipeline=new PerceptionPipeline({segment:async()=>({masks:[mask]}),memory,runtime:{submit:()=>{calls++;return {accepted:true};}},now:()=>113});
 pipeline.start('stop-history');pipeline.submit(makeInput());await waiting;const stopped=pipeline.stop();release([{eventId:'private',type:'fixated',observedAt:0,endAt:1,processedAt:2,dwellValidMs:1}]);await stopped;assert.equal(calls,0);await memory.close();
});
test('decision hook receives a detached pixel-free bundle only when runtime accepts',async()=>{
 const memory=await MemoryService.open({sessionId:'decision',clock:()=>113});let accepted=false,hookCalls=0,captured,alignment,submitted;
 const pipeline=new PerceptionPipeline({segment:async()=>({masks:[mask]}),memory,runtime:{submit:i=>{submitted=i;return {accepted};}},now:()=>113,onDecision:(b,a)=>{hookCalls++;captured=b;alignment=a;b.frame.frameId='mutated';}});pipeline.start('decision');
 pipeline.submit(makeInput());await pipeline.current;assert.equal(hookCalls,0);
 const next=makeInput();next.frame.frameId='f2';next.frame.observedAt+=1;next.frame.processedAt+=1;next.gaze.frameId='f2';next.gaze.observedAt+=1;next.gaze.processedAt+=1;next.event=null;accepted=true;
 pipeline.submit(next);await pipeline.current;assert.equal(hookCalls,1);assert.equal('imageData' in captured.frame,false);assert.equal(submitted.frame.frameId,'f2');assert.equal(alignment.renderAt,101);assert.equal(alignment.gazeAt,111);assert.equal(alignment.totalErrorMs,14);await pipeline.stop();await memory.close();
});

test('changed linked observation invalidates dependent prepared and pending results only',async()=>{
 let now=113,hold,started;const waiting=new Promise(r=>{started=r;});let calls=0;const published=[];
 const memory=await MemoryService.open({sessionId:'conflict',clock:()=>now});
 const runtime=new RuntimeFacade({sessionId:'conflict',now:()=>now,minIntervalMs:0,analyzer:{kind:'server_provider',run:async()=>{if(++calls===2){started();await new Promise(r=>{hold=r;});}return {scenarios:[]};}},publish:x=>published.push(x)});runtime.start();
 let currentMask=mask;const pipeline=new PerceptionPipeline({segment:async()=>({masks:[currentMask]}),memory,runtime,now:()=>now});pipeline.start('conflict');
 pipeline.submit(makeInput());await pipeline.current;await tick();const first=published[0];assert.ok(first);
 const copy={...first,id:'unrelated',objectIds:['other']};runtime.cache.put(copy);
 const pending=makeInput();delete pending.event;pending.frame.imageData=makeInput().frame.imageData;pending.dependencies={mapId:'map',mapVersion:1,objectIds:first.objectIds,evidenceIds:['f1'],expiresAt:1000};pending.events=[];pending.context={memory:[]};pending.observedUntil=110;delete pending.frame.mapId;delete pending.frame.mapVersion;delete pending.frame.coordinateFrameId;delete pending.frame.width;delete pending.frame.height;delete pending.frame.rgba;delete pending.frame.depth;delete pending.frame.syncUncertaintyMs;delete pending.gaze.frameId;delete pending.gaze.causalStatus;delete pending.gaze.syncUncertaintyMs;
 runtime.submit(pending);await waiting;
 now=133;const next=makeInput();next.frame.frameId='f2';next.frame.observedAt=120;next.frame.processedAt=121;next.gaze.frameId='f2';next.gaze.observedAt=130;next.gaze.processedAt=131;next.event=null;
 currentMask={...mask,width:1,bounds:{left:0,top:0,right:1,bottom:2},raster:[1,1]};pipeline.submit(next);await pipeline.current;
 assert.equal(runtime.getPrepared('f1',{mapId:'map',mapVersion:1}),null);assert.ok(runtime.getPrepared('unrelated',{mapId:'map',mapVersion:1}));
 hold();await tick();assert.equal(published.filter(x=>x.id==='f1').length,1);
 await pipeline.stop();runtime.stop();await memory.close();
});

test('unchanged linked observation does not invalidate unrelated or dependent cache entries',async()=>{
 let now=113;const memory=await MemoryService.open({sessionId:'unchanged',clock:()=>now});const invalidations=[];
 const pipeline=new PerceptionPipeline({segment:async()=>({masks:[mask]}),memory,runtime:{submit:()=>({accepted:true}),invalidate:x=>invalidations.push(x)},now:()=>now});pipeline.start('unchanged');pipeline.submit(makeInput());await pipeline.current;
 now=133;const next=makeInput();next.frame.frameId='f2';next.frame.observedAt=120;next.frame.processedAt=121;next.gaze.frameId='f2';next.gaze.observedAt=130;next.gaze.processedAt=131;next.event=null;
 pipeline.submit(next);await pipeline.current;assert.deepEqual(invalidations,[]);await pipeline.stop();await memory.close();
});

test('withdrawal invalidates a cached result and its historical aliases',async()=>{
 const memory=await MemoryService.open({sessionId:'withdraw',clock:()=>113});let published;
 const runtime=new RuntimeFacade({sessionId:'withdraw',now:()=>113,minIntervalMs:0,segmenter:{kind:'local_fixture',run:async()=>[]},reasoner:{kind:'local_fixture',run:async()=>({scenarios:[]})},publish:r=>published=r});
 runtime.start();const p=new PerceptionPipeline({segment:async()=>({masks:[mask]}),memory,runtime,now:()=>113});p.start('withdraw');p.submit(makeInput());await p.current;await tick();assert.ok(published);assert.ok(runtime.getPrepared('f1',{mapId:'map',mapVersion:1}));
 await memory.deleteEvidence('f1');assert.equal(runtime.getPrepared('f1',{mapId:'map',mapVersion:1}),null);await p.stop();runtime.stop();await memory.close();
});

test('withdrawal while a reasoner is running suppresses publication',async()=>{
 const memory=await MemoryService.open({sessionId:'flight',clock:()=>113});let finish,published=0;
 const runtime=new RuntimeFacade({sessionId:'flight',now:()=>113,minIntervalMs:0,segmenter:{kind:'local_fixture',run:async()=>[]},reasoner:{kind:'local_fixture',run:()=>new Promise(resolve=>{finish=resolve;})},publish:()=>published++});runtime.start();
 const p=new PerceptionPipeline({segment:async()=>({masks:[mask]}),memory,runtime,now:()=>113});p.start('flight');p.submit(makeInput());await p.current;await tick();assert.ok(finish);await memory.deleteEvidence('f1');finish({scenarios:[]});await tick();assert.equal(published,0);await p.stop();runtime.stop();await memory.close();
});

test('scene exploration commits observations without inventing gaze or invoking reasoning',async()=>{
 const memory=await MemoryService.open({sessionId:'explore',clock:()=>113});let calls=0;const runtime={submit:()=>{calls++;return {accepted:true}}};
 const p=new PerceptionPipeline({segment:async()=>({masks:[mask]}),memory,runtime,now:()=>113});p.start('explore');const input=makeInput();input.gaze=null;input.event=null;assert.equal(p.submit(input).accepted,true);await p.current;
 assert.equal(calls,0);assert.equal(memory.memory.observations.size,1);assert.equal(memory.memory.events.size,0);assert.equal([...memory.memory.observations.values()][0].gazeHitPointWorld,null);await p.stop();await memory.close();
});

test('scene-only SAM accepts render evidence with explicitly unavailable presentation timing and rejects gaze',async()=>{
 const memory=await MemoryService.open({sessionId:'scene-timing',clock:()=>113});let calls=0;
 const p=new PerceptionPipeline({segment:async()=>{calls++;return {masks:[]};},memory,runtime:{submit:()=>({accepted:true})},now:()=>113});p.start('scene-timing');
 const scene=makeInput();scene.gaze=null;scene.event=null;scene.frame.presentTsEstimateMs=null;scene.frame.syncUncertaintyMs=null;scene.frame.timingUnavailableReason='display_presentation_not_measured';
 assert.equal(p.submit(scene).accepted,true);await p.current;assert.equal(calls,1);
 const gaze=makeInput();gaze.frame.presentTsEstimateMs=null;gaze.frame.syncUncertaintyMs=null;gaze.frame.timingUnavailableReason='display_presentation_not_measured';
 assert.equal(p.submit(gaze).accepted,false);assert.equal(calls,1);await p.stop();await memory.close();
});

test('gaze preempts an in-flight scene exploration',async()=>{
 const memory=await MemoryService.open({sessionId:'priority',clock:()=>113});let aborted=false,calls=0;const runtime={submit:()=>({accepted:true})};
 const p=new PerceptionPipeline({segment:(f,{signal})=>{calls++;if(calls===1)return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('cancelled'))},{once:true}));return Promise.resolve({masks:[mask]});},memory,runtime,now:()=>113});p.start('priority');const scene=makeInput();scene.gaze=null;scene.event=null;p.submit(scene);const gaze=makeInput();gaze.frame.frameId='f2';gaze.gaze.frameId='f2';assert.equal(p.submit(gaze).accepted,true);await new Promise(r=>setTimeout(r,10));await p.current;assert.equal(aborted,true);assert.equal(calls,2);await p.stop();await memory.close();
});

test('stopping exploration during an abortable save leaves no scene observations',async()=>{
 const storage=new EphemeralStorage(); const save=storage.save.bind(storage); let release, entered;
 const waiting=new Promise(r=>{entered=r;}); storage.save=async (...args)=>{entered();await new Promise(r=>{release=r;});return save(...args);};
 const memory=await MemoryService.open({sessionId:'cancel-save',storage,clock:()=>113});let results=0;
 const p=new PerceptionPipeline({segment:async()=>({masks:[mask]}),memory,runtime:{submit:()=>({accepted:true})},now:()=>113,onExplorationResult:()=>results++});p.start('cancel-save');
 const scene=makeInput();scene.gaze=null;scene.event=null;p.submit(scene);await waiting;const stopped=p.stop();release();await stopped;
 assert.equal(memory.memory.observations.size,0);assert.equal(await storage.load('cancel-save'),null);assert.equal(results,0);await memory.close();
});

test('exploration reports empty and nonempty results without inventing observations',async()=>{
 const memory=await MemoryService.open({sessionId:'explore-results',clock:()=>113});const results=[];let masks=[];
 const p=new PerceptionPipeline({segment:async()=>({masks}),memory,runtime:{submit:()=>({accepted:true})},now:()=>113,onExplorationResult:r=>results.push(r)});p.start('explore-results');
 const first=makeInput();first.gaze=null;first.event=null;p.submit(first);await p.current;assert.deepEqual(results,[{count:0}]);assert.equal(memory.memory.observations.size,0);
 masks=[mask];const second=makeInput();second.frame.frameId='f2';second.frame.observedAt=101;second.frame.processedAt=102;second.gaze=null;second.event=null;p.submit(second);await p.current;assert.deepEqual(results,[{count:0},{count:1}]);assert.equal(memory.memory.observations.size,1);
 await p.stop();await memory.close();
});


test('separate remote pipeline namespaces cannot reuse tracked identities',async()=>{
 const memory=await MemoryService.open({sessionId:'concepts',clock:()=>113});const outputs=[];
 const runtime={submit:i=>{outputs.push(i);return {accepted:true};}};
 for(const namespace of ['concept-a','concept-b']) {
  const p=new PerceptionPipeline({segment:async()=>({masks:[mask]}),identityNamespace:namespace,memory,runtime,now:()=>113});p.start(namespace);const input=makeInput();input.frame.frameId=namespace;input.gaze.frameId=namespace;input.event.eventId=namespace;p.submit(input);await p.current;await p.stop();
 }
 assert.equal(outputs.length,2);assert.notEqual(outputs[0].dependencies.objectIds[0],outputs[1].dependencies.objectIds[0]);await memory.close();
});

test('segment receives only validated aligned gaze, and scene exploration receives no gaze',async()=>{
 const memory=await MemoryService.open({sessionId:'point',clock:()=>113}); const seen=[];
 const p=new PerceptionPipeline({segment:async(f,{gaze})=>{seen.push(gaze);return {masks:[]};},memory,runtime:{submit:()=>({accepted:true})},now:()=>113});p.start('point');
 const bad=makeInput();bad.gaze.syncUncertaintyMs=100;assert.equal(p.submit(bad).accepted,false);assert.equal(seen.length,0);
 const input=makeInput();assert.equal(p.submit(input).accepted,true);await p.current;assert.deepEqual(seen[0],input.gaze);
 const scene=makeInput();scene.gaze=null;scene.event=null;assert.equal(p.submit(scene).accepted,true);await p.current;assert.equal(seen[1],null);
 await p.stop();await memory.close();
});
