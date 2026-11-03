import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalServer} from '../server.js';

const scenario={scenario_id:'s',possible_next_action:'Look toward the masked region',horizon_ms:1000,grounding_refs:['f'],assumptions:[],status:'active'};
const base={consentScope:'provisional_spark',timingStatus:'provisional',frame:{frameId:'f',observedAt:100,width:4,height:2},imageDataUrl:'data:image/png;base64,iVBORw0KGgo=',gazePoint:{x:.4,y:.3,sampleAtMs:1600,processedAtMs:1650,timestampKind:'browser_capture_estimate',estimateStatus:'uncalibrated_estimate'},issuedAtMs:1700,masks:[{left:1,top:0,right:3,bottom:2}]};
const candidate={objectId:'f:mask:0',bounds:{left:1,top:0,right:3,bottom:2}};

async function withServer(reasoner, run) {
  const server=createLocalServer({reasoner}); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
}
const post=(base,value)=>fetch(`${base}/api/reason-provisional`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});

test('provisional route validates frame-scoped mask candidates and allows only ranked IDs or abstention labels',async()=>{
  let received;
  await withServer(async input=>{received=input;return {scenarios:[scenario],nextGaze:{rankedTargetIds:['f:mask:0','unknown','outside_view']},model:'muse-spark-1.3'};},async base=>{
    const response=await post(base,{...baseRequest(),candidates:[candidate]});
    assert.equal(response.status,200);
    const body=await response.json();
    assert.deepEqual(received.candidates,[candidate]);
    assert.deepEqual(body.nextGaze,{rankedTargetIds:['f:mask:0','unknown','outside_view']});
    assert.deepEqual(body.frame,{frameId:'f',observedAt:100});
  });
});

test('provisional route accepts persistent track IDs whose bounds match a mask',async()=>{
  let received;
  await withServer(async input=>{received=input;return {scenarios:[scenario],nextGaze:{rankedTargetIds:['trk:e1:3']}};},async base=>{
    const request={...baseRequest(),masks:[{left:0,top:0,right:1,bottom:1},{left:1,top:0,right:3,bottom:2}],candidates:[{objectId:'trk:e1:3',bounds:{left:1,top:0,right:3,bottom:2}}]};
    const response=await post(base,request);
    assert.equal(response.status,200);
    assert.deepEqual(received.candidates,request.candidates);
    assert.deepEqual((await response.json()).nextGaze,{rankedTargetIds:['trk:e1:3']});
  });
});

test('provisional route rejects malformed candidate IDs or bounds before calling the reasoner',async()=>{
  let calls=0;
  await withServer(async()=>{calls++;return {scenarios:[]};},async base=>{
    const requests=[
      {...baseRequest(),candidates:[{...candidate,objectId:'has space'}]},
      {...baseRequest(),candidates:[{...candidate,objectId:'x'.repeat(129)}]},
      {...baseRequest(),candidates:[{...candidate,bounds:{left:0,top:0,right:3,bottom:2}}]},
      {...baseRequest(),candidates:[{...candidate,extra:true}]},
      {...baseRequest(),candidates:[candidate,candidate]}
    ];
    for(const request of requests) assert.equal((await post(base,request)).status,400);
    assert.equal(calls,0);
  });
});

test('provisional route rejects provider targets outside this mask candidate space',async()=>{
  await withServer(async()=>({scenarios:[scenario],nextGaze:{rankedTargetIds:['invented']}}),async base=>{
    const response=await post(base,{...baseRequest(),candidates:[candidate]});
    assert.equal(response.status,502);
    assert.deepEqual(await response.json(),{error:'provider_failed',providerCode:'REASONER_JSON_INVALID'});
  });
});

test('provisional response omits nextGaze when older callers supply no candidates',async()=>{
  await withServer(async()=>({scenarios:[scenario],nextGaze:{rankedTargetIds:['unknown']}}),async base=>{
    const response=await post(base,baseRequest());
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(Object.hasOwn(body,'nextGaze'),false);
  });
});

function baseRequest(){return structuredClone(base);}

const depthEvidence = {artifactSha256:'a'.repeat(64), modelId:'depth-anything/Depth-Anything-V2-Metric-Hypersim-Small', modelSha256:'b782898d8a3e8be1f639de33837ed85e9b4b73e40f8f5e5cd99067588d722545', observedAtMs:100, availableAtMs:1650, units:'m', convention:'axial_z', depthSource:'monocular_estimated_depth', objects:[{objectId:'f:mask:0', status:'ok', validFraction:1, medianDepthM:1.5, q1M:1.4, q3M:1.6}], relations:[], gazeDepthM:1.5};

test('provisional route passes validated depth statistics to the reasoner as depth evidence', async () => {
  let received;
  await withServer(async input => { received = input; return {scenarios:[scenario], nextGaze:{rankedTargetIds:['f:mask:0']}}; }, async base => {
    const response = await post(base, {...baseRequest(), candidates:[candidate], depth:depthEvidence});
    assert.equal(response.status, 200);
    const evidence = received.evidence.find(e => e.kind === 'depth');
    assert.equal(evidence.processedAt, 1650);
    assert.equal(evidence.observedAt, 100);
    assert.deepEqual(JSON.parse(evidence.text).objects, depthEvidence.objects);
  });
});

test('provisional route rejects depth for non-candidates, late availability or malformed statistics', async () => {
  let calls = 0;
  await withServer(async () => { calls++; return {scenarios:[]}; }, async base => {
    const bad = [
      {...depthEvidence, objects:[{...depthEvidence.objects[0], objectId:'other'}]},
      {...depthEvidence, availableAtMs:1701},
      {...depthEvidence, observedAtMs:99},
      {...depthEvidence, objects:[{...depthEvidence.objects[0], q1M:1.7}]},
      {...depthEvidence, units:'relative'},
      {...depthEvidence, values:[1]},
    ];
    for (const depth of bad) assert.equal((await post(base, {...baseRequest(), candidates:[candidate], depth})).status, 400);
    assert.equal(calls, 0);
  });
});

test('provisional route passes a gaze target that is one of the candidates and rejects any other',async()=>{
  let received;
  await withServer(async input=>{received=input;return {scenarios:[scenario],nextGaze:{rankedTargetIds:['f:mask:0']}};},async base=>{
    const gazeTarget={objectId:'f:mask:0',distance:.03,rankedObjectIds:['f:mask:0']};
    assert.equal((await post(base,{...baseRequest(),candidates:[candidate],gazeTarget})).status,200);
    const scene=JSON.parse(received.evidence.find(item=>item.kind==='scene').text);
    assert.equal(scene.gazeTarget.objectId,'f:mask:0');
    assert.equal(scene.gazeTarget.distanceFractionOfDiagonal,.03);
    for(const bad of [{...gazeTarget,objectId:'other',rankedObjectIds:['other']},{...gazeTarget,distance:2},{...gazeTarget,rankedObjectIds:['other']},{...gazeTarget,extra:1}])
      assert.equal((await post(base,{...baseRequest(),candidates:[candidate],gazeTarget:bad})).status,400);
    assert.equal((await post(base,{...baseRequest(),gazeTarget})).status,400);
  });
});
