import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCoordinator,FrameHistory} from '../src/app.js';
import {MemoryService} from '../src/memory/index.js';
import {RuntimeFacade} from '../src/runtime/facade.js';
import {createLocalServer} from '../server.js';

test('server serves only explicit integration modules and rejects unknown paths',async()=>{
  const server=createLocalServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try { const base=`http://127.0.0.1:${server.address().port}`;
    for(const path of ['/','/src/app.js','/src/gaze/index.js','/src/gaze/persistence.js','/src/gaze/webcam.js','/src/gaze/remote-webcam.js','/src/gaze/calibration-window.js','/src/runtime/clock.js','/src/gaze/webeyetrack-worker.js','/src/gaze/webeyetrack-bootstrap.js','/src/gaze/overlay.js','/src/spatial/world.js','/src/memory/index.js','/src/memory/session.js','/src/memory/provisional-tracking.js','/src/evaluation/ledger.js','/src/runtime/facade.js','/src/runtime/provider-journal.js']) assert.equal((await fetch(base+path)).status,200,path);
    for(const path of ['/README.md','/%2e%2e/server.js','/src/not-listed.js','/vendor/not-allowed.js','/server/reasoner-adapter.js','/server.js','/.env','/data/session.json','/artifacts/result.json']) assert.equal((await fetch(base+path)).status,404,path);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('cloud profile exposes safe runtime config and a same-origin bounded gaze frame proxy',async()=>{
  const forwarded=[];const gazeProvider={
    async health(){return {ready:true,model:{id:'webeyetrack-blazegaze-mpiifacegaze',sourceCommit:'75fbd2f5f784f2eb3a39675a8dcbf1b01c697f1c',sha256:'a'.repeat(64)}};},
    async createSession(input){forwarded.push(['create',input]);return {sessionId:'session_1',expiresInSeconds:600,calibrated:false};},
    async frame(input){forwarded.push(['frame',input]);return {frameId:input.frameId,captureTimestampMs:input.captureTimestampMs,faceDetected:true,gazeState:'open',normPog:[0,0],durations:{total:1}};},
    async startCandidate(){return {status:'ready'};},async addCalibrationSample(){return {adapted:false,points:1};},
    async acceptCandidate(){return {status:'accepted',calibrated:true,adapter:{schemaVersion:1}};},async discardCandidate(){},async deleteSession(id){forwarded.push(['delete',id]);},async close(){}
  };
  const server=createLocalServer({computeProfile:'cloud',gazeProvider});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    const config=await (await fetch(base+'/api/runtime/config')).json();assert.deepEqual(config,{computeProfile:'cloud',gazeBackend:'remote_gpu'});
    const health=await (await fetch(base+'/api/gaze/health')).json();assert.equal(health.ready,true);assert.equal(health.backend,'remote_gpu');assert.equal('url' in health,false);
    const created=await fetch(base+'/api/gaze/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({screenPxDimensions:[800,600]})});assert.equal(created.status,201);assert.equal((await created.json()).sessionId,'session_1');
    const frame=await fetch(base+'/api/gaze/sessions/session_1/frame',{method:'POST',headers:{'content-type':'image/jpeg','x-frame-id':'1','x-capture-timestamp-ms':'12.5'},body:Buffer.from([255,216,255,217])});assert.equal(frame.status,200);assert.deepEqual(await frame.json(),{frameId:1,captureTimestampMs:12.5,faceDetected:true,gazeState:'open',normPog:[0,0],durations:{total:1}});
    const oversized=await fetch(base+'/api/gaze/sessions/session_1/frame',{method:'POST',headers:{'content-type':'image/jpeg','x-frame-id':'2','x-capture-timestamp-ms':'13'},body:Buffer.alloc(512*1024+1)});assert.equal(oversized.status,413);assert.equal(forwarded.filter(item=>item[0]==='frame').length,1);
    const deleted=await fetch(base+'/api/gaze/sessions/session_1',{method:'DELETE'});assert.equal(deleted.status,200);assert.equal(forwarded.at(-1)[0],'delete');
    const local=createLocalServer({computeProfile:'local'});await new Promise(resolve=>local.listen(0,'127.0.0.1',resolve));try{const localBase=`http://127.0.0.1:${local.address().port}`,localConfig=await (await fetch(localBase+'/api/runtime/config')).json();assert.deepEqual(localConfig,{computeProfile:'local',gazeBackend:'browser_local'});}finally{await new Promise(resolve=>local.close(resolve));}
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('landmark worker sends derived gaze features rather than raw MediaPipe landmarks',async()=>{
  const server=createLocalServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    const source=await (await fetch(base+'/src/gaze/webeyetrack-worker.js')).text();
    assert.match(source,/landmarkGazeFeatures\(points,message\.width,message\.height\)/);
    assert.match(source,/landmarkFeatures:gazeFeatures/);
    assert.doesNotMatch(source,/facialLandmarks\s*:/);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('server exposes the pinned WebEyeTrack bundle and both local gaze-model files',async()=>{
  const server=createLocalServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    for(const path of ['/vendor/webeyetrack.js','/vendor/vision_bundle.mjs','/vendor/face_landmarker.task']) {
      const response=await fetch(base+path);assert.equal(response.status,200,path);await response.body.cancel();
    }
    const modelResponse=await fetch(base+'/web/model.json');assert.equal(modelResponse.status,200);
    const model=await modelResponse.json();
    const weightPaths=model.weightsManifest.flatMap(group=>group.paths);
    assert.ok(weightPaths.includes('group1-shard1of1.bin'));
    const shard=await fetch(base+'/web/group1-shard1of1.bin');assert.equal(shard.status,200);await shard.body.cancel();
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('application wiring rejects unaligned samples and leaves provider integration blocked',async()=>{
  const memory=await MemoryService.open({sessionId:'wiring',now:0});
  const runtime=new RuntimeFacade({sessionId:'wiring',now:()=>100});
  const controller={start:async options=>{assert.deepEqual(options,{userInitiated:true,cameraConsent:true,videoConstraints:{width:{ideal:1280},height:{ideal:720}}});return {width:640};},stop(){}};
  const app=createCoordinator({controller,memory,runtime});
  assert.equal((await app.start()).started,true);
  assert.equal((await app.acceptSample({valid:true,viewportXY:{x:.5,y:.5},timestampMs:10,sceneAssociationEligible:true,timestampKind:'browser_capture_estimate',syncUncertaintyMs:1},{frameId:'f',presentTsEstimateMs:null})).reason,'alignment_unavailable');
  assert.equal((await app.acceptSample({valid:true,viewportXY:{x:.5,y:.5},timestampMs:10,sceneAssociationEligible:false,syncUncertaintyMs:null},{frameId:'f',presentTsEstimateMs:8,displayUncertaintyMs:1})).reason,'unverified_camera_timing');
  assert.equal((await memory.retrieve({observedUntil:100})).glimpses.length,0);
  assert.equal(runtime.submit({}).reason,'provider_blocked');assert.equal(app.status().wonder,'blocked');
  app.stop();await memory.close();
});
test('application stop during camera start cannot start runtime or revive state',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r), states=[];let stops=0;
  const controller={start:()=>pending,stop:()=>stops++};const memory={close:async()=>{}};
  const runtime=new RuntimeFacade({sessionId:'race'});const app=createCoordinator({controller,memory,runtime,onState:s=>states.push(s)});
  const starting=app.start();const stopping=app.stop();resolve({width:640});assert.equal((await starting).reason,'cancelled');await stopping;
  assert.equal(app.status().active,false);assert.equal(stops,1);assert.deepEqual(states,['starting','stopping','stopped']);
});
test('immutable RGBA scene evidence is bounded and selected by presentation time',()=>{
  const h=new FrameHistory({maxAgeMs:100,maxBytes:1000}),f={frameId:'f',renderTsMs:10,presentTsEstimateMs:15,displayUncertaintyMs:4,viewport:{width:1,height:1},image:{mutable:true}},rgba=new Uint8Array([1,2,3,4]);
  assert.equal(h.add(f,rgba,20),true);f.renderTsMs=99;f.image.mutable=false;rgba[0]=9;
  assert.equal(h.at(14),null);assert.equal(h.at(20).renderTsMs,10);assert.equal(h.at(20).image,undefined);assert.equal(h.at(20).evidence.rgba[0],1);
  h.trim(111);assert.equal(h.frames.length,0);assert.equal(h.bytes,0);
});
test('aligned injected evidence flows to memory while no real model is claimed',async()=>{
  const memory=await MemoryService.open({sessionId:'aligned',now:0}), runtime=new RuntimeFacade({sessionId:'aligned',now:()=>300});
  const app=createCoordinator({controller:{start:async()=>({width:1}),stop(){}},memory,runtime});await app.start();
  const sample=t=>({valid:true,viewportXY:{x:.5,y:.5},timestampMs:t,processedMs:t,syncUncertaintyMs:1,sceneAssociationEligible:true,timestampKind:'browser_capture_estimate'});
  const frame=t=>({frameId:`f${t}`,presentTsEstimateMs:t-2,displayUncertaintyMs:1,evidence:{id:`f${t}`,observedAt:t-2,bytes:1}});
  for(const t of [10,90,170]) await app.acceptSample(sample(t),frame(t));
  await app.acceptSample({valid:false,processedMs:180},null);
  assert.equal(memory.memory.events.size,1);assert.equal([...memory.memory.events.values()][0].type,'fixated');
  assert.equal(runtime.status().sam,'blocked');app.stop();await memory.close();
});
test('glimpse closes on invalid tracking, excludes gap, and samples are serialized',async()=>{
  const memory=await MemoryService.open({sessionId:'glimpse',now:0}),runtime=new RuntimeFacade({sessionId:'glimpse',now:()=>300});
  const app=createCoordinator({controller:{start:async()=>({width:1}),stop(){}},memory,runtime});await app.start();
  const sample=t=>({valid:true,viewportXY:{x:.5,y:.5},timestampMs:t,processedMs:t,syncUncertaintyMs:1,sceneAssociationEligible:true,timestampKind:'browser_capture_estimate'});
  const frame=t=>({frameId:`f${t}`,presentTsEstimateMs:t-2,displayUncertaintyMs:1,evidence:{id:`f${t}`,observedAt:t-2,bytes:1}});
  await Promise.all([app.acceptSample(sample(10),frame(10)),app.acceptSample(sample(90),frame(90)),app.acceptSample({valid:false,processedMs:190},null)]);
  const event=[...memory.memory.events.values()][0];assert.equal(event.type,'briefly_crossed');assert.equal(event.dwellValidMs,80);assert.equal(event.endAt,90);
  await app.stop();await memory.close();
});



test('gaze proxy passes the worker failure code to the browser and logs it without frame content',async()=>{
  const logs=[];
  const gazeProvider={async health(){return {ready:true};},async frame(){throw Object.assign(new Error('x'),{code:'GAZE_FRAME_OUT_OF_ORDER'});},async close(){}};
  const server=createLocalServer({computeProfile:'cloud',gazeProvider,logger:line=>logs.push(line)});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    const frame=await fetch(base+'/api/gaze/sessions/session_1/frame',{method:'POST',headers:{'content-type':'image/jpeg','x-frame-id':'3','x-capture-timestamp-ms':'9'},body:Buffer.from([255,216,255,217])});
    assert.equal(frame.status,503);
    assert.deepEqual(await frame.json(),{error:'gaze_unavailable',code:'GAZE_FRAME_OUT_OF_ORDER'});
    const entry=logs.map(line=>JSON.parse(line)).find(item=>item.stage?.startsWith('failed:'));
    assert.deepEqual(entry,{event:'api_stage',route:'gaze_frame',stage:'failed:GAZE_FRAME_OUT_OF_ORDER',status:503});
    assert.equal(logs.some(line=>line.includes('session_1')||line.includes('255')),false);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
