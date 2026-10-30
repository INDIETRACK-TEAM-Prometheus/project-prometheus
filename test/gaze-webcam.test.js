import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebcamGazeController} from '../src/gaze/webcam.js';

function harness({normPog=[-.25,.25],landmarkFeatures=null,getUserMedia:acquireCamera=null,autoReady=true,workerReadyTimeoutMs=10000,createCanvas:makeCanvas=null}={}) {
  let callback=null, currentTime=0, nowMs=100, cameraOpens=0, trackStops=0, frameCounter=0;
  const workers=[],diagnostics=[],errors=[];
  const track={stop(){trackStops++;},getSettings(){return {width:2,height:2,frameRate:30,deviceId:'private-device-id'};}};
  const mediaDevices={async getUserMedia(request){cameraOpens++;assert.deepEqual(request.audio,false);return acquireCamera?acquireCamera(request):{getTracks:()=>[track],getVideoTracks:()=>[track]};}};
  const video={
    videoWidth:2,videoHeight:2,currentTime:0,srcObject:null,
    async play(){},pause(){},
    requestVideoFrameCallback(fn){callback=fn;return ++frameCounter;},
    cancelVideoFrameCallback(){callback=null;},
    emit({captureTime}={}){currentTime++;this.currentTime=currentTime;const fn=callback;callback=null;assert.ok(fn,'a video-frame callback should be scheduled');fn(nowMs++,captureTime===undefined?{}:{captureTime});}
  };
  const workerFactory=(url,options)=>{
    const worker={url,options,messages:[],terminated:false,onmessage:null,onerror:null,
      postMessage(message,transfer=[]){
        this.messages.push({message,transfer});
        if(message.type==='init'&&autoReady)queueMicrotask(()=>this.onmessage?.({data:{type:'ready'}}));
        if(message.type==='frame')queueMicrotask(()=>this.onmessage?.({data:{
          type:'result',frameId:message.frameId,faceDetected:true,gazeState:'open',normPog,landmarkFeatures,
          eyeCrops:{left:{x:0,y:0,width:1,height:1},right:{x:1,y:0,width:1,height:1}},
          durations:{total:.01},width:message.width,height:message.height,
          captureTimestampMs:message.captureTimestampMs,callbackTimestampMs:message.callbackTimestampMs,
          timestampKind:message.timestampKind,sentAtMs:message.sentAtMs
        }}));
        if(message.type==='adapt')queueMicrotask(()=>this.onmessage?.({data:{type:'adapted',requestId:message.requestId,points:1}}));
      },terminate(){this.terminated=true;}
    };
    workers.push(worker);return worker;
  };
  const createCanvas=makeCanvas??(()=>{
    const canvas={width:0,height:0,getContext(){return {
      drawImage(){},
      getImageData(_x,_y,width,height){return {width,height,data:new Uint8ClampedArray(width*height*4)}}
    };}};
    return canvas;
  });
  const samples=[];
  const controller=createWebcamGazeController({
    video,mediaDevices,workerFactory,createCanvas,workerReadyTimeoutMs,
    clockNow:()=>nowMs++,getViewport:()=>({width:800,height:600}),
    onSample:sample=>samples.push(sample),onError:error=>errors.push(error),onDiagnostic:code=>diagnostics.push(code)
  });
  return {controller,video,workers,samples,diagnostics,errors,counters:()=>({cameraOpens,trackStops}),advanceClock(ms){nowMs+=ms;},async flush(){await new Promise(resolve=>setImmediate(resolve));}};
}

test('camera opens only after explicit consent and sends a local worker sample',async()=>{
  const h=harness();
  await assert.rejects(h.controller.start({userInitiated:true}),/consent/);
  assert.equal(h.workers.length,0);assert.deepEqual(h.counters(),{cameraOpens:0,trackStops:0});
  const settings=await h.controller.start({userInitiated:true,cameraConsent:true});
  assert.deepEqual(settings,{width:2,height:2,frameRate:30});
  assert.equal(h.counters().cameraOpens,1);assert.equal(h.workers.length,1);
  assert.deepEqual(h.workers[0].options,{name:'prometheus-webeyetrack'});
  h.video.emit();await h.flush();
  assert.equal(h.samples.length,1);
  assert.equal(h.samples[0].invalidReason,'calibration_required');
  assert.equal(h.samples[0].valid,false);
  assert.deepEqual(h.samples[0].features,[.25,.75]);
  assert.deepEqual(h.samples[0].rawScreenXY,{x:200,y:450});
  assert.deepEqual(h.samples[0].leftEye.crop,{x:0,y:0,width:1,height:1});
  assert.equal(h.samples[0].timestampKind,'callback_time_not_capture');
  assert.equal(h.workers[0].url,'/src/gaze/webeyetrack-worker.js');
  h.controller.stop();
  assert.deepEqual(h.counters(),{cameraOpens:1,trackStops:1});
  assert.equal(h.workers[0].terminated,true);assert.equal(h.video.srcObject,null);
  for(const code of ['camera_request_started','camera_stream_acquired','worker_created','worker_ready','video_attached','video_playback_started','capture_started','camera_stop_requested','camera_stopped']) assert.ok(h.diagnostics.includes(code),code);
  assert.ok(h.diagnostics.every(code=>/^[a-z_]+$/.test(code)));
});

