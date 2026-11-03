import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfiledWebcamGazeController,createRemoteWebcamGazeController,describeCalibrationTarget,describeOpenEyeWait,validateRemoteGazeAdapter} from '../src/gaze/remote-webcam.js';

const model={id:'webeyetrack-blazegaze-mpiifacegaze',sourceCommit:'75fbd2f5f784f2eb3a39675a8dcbf1b01c697f1c',sha256:'a'.repeat(64)};
const shapes=[[518,16],[16],[16,16],[16],[16,2],[2]];
function adapter(){return {schemaVersion:1,adapterId:'webeyetrack-gaze-mlp-f32-v1',modelId:model.id,sourceCommit:model.sourceCommit,modelSha256:model.sha256,weights:shapes.map(shape=>{const count=shape.reduce((n,x)=>n*x,1),bytes=Buffer.alloc(count*4);for(let i=0;i<count;i++)bytes.writeFloatLE(.125,i*4);return {shape,dtype:'float32-le',data:bytes.toString('base64')};})};}
function response(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});}

function harness({ready=true,restoreAdapter=null,holdFirstFrame=false,frameHz=8,frameFailure=null,frameFields=null,targetBehaviour=null,screenCm=null,clickStatus='adapted'}={}){
  let now=1000,callback=null,callbackId=0,mediaOpens=0,trackStops=0,frameCalls=0,resolveFirst=null,active=false;
  const targetCalls=[],errors=[],samples=[],calls=[],video={videoWidth:1280,videoHeight:720,srcObject:null,async play(){},pause(){},requestVideoFrameCallback(fn){callback=fn;return ++callbackId;},cancelVideoFrameCallback(){callback=null;},emit(captureTime=now){now=captureTime;const fn=callback;callback=null;assert.ok(fn,'video frame callback scheduled');fn(now,{captureTime});}};
  const track={stop(){trackStops++;},getSettings(){return {width:1280,height:720,frameRate:30};}};
  const mediaDevices={async getUserMedia(){mediaOpens++;return {getTracks:()=>[track],getVideoTracks:()=>[track]};}};
  const fetchImpl=async(url,options={})=>{
    calls.push({url:String(url),options});
    if(url==='/api/gaze/health')return response({ready,backend:'remote_gpu',model});
    if(url==='/api/gaze/sessions'&&options.method==='POST'){const input=JSON.parse(options.body);active=true;return response({sessionId:'session_test',expiresInSeconds:600,calibrated:!!input.adapter});}
    if(url==='/api/gaze/sessions/session_test'&&options.method==='DELETE'){active=false;return response({deleted:true});}
    if(url.endsWith('/candidate/start'))return response({status:'ready'});
    if(url.endsWith('/candidate/discard'))return response({status:'ready'});
    if(url.endsWith('/candidate/accept'))return response({status:'accepted',calibrated:true,adapter:adapter()});
    if(url.endsWith('/calibration/target')){const input=JSON.parse(options.body),behaviour=targetBehaviour?.(input)??'ok',n=input.frames.length;targetCalls.push(input);
      if(behaviour==='insufficient')return response({status:'insufficient',phase:input.phase,pointIndex:input.pointIndex,totalFrames:n,faceFrames:n,closedFrames:n,usableFrames:0,frameErrors:0,eyeAspectRatio:{min:.17,threshold:.2}});
      return response(input.phase==='train'?{status:'accepted',phase:'train',pointIndex:input.pointIndex,totalFrames:n,faceFrames:n,closedFrames:0,usableFrames:n,frameErrors:0,eyeAspectRatio:null,collected:input.pointIndex+1}:{status:'measured',phase:'validate',pointIndex:input.pointIndex,totalFrames:n,faceFrames:n,closedFrames:0,usableFrames:n,frameErrors:0,eyeAspectRatio:null,normPog:[0,.1]});}
    if(url.endsWith('/candidate/adapt'))return response({adapted:true,points:27});
    if(url.endsWith('/calibration/click')){const input=JSON.parse(options.body);return response({status:clickStatus,usableFrames:clickStatus==='adapted'?input.frames.length:0,totalFrames:input.frames.length});}
    if(url.endsWith('/calibration/sample')){const input=JSON.parse(options.body);return response({adapted:input.pointIndex===26,points:input.pointIndex+1});}
    if(url.endsWith('/frame')){
      frameCalls++;const failure=typeof frameFailure==='function'?frameFailure(frameCalls):frameFailure;if(failure)return response({error:'gaze_unavailable',code:failure},503);const headers=options.headers,frameId=Number(headers['x-frame-id']),captureTimestampMs=Number(headers['x-capture-timestamp-ms']);
      if(holdFirstFrame&&frameCalls===1)await new Promise(resolve=>{resolveFirst=resolve;options.signal.addEventListener('abort',()=>resolveFirst?.(),{once:true});});
      return response({status:'ok',frameId,captureTimestampMs,faceDetected:true,gazeState:'open',normPog:[0,.1],durations:{total:7},...(frameFields??{})});
    }
    throw new Error(`unexpected request ${url}`);
  };
  const canvas={width:0,height:0,getContext(){return {drawImage(){}};},toBlob(done,type){done(new Blob([Uint8Array.from([255,216,255,217])],{type}));}};
  const diagnostics=[];
  const controller=createRemoteWebcamGazeController({video,mediaDevices,fetchImpl,createCanvas:()=>canvas,clockNow:()=>now,getViewport:()=>({width:800,height:600}),maxFrameHz:frameHz,getAdapter:async()=>restoreAdapter,getScreenCm:()=>screenCm,onSample:sample=>samples.push(sample),onError:error=>errors.push(error),onDiagnostic:code=>diagnostics.push(code)});
  return {controller,video,samples,errors,calls,targetCalls,diagnostics,counts:()=>({mediaOpens,trackStops,frameCalls,active}),setTime(value){now=value;},async flush(){for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));},releaseFirst(){resolveFirst?.();resolveFirst=null;}};
}

