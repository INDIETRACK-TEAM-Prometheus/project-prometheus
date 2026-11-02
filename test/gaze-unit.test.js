import test from 'node:test';
import assert from 'node:assert/strict';
import {fitCalibration,predictCalibration,calibrationMetrics,mapCoordinates,mirrorPoint,mirrorRect,eyeCrop,eyePreviewCrop,trackingSample,createLandmarkSession,withinCalibrationBounds,landmarkGazeFeatures,fitLandmarkResidualCalibration,predictLandmarkResidual,landmarkResidualMetrics,landmarkResidualPassesSelection,LANDMARK_RESIDUAL_FIT_ATTEMPTS} from '../src/gaze/index.js';

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
test('MediaPipe landmarks reduce to bilateral iris and upper-lid features without exposing landmarks',()=>{
  const landmarks=Array.from({length:478},()=>({x:.5,y:.5}));
  Object.assign(landmarks[263],{x:.6,y:.5});Object.assign(landmarks[362],{x:.5,y:.5});Object.assign(landmarks[473],{x:.56,y:.49});
  Object.assign(landmarks[385],{x:.54,y:.47});Object.assign(landmarks[386],{x:.55,y:.47});Object.assign(landmarks[387],{x:.56,y:.47});
  Object.assign(landmarks[33],{x:.35,y:.5});Object.assign(landmarks[133],{x:.55,y:.5});Object.assign(landmarks[468],{x:.47,y:.49});
  Object.assign(landmarks[158],{x:.43,y:.47});Object.assign(landmarks[159],{x:.45,y:.47});Object.assign(landmarks[160],{x:.47,y:.47});
  const features=landmarkGazeFeatures(landmarks,1000,1000);
  assert.ok(Math.abs(features[0]-.1)<1e-10);assert.ok(Math.abs(features[1]+.075)<1e-10);assert.ok(Math.abs(features[2]+.225)<1e-10);
  assert.equal(landmarkGazeFeatures(landmarks.slice(0,473),1000,1000),null);
  landmarks[468].presence=.4;assert.equal(landmarkGazeFeatures(landmarks,1000,1000),null);
  assert.equal(landmarkGazeFeatures(landmarks,0,1000),null);
});
test('landmark residual candidate fits 18 samples and compares on a third repeat of the 3x3 target set',()=>{
  const screen={width:1000,height:500};
  const fit=Array.from({length:LANDMARK_RESIDUAL_FIT_ATTEMPTS},(_,i)=>{
    const landmarkFeatures=[(i%3-1)*.1,(Math.floor(i/3)%3-1)*.1,(i<9?-.1:.1)];
    const [x,y,lid]=landmarkFeatures,dx=.15*x+.05*lid,dy=.1*y-.02*lid;
    return {id:`fit-${i}`,features:[.5,.5],landmarkFeatures,target:{x:(.5+dx)*screen.width,y:(.5+dy)*screen.height}};
  });
  const model=fitLandmarkResidualCalibration(fit,screen);
  assert.ok(model);
  const holdout=Array.from({length:9},(_,i)=>{
    const landmarkFeatures=[(i%3-1)*.1,(Math.floor(i/3)-1)*.1,0], [x,y,lid]=landmarkFeatures;
    const dx=.15*x+.05*lid,dy=.1*y-.02*lid;
    return {id:`holdout-${i}`,features:[.5,.5],landmarkFeatures,target:{x:(.5+dx)*screen.width,y:(.5+dy)*screen.height}};
  });
  const corrected=landmarkResidualMetrics(model,holdout,screen),baseline=calibrationMetrics({dimension:2,x:[0,screen.width,0],y:[0,0,screen.height],trainingIds:[]},holdout,{x:0,y:0,...screen});
  assert.equal(corrected.attempts,9);assert.equal(corrected.validRate,1);assert.ok(corrected.correctedCount>0);assert.ok(corrected.p95<baseline.p95);
  assert.equal(landmarkResidualPassesSelection(true,model,baseline,corrected),true);
  assert.equal(landmarkResidualPassesSelection(false,model,baseline,corrected),false);
  assert.equal(landmarkResidualPassesSelection(true,model,baseline,{...corrected,p95:baseline.p95}),false);
  assert.equal(landmarkResidualPassesSelection(true,model,baseline,{...corrected,correctedCount:1}),false);
  assert.deepEqual(predictLandmarkResidual(model,[.5,.5],[.2,0,0]),null);
  assert.equal(predictLandmarkResidual(model,[.99,.5],[.1,.1,.1]),null);
});
test('missing or degenerate landmark features fall back from residual fitting',()=>{
  const attempts=Array.from({length:LANDMARK_RESIDUAL_FIT_ATTEMPTS},(_,i)=>({id:`fit-${i}`,features:[.5,.5],landmarkFeatures:[0,0,0],target:{x:500,y:250}}));
  assert.equal(fitLandmarkResidualCalibration(attempts,{width:1000,height:500}),null);
  assert.equal(fitLandmarkResidualCalibration(attempts.slice(0,-1),{width:1000,height:500}),null);
  const missing=attempts.map(sample=>({...sample,landmarkFeatures:null}));
  assert.equal(fitLandmarkResidualCalibration(missing,{width:1000,height:500}),null);
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
test('preview crop expands upward for brows without changing the tracker crop or lower edge',()=>{
  const frame={x:0,y:0,width:100,height:100},crop=eyeCrop({x:20,y:20},{x:40,y:20},frame);
  const preview=eyePreviewCrop(crop,frame,20);
  assert.deepEqual(crop,{x:15,y:12,width:30,height:16});
  assert.deepEqual(preview,{x:15,y:1,width:30,height:27});
  assert.equal(preview.y+preview.height,crop.y+crop.height);
  assert.deepEqual(eyePreviewCrop({x:15,y:2,width:30,height:10},frame,20),{x:15,y:0,width:30,height:12});
  assert.equal(eyePreviewCrop(null,frame,20),null);
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

test('calibration reach reports how far the measured gaze travels and its bias per axis', async () => {
  const {calibrationReach} = await import('../src/gaze/index.js');
  const screen = {x:0, y:0, width:1000, height:500};
  const identity = {dimension:2, x:[0,1000,0], y:[0,0,500], trainingIds:[], featureBounds:[]};
  const targets = [.1,.5,.9].flatMap(x => [.1,.5,.9].map(y => ({x:x*1000, y:y*500})));
  // measured travels 60% of the distance from the centre horizontally and 100% vertically, 5% of the width to the right
  const attempts = targets.map((target, i) => ({id:`v${i}`, target, features:[.5+(target.x/1000-.5)*.6+.05, target.y/500]}));
  const reach = calibrationReach(identity, attempts, screen);
  assert.equal(reach.count, 9);
  assert.ok(Math.abs(reach.gainX-.6)<1e-9 && Math.abs(reach.gainY-1)<1e-9);
  assert.ok(Math.abs(reach.biasX-.05)<1e-9 && Math.abs(reach.biasY)<1e-9);
  assert.equal(calibrationReach(identity, attempts.slice(0,2), screen), null);
  assert.equal(calibrationReach(identity, attempts.map(a => ({...a, valid:false})), screen), null);
});