test('derived landmark cues reach the page only as a finite bounded feature vector',async()=>{
  const good=harness({landmarkFeatures:[.1,-.2,.3]});await good.controller.start({userInitiated:true,cameraConsent:true});good.video.emit();await good.flush();
  assert.deepEqual(good.samples[0].landmarkFeatures,[.1,-.2,.3]);good.controller.stop();
  const malformed=harness({landmarkFeatures:[.1,Infinity,0]});await malformed.controller.start({userInitiated:true,cameraConsent:true});malformed.video.emit();await malformed.flush();
  assert.equal(malformed.samples[0].landmarkFeatures,null);malformed.controller.stop();
});

test('camera permission is requested synchronously before waiting for the worker',async()=>{
  const h=harness({autoReady:false});
  const pending=h.controller.start({userInitiated:true,cameraConsent:true});
  assert.equal(h.counters().cameraOpens,1);
  assert.equal(h.workers.length,1);
  h.workers[0].onmessage({data:{type:'ready'}});
  await pending;
  h.controller.stop();
});

test('camera permission failures keep a fixed diagnostic code and discard the browser message',async()=>{
  const failure=Object.assign(new Error('private browser detail'),{name:'NotAllowedError'});
  const h=harness({getUserMedia:()=>Promise.reject(failure)});
  await assert.rejects(h.controller.start({userInitiated:true,cameraConsent:true}),error=>error.code==='camera_permission_denied'&&!error.message.includes('private browser detail'));
  assert.equal(h.workers[0].terminated,true);
});

test('worker initialization failures keep a fixed diagnostic code and discard worker text',async()=>{
  const h=harness({autoReady:false});
  const pending=h.controller.start({userInitiated:true,cameraConsent:true});
  await h.flush();
  h.workers[0].onmessage({data:{type:'error',fatal:true,error:'private worker detail'}});
  await assert.rejects(pending,error=>error.code==='worker_initialization_failed'&&!error.message.includes('private worker detail'));
  assert.deepEqual(h.counters(),{cameraOpens:1,trackStops:1});
  assert.equal(h.workers[0].terminated,true);
  assert.ok(h.diagnostics.includes('worker_initialization_failed'));
  assert.equal(JSON.stringify(h.diagnostics).includes('private worker detail'),false);
});

test('worker initialization timeout stops an already acquired camera stream',async()=>{
  const h=harness({autoReady:false,workerReadyTimeoutMs:5});
  await assert.rejects(h.controller.start({userInitiated:true,cameraConsent:true}),error=>error.code==='worker_initialization_timeout');
  assert.deepEqual(h.counters(),{cameraOpens:1,trackStops:1});
  assert.equal(h.workers[0].terminated,true);
  assert.equal(h.video.srcObject,null);
  assert.ok(h.diagnostics.includes('worker_initialization_timeout'));
});

test('fatal worker inference reports a fixed code without exposing worker text or gaze values',async()=>{
  const h=harness();await h.controller.start({userInitiated:true,cameraConsent:true});
  h.workers[0].onmessage({data:{type:'error',fatal:true,code:'untrusted_code',step:'untrusted_step',error:'private worker text',normPog:[.123,.456]}});
  assert.equal(h.errors.at(-1).code,'worker_inference_failed');
  assert.equal(h.diagnostics.at(-1),'worker_inference_failed');
  assert.equal(JSON.stringify(h.diagnostics).includes('private'),false);
  assert.equal(JSON.stringify(h.diagnostics).includes('.123'),false);
  h.controller.stop();
});

test('capture failure stops the camera with a fixed capture code',async()=>{
  const h=harness({createCanvas(){throw new Error('private canvas detail');}});
  await h.controller.start({userInitiated:true,cameraConsent:true});
  h.video.emit();
  assert.equal(h.errors.at(-1).code,'capture_frame_failed');
  assert.deepEqual(h.counters(),{cameraOpens:1,trackStops:1});
  assert.ok(h.diagnostics.includes('capture_frame_failed'));
  assert.equal(JSON.stringify(h.diagnostics).includes('private canvas detail'),false);
});