test('remote gaze health blocks startup before camera access and has no local-worker fallback',async()=>{
  const h=harness({ready:false});
  await assert.rejects(h.controller.start({userInitiated:true,cameraConsent:true}),error=>error.code==='gaze_remote_unavailable');
  assert.equal(h.counts().mediaOpens,0);assert.equal(h.calls.some(call=>call.url==='/api/gaze/sessions'),false);
  const failed=harness({ready:false});let workerCreates=0;
  const profiled=createProfiledWebcamGazeController({video:failed.video,mediaDevices:{getUserMedia:failed.controller.start},fetchImpl:async(url,options)=>url==='/api/runtime/config'?response({computeProfile:'cloud',gazeBackend:'remote_gpu'}):failed.calls.length?response({}):response({ready:false,backend:'remote_gpu',model}),workerFactory(){workerCreates++;}});
  await assert.rejects(profiled.start({userInitiated:true,cameraConsent:true}));
  assert.equal(workerCreates,0);
});

test('remote uploader sends bounded JPEGs at the configured rate and emits gaze vectors only',async()=>{
  const h=harness();
  const settings=await h.controller.start({userInitiated:true,cameraConsent:true});
  assert.deepEqual(settings,{width:1280,height:720,frameRate:30});
  h.video.emit(1010);await h.flush();
  const upload=h.calls.find(call=>call.url.endsWith('/frame'));
  assert.ok(upload);assert.equal(upload.options.headers['content-type'],'image/jpeg');assert.equal(upload.options.body.byteLength,4);
  assert.equal(h.samples.length,1);assert.deepEqual(h.samples[0].normPog,[0,.1]);assert.equal(h.samples[0].features[0],.5);assert.equal(h.samples[0].width,640);assert.equal(h.samples[0].height,360);
  assert.equal('landmarks' in h.samples[0],false);assert.equal('eyePatch' in h.samples[0],false);
  await h.controller.stop();await h.flush();assert.equal(h.counts().trackStops,1);assert.equal(h.counts().active,false);
});

