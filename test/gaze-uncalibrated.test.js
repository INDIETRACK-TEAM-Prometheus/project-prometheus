import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateUncalibratedGaze} from '../src/gaze/uncalibrated.js';

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
  assert.ok(Math.abs(result.point.x-.8)<1e-12);
  assert.ok(Math.abs(result.point.y-.8)<1e-12);
});

test('missing, blink-invalid or malformed iris landmarks are withheld',()=>{
  const expected={status:'unavailable',calibrationStatus:'uncalibrated',reason:'both_eye_iris_landmarks_required',point:null};
  assert.deepEqual(estimateUncalibratedGaze({leftEye:eye(0,0)}),expected);
  assert.deepEqual(estimateUncalibratedGaze({leftEye:eye(0,0,false),rightEye:eye(0,0)}),expected);
  assert.deepEqual(estimateUncalibratedGaze({leftEye:{...eye(0,0),iris:{x:NaN,y:0}},rightEye:eye(0,0)}),expected);
  assert.deepEqual(estimateUncalibratedGaze({leftEye:{...eye(0,0),corners:[{x:2,y:2},{x:2,y:2}]},rightEye:eye(0,0)}),expected);
});

test('estimate stays inside normalized viewport bounds at extreme iris offsets',()=>{
  const result=estimateUncalibratedGaze({leftEye:eye(5,-5),rightEye:eye(5,-5)});
  assert.ok(result.point.x>=0&&result.point.x<1);
  assert.ok(result.point.y>=0&&result.point.y<1);
});
