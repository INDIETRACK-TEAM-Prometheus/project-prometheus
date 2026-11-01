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