test('remote uploader keeps one in-flight request and coalesces a latest frame',async()=>{
  const h=harness({holdFirstFrame:true});await h.controller.start({userInitiated:true,cameraConsent:true});
  h.video.emit(1010);await h.flush();assert.equal(h.counts().frameCalls,1);
  h.video.emit(1030);h.video.emit(1050);h.video.emit(1070);assert.equal(h.counts().frameCalls,1);
  h.setTime(1200);h.releaseFirst();await h.flush();assert.equal(h.counts().frameCalls,2);
  const frames=h.calls.filter(call=>call.url.endsWith('/frame'));
  assert.equal(frames.length,2);assert.equal(frames[1].options.headers['x-capture-timestamp-ms'],'1070');
  h.controller.pause();const before=h.counts().frameCalls;assert.throws(()=>h.video.emit(1300),/callback/);assert.equal(h.counts().frameCalls,before);
  h.controller.resume();h.video.emit(1500);await h.flush();assert.equal(h.counts().frameCalls,before+1);
  await h.controller.stop();
});

test('cloud calibration holds the live stream, uploads one burst per target, adapts once and can be restored',async()=>{
  const h=harness();await h.controller.start({userInitiated:true,cameraConsent:true});
  await assert.rejects(h.controller.captureCalibrationFrames(),/calibration candidate unavailable/);
  await h.controller.beginCalibration();
  h.video.emit(1100);await h.flush();
  assert.equal(h.counts().frameCalls,0);
  let lastFrameId=0;
  for(let index=0;index<27;index++){
    const frames=await h.controller.captureCalibrationFrames({count:3,spanMs:0});
    assert.equal(frames.length,3);assert.equal(frames[0].bytes.length,4);
    for(const frame of frames){assert.ok(frame.frameId>lastFrameId);lastFrameId=frame.frameId;}
    const result=await h.controller.uploadCalibrationTarget({phase:'train',pointIndex:index,target:{x:400,y:300},frames});
    assert.equal(result.status,'accepted');assert.equal(result.collected,index+1);
  }
  assert.equal(h.targetCalls.length,27);
  const first=h.targetCalls[0];
  assert.deepEqual(first.target,[400/800-.5,300/600-.5]);assert.equal(first.frames[0].jpeg,Buffer.from([255,216,255,217]).toString('base64'));
  assert.deepEqual(await h.controller.finalizeCalibration(),{adapted:true,points:27});
  const committed=await h.controller.commitCalibration();assert.equal(validateRemoteGazeAdapter(committed.adapter,model),true);
  h.video.emit(3000);await h.flush();assert.equal(h.counts().frameCalls,1);
  const saved=harness({restoreAdapter:committed.adapter});await saved.controller.start({userInitiated:true,cameraConsent:true});
  const createCall=saved.calls.find(call=>call.url==='/api/gaze/sessions'&&call.options.method==='POST');
  assert.ok(JSON.parse(createCall.options.body).adapter);assert.equal(saved.controller.calibrated,true);
  saved.video.emit(6000);await saved.flush();assert.equal(saved.samples[0].valid,true);
  await saved.controller.stop();await h.controller.stop();
});

test('cancelling calibration resumes the live stream and an insufficient target is returned, not hidden',async()=>{
  const h=harness({targetBehaviour:()=> 'insufficient'});
  await h.controller.start({userInitiated:true,cameraConsent:true});await h.controller.beginCalibration();
  const frames=await h.controller.captureCalibrationFrames({count:3,spanMs:0});
  const result=await h.controller.uploadCalibrationTarget({phase:'train',pointIndex:0,target:{x:10,y:10},frames});
  assert.equal(result.status,'insufficient');
  assert.match(describeCalibrationTarget(result),/Eyes judged closed \(EAR min 0\.17; closed under 0\.20\)/);
  await assert.rejects(h.controller.uploadCalibrationTarget({phase:'train',pointIndex:27,target:{x:10,y:10},frames}),/invalid calibration target/);
  await h.controller.cancelCalibration();
  h.video.emit(2000);await h.flush();assert.equal(h.counts().frameCalls,1);
  await h.controller.stop();
});

