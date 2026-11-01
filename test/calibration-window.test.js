import test from 'node:test';import assert from 'node:assert/strict';import {stableCalibrationWindow,calibrationSampleFreshnessMs,calibrationTargetTimedOut} from '../src/gaze/calibration-window.js';
test('calibration needs multiple settled recent samples; motion, old and future samples are rejected',()=>{
 const s=[500,550,600].map(at=>({at,features:[.5,.5]})),options={targetShownAt:0,now:650};assert.equal(stableCalibrationWindow(s,options),true);
 assert.equal(stableCalibrationWindow(s.slice(0,2),options),false);
 assert.equal(stableCalibrationWindow([...s.slice(0,2),{at:600,features:[.6,.5]}],options),false);
 assert.equal(stableCalibrationWindow(s,{...options,now:1000}),false);
 assert.equal(stableCalibrationWindow(s,{...options,now:550}),false);
});

test('stable sampling and freshness follow observed cadence while keeping bounded waits',()=>{
 const slow=[500,1000,1500].map(at=>({at,features:[.5,.5]}));
 assert.equal(calibrationSampleFreshnessMs(slow),750);
 assert.equal(stableCalibrationWindow(slow,{targetShownAt:0,now:1650}),true);
 assert.equal(stableCalibrationWindow(slow,{targetShownAt:0,now:2800}),false);
 assert.equal(calibrationTargetTimedOut(0,2499),false);
 assert.equal(calibrationTargetTimedOut(0,2500),true);
});

test('sample freshness falls back for irregular or nonpositive timestamps and caps slow cadence',()=>{
 assert.equal(calibrationSampleFreshnessMs([{at:10},{at:10},{at:2010}]),250);
 assert.equal(calibrationSampleFreshnessMs([{at:0},{at:800}]),1200);
 assert.throws(()=>calibrationSampleFreshnessMs([],{maxMs:2000}),/invalid calibration freshness/);
});
