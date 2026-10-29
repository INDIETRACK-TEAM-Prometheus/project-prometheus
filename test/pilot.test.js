import test from 'node:test';
import assert from 'node:assert/strict';
import {pilotReport} from '../src/app.js';
test('pilot report withholds completion until duration and valid calibrated samples',()=>{
 const pilot={startedAt:100,startedAtUtc:'2026-01-01T00:00:00Z',stoppedAt:null,samples:10,validSamples:2,faces:5,timestampKinds:{browser_capture_estimate:0,callback_time_not_capture:10},inferenceCount:2,inferenceSum:6,inferenceMax:4,cameraSettings:{width:640,height:480,reportedFrameRate:30},calibration:{passed:true,attempts:[]}};
 assert.equal(pilotReport(pilot,1800099,{}).pilot30Minutes.status,'not_passed');
 const report=pilotReport(pilot,1800100,{pending:1,dropped:2});
 assert.equal(report.pilot30Minutes.status,'completed_with_valid_samples');
 assert.equal(report.inferenceMs.mean,3);assert.equal(report.opticalTimingUncertaintyMs,null);assert.equal(report.queue.dropped,2);
 pilot.calibration.invalidatedAtUtc='2026-01-01T00:30:00Z';assert.equal(pilotReport(pilot,1800100,{}).pilot30Minutes.status,'not_passed');
});
 test('paused time is excluded from pilot duration',()=>{
 const pilot={startedAt:100,stoppedAt:null,pauseStartedAt:1000,pausedMs:100,samples:1,validSamples:1,faces:1,timestampKinds:{},inferenceCount:0,calibration:{passed:true},cameraSettings:{}};
 assert.equal(pilotReport(pilot,2000,{}).durationMs,800);
});
