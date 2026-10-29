import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebcamGazeController} from '../src/gaze/webcam.js';

function harness(result = {faceLandmarks:[],faceBlendshapes:[]}) {
  let callback, loads=0, captures=0, stops=0, closes=0;
  const video={videoWidth:640,videoHeight:480,currentTime:1,srcObject:null,play:async()=>{},requestVideoFrameCallback(fn){callback=fn;return 1;},cancelVideoFrameCallback(){callback=null;}};
  const detector={detectForVideo(){return result;},close(){closes++;}};
  const loadVision=async()=>{loads++;return {FilesetResolver:{forVisionTasks:async()=>({})},FaceLandmarker:{createFromOptions:async()=>detector}};};
  const track={stop(){stops++;},getSettings(){return {width:640,height:480,frameRate:30,deviceId:'device'};}};
  const mediaDevices={getUserMedia:async()=>{captures++;return {getTracks:()=>[track],getVideoTracks:()=>[track]};}};
  return {video,loadVision,mediaDevices,counts:()=>({loads,captures,stops,closes}),frame:(now=123,metadata={})=>callback(now,metadata)};
}
test('webcam loads and captures only after explicit consent; no face means no gaze', async()=>{
  const h=harness(), samples=[];
  const c=createWebcamGazeController({...h,wasmRoot:'/wasm',modelAssetPath:'/model.task',onSample:s=>samples.push(s)});
  await assert.rejects(c.start({userInitiated:true}),/consent/); assert.equal(h.counts().loads,0); assert.equal(h.counts().captures,0);
  const settings=await c.start({userInitiated:true,cameraConsent:true}); assert.equal(settings.width,640);
  h.frame(); assert.equal(samples[0].invalidReason,'face_not_detected'); assert.equal(samples[0].rawScreenXY,null); assert.equal(samples[0].timestampKind,'callback_time_not_capture');
  assert.equal(samples[0].syncUncertaintyMs,null); assert.equal(samples[0].sceneAssociationEligible,false);
  c.stop(); assert.deepEqual(h.counts(),{loads:1,captures:1,stops:1,closes:1}); assert.equal(h.video.srcObject,null);
});
test('anatomical eye crop and iris indices follow MediaPipe topology', async()=>{
  const marks=Array.from({length:478},()=>({x:.5,y:.5}));
  marks[263]={x:.6,y:.4}; marks[362]={x:.8,y:.4}; marks[33]={x:.2,y:.4}; marks[133]={x:.4,y:.4};
  for (const i of [474,475,476,477]) marks[i]={x:.7,y:.4};
  for (const i of [469,470,471,472]) marks[i]={x:.3,y:.4};
  const h=harness({faceLandmarks:[marks],faceBlendshapes:[{categories:[{categoryName:'eyeBlinkLeft',score:0},{categoryName:'eyeBlinkRight',score:0}]}]}), samples=[];
  const c=createWebcamGazeController({...h,wasmRoot:'/wasm',modelAssetPath:'/model.task',onSample:s=>samples.push(s)});
  await c.start({userInitiated:true,cameraConsent:true}); h.frame();
  assert.equal(samples[0].leftEye.corners[0].x,384); assert.equal(samples[0].rightEye.corners[0].x,128);
  assert.equal(samples[0].leftEye.iris.x,448); assert.equal(samples[0].rightEye.iris.x,192);
  assert.equal(samples[0].rawScreenXY,null); c.stop();
});
test('browser captureTime remains unaligned until clock and display timing are measured', async()=>{
  const h=harness(), samples=[];const c=createWebcamGazeController({...h,wasmRoot:'/wasm',modelAssetPath:'/model.task',onSample:s=>samples.push(s)});
  await c.start({userInitiated:true,cameraConsent:true});h.frame(130,{captureTime:110});
  assert.equal(samples[0].timestampMs,110);assert.equal(samples[0].timestampKind,'browser_capture_estimate');assert.equal(samples[0].sourceClockId,'browser_video_capture_estimate');
  assert.equal(samples[0].syncStatus,'unmeasured');assert.equal(samples[0].syncOffsetMs,null);assert.equal(samples[0].syncDriftPpm,null);assert.equal(samples[0].syncUncertaintyMs,null);
  assert.equal(samples[0].scenePresentTsEstimateMs,null);assert.equal(samples[0].displayUncertaintyMs,null);assert.equal(samples[0].sceneAssociationEligible,false);c.stop();
});
test('stop while permission is pending stops the eventual stream', async()=>{
  const h=harness(); let resolve; let stopped=0;
  h.mediaDevices.getUserMedia=()=>new Promise(r=>{resolve=r;});
  const c=createWebcamGazeController({...h,wasmRoot:'/wasm',modelAssetPath:'/model.task'});
  const pending=c.start({userInitiated:true,cameraConsent:true});
  while (!resolve) await new Promise(r=>setImmediate(r));
  c.stop(); resolve({getTracks:()=>[{stop(){stopped++;}}]}); await pending;
  assert.equal(stopped,1); assert.equal(h.video.srcObject,null); assert.equal(h.counts().closes,1);
});
