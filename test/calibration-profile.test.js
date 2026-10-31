import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GAZE_CALIBRATION_PROFILE_KEY,
  createGazeCalibrationProfile,
  fitAffineCalibration,
  identityAffineCalibration,
  loadGazeCalibrationProfile,
  restoreWebEyeTrackAdaptationSamples,
  restoreLandmarkResidualCalibration,
  validateGazeCalibrationProfile,
  saveGazeCalibrationProfile,
  selectAffineCalibrationCandidate
} from '../src/gaze/calibration-profile.js';
import {fitLandmarkResidualCalibration,calibrationMetrics} from '../src/gaze/index.js';

const environment = {
  viewport:{width:1280,height:720,devicePixelRatio:1},
  screen:{width:1920,height:1080},
  camera:{width:640,height:480,frameRate:30}
};
const runtime = {tracker:'WebEyeTrack',trackerVersion:'0.0.2',landmarkModel:'face_landmarker.task'};
const calibration = {passed:true,status:'completed',attempts:54,validCount:54,validRate:1,p50:.01,p95:.02,unit:'screen_diagonal_fraction',completedAtUtc:'2026-10-30T00:00:00.000Z'};
const patch = value => ({width:2,height:2,data:new Uint8ClampedArray([value,value+1,value+2,255,value+3,value+4,value+5,255,value+6,value+7,value+8,255,value+9,value+10,value+11,255])});
const replaySamples = Array.from({length:4},(_,i)=>({eyePatch:patch(i),headVector:[i,0,1],faceOrigin3D:[0,i,2],target:[i/10,i===0?0:-i/10]}));
const memoryStore = () => {
  const values = new Map();
  return {values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
};
const metrics = {attempts:9,validCount:9,validRate:1,p50:.01,p95:.02,unit:'screen_diagonal_fraction'};

test('profile replays ImageData bytes as typed arrays and stores only calibration inputs and summaries',async()=>{
  const profile = createGazeCalibrationProfile({adaptationSamples:replaySamples,calibration,environment,runtime,createdAtUtc:'2026-10-30T00:00:00.000Z'});
  const profileFromWorkerPayload = createGazeCalibrationProfile({adaptationSamples:profile.adaptation.samples,calibration,environment,runtime,createdAtUtc:profile.createdAtUtc});
  assert.deepEqual(profileFromWorkerPayload.adaptation,profile.adaptation);
  const restoredSamples = restoreWebEyeTrackAdaptationSamples(profile.adaptation.samples);
  assert.ok(restoredSamples[0].eyePatch.data instanceof Uint8ClampedArray);
  assert.deepEqual([...restoredSamples[0].eyePatch.data],[...patch(0).data]);
  assert.deepEqual(restoredSamples.map(sample=>sample.target),replaySamples.map(sample=>sample.target));

  const store = memoryStore();
  assert.equal(await saveGazeCalibrationProfile(store,profile),true);
  const loaded = await loadGazeCalibrationProfile(store,{environment,runtime});
  assert.equal(loaded.status,'compatible');
  assert.deepEqual(loaded.profile,profile);
  assert.equal(store.values.get(GAZE_CALIBRATION_PROFILE_KEY).includes('"eyePatch"'),true);
  assert.equal(store.values.get(GAZE_CALIBRATION_PROFILE_KEY).includes('faceOrigin3D'),true);
});

test('profile load reports runtime or environment changes without mutating or recalibrating it',async()=>{
  const store = memoryStore();
  const profile = createGazeCalibrationProfile({adaptationSamples:replaySamples,calibration,environment,runtime});
  await saveGazeCalibrationProfile(store,profile);
  const changedEnvironment = await loadGazeCalibrationProfile(store,{environment:{...environment,viewport:{...environment.viewport,width:1440}},runtime});
  assert.equal(changedEnvironment.status,'environment_changed');
  assert.equal(changedEnvironment.reason,'viewport.width');
  assert.deepEqual(changedEnvironment.profile,profile);
  const changedRuntime = await loadGazeCalibrationProfile(store,{environment,runtime:{...runtime,trackerVersion:'0.0.3'}});
  assert.equal(changedRuntime.status,'runtime_changed');
  assert.deepEqual(store.values.get(GAZE_CALIBRATION_PROFILE_KEY),JSON.stringify(profile));
});

test('missing, corrupt, failed, and incomplete profiles stay unavailable',async()=>{
  const store = memoryStore();
  assert.equal((await loadGazeCalibrationProfile(store,{environment,runtime})).status,'missing');
  store.values.set(GAZE_CALIBRATION_PROFILE_KEY,'{');
  assert.equal((await loadGazeCalibrationProfile(store,{environment,runtime})).status,'invalid_profile');
  const incomplete = createGazeCalibrationProfile({adaptationSamples:replaySamples,calibration,environment,runtime});
  assert.equal(await saveGazeCalibrationProfile({setItem(){throw new Error('quota exceeded');}},incomplete),false);
  assert.throws(()=>createGazeCalibrationProfile({adaptationSamples:replaySamples,calibration:{...calibration,passed:false},environment,runtime}));
  assert.throws(()=>restoreWebEyeTrackAdaptationSamples([{...incomplete.adaptation.samples[0],eyePatch:{...incomplete.adaptation.samples[0].eyePatch,width:3}}]));
});

function affineSamples(prefix, points, outlierId=null) {
  return points.map(([x,y],index)=>({id:`${prefix}-${index}`,features:[x,y],target:{
    x:100+700*x+20*y+(outlierId===index?800:0),
    y:50+10*x+400*y+(outlierId===index?500:0)
  }}));
}

test('fits a robust affine candidate and selects it only on independent validation samples',()=>{
  const grid = [.1,.5,.9].flatMap(y=>[.1,.5,.9].map(x=>[x,y]));
  const train = affineSamples('train',grid,4), selection = affineSamples('select',[[.2,.15],[.75,.2],[.3,.8],[.8,.75]]);
  const model = fitAffineCalibration(train);
  const baseline = identityAffineCalibration({width:1000,height:500});
  const result = selectAffineCalibrationCandidate({candidateModel:model,baselineModel:baseline,selectionSamples:selection,screen:{x:0,y:0,width:1000,height:500}});
  assert.equal(result.selected,true);
  assert.equal(result.status,'selected_on_independent_selection');
  assert.ok(result.candidate.p95 < result.baseline.p95);
  assert.ok(model.trainingIds.includes('train-4'));
  assert.throws(()=>selectAffineCalibrationCandidate({candidateModel:model,baselineModel:baseline,selectionSamples:[train[0]],screen:{x:0,y:0,width:1000,height:500}}),/overlaps training/);
  assert.throws(()=>fitAffineCalibration([train[0],train[0],train[2]]));
});

test('affine selection withholds holdout samples outside the fitted feature bounds',()=>{
  const train=affineSamples('range-train',[[.25,.25],[.75,.25],[.25,.75],[.75,.75]]);
  const selection=affineSamples('range-select',[[.4,.4],[.6,.6],[.5,.65],[.9,.5]]);
  const candidateModel=fitAffineCalibration(train);
  const result=selectAffineCalibrationCandidate({candidateModel,baselineModel:identityAffineCalibration({width:1000,height:500}),selectionSamples:selection,screen:{x:0,y:0,width:1000,height:500}});
  assert.equal(result.selected,false);
  assert.equal(result.candidate.validCount,3);
  assert.equal(result.candidate.validRate,.75);
  assert.equal(result.baseline.validCount,4);
});

test('identity affine calibration maps normalized features into a nonzero screen origin',()=>{
  const screen={x:40,y:30,width:1000,height:500},model=identityAffineCalibration(screen);
  assert.deepEqual(model.x,[40,1000,0]);
  assert.deepEqual(model.y,[30,0,500]);
  const metrics=calibrationMetrics(model,[
    {id:'top-left',features:[0,0],target:{x:40,y:30}},
    {id:'bottom-right',features:[1,1],target:{x:1040,y:530}}
  ],screen,{independent:false});
  assert.equal(metrics.p95,0);
});

test('saved affine feature bounds stay in normalized coordinate space',()=>{
  const model=fitAffineCalibration(affineSamples('saved-range',[[.1,.1],[.9,.1],[.1,.9],[.9,.9]]));
  model.featureBounds[0].min=-.01;
  const args={adaptationSamples:replaySamples,calibration,environment,runtime,affine:{model,selection:{selected:false,status:'not_selected',baseline:metrics,candidate:metrics}}};
  assert.throws(()=>createGazeCalibrationProfile(args),/invalid affine calibration selection/);
});

test('profile round-trips selected landmark residual coefficients and safe feature bounds',async()=>{
  const screen={width:1000,height:500};
  const attempts=Array.from({length:18},(_,i)=>{
    const features=[((i%3)+1)/4,((Math.floor(i/3)%3)+1)/4];
    return {id:`residual-${i}`,features,landmarkFeatures:[(i%3-1)/4,(Math.floor(i/3)%3-1)/4,((i*7)%17-8)/10],target:{x:400+features[0]*200,y:250+features[1]*200}};
  });
  const model=fitLandmarkResidualCalibration(attempts,screen);
  assert.ok(model);
  assert.equal(model.dimension,3);assert.equal(model.x.length,4);assert.equal(model.y.length,4);assert.equal(model.featureBounds.length,3);
  const profile=createGazeCalibrationProfile({adaptationSamples:replaySamples,calibration,environment,runtime,landmarkResidual:model});
  assert.deepEqual(restoreLandmarkResidualCalibration(profile),model);
  const store=memoryStore();await saveGazeCalibrationProfile(store,profile);
  const loaded=await loadGazeCalibrationProfile(store,{environment,runtime});
  assert.equal(loaded.status,'compatible');assert.deepEqual(restoreLandmarkResidualCalibration(loaded.profile),model);
  const oldProfile={...profile};delete oldProfile.landmarkResidual;
  assert.equal(validateGazeCalibrationProfile(oldProfile,{environment,runtime}).status,'compatible');
});

test('landmark residual profile rejects malformed shapes, nonfinite values, duplicate IDs, and unsafe bounds',()=>{
  const model={dimension:3,x:[0,1,0,0],y:[0,0,1,0],trainingIds:['a','b','c'],featureBounds:[{min:-.5,max:.5},{min:-1,max:1},{min:0,max:1}]};
  const args={adaptationSamples:replaySamples,calibration,environment,runtime};
  assert.throws(()=>createGazeCalibrationProfile({...args,landmarkResidual:{...model,dimension:2}}),/landmark residual/);
  assert.throws(()=>createGazeCalibrationProfile({...args,landmarkResidual:{...model,x:[0,1,NaN,0]}}),/landmark residual/);
  assert.throws(()=>createGazeCalibrationProfile({...args,landmarkResidual:{...model,trainingIds:['a','a']}}),/landmark residual/);
  assert.throws(()=>createGazeCalibrationProfile({...args,landmarkResidual:{...model,featureBounds:[{min:-1.01,max:.5},...model.featureBounds.slice(1)]}}),/landmark residual/);
  assert.throws(()=>restoreLandmarkResidualCalibration({landmarkResidual:{...model,x:[0,1,Infinity,0]}}));
});
