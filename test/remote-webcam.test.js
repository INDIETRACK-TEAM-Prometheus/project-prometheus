import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfiledWebcamGazeController,createRemoteWebcamGazeController,describeOpenEyeWait,validateRemoteGazeAdapter} from '../src/gaze/remote-webcam.js';

const model={id:'webeyetrack-blazegaze-mpiifacegaze',sourceCommit:'75fbd2f5f784f2eb3a39675a8dcbf1b01c697f1c',sha256:'a'.repeat(64)};
const shapes=[[518,16],[16],[16,16],[16],[16,2],[2]];
function adapter(){return {schemaVersion:1,adapterId:'webeyetrack-gaze-mlp-f32-v1',modelId:model.id,sourceCommit:model.sourceCommit,modelSha256:model.sha256,weights:shapes.map(shape=>{const count=shape.reduce((n,x)=>n*x,1),bytes=Buffer.alloc(count*4);for(let i=0;i<count;i++)bytes.writeFloatLE(.125,i*4);return {shape,dtype:'float32-le',data:bytes.toString('base64')};})};}
function response(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});}

function harness({ready=true,restoreAdapter=null,holdFirstFrame=false,frameHz=8,frameFailure=null,frameFields=null}={}){
  let now=1000,callback=null,callbackId=0,mediaOpens=0,trackStops=0,frameCalls=0,resolveFirst=null,active=false;
  const errors=[],samples=[],calls=[],video={videoWidth:1280,videoHeight:720,srcObject:null,async play(){},pause(){},requestVideoFrameCallback(fn){callback=fn;return ++callbackId;},cancelVideoFrameCallback(){callback=null;},emit(captureTime=now){now=captureTime;const fn=callback;callback=null;assert.ok(fn,'video frame callback scheduled');fn(now,{captureTime});}};
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
    if(url.endsWith('/calibration/sample')){const input=JSON.parse(options.body);return response({adapted:input.pointIndex===26,points:input.pointIndex+1});}
    if(url.endsWith('/frame')){
      frameCalls++;if(frameFailure)return response({error:'gaze_unavailable',code:frameFailure},503);const headers=options.headers,frameId=Number(headers['x-frame-id']),captureTimestampMs=Number(headers['x-capture-timestamp-ms']);
      if(holdFirstFrame&&frameCalls===1)await new Promise(resolve=>{resolveFirst=resolve;options.signal.addEventListener('abort',()=>resolveFirst?.(),{once:true});});
      return response({status:'ok',frameId,captureTimestampMs,faceDetected:true,gazeState:'open',normPog:[0,.1],durations:{total:7},...(frameFields??{})});
    }
    throw new Error(`unexpected request ${url}`);
  };
  const canvas={width:0,height:0,getContext(){return {drawImage(){}};},toBlob(done,type){done(new Blob([Uint8Array.from([255,216,255,217])],{type}));}};
  const diagnostics=[];
  const controller=createRemoteWebcamGazeController({video,mediaDevices,fetchImpl,createCanvas:()=>canvas,clockNow:()=>now,getViewport:()=>({width:800,height:600}),maxFrameHz:frameHz,getAdapter:async()=>restoreAdapter,onSample:sample=>samples.push(sample),onError:error=>errors.push(error),onDiagnostic:code=>diagnostics.push(code)});
  return {controller,video,samples,errors,calls,diagnostics,counts:()=>({mediaOpens,trackStops,frameCalls,active}),setTime(value){now=value;},async flush(){for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));},releaseFirst(){resolveFirst?.();resolveFirst=null;}};
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

