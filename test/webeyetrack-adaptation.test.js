import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebEyeTrackCalibrationAdapter,handleWebEyeTrackAdaptation,WEBEYETRACK_CALIBRATION_POINTS} from '../src/gaze/webeyetrack-adaptation.js';

test('WebEyeTrack calibration retains patches and adapts once with all 27 targets',async()=>{
  const calls=[];
  const addSample=createWebEyeTrackCalibrationAdapter({adapt(...args){calls.push(args);}});
  for(let i=0;i<WEBEYETRACK_CALIBRATION_POINTS;i++){
    const eyePatch={pixels:new Uint8ClampedArray([i])},headVector=[i,0,0],faceOrigin3D=[0,i,0],target={x:i/100,y:-i/100};
    assert.equal(await addSample({eyePatch,headVector,faceOrigin3D},target),i+1);
    assert.equal(calls.length,i===WEBEYETRACK_CALIBRATION_POINTS-1?1:0);
  }
  const [eyePatches,headVectors,faceOrigins3D,normPogs]=calls[0];
  assert.equal(eyePatches.length,WEBEYETRACK_CALIBRATION_POINTS);
  assert.equal(headVectors.length,WEBEYETRACK_CALIBRATION_POINTS);
  assert.equal(faceOrigins3D.length,WEBEYETRACK_CALIBRATION_POINTS);
  assert.deepEqual(normPogs,Array.from({length:WEBEYETRACK_CALIBRATION_POINTS},(_,i)=>[i/100,-i/100]));
  assert.deepEqual(eyePatches.map(patch=>patch.pixels[0]),Array.from({length:WEBEYETRACK_CALIBRATION_POINTS},(_,i)=>i));
  await assert.rejects(addSample({},{}),/limit reached/);
});

test('calibration acknowledgment waits for upstream adaptation and maps rejection to an error response',async()=>{
  let finishAdaptation;
  const result={gazeState:'open',eyePatch:{},headVector:[0,0,0],faceOrigin3D:[0,0,0]};
  const tracker={latestGazeResult:result,adapt(){return new Promise(resolve=>{finishAdaptation=resolve;});}};
  const addSample=createWebEyeTrackCalibrationAdapter(tracker,1);
  const posted=[];
  const acknowledgment=handleWebEyeTrackAdaptation(tracker,addSample,{x:0,y:0},'adapt-1').then(response=>posted.push(response));

  await Promise.resolve();
  assert.equal(typeof finishAdaptation,'function');
  assert.deepEqual(posted,[]);
  finishAdaptation();
  await acknowledgment;
  assert.deepEqual(posted,[{type:'adapted',requestId:'adapt-1',points:1}]);

  const failedTracker={latestGazeResult:result,adapt(){return Promise.reject(new Error('private upstream failure'));}};
  const failedSample=createWebEyeTrackCalibrationAdapter(failedTracker,1);
  assert.deepEqual(await handleWebEyeTrackAdaptation(failedTracker,failedSample,{x:0,y:0},'adapt-2'),{
    type:'adaptError',requestId:'adapt-2',code:'worker_adaptation_failed',step:'worker_adaptation'
  });
});
