import test from 'node:test';
import assert from 'node:assert/strict';
import {GAZE_CALIBRATION_STORAGE_KEY,saveGazeCalibration,loadGazeCalibration,gazeCalibrationEnvironmentChanged} from '../src/gaze/persistence.js';

function storage() {
  const values=new Map();
  return {values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
}

const model={dimension:4,x:[1,2,3,4,5],y:[6,7,8,9,10],featureBounds:Array.from({length:4},(_,i)=>({min:i,max:i+1})),trainingIds:['train-0']};
const calibration={passed:true,status:'completed',attempts:54,validCount:54,validRate:1,p50:.01,p95:.02,unit:'screen_diagonal_fraction',trainingAttempts:27,validationAttempts:27,screenSize:{width:1280,height:720},completedAtUtc:'2026-10-30T00:00:00.000Z',attemptSamples:[{features:[1,2,3,4]}]};
const environment={viewport:{width:1280,height:720,devicePixelRatio:1},screen:{width:1920,height:1080},camera:{width:640,height:480,frameRate:30}};

test('stores and reloads only a completed calibration model and its environment summary',()=>{
  const local=storage();
  assert.equal(saveGazeCalibration(local,{model,calibration,environment}),true);
  const restored=loadGazeCalibration(local);
  assert.deepEqual(restored.model,{dimension:4,x:model.x,y:model.y,featureBounds:model.featureBounds});
  assert.deepEqual(restored.calibration,{
    passed:true,status:'completed',attempts:54,validCount:54,validRate:1,p50:.01,p95:.02,unit:'screen_diagonal_fraction',
    trainingAttempts:27,validationAttempts:27,screenSize:{width:1280,height:720},completedAtUtc:'2026-10-30T00:00:00.000Z'
  });
  assert.deepEqual(restored.environment,environment);
  const raw=local.values.get(GAZE_CALIBRATION_STORAGE_KEY);
  assert.equal(raw.includes('features'),false);
  assert.equal(raw.includes('attemptSamples'),false);
  assert.equal(raw.includes('video'),false);
});

test('does not save failed, malformed, or unavailable calibration storage',()=>{
  const local=storage();
  assert.equal(saveGazeCalibration(local,{model,calibration:{...calibration,passed:false},environment}),false);
  assert.equal(saveGazeCalibration(local,{model:{...model,x:[NaN]},calibration,environment}),false);
  assert.equal(saveGazeCalibration(null,{model,calibration,environment}),false);
  local.values.set(GAZE_CALIBRATION_STORAGE_KEY,'{');
  assert.equal(loadGazeCalibration(local),null);
  local.values.set(GAZE_CALIBRATION_STORAGE_KEY,JSON.stringify({version:1,model,calibration:{passed:false},environment}));
  assert.equal(loadGazeCalibration(local),null);
});

test('detects measured environment changes without treating them as a calibration failure',()=>{
  assert.equal(gazeCalibrationEnvironmentChanged(environment,environment),false);
  assert.equal(gazeCalibrationEnvironmentChanged(environment,{...environment,viewport:{...environment.viewport,width:1440}}),true);
  assert.equal(gazeCalibrationEnvironmentChanged(environment,{...environment,camera:{...environment.camera,frameRate:60}}),true);
  assert.equal(gazeCalibrationEnvironmentChanged(environment,null),true);
});
