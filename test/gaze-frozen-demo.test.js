import test from 'node:test';
import assert from 'node:assert/strict';
import {selectFrozenSceneGaze,runFrozenGazeCycle} from '../src/gaze/frozen-demo.js';
import {remapGazePointToViewport} from '../src/gaze/persistence.js';
import {gazeSamPrompt,sendProvisionalSparkRequest,provisionalSparkMinIntervalMs,provisionalGazeFailureReason,provisionalSparkValidityScope,publishProvisionalSparkIfCurrent} from '../src/app.js';
import {createSceneDiagnostic,flipRgba} from '../src/spatial/scene-diagnostic.js';

const frame={frameId:'synthetic-42',observedAt:42,width:4,height:2};
const rect={left:50,top:100,width:400,height:200};
const sample={valid:true,timestampKind:'browser_capture_estimate',timestampMs:1600,processedMs:1650,rawScreenXY:{x:250,y:150}};

test('each gaze cycle releases its captured scene after async work, including failure',async()=>{
 let frozen=false,captures=0;
 const cycle=()=>runFrozenGazeCycle({prepare:()=>{assert.equal(frozen,false);frozen=true;captures++;return true;},run:async()=>{assert.equal(frozen,true);await Promise.resolve();return captures;},resume:()=>{frozen=false;}});
 assert.equal(await cycle(),1);assert.equal(frozen,false);assert.equal(await cycle(),2);assert.equal(frozen,false);
 await assert.rejects(runFrozenGazeCycle({prepare:()=>{frozen=true;return true;},run:async()=>{throw Error('request failed');},resume:()=>{frozen=false;}}),/request failed/);assert.equal(frozen,false);
});

test('cancelled Spark persistence cannot republish a discarded result and history labels its exact scope',async()=>{
 let finishPersist,current=true,shown=null,discarded=0;
 const pending=publishProvisionalSparkIfCurrent({persist:()=>new Promise(resolve=>{finishPersist=resolve;}),isCurrent:()=>current,discard:async()=>{discarded++;},publish:value=>{shown=value;}});
 current=false;finishPersist(['stale scenario']);assert.equal(await pending,false);assert.equal(shown,null);assert.equal(discarded,1);
 const scope=provisionalSparkValidityScope({frame:{frameId:'frozen-42',observedAt:1200},gaze:{x:.25,y:.75,sampleAtMs:1230}});
 assert.match(scope,/frozen-42/);assert.match(scope,/not reusable for the current scene or gaze/);assert.match(scope,/physical time alignment not verified/);
});

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

