import test from 'node:test';
import assert from 'node:assert/strict';
import {ProvisionalTrackingStore,deleteProvisionalTracking} from '../src/memory/provisional-tracking.js';

function sharedStorage(){
  const rows=new Map();
  return {rows,load:async id=>structuredClone(rows.get(id)??null),save:async(id,value)=>rows.set(id,structuredClone(value)),delete:async id=>rows.delete(id),close:async()=>{}};
}
function locks(){
  const held=new Set();
  return {request:async(name,_options,callback)=>{if(held.has(name))return callback(null);held.add(name);try{return await callback({});}finally{held.delete(name);}}};
}
const validInput=()=>({
  frame:{frameId:'f-1',observedAt:100,width:640,height:480,imageDataUrl:'RAW_SCENE_IMAGE'},
  gazePoint:{x:.5,y:.25,eyeLandmarks:{secret:'RAW_EYE'}},
  gazeTiming:{sampleAtMs:110,processedAtMs:120,timestampKind:'callback_time_not_capture',estimateStatus:'uncalibrated_estimate',faceVideo:'RAW_FACE_VIDEO'},
  masks:[{bounds:{left:1,top:2,right:10,bottom:12},raster:[1,0],rawMask:'RAW_MASK'}],
  scenarios:[{scenario_id:'s1',possible_next_action:'look around',horizon_ms:1000,grounding_refs:['f-1'],assumptions:['uncertain'],status:'active',apiKey:'DO_NOT_STORE'}]
});

test('persists only provisional summaries and restores them after restart until explicit deletion',async()=>{
  const storage=sharedStorage(),exclusive=locks(),options={sessionId:'local-research',retentionConsent:true,storage,locks:exclusive,now:()=>500};
  const first=await ProvisionalTrackingStore.open(options);
  const saved=await first.appendDemoResult(validInput());
  assert.equal(saved.classification,'uncalibrated_provisional');
  assert.equal(saved.timingStatus,'provisional');
  assert.equal(saved.sam.maskCount,1);
  await first.close();

  const reopened=await ProvisionalTrackingStore.open({...options,now:()=>Number.MAX_SAFE_INTEGER});
  const restored=await reopened.list();
  assert.equal(restored.length,1);
  assert.deepEqual(restored[0],saved);
  const serialized=JSON.stringify(await storage.load('provisional-tracking:local-research'));
  for(const secret of ['RAW_SCENE_IMAGE','RAW_EYE','RAW_FACE_VIDEO','RAW_MASK','DO_NOT_STORE','imageDataUrl','eyeLandmarks','faceVideo','rawMask','apiKey']) assert.equal(serialized.includes(secret),false,secret);
  await reopened.deleteAll();
  assert.deepEqual(await reopened.list(),[]);
  await reopened.close();
  assert.equal(await storage.load('provisional-tracking:local-research'),null);
});

test('requires explicit consent and rejects calibrated samples without writing anything',async()=>{
  const storage=sharedStorage(),exclusive=locks(),options={sessionId:'local-research',storage,locks:exclusive};
  await assert.rejects(ProvisionalTrackingStore.open(options),/consent/);
  const store=await ProvisionalTrackingStore.open({...options,retentionConsent:true});
  await assert.rejects(store.appendDemoResult({...validInput(),gazeTiming:{...validInput().gazeTiming,estimateStatus:'validated_calibration_estimate'}}),/uncalibrated/);
  assert.deepEqual(await store.list(),[]);
  await store.close();
  assert.equal(await storage.load('provisional-tracking:local-research'),null);
});

test('exclusive lock prevents a second writer and standalone deletion removes the persistent slot',async()=>{
  const storage=sharedStorage(),exclusive=locks(),options={sessionId:'local-research',retentionConsent:true,storage,locks:exclusive};
  const store=await ProvisionalTrackingStore.open(options);
  await assert.rejects(ProvisionalTrackingStore.open(options),/open elsewhere/);
  await store.appendDemoResult(validInput());
  await store.close();
  await deleteProvisionalTracking({sessionId:'local-research',storage,locks:exclusive});
  assert.equal(await storage.load('provisional-tracking:local-research'),null);
});
