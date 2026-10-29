import test from 'node:test';
import assert from 'node:assert/strict';
import {fitCalibration,predictCalibration,calibrationMetrics,mapCoordinates,mirrorPoint,mirrorRect,eyeCrop,trackingSample,createLandmarkSession,withinCalibrationBounds} from '../src/gaze/index.js';

const training = [[0,0],[1,0],[0,1],[1,1]].map(([x,y],i) => ({id:`t${i}`,features:[x,y],target:{x:100+500*x,y:50+300*y}}));
test('calibration predicts independent points and reports normalized validation separately', () => {
  const model = fitCalibration(training), p = predictCalibration(model,[.25,.75]);
  assert.equal(withinCalibrationBounds(model,[.5,.5]),true); assert.equal(withinCalibrationBounds(model,[1.01,.5]),false); assert.equal(withinCalibrationBounds(model,[NaN,.5]),false);
  assert.ok(Math.abs(p.x-225)<1e-8 && Math.abs(p.y-275)<1e-8);
  const attempts = [{id:'v1',features:[.25,.75],target:{x:225,y:275}},{id:'v2',valid:false}];
  const metrics = calibrationMetrics(model,attempts,{x:0,y:0,width:1000,height:500});
  assert.equal(metrics.validRate,.5); assert.ok(metrics.p95<1e-10);
  assert.throws(() => calibrationMetrics(model,training,{x:0,y:0,width:1000,height:500}),/overlaps/);
  assert.equal(calibrationMetrics(model, training,{x:0,y:0,width:1000,height:500},{independent:false}).validCount,4);
  assert.throws(() => fitCalibration(training.map(s => ({...s,features:[1,1]}))),/degenerate/);
});

test('calibrated mapping keeps the screen direction learned from its targets',()=>{
  const samples=[-1,-.5,0,.5,1].map((x,i)=>({id:`mirror-${i}`,features:[x],target:{x:500-100*x,y:300}}));
  const model=fitCalibration(samples);
  assert.ok(predictCalibration(model,[.5]).x<500);
  assert.ok(predictCalibration(model,[-.5]).x>500);
});
test('window offsets and diagnostic panel do not become world gaze', () => {
  const screen={x:0,y:0,width:1920,height:1080}, app={x:100,y:50,width:1000,height:700}, world={x:0,y:0,width:700,height:700};
  const a=mapCoordinates({x:450,y:400},screen,app,world);
  assert.deepEqual(a.viewportXY,{x:.5,y:.5});
  assert.equal(mapCoordinates({x:900,y:400},screen,app,world).viewportXY,null);
  assert.equal(mapCoordinates({x:450,y:400},screen,{...app,x:300},world).viewportXY.x,150/700);
});
test('display mirroring and corners keep crop independent of iris', () => {
  assert.deepEqual(mirrorPoint({x:20,y:4},100),{x:80,y:4});
  assert.deepEqual(mirrorRect({x:10,y:5,width:30,height:20},100),{x:60,y:5,width:30,height:20});
  assert.deepEqual(eyeCrop({x:20,y:20},{x:40,y:20},{x:0,y:0,width:100,height:100}),{x:15,y:12,width:30,height:16});
  assert.deepEqual(eyeCrop({x:0,y:0},{x:10,y:0},{x:0,y:0,width:100,height:100}),{x:0,y:0,width:12.5,height:4});
});
test('tracking loss, blink and degradation withhold current gaze', () => {
  const good={captureMs:5,faceDetected:true,leftEye:{valid:true},rightEye:{valid:true},calibrationValid:true,rawScreenXY:{x:2,y:3}};
  assert.equal(trackingSample(good).valid,true);
  for (const change of [{faceDetected:false},{leftEye:{valid:true,blink:true}},{degradedReason:'head_moved'},{calibrationValid:false}]) {
    const sample=trackingSample({...good,...change}); assert.equal(sample.valid,false); assert.equal(sample.rawScreenXY,null); assert.equal(sample.captureMs,5);
  }
});
test('injected provider cannot receive frames before explicit start or after stop', async () => {
  let count=0; const session=createLandmarkSession({detect: async () => ++count});
  await assert.rejects(session.detect({},{}),/not started/);
  assert.throws(() => session.start({userInitiated:true}),/consent/);
  session.start({userInitiated:true,cameraConsent:true}); assert.equal(await session.detect({},{}),1);
  session.stop(); await assert.rejects(session.detect({},{}),/not started/); assert.equal(count,1);
});