test('cloud calibration uses 27 fresh frame IDs, accepts model-only weights, and can restore them',async()=>{
  const h=harness();await h.controller.start({userInitiated:true,cameraConsent:true});await h.controller.beginCalibration();
  for(let index=0;index<27;index++){
    const before=h.samples.length;h.video.emit(1100+index*150);await h.flush();assert.equal(h.samples.length,before+1);
    const result=await h.controller.calibrate({x:400,y:300},-Infinity,250);
    assert.equal(result.points,index+1);assert.equal(result.adapted,index===26);
  }
  const committed=await h.controller.commitCalibration();assert.equal(validateRemoteGazeAdapter(committed.adapter,model),true);
  const saved=harness({restoreAdapter:committed.adapter});await saved.controller.start({userInitiated:true,cameraConsent:true});
  const createCall=saved.calls.find(call=>call.url==='/api/gaze/sessions'&&call.options.method==='POST');
  assert.ok(JSON.parse(createCall.options.body).adapter);assert.equal(saved.controller.calibrated,true);
  saved.video.emit(6000);await saved.flush();assert.equal(saved.samples[0].valid,true);
  await saved.controller.stop();await h.controller.stop();
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

test('a failed remote frame stops tracking with the underlying reason attached',async()=>{
  const worker=harness({frameFailure:'GAZE_INFERENCE_FAILED'});
  await worker.controller.start({userInitiated:true,cameraConsent:true});
  worker.video.emit(1010);await worker.flush();
  assert.equal(worker.errors.length,1);
  assert.equal(worker.errors[0].code,'gaze_remote_inference_failed');
  assert.equal(worker.errors[0].detail,'gaze_inference_failed');
  assert.equal(worker.controller.telemetry().counts.failed,1);
  const timeout=harness({frameFailure:'GAZE_REMOTE_TIMEOUT'});
  await timeout.controller.start({userInitiated:true,cameraConsent:true});
  timeout.video.emit(1010);await timeout.flush();
  assert.equal(timeout.errors[0].detail,'gaze_remote_timeout');
  const odd=harness({frameFailure:'not a code'});
  await odd.controller.start({userInitiated:true,cameraConsent:true});
  odd.video.emit(1010);await odd.flush();
  assert.equal(odd.errors[0].code,'gaze_remote_inference_failed');
  assert.equal(odd.errors[0].detail,'gaze_remote_unavailable');
});

test('closed-eye responses carry their eye aspect ratios and the wait message names the real reason',async()=>{
  const h=harness({frameFields:{gazeState:'closed',normPog:[0,0],eyeAspectRatio:{left:.18,right:.26,threshold:.2}}});
  await h.controller.start({userInitiated:true,cameraConsent:true});
  h.video.emit(1010);await h.flush();
  const sample=h.samples[0];
  assert.equal(sample.features,null);
  assert.deepEqual(sample.eyeAspectRatio,{left:.18,right:.26,threshold:.2});
  assert.match(describeOpenEyeWait(sample),/눈 감김 판정 \(EAR 왼쪽 0\.18 · 오른쪽 0\.26, 한쪽이라도 0\.20 미만이면 감김\)/);
  const bad=harness({frameFields:{gazeState:'closed',normPog:[0,0],eyeAspectRatio:{left:'x',right:.26,threshold:.2}}});
  await bad.controller.start({userInitiated:true,cameraConsent:true});
  bad.video.emit(1010);await bad.flush();
  assert.equal(bad.samples[0].eyeAspectRatio,null);
  assert.equal(describeOpenEyeWait(bad.samples[0]),'서버 응답: 눈 감김 판정');
});

test('open-eye wait descriptions distinguish no response, no face, closed eyes and missing gaze points',()=>{
  assert.equal(describeOpenEyeWait(null),'아직 서버 응답이 없습니다');
  assert.equal(describeOpenEyeWait({faceDetected:false}),'서버 응답: 얼굴 미검출');
  assert.equal(describeOpenEyeWait({faceDetected:true,gazeState:'open',features:null}),'서버 응답: 시선 좌표 없음');
  assert.equal(describeOpenEyeWait({faceDetected:true,gazeState:'open',features:[.5,.5]}),'서버 응답: 열린 눈 확인');
});
