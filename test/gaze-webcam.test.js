import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebcamGazeController} from '../src/gaze/webcam.js';
import {estimateUncalibratedGaze} from '../src/gaze/uncalibrated.js';

function harness(result = {faceLandmarks:[],faceBlendshapes:[]}) {
  let callback, mediaRequest, loads=0, captures=0, stops=0, closes=0;
  const video={videoWidth:640,videoHeight:480,currentTime:1,srcObject:null,play:async()=>{},requestVideoFrameCallback(fn){callback=fn;return 1;},cancelVideoFrameCallback(){callback=null;}};
  const detector={detectForVideo(){return result;},close(){closes++;}};
  const loadVision=async()=>{loads++;return {FilesetResolver:{forVisionTasks:async()=>({})},FaceLandmarker:{createFromOptions:async()=>detector}};};
  const track={stop(){stops++;},getSettings(){return {width:640,height:480,frameRate:30,deviceId:'device'};}};
  const mediaDevices={getUserMedia:async request=>{mediaRequest=request;captures++;return {getTracks:()=>[track],getVideoTracks:()=>[track]};}};
  return {video,loadVision,mediaDevices,counts:()=>({loads,captures,stops,closes}),mediaRequest:()=>mediaRequest,frame:(now=123,metadata={})=>callback(now,metadata)};
}
function openEyes() {
  const marks=Array.from({length:478},()=>({x:.5,y:.5}));
  marks[263]={x:.6,y:.4}; marks[362]={x:.8,y:.4}; marks[33]={x:.2,y:.4}; marks[133]={x:.4,y:.4};
  [[474,.694,.4],[475,.706,.4],[476,.7,.396],[477,.7,.404],[469,.294,.4],[470,.306,.4],[471,.3,.396],[472,.3,.404]].forEach(([i,x,y])=>marks[i]={x,y});
  return marks;
}
async function detectEyeSample(marks, leftScore=0, rightScore=0) {
  const h=harness({faceLandmarks:[marks],faceBlendshapes:[{categories:[{categoryName:'eyeBlinkLeft',score:leftScore},{categoryName:'eyeBlinkRight',score:rightScore}]}]}), samples=[];
  const c=createWebcamGazeController({...h,wasmRoot:'/wasm',modelAssetPath:'/model.task',onSample:s=>samples.push(s)});
  await c.start({userInitiated:true,cameraConsent:true});
  c.setCalibration({dimension:4,x:[.5,0,0,0,0],y:[.5,0,0,0,0],featureBounds:Array.from({length:4},()=>({min:-1,max:1}))});
  h.frame(); c.stop(); return samples[0];
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
  const sample=await detectEyeSample(openEyes());
  assert.equal(sample.leftEye.corners[0].x,384); assert.equal(sample.rightEye.corners[0].x,128);
  assert.equal(sample.leftEye.iris.x,448); assert.equal(sample.rightEye.iris.x,192);
  assert.equal(sample.valid,true); assert.deepEqual(sample.rawScreenXY,{x:.5,y:.5});
});
test('low or malformed provider landmark quality withholds gaze without inventing confidence',async()=>{
  const low=openEyes();low[474].visibility=.2;
  const lowSample=await detectEyeSample(low);
  assert.equal(lowSample.leftEye.reason,'landmark_visibility_low');assert.equal(lowSample.leftEye.confidence,null);assert.equal(lowSample.valid,false);assert.equal(lowSample.rawScreenXY,null);
  const malformed=openEyes();malformed[474].presence=NaN;
  const malformedSample=await detectEyeSample(malformed);
  assert.equal(malformedSample.leftEye.reason,'landmark_quality_invalid');assert.equal(malformedSample.rawScreenXY,null);
});
test('collapsed iris landmarks and blink uncertainty withhold gaze',async()=>{
  const collapsed=openEyes();for(const i of [474,475,476,477])collapsed[i]={x:.7,y:.4};
  const collapsedSample=await detectEyeSample(collapsed);
  assert.equal(collapsedSample.leftEye.reason,'landmarks_degenerate');assert.equal(collapsedSample.rawScreenXY,null);
  const blinkSample=await detectEyeSample(openEyes(),NaN,0);
  assert.equal(blinkSample.leftEye.reason,'blink_unknown');assert.equal(blinkSample.valid,false);assert.equal(blinkSample.rawScreenXY,null);
});
test('one valid eye can drive only the separate uncalibrated estimate, never binocular calibration',async()=>{
  const sample=await detectEyeSample(openEyes(),0,.5);
  assert.equal(sample.leftEye.valid,true);assert.equal(sample.rightEye.valid,false);
  assert.equal(sample.features,null);assert.equal(sample.rawScreenXY,null);assert.equal(sample.valid,false);
  const estimate=estimateUncalibratedGaze({leftEye:sample.leftEye,rightEye:sample.rightEye});
  assert.equal(estimate.status,'uncalibrated_estimate');assert.equal(estimate.method,'single_eye_iris_relative_to_eye_corners');assert.deepEqual(estimate.eyesUsed,['left']);
});
test('browser captureTime remains unaligned until clock and display timing are measured', async()=>{
  const h=harness(), samples=[];const c=createWebcamGazeController({...h,wasmRoot:'/wasm',modelAssetPath:'/model.task',onSample:s=>samples.push(s)});
  await c.start({userInitiated:true,cameraConsent:true});h.frame(130,{captureTime:110});
  assert.equal(samples[0].timestampMs,110);assert.equal(samples[0].timestampKind,'browser_capture_estimate');assert.equal(samples[0].sourceClockId,'browser_video_capture_estimate');
  assert.equal(samples[0].syncStatus,'unmeasured');assert.equal(samples[0].syncOffsetMs,null);assert.equal(samples[0].syncDriftPpm,null);assert.equal(samples[0].syncUncertaintyMs,null);
  assert.equal(samples[0].scenePresentTsEstimateMs,null);assert.equal(samples[0].displayUncertaintyMs,null);assert.equal(samples[0].sceneAssociationEligible,false);c.stop();
});
test('camera resolution remains a non-mandatory local preference',async()=>{
  const h=harness(),c=createWebcamGazeController({...h,wasmRoot:'/wasm',modelAssetPath:'/model.task'});
  await c.start({userInitiated:true,cameraConsent:true,videoConstraints:{width:{ideal:1280},height:{ideal:720}}});
  assert.deepEqual(h.mediaRequest(),{video:{width:{ideal:1280},height:{ideal:720}},audio:false});
  c.stop();
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
