import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GAZE_CALIBRATION_PROFILE_KEY,
  createGazeCalibrationProfile,
  fitAffineCalibration,
  identityAffineCalibration,
  loadGazeCalibrationProfile,
  restoreWebEyeTrackAdaptationSamples,
  saveGazeCalibrationProfile,
  selectAffineCalibrationCandidate
} from '../src/gaze/calibration-profile.js';

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