test('target descriptions name no face, closed eyes, frame errors and missing frames',()=>{
  const base={status:'insufficient',totalFrames:5,faceFrames:5,closedFrames:0,usableFrames:0,frameErrors:0,eyeAspectRatio:null};
  assert.equal(describeCalibrationTarget(null),'No result');
  assert.equal(describeCalibrationTarget({...base,status:'accepted',usableFrames:4}),'Usable frames 4/5');
  assert.equal(describeCalibrationTarget({...base,faceFrames:0}),'No face detected (5 frames)');
  assert.equal(describeCalibrationTarget({...base,closedFrames:5}),'Eyes judged closed');
  assert.equal(describeCalibrationTarget({...base,frameErrors:2,usableFrames:1}),'2 frame processing errors');
  assert.equal(describeCalibrationTarget({...base,usableFrames:1}),'Not enough usable frames (1/5)');
});

test('remote uploader records bounded per-frame transport telemetry on the browser clock',async()=>{
  const h=harness();
  await h.controller.start({userInitiated:true,cameraConsent:true});
  for(const at of [1010,1200,1400]){h.video.emit(at);await h.flush();}
  const t=h.controller.telemetry();
  assert.equal(t.kind,'remote_gaze_transport');
  assert.equal(t.counts.sent,3);assert.equal(t.counts.received,3);assert.equal(t.counts.published,3);assert.equal(t.counts.failed,0);
  assert.equal(t.windowSamples,3);assert.equal(t.bytes.p50,4);assert.equal(t.remoteModelMs.p50,7);
  assert.ok(t.ageAtSampleMs.n===3&&t.ageAtSampleMs.max>=0);
  assert.ok(t.effectiveResultHz>0);
  assert.match(t.note,/display presentation time is not measured/);
  await h.controller.stop();
});

async function emitFrames(h,times){for(const at of times){h.video.emit(at);await h.flush();}}
const spaced=count=>Array.from({length:count},(_,i)=>1010+i*200);

test('transient frame failures are tolerated and only the fifth consecutive one stops tracking with the reason attached',async()=>{
  const h=harness({frameFailure:'GAZE_INFERENCE_FAILED'});
  await h.controller.start({userInitiated:true,cameraConsent:true});
  await emitFrames(h,spaced(4));
  assert.equal(h.errors.length,0);assert.equal(h.controller.telemetry().counts.failed,4);
  assert.equal(h.diagnostics.filter(code=>code==='gaze_frame_retry').length,4);
  await emitFrames(h,[1810]);
  assert.equal(h.errors.length,1);
  assert.equal(h.errors[0].code,'gaze_remote_inference_failed');
  assert.equal(h.errors[0].detail,'gaze_inference_failed');
  assert.equal(h.controller.telemetry().counts.failed,5);
});

test('a successful frame resets the failure streak',async()=>{
  const h=harness({frameFailure:calls=>[1,2,3,4,6,7,8,9,10].includes(calls)?'GAZE_REMOTE_TIMEOUT':null});
  await h.controller.start({userInitiated:true,cameraConsent:true});
  await emitFrames(h,spaced(9));
  assert.equal(h.errors.length,0);assert.equal(h.samples.length,1);
  await emitFrames(h,[3000]);
  assert.equal(h.errors.length,1);assert.equal(h.errors[0].detail,'gaze_remote_timeout');
});

