import test from 'node:test';
import assert from 'node:assert/strict';
import {selectFrozenSceneGaze} from '../src/gaze/frozen-demo.js';
import {gazeSamPrompt,sendProvisionalSparkRequest,provisionalSparkMinIntervalMs} from '../src/app.js';
import {createSceneDiagnostic,flipRgba} from '../src/spatial/scene-diagnostic.js';

const frame={frameId:'synthetic-42',observedAt:42,width:4,height:2};
const rect={left:50,top:100,width:400,height:200};
const sample={valid:true,timestampKind:'browser_capture_estimate',timestampMs:1600,processedMs:1650,rawScreenXY:{x:250,y:150}};

test('provisional gaze selector admits only a fresh post-freeze capture estimate inside the canvas',()=>{
  const selected=selectFrozenSceneGaze({sample,frame,canvasRect:rect,frozenAtMs:1000,stableAfterMs:1500,nowMs:1700});
  assert.equal(selected.status,'ready');assert.equal(selected.frameId,frame.frameId);assert.deepEqual(selected.point,{x:.5,y:.25});
  assert.equal(selected.captureProcessingLagMs,50);assert.equal(selected.maxCaptureProcessingLagMs,250);assert.equal(selected.maxAcceptedProcessingAgeMs,100);assert.equal(selected.maxAcceptedSampleAgeMs,350);assert.equal(selected.opticalTimingUncertaintyMs,null);
  for(const [input,reason] of [
    [{sample:{...sample,timestampKind:'callback_time_not_capture'}},'capture_estimate_required'],
    [{sample:{...sample,timestampMs:1499,processedMs:1500}},'sample_before_stable_window'],
    [{sample:{...sample,processedMs:1900},nowMs:1950},'sample_stale_or_lagged'],
    [{sample:{...sample,processedMs:1600},nowMs:1701},'sample_stale_or_lagged'],
    [{sample:{...sample,rawScreenXY:{x:10,y:10}}},'gaze_outside_frozen_scene']
  ]) assert.equal(selectFrozenSceneGaze({sample,frame,canvasRect:rect,frozenAtMs:1000,stableAfterMs:1500,nowMs:1700,...input}).reason,reason);
  const uncalibrated={...sample,valid:false,rawScreenXY:null,invalidReason:'calibration_required'};
  assert.equal(selectFrozenSceneGaze({sample:uncalibrated,frame,canvasRect:rect,frozenAtMs:1000,stableAfterMs:1500,nowMs:1700}).reason,'capture_estimate_required');
});

test('gaze-point SAM request and displayed mask stay attached to the exact frozen framebuffer',async()=>{
  const selected=selectFrozenSceneGaze({sample,frame,canvasRect:rect,frozenAtMs:1000,stableAfterMs:1500,nowMs:1700});
  const raw=Uint8Array.from({length:frame.width*frame.height*4},(_,i)=>i%256),mask={sourceWidth:4,sourceHeight:2,width:1,height:1,bounds:{left:1,top:0,right:2,bottom:1},raster:[1]};
  let requestBody,shown;
  const diagnostic=createSceneDiagnostic({
    pin:value=>value.frameId===frame.frameId&&value.observedAt===frame.observedAt,
    release:()=>{},
    encode:async(pixels,width,height)=>{assert.deepEqual([...pixels],[...flipRgba(raw,width,height)]);return 'frozen-frame-image';},
    request:async(body)=>{requestBody=body;return {frame:body.frame,masks:[mask]};},
    display:value=>{shown=value;}
  });
  const prompt=gazeSamPrompt(frame,selected.point);
  assert.equal(prompt,'<0f>1<|point;x=2;y=0;w=4;h=2|>');
  assert.equal((await diagnostic.run(frame,raw,prompt)).status,'ok');
  assert.deepEqual(Object.keys(requestBody).sort(),['frame','imageDataUrl','prompt']);assert.deepEqual(requestBody.frame,{frameId:frame.frameId,observedAt:frame.observedAt});assert.equal(requestBody.prompt,prompt);
  assert.equal(shown.frame.frameId,frame.frameId);assert.deepEqual([...shown.pixels],[...flipRgba(raw,4,2)]);assert.equal(shown.overlay[(0*4+1)*4+3],120);
});

test('provisional Spark follow-up sends the same frame, estimated point and bounded SAM boxes only with explicit consent',async()=>{
 const masks=Array.from({length:12},(_,i)=>({bounds:{left:i,top:0,right:i+1,bottom:1}}));let sent;
 const result=await sendProvisionalSparkRequest({consent:true,frame,imageDataUrl:'data:image/png;base64,iVBORw0KGgo=',gazePoint:selectedPoint(),gazeTiming:{captureAtMs:1600,processedAtMs:1650},masks,issuedAtMs:1700,fetchImpl:async(url,options)=>{sent={url,body:JSON.parse(options.body),signal:options.signal};return {ok:true,json:async()=>({timingStatus:'provisional',frame:{frameId:frame.frameId,observedAt:frame.observedAt},scenarios:[]})};}});
 assert.equal(result.status,'ok');assert.equal(sent.url,'/api/reason-provisional');assert.equal(sent.body.consentScope,'provisional_spark');assert.equal(sent.body.timingStatus,'provisional');assert.deepEqual(sent.body.frame,frame);assert.equal(sent.body.imageDataUrl,'data:image/png;base64,iVBORw0KGgo=');assert.deepEqual(sent.body.gazePoint,{x:.5,y:.25,captureAtMs:1600,processedAtMs:1650});assert.equal(sent.body.masks.length,10);assert.deepEqual(sent.body.masks[0],masks[0].bounds);assert.equal(provisionalSparkMinIntervalMs,30000);
 let calls=0;const withheld=await sendProvisionalSparkRequest({consent:false,fetchImpl:async()=>{calls++;}});assert.deepEqual(withheld,{status:'withheld',reason:'consent_required'});assert.equal(calls,0);
 const mismatched=await sendProvisionalSparkRequest({consent:true,frame,imageDataUrl:'png',gazePoint:{x:.5,y:.25},gazeTiming:{captureAtMs:1600,processedAtMs:1650},masks:[],issuedAtMs:1700,fetchImpl:async()=>({ok:true,json:async()=>({timingStatus:'provisional',frame:{frameId:'other',observedAt:frame.observedAt},scenarios:[]})})});assert.equal(mismatched.status,'failed');
 const controller=new AbortController();controller.abort();const aborted=await sendProvisionalSparkRequest({consent:true,frame,imageDataUrl:'png',gazePoint:{x:.5,y:.25},gazeTiming:{captureAtMs:1600,processedAtMs:1650},masks:[],issuedAtMs:1700,signal:controller.signal,fetchImpl:async()=>{calls++;}});assert.equal(aborted.status,'cancelled');assert.equal(calls,0);
});
function selectedPoint(){return {x:.5,y:.25};}