test('saved calibration point reaches SAM at the same normalized location after viewport resize',()=>{
  const saved={viewport:{width:1280,height:720,devicePixelRatio:1},screen:{width:1920,height:1080},camera:{width:640,height:480,frameRate:30}};
  const current={...saved,viewport:{...saved.viewport,width:1920,height:1080}};
  const rawScreenXY=remapGazePointToViewport({x:640,y:360},saved,current);
  const resizedFrame={frameId:'resized',observedAt:42,width:1920,height:1080};
  const resizedSample={...sample,rawScreenXY};
  const selected=selectFrozenSceneGaze({sample:resizedSample,frame:resizedFrame,canvasRect:{left:0,top:0,width:1920,height:1080},frozenAtMs:1000,stableAfterMs:1500,nowMs:1700});
  assert.equal(selected.status,'ready');
  assert.deepEqual(selected.point,{x:.5,y:.5});
  assert.equal(gazeSamPrompt(resizedFrame,selected.point),'<0f>1<|point;x=960;y=540;w=1920;h=1080|>');
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
 const result=await sendProvisionalSparkRequest({consent:true,frame,imageDataUrl:'data:image/png;base64,iVBORw0KGgo=',gazePoint:selectedPoint(),gazeTiming:{sampleAtMs:1600,processedAtMs:1650,timestampKind:'browser_capture_estimate',estimateStatus:'uncalibrated_estimate'},masks,issuedAtMs:1700,fetchImpl:async(url,options)=>{sent={url,body:JSON.parse(options.body),signal:options.signal};return {ok:true,json:async()=>({timingStatus:'provisional',frame:{frameId:frame.frameId,observedAt:frame.observedAt},scenarios:[]})};}});
 assert.equal(result.status,'ok');assert.equal(sent.url,'/api/reason-provisional');assert.equal(sent.body.consentScope,'provisional_spark');assert.equal(sent.body.timingStatus,'provisional');assert.deepEqual(sent.body.frame,frame);assert.equal(sent.body.imageDataUrl,'data:image/png;base64,iVBORw0KGgo=');assert.deepEqual(sent.body.gazePoint,{x:.5,y:.25,sampleAtMs:1600,processedAtMs:1650,timestampKind:'browser_capture_estimate',estimateStatus:'uncalibrated_estimate'});assert.equal(sent.body.masks.length,10);assert.deepEqual(sent.body.masks[0],masks[0].bounds);assert.equal(provisionalSparkMinIntervalMs,30000);
 let callbackPayload;const callback=await sendProvisionalSparkRequest({consent:true,frame,imageDataUrl:'png',gazePoint:selectedPoint(),gazeTiming:{sampleAtMs:1600,processedAtMs:1650,timestampKind:'callback_time_not_capture',estimateStatus:'uncalibrated_estimate'},masks:[],issuedAtMs:1700,fetchImpl:async(url,options)=>{callbackPayload=JSON.parse(options.body);return {ok:true,json:async()=>({timingStatus:'provisional',frame:{frameId:frame.frameId,observedAt:frame.observedAt},scenarios:[]})};}});assert.equal(callback.status,'ok');assert.equal(callbackPayload.gazePoint.timestampKind,'callback_time_not_capture');assert.equal(callbackPayload.gazePoint.sampleAtMs,1600);assert.equal('captureAtMs'in callbackPayload.gazePoint,false);
 let calls=0;const withheld=await sendProvisionalSparkRequest({consent:false,fetchImpl:async()=>{calls++;}});assert.deepEqual(withheld,{status:'withheld',reason:'consent_required'});assert.equal(calls,0);
 const mismatched=await sendProvisionalSparkRequest({consent:true,frame,imageDataUrl:'png',gazePoint:{x:.5,y:.25},gazeTiming:{sampleAtMs:1600,processedAtMs:1650,timestampKind:'browser_capture_estimate',estimateStatus:'uncalibrated_estimate'},masks:[],issuedAtMs:1700,fetchImpl:async()=>({ok:true,json:async()=>({timingStatus:'provisional',frame:{frameId:'other',observedAt:frame.observedAt},scenarios:[]})})});assert.equal(mismatched.status,'failed');
 const limited=await sendProvisionalSparkRequest({consent:true,frame,imageDataUrl:'png',gazePoint:selectedPoint(),gazeTiming:{sampleAtMs:1600,processedAtMs:1650,timestampKind:'browser_capture_estimate',estimateStatus:'uncalibrated_estimate'},masks:[],issuedAtMs:1700,fetchImpl:async()=>({ok:false,status:429,json:async()=>({error:'provider_limited',providerCode:'PROVIDER_BUDGET_EXCEEDED',secret:'never display'})})});assert.deepEqual(limited,{status:'failed',reason:'budget_exceeded'});
 assert.equal(provisionalGazeFailureReason({reason:'visible_eye_iris_landmarks_required'},'uncalibrated_iris_estimate_required'),'No valid iris landmarks');
 const controller=new AbortController();controller.abort();const aborted=await sendProvisionalSparkRequest({consent:true,frame,imageDataUrl:'png',gazePoint:{x:.5,y:.25},gazeTiming:{sampleAtMs:1600,processedAtMs:1650,timestampKind:'browser_capture_estimate',estimateStatus:'uncalibrated_estimate'},masks:[],issuedAtMs:1700,signal:controller.signal,fetchImpl:async()=>{calls++;}});assert.equal(aborted.status,'cancelled');assert.equal(calls,0);
});
function selectedPoint(){return {x:.5,y:.25};}
