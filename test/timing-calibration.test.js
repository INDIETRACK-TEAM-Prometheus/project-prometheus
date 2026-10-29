import test from 'node:test';
import assert from 'node:assert/strict';
import {ClockDriftMonitor,createTimingTemplate,validateTimingCalibration} from '../src/runtime/clock.js';
import {FrameHistory,timingPresentations} from '../src/app.js';

const setup={userAgent:'test-browser',viewport:{width:800,height:600,devicePixelRatio:1,screenX:0,screenY:0,screenWidth:800,screenHeight:600},camera:{modelLabel:'synthetic test camera',width:640,height:480,frameRate:30}};
function evidence(){
 const profile=createTimingTemplate({browserSessionId:'page-1',cameraSessionId:'camera-1',setup,intendedDurationMs:1800000});
 Object.assign(profile.reference,{timebaseId:'reference-1',instrumentId:'photodiode-1',uncertaintyMs:1,evidenceFile:'optical.csv',evidenceSha256:'a'.repeat(64),measuredAtUtc:'2026-10-29T00:00:00.000Z'});
 profile.cameraClock.fit=[1000,2000,3000].map((sourceMs,i)=>({id:`camera-fit-${i}`,sourceMs,performanceMs:sourceMs+9+i,callbackMs:sourceMs+21+i}));
 profile.cameraClock.validation=[4000,5000,6000].map((sourceMs,i)=>({id:`camera-holdout-${i}`,sourceMs,performanceMs:sourceMs+13+i,callbackMs:sourceMs+25+i}));
 for(const [region,index] of Object.entries({top:0,middle:1,bottom:2})){
  const delay=15+index;
  profile.displayRegions[region].fit=[1000,2000,3000].map((renderMs,i)=>({id:`${region}-fit-${i}`,renderMs,presentMs:renderMs+delay+i}));
  profile.displayRegions[region].validation=[4000,5000,6000].map((renderMs,i)=>({id:`${region}-holdout-${i}`,renderMs,presentMs:renderMs+delay+3+i}));
 }
 return profile;
}

test('optical timing record requires the current setup, independent holdouts and measured clock pairs',()=>{
 const profile=evidence(),record=validateTimingCalibration(profile,{browserSessionId:'page-1',cameraSessionId:'camera-1',setup});
 assert.equal(record.status,'measurement_record_validated');assert.equal(record.t15Status,'not_run');assert.ok(Math.abs(record.cameraClockModel.driftPpm-1000)<1e-6);
 assert.throws(()=>validateTimingCalibration(profile,{browserSessionId:'new-page',cameraSessionId:'camera-1',setup}),/session mismatch/);
 const duplicate=evidence();duplicate.cameraClock.validation[0].id=duplicate.cameraClock.fit[0].id;assert.throws(()=>validateTimingCalibration(duplicate,{browserSessionId:'page-1',cameraSessionId:'camera-1',setup}),/independent/);
 const jump=evidence();jump.cameraClock.validation[1].performanceMs+=100;jump.cameraClock.validation[1].callbackMs+=100;assert.throws(()=>validateTimingCalibration(jump,{browserSessionId:'page-1',cameraSessionId:'camera-1',setup}),/jump/);
});

test('runtime drift monitor latches a clock jump and never estimates after expiry',()=>{
 const record=validateTimingCalibration(evidence(),{browserSessionId:'page-1',cameraSessionId:'camera-1',setup}),monitor=new ClockDriftMonitor(record.cameraClockModel,record.cameraCallbackLagMs);
 assert.equal(monitor.observe(4000,4025).status,'ok');assert.equal(monitor.observe(5000,5026).status,'ok');
 assert.deepEqual(monitor.observe(6000,6100),{status:'withheld',reason:'clock_jump_detected'});
 assert.equal(monitor.observe(6001,6101).reason,'clock_jump_detected');
 assert.equal(monitor.model&&monitor.model.maxExtrapolationMs,1800000);
});

test('each calibrated gaze band selects the exact retained frame using optical presentation time',()=>{
 const record=validateTimingCalibration(evidence(),{browserSessionId:'page-1',cameraSessionId:'camera-1',setup});
 const frame=timingPresentations({frameId:'frame-7',renderTsMs:6000,viewport:{width:1,height:1}},record),history=new FrameHistory();
 assert.equal(history.add(frame,Uint8Array.from([1,2,3,4]),6000),true);
 assert.equal(history.at(6018,'top'),null);
 const selected=history.at(6030,'top');assert.equal(selected.frameId,'frame-7');assert.equal(selected.presentTsEstimateMs,6020);assert.ok(selected.displayUncertaintyMs>0);
 assert.equal(history.at(6030,'middle').presentTsEstimateMs,6021);assert.equal(history.at(6030,'bottom').presentTsEstimateMs,6022);
});