test('failures that cannot recover stop tracking immediately',async()=>{
  const gone=harness({frameFailure:'GAZE_SESSION_UNAVAILABLE'});
  await gone.controller.start({userInitiated:true,cameraConsent:true});await emitFrames(gone,[1010]);
  assert.equal(gone.errors.length,1);assert.equal(gone.errors[0].detail,'gaze_session_unavailable');
  const odd=harness({frameFailure:'not a code'});
  await odd.controller.start({userInitiated:true,cameraConsent:true});await emitFrames(odd,spaced(5));
  assert.equal(odd.errors.length,1);assert.equal(odd.errors[0].detail,'gaze_remote_unavailable');
});

test('closed-eye responses carry their eye aspect ratios and the wait message names the real reason',async()=>{
  const h=harness({frameFields:{gazeState:'closed',normPog:[0,0],eyeAspectRatio:{left:.18,right:.26,threshold:.2}}});
  await h.controller.start({userInitiated:true,cameraConsent:true});
  h.video.emit(1010);await h.flush();
  const sample=h.samples[0];
  assert.equal(sample.features,null);
  assert.deepEqual(sample.eyeAspectRatio,{left:.18,right:.26,threshold:.2});
  assert.match(describeOpenEyeWait(sample),/eyes judged closed \(EAR left 0\.18 · right 0\.26; closed if either is under 0\.20\)/);
  const bad=harness({frameFields:{gazeState:'closed',normPog:[0,0],eyeAspectRatio:{left:'x',right:.26,threshold:.2}}});
  await bad.controller.start({userInitiated:true,cameraConsent:true});
  bad.video.emit(1010);await bad.flush();
  assert.equal(bad.samples[0].eyeAspectRatio,null);
  assert.equal(describeOpenEyeWait(bad.samples[0]),'Server response: eyes judged closed');
});

test('open-eye wait descriptions distinguish no response, no face, closed eyes and missing gaze points',()=>{
  assert.equal(describeOpenEyeWait(null),'No server response yet');
  assert.equal(describeOpenEyeWait({faceDetected:false}),'Server response: no face detected');
  assert.equal(describeOpenEyeWait({faceDetected:true,gazeState:'open',features:null}),'Server response: no gaze coordinates');
  assert.equal(describeOpenEyeWait({faceDetected:true,gazeState:'open',features:[.5,.5]}),'Server response: open eyes confirmed');
});

test('a server that found no face names whether landmarks or the eye patch failed', async () => {
  const eyePatch = harness({frameFields: {faceDetected: false, gazeState: 'unknown', normPog: null, trackingFailure: {stage: 'eye_patch', message: 'shape mismatch'}}});
  await eyePatch.controller.start({userInitiated: true, cameraConsent: true});
  eyePatch.video.emit(1010); await eyePatch.flush();
  assert.deepEqual(eyePatch.samples[0].trackingFailure, {stage: 'eye_patch', message: 'shape mismatch'});
  assert.equal(describeOpenEyeWait(eyePatch.samples[0]), 'Server response: face found but the eye region could not be extracted (shape mismatch)');
  const landmarks = harness({frameFields: {faceDetected: false, gazeState: 'unknown', normPog: null, trackingFailure: {stage: 'landmarks', message: null}}});
  await landmarks.controller.start({userInitiated: true, cameraConsent: true});
  landmarks.video.emit(1010); await landmarks.flush();
  assert.equal(describeOpenEyeWait(landmarks.samples[0]), 'Server response: no face detected');
  assert.equal(describeOpenEyeWait({faceDetected: false}), 'Server response: no face detected');
  const base = {status: 'insufficient', totalFrames: 5, faceFrames: 0, closedFrames: 0, usableFrames: 0, frameErrors: 0, eyeAspectRatio: null};
  assert.equal(describeCalibrationTarget({...base, eyePatchFailures: 5, failureMessage: 'shape mismatch'}), 'Face found but eye region extraction failed in 5/5 frames (shape mismatch)');
  assert.equal(describeCalibrationTarget({...base, eyePatchFailures: 0}), 'No face detected (5 frames)');
});

