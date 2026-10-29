import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateUncalibratedGaze,selectProvisionalIrisGaze} from '../src/gaze/uncalibrated.js';

const eye = (x, y, valid=true) => ({valid, corners:[{x:0,y:0},{x:100,y:0}], iris:{x:50+x*100,y:y*100}});

test('iris-only heuristic emits a clearly uncalibrated normalized estimate',()=>{
  const result=estimateUncalibratedGaze({leftEye:eye(0,0),rightEye:eye(0,0)});
  assert.equal(result.status,'uncalibrated_estimate');
  assert.equal(result.calibrationStatus,'uncalibrated');
  assert.equal(result.method,'iris_relative_to_eye_corners');
  assert.deepEqual(result.feature,{x:0,y:0});
  assert.deepEqual(result.point,{x:.5,y:.5});
});

test('estimate responds to iris movement relative to both eye corners',()=>{
  const result=estimateUncalibratedGaze({leftEye:eye(.1,.05),rightEye:eye(.2,.1)});
  assert.ok(Math.abs(result.feature.x-.15)<1e-12);
  assert.ok(Math.abs(result.feature.y-.075)<1e-12);
  assert.ok(Math.abs(result.point.x-.2)<1e-12);
  assert.ok(Math.abs(result.point.y-.8)<1e-12);
});
test('single visible eye is isolated to a labeled uncalibrated estimate',()=>{
  const leftOnly=estimateUncalibratedGaze({leftEye:eye(.1,.05),rightEye:eye(0,0,false)});
  assert.equal(leftOnly.status,'uncalibrated_estimate');
  assert.equal(leftOnly.method,'single_eye_iris_relative_to_eye_corners');
  assert.deepEqual(leftOnly.eyesUsed,['left']);
  assert.deepEqual(leftOnly.feature,{x:.1,y:.05});
  const rightOnly=estimateUncalibratedGaze({leftEye:eye(0,0,false),rightEye:eye(-.1,.05)});
  assert.deepEqual(rightOnly.eyesUsed,['right']);
  assert.deepEqual(rightOnly.feature,{x:-.1,y:.05});
});

test('raw-camera horizontal iris movement maps to the opposite screen direction',()=>{
  const cameraRight=estimateUncalibratedGaze({leftEye:eye(.1,0),rightEye:eye(.1,0)});
  const cameraLeft=estimateUncalibratedGaze({leftEye:eye(-.1,0),rightEye:eye(-.1,0)});
  assert.ok(cameraRight.point.x<.5);
  assert.ok(cameraLeft.point.x>.5);
});

test('missing, blink-invalid or malformed iris landmarks are withheld',()=>{
  const expected={status:'unavailable',calibrationStatus:'uncalibrated',reason:'visible_eye_iris_landmarks_required',point:null};
  assert.deepEqual(estimateUncalibratedGaze({}),expected);
  assert.deepEqual(estimateUncalibratedGaze({leftEye:eye(0,0,false),rightEye:eye(0,0,false)}),expected);
  assert.deepEqual(estimateUncalibratedGaze({leftEye:{...eye(0,0),iris:{x:NaN,y:0}},rightEye:eye(0,0,false)}),expected);
  assert.deepEqual(estimateUncalibratedGaze({leftEye:{...eye(0,0),corners:[{x:2,y:2},{x:2,y:2}]},rightEye:eye(0,0,false)}),expected);
});

test('estimate stays inside normalized viewport bounds at extreme iris offsets',()=>{
  const result=estimateUncalibratedGaze({leftEye:eye(5,-5),rightEye:eye(5,-5)});
  assert.ok(result.point.x>=0&&result.point.x<1);
  assert.ok(result.point.y>=0&&result.point.y<1);
});

test('provisional selector accepts fresh capture estimates and explicitly tagged callback time',()=>{
  const estimate=estimateUncalibratedGaze({leftEye:eye(0,0),rightEye:eye(0,0)}),base={estimate,frame:{frameId:'f',width:1000,height:1000},canvasRect:{left:0,top:0,width:1000,height:1000},viewport:{width:1000,height:1000},stableAfterMs:1000,nowMs:1120};
  const capture=selectProvisionalIrisGaze({...base,sample:{faceDetected:true,timestampMs:1100,processedMs:1110,timestampKind:'browser_capture_estimate'}});
  assert.equal(capture.status,'ready');assert.equal(capture.calibrationStatus,'uncalibrated');assert.equal(capture.timingStatus,'provisional_browser_capture_estimate');assert.equal(capture.timestampKind,'browser_capture_estimate');assert.equal(capture.sampleAtMs,1100);assert.equal('captureAtMs'in capture,false);
  const callback=selectProvisionalIrisGaze({...base,sample:{faceDetected:true,timestampMs:1100,processedMs:1110,timestampKind:'callback_time_not_capture'}});
  assert.equal(callback.status,'ready');assert.equal(callback.timingStatus,'provisional_callback_time_not_capture');assert.equal(callback.timestampKind,'callback_time_not_capture');
  const singleEye=estimateUncalibratedGaze({leftEye:eye(.1,.05),rightEye:eye(0,0,false)});
  const provisional=selectProvisionalIrisGaze({...base,estimate:singleEye,sample:{faceDetected:true,timestampMs:1100,processedMs:1110,timestampKind:'browser_capture_estimate'}});
  assert.equal(provisional.status,'ready');assert.equal(provisional.method,'single_eye_iris_relative_to_eye_corners');assert.deepEqual(provisional.eyesUsed,['left']);
});

test('provisional selector withholds absent face, stale sample, unknown time basis and outside-canvas estimate',()=>{
  const estimate=estimateUncalibratedGaze({leftEye:eye(0,0),rightEye:eye(0,0)}),base={estimate,frame:{frameId:'f',width:1000,height:1000},canvasRect:{left:0,top:0,width:1000,height:1000},viewport:{width:1000,height:1000},stableAfterMs:1000,nowMs:1120};
  const sample={faceDetected:true,timestampMs:1100,processedMs:1110,timestampKind:'browser_capture_estimate'};
  assert.equal(selectProvisionalIrisGaze({...base,sample:{...sample,faceDetected:false}}).reason,'face_not_detected');
  assert.equal(selectProvisionalIrisGaze({...base,sample:{...sample,timestampKind:'callback_fallback'}}).reason,'sample_time_unavailable');
  assert.equal(selectProvisionalIrisGaze({...base,sample:{...sample,processedMs:1200}}).reason,'sample_stale_or_lagged');
  assert.equal(selectProvisionalIrisGaze({...base,canvasRect:{left:600,top:0,width:400,height:1000},sample}).reason,'gaze_outside_frozen_scene');
  assert.equal(selectProvisionalIrisGaze({...base,estimate:{status:'unavailable'},sample}).reason,'uncalibrated_iris_estimate_required');
});
