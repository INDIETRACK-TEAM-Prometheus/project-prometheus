import test from 'node:test';import assert from 'node:assert/strict';import {stableCalibrationWindow} from '../src/gaze/calibration-window.js';
test('calibration needs multiple settled recent samples; motion, old and future samples are rejected',()=>{
 const s=[500,550,600].map(at=>({at,features:[.5,.5]})),options={targetShownAt:0,now:650};assert.equal(stableCalibrationWindow(s,options),true);
 assert.equal(stableCalibrationWindow(s.slice(0,2),options),false);
 assert.equal(stableCalibrationWindow([...s.slice(0,2),{at:600,features:[.6,.5]}],options),false);
 assert.equal(stableCalibrationWindow(s,{...options,now:1000}),false);
 assert.equal(stableCalibrationWindow(s,{...options,now:550}),false);
});