test('two live frames are pipelined so a result does not wait a full round trip for the next request',async()=>{
  const h=harness({holdFirstFrame:true});await h.controller.start({userInitiated:true,cameraConsent:true});
  h.video.emit(1010);await h.flush();assert.equal(h.counts().frameCalls,1);
  h.video.emit(1200);await h.flush();assert.equal(h.counts().frameCalls,2,'second frame sent while the first is still on the GPU');
  assert.equal(h.samples.length,1);assert.equal(h.samples[0].captureSourceMs,1200);
  h.releaseFirst();await h.flush();
  assert.equal(h.samples.length,1,'the older result arriving late is dropped, not published');
  assert.equal(h.controller.telemetry().counts.staleDropped,1);
  await h.controller.stop();
});

test('a pipelined frame overtaken by a newer one is dropped without counting as a failure',async()=>{
  const h=harness({frameFailure:'GAZE_FRAME_OUT_OF_ORDER'});await h.controller.start({userInitiated:true,cameraConsent:true});
  for(const t of spaced(7)){h.setTime(t);h.video.emit(t);await h.flush();}
  assert.equal(h.errors.length,0);assert.equal(h.controller.telemetry().counts.outOfOrder,7);assert.equal(h.controller.telemetry().counts.failed,0);
  await h.controller.stop();
});

test('stored adapters may carry the calibration affine and nothing else extra',()=>{
  const sample=adapter();
  assert.equal(validateRemoteGazeAdapter({...sample,affine:[[1.1,0,.01],[0,.9,-.02]]},model),true);
  assert.equal(validateRemoteGazeAdapter({...sample,affine:[[1,0,0]]},model),false);
  assert.equal(validateRemoteGazeAdapter({...sample,affine:[[1,0,0],[0,1,500]]},model),false);
  assert.equal(validateRemoteGazeAdapter({...sample,extra:1},model),false);
});

test('the physical screen size is sent with the session only when it is valid',async()=>{
  const h=harness({screenCm:[30.2,18.9]});await h.controller.start({userInitiated:true,cameraConsent:true});
  assert.deepEqual(JSON.parse(h.calls.find(call=>call.url==='/api/gaze/sessions').options.body).screenCmDimensions,[30.2,18.9]);
  await h.controller.stop();
  const bad=harness({screenCm:[0,18.9]});await bad.controller.start({userInitiated:true,cameraConsent:true});
  assert.equal('screenCmDimensions' in JSON.parse(bad.calls.find(call=>call.url==='/api/gaze/sessions').options.body),false);
  await bad.controller.stop();
});

test('click calibration works from the first frame like the official demo and sends the clicked point with two fresh frames',async()=>{
  const cold=harness();await cold.controller.start({userInitiated:true,cameraConsent:true});
  assert.equal(cold.controller.calibrated,true);assert.equal(cold.controller.official,true);
  assert.equal((await cold.controller.clickCorrection({x:10,y:10})).adapted,true);await cold.controller.stop();
  await assert.rejects(cold.controller.clickCorrection({x:10,y:10}),/unavailable/);
  const h=harness({restoreAdapter:adapter()});await h.controller.start({userInitiated:true,cameraConsent:true});
  assert.deepEqual(await h.controller.clickCorrection({x:600,y:150}),{adapted:true,usableFrames:2,totalFrames:2});
  const body=JSON.parse(h.calls.find(call=>call.url.endsWith('/calibration/click')).options.body);
  assert.deepEqual(body.target,[.25,-.25]);assert.equal(body.frames.length,2);assert.ok(body.frames[1].frameId>body.frames[0].frameId);
  await h.controller.stop();
  const none=harness({restoreAdapter:adapter(),clickStatus:'insufficient'});await none.controller.start({userInitiated:true,cameraConsent:true});
  assert.deepEqual(await none.controller.clickCorrection({x:0,y:0}),{adapted:false,usableFrames:0,totalFrames:2});
  await none.controller.stop();
});