test('official adapt targets use normalized screen coordinates and commit validation state',async()=>{
  const h=harness();
  await h.controller.start({userInitiated:true,cameraConsent:true});
  await h.controller.beginCalibration();
  assert.equal(h.workers.length,2);
  h.video.emit({captureTime:110});await h.flush();
  assert.equal(h.workers[0].messages.filter(entry=>entry.message.type==='frame').length,0,'the previous tracker is idle during calibration');
  assert.equal(h.workers[1].messages.filter(entry=>entry.message.type==='frame').length,1,'only the calibration candidate processes frames');
  assert.equal(h.samples.at(-1).valid,false);
  const calibrationSample=h.samples.at(-1);
  await assert.rejects(h.controller.calibrate({x:600,y:150},calibrationSample.callbackTimestampMs+1),/fresh open-eye/);
  const adapted=await h.controller.calibrate({x:600,y:150});
  assert.deepEqual(adapted,{adapted:true,points:1});
  const adaptation=h.workers[1].messages.find(entry=>entry.message.type==='adapt').message;
  assert.deepEqual(adaptation.target,{x:.25,y:-.25});
  assert.equal(adaptation.frameId,calibrationSample.frameId);
  h.controller.commitCalibration();
  h.video.emit({captureTime:120});await h.flush();
  assert.equal(h.samples.at(-1).valid,true);
  assert.equal(h.samples.at(-1).timestampMs,120);
  assert.equal(h.counters().cameraOpens,1,'candidate worker reuses the page-owned stream');
  h.controller.stop();
  assert.ok(h.workers.every(worker=>worker.terminated));
});

test('calibration rejects samples older than the callback-time freshness window',async()=>{
  const h=harness();
  await h.controller.start({userInitiated:true,cameraConsent:true});
  await h.controller.beginCalibration();
  h.video.emit();await h.flush();
  const sample=h.samples.at(-1);
  h.advanceClock(251);
  await assert.rejects(h.controller.calibrate({x:400,y:300},sample.callbackTimestampMs),/fresh open-eye/);
  assert.equal(h.workers[1].messages.filter(entry=>entry.message.type==='adapt').length,0);
  h.controller.stop();
});

test('cancelled recalibration restores the prior in-memory tracker without reopening camera',async()=>{
  const h=harness();
  await h.controller.start({userInitiated:true,cameraConsent:true});
  await h.controller.beginCalibration();
  h.video.emit();await h.flush();
  await h.controller.calibrate({x:400,y:300});
  h.controller.commitCalibration();
  const acceptedWorker=h.workers[1];
  await h.controller.beginCalibration();
  h.video.emit();await h.flush();
  assert.equal(h.samples.at(-1).valid,false);
  h.controller.cancelCalibration();
  assert.equal(h.workers[2].terminated,true);
  h.video.emit();await h.flush();
  assert.equal(h.samples.at(-1).valid,true);
  assert.equal(h.workers[1],acceptedWorker);
  assert.equal(h.counters().cameraOpens,1);
  h.controller.stop();
});

test('stop during pending camera permission closes the stream when permission resolves',async()=>{
  let resolvePermission,stopped=0;
  const h=harness({getUserMedia:()=>new Promise(resolve=>{resolvePermission=resolve;})});
  const pending=h.controller.start({userInitiated:true,cameraConsent:true});
  await h.flush();
  assert.equal(typeof resolvePermission,'function');
  h.controller.stop();
  resolvePermission({getTracks:()=>[{stop(){stopped++;}}],getVideoTracks:()=>[]});
  await assert.rejects(pending,/start cancelled/);
  assert.equal(stopped,1);
  assert.equal(h.video.srcObject,null);
  assert.equal(h.workers[0].terminated,true);
});

test('late permission from a stopped start cannot replace a restarted camera stream',async()=>{
  const permissions=[];
  let oldStreamStops=0,currentStreamStops=0;
  const h=harness({getUserMedia:()=>new Promise(resolve=>permissions.push(resolve))});
  const makeStream=stop=>{
    const track={stop,getSettings(){return {width:2,height:2,frameRate:30};}};
    return {getTracks:()=>[track],getVideoTracks:()=>[track]};
  };
  const oldStart=h.controller.start({userInitiated:true,cameraConsent:true});
  await h.flush();
  h.controller.stop();
  const restarted=h.controller.start({userInitiated:true,cameraConsent:true});
  await h.flush();
  const currentStream=makeStream(()=>currentStreamStops++);
  permissions[1](currentStream);
  await restarted;
  const oldStream=makeStream(()=>oldStreamStops++);
  permissions[0](oldStream);
  await assert.rejects(oldStart,/start cancelled/);
  assert.equal(oldStreamStops,1);
  assert.equal(h.video.srcObject,currentStream);
  assert.equal(h.workers[1].terminated,false);
  h.controller.stop();
  assert.equal(currentStreamStops,1);
});
