import test from 'node:test';
import assert from 'node:assert/strict';
import {stableCalibrationWindow,calibrationWindowStatus,calibrationSampleStatus,calibrationSampleFreshnessMs,calibrationTargetTimedOut,calibrationTargetTimeoutMs,CALIBRATION_TARGET_TIMEOUT_MS,MAX_CALIBRATION_TARGET_TIMEOUT_MS} from '../src/gaze/calibration-window.js';

test('validation requires recent stable post-dwell samples and rejects motion, old and future samples',()=>{
 const samples=[500,550,600].map(at=>({at,features:[.5,.5]})),options={targetShownAt:0,now:650};
 assert.equal(stableCalibrationWindow(samples,options),true);
 assert.equal(stableCalibrationWindow(samples.slice(0,2),options),false);
 assert.equal(stableCalibrationWindow([...samples.slice(0,2),{at:600,features:[.6,.5]}],options),false);
 assert.equal(stableCalibrationWindow(samples,{...options,now:1000}),false);
 assert.equal(stableCalibrationWindow(samples,{...options,now:550}),false);
 assert.equal(calibrationWindowStatus([{at:499,features:[.5,.5]}],options),'no_post_dwell_samples');
});

test('training admission accepts a fresh post-dwell open-eye frame even when uncalibrated gaze is unstable',()=>{
 const noisy=[500,800,1100].map((at,index)=>({at,features:index===1?[.56,.5]:[.4,.5]}));
 const latest={features:noisy.at(-1).features,callbackTimestampMs:1100};
 assert.equal(calibrationWindowStatus(noisy,{targetShownAt:0,now:1200}),'gaze_unstable');
 assert.equal(calibrationSampleStatus(latest,{targetShownAt:0,now:1200,maxAgeMs:500}),'ready');
 assert.equal(calibrationSampleStatus({...latest,callbackTimestampMs:499},{targetShownAt:0,now:1200,maxAgeMs:500}),'no_post_dwell_sample');
 assert.equal(calibrationSampleStatus({features:null,callbackTimestampMs:1100},{targetShownAt:0,now:1200,maxAgeMs:500}),'no_open_eye_sample');
});

test('freshness, validation window and target deadline adapt to slow frame cadence within bounds',()=>{
 const slow=[500,4500,8500].map(at=>({at,features:[.5,.5]}));
 assert.equal(calibrationSampleFreshnessMs(slow),2500);
 assert.equal(stableCalibrationWindow(slow,{targetShownAt:0,now:9000}),true);
 assert.equal(stableCalibrationWindow(slow,{targetShownAt:0,now:18000}),false);
 assert.equal(calibrationTargetTimeoutMs([]),CALIBRATION_TARGET_TIMEOUT_MS);
 assert.equal(calibrationTargetTimedOut(0,CALIBRATION_TARGET_TIMEOUT_MS-1,[]),false);
 assert.equal(calibrationTargetTimedOut(0,CALIBRATION_TARGET_TIMEOUT_MS,[]),true);
 assert.equal(calibrationTargetTimeoutMs(slow),MAX_CALIBRATION_TARGET_TIMEOUT_MS);
 assert.equal(calibrationTargetTimeoutMs([{at:0},{at:33},{at:66}],500),CALIBRATION_TARGET_TIMEOUT_MS,'previous-target cadence does not shorten this target wait');
 assert.equal(calibrationTargetTimedOut(0,8000,slow),false);
 assert.equal(calibrationTargetTimedOut(0,MAX_CALIBRATION_TARGET_TIMEOUT_MS,slow),true);
});

test('a startup stall can still produce a fresh target-associated sample before its timeout',()=>{
 const targetShownAt=0,firstFrame={at:3200,features:[.4,.6]},latest={features:firstFrame.features,callbackTimestampMs:firstFrame.at};
 assert.equal(calibrationTargetTimedOut(targetShownAt,3300,[firstFrame]),false);
 assert.equal(calibrationSampleStatus(latest,{targetShownAt,now:3300,maxAgeMs:250}),'ready');
});

test('freshness falls back for irregular/nonpositive timestamps and remains capped',()=>{
 assert.equal(calibrationSampleFreshnessMs([{at:10},{at:10},{at:6010}]),250);
 assert.equal(calibrationSampleFreshnessMs([{at:0},{at:2000}]),2500);
 assert.throws(()=>calibrationSampleFreshnessMs([],{maxMs:3000}),/invalid calibration freshness/);
});
