import {ProviderJournal} from '../src/runtime/provider-journal.js';
import {EphemeralStorage} from '../src/memory/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalServer} from '../server.js';
import {RuntimeFacade} from '../src/runtime/facade.js';
import {createServerAnalyzer} from '../src/runtime/server-providers.js';
const frame = {frameId:'f',observedAt:4,processedAt:5,imageData:'data:image/png;base64,iVBORw0KGgo=',causalStatus:'online_causal',provenanceKind:'synthetic'};
const input = {frame,gaze:{x:.5,y:.5,observedAt:4,processedAt:5},events:[{eventId:'e',observedAt:3,processedAt:5}],context:{memory:[]},dependencies:{mapId:'m',mapVersion:1,objectIds:[],evidenceIds:['f','e'],expiresAt:500}};
const scenario={scenario_id:'s',possible_next_action:'observe',horizon_ms:1000,grounding_refs:['f'],assumptions:[],status:'active'};
const tick=()=>new Promise(r=>setTimeout(r,0));
test('server chains SAM to the reasoner with causal, allowlisted evidence',async()=>{
 let received;
 const server=createLocalServer({sam:async({prompt})=>{assert.equal(prompt,'cup');return {masks:[{bounds:{left:1,top:2,right:3,bottom:4}}],model:'sam-3.1'};},reasoner:async args=>{received=args;return {scenarios:[scenario],model:'muse-spark-1.3',usage:{inputTokens:100,outputTokens:10,cachedInputTokens:0},estimatedCostUsd:0.0001675};}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=body=>fetch(base+'/api/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const response=await post({input,prompt:'cup'});assert.equal(response.status,200);const result=await response.json();assert.deepEqual(result.scenarios,[scenario]);assert.equal(result.reasoner.usage.inputTokens,100);assert.equal(result.reasoner.estimatedCostUsd,0.0001675);assert.deepEqual(result.frame,{frameId:'f',observedAt:4});
  assert.deepEqual(received.evidence.map(e=>e.id),['f','e']);assert.equal(received.observedUntil,4);assert.equal(received.issuedAt,5);assert.equal(received.imageDataUrl,input.frame.imageData);assert.equal(received.rawFace,undefined);assert.match(received.evidence[0].text,/segmentationBounds/);
  const bad=structuredClone(input);bad.frame.causalStatus='unknown';assert.equal((await post({input:bad,prompt:'cup'})).status,400);
  bad.frame.causalStatus='online_causal';bad.context.memory.push({evidenceId:'future',text:'x',observedAt:10,processedAt:11,causalStatus:'online_causal'});assert.equal((await post({input:bad,prompt:'cup'})).status,400);
 } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('remote adapter requires consent and runtime rejects stopped or late outputs',async()=>{
 assert.throws(()=>createServerAnalyzer({samPrompt:'cup'}));let resolve,signal;const output=[];
 const analyzer=createServerAnalyzer({remoteConsent:true,samPrompt:'cup',sessionId:'test',journal:await ProviderJournal.open({storage:new EphemeralStorage(),sessionId:'test'}),fetchImpl:(_url,options)=>{signal=options.signal;return new Promise(r=>resolve=r);}});
 const runtime=new RuntimeFacade({sessionId:'s',analyzer,now:()=>100,minIntervalMs:0,publish:x=>output.push(x)});runtime.start();
 const bad=structuredClone(input);delete bad.frame.causalStatus;assert.throws(()=>runtime.submit(bad));
 runtime.submit(input);for(let i=0;i<100 && !signal;i++)await tick();assert.ok(signal);runtime.stop();assert.equal(signal.aborted,true);resolve({ok:true,json:async()=>({frame:{frameId:'f',observedAt:4},scenarios:[scenario]})});await tick();assert.deepEqual(output,[]);
});
test('remote runtime publishes valid response and rejects unknown grounding',async()=>{
 let grounding='f';const out=[];
 const analyzer=createServerAnalyzer({remoteConsent:true,samPrompt:'cup',sessionId:'test',journal:await ProviderJournal.open({storage:new EphemeralStorage(),sessionId:'test'}),fetchImpl:async()=>({ok:true,json:async()=>({frame:{frameId:'f',observedAt:4},scenarios:[{...scenario,grounding_refs:[grounding]}]})})});
 const runtime=new RuntimeFacade({sessionId:'s',analyzer,now:()=>100,minIntervalMs:0,publish:x=>out.push(x)});runtime.start();runtime.submit(input);for(let i=0;i<100 && !out.length;i++)await tick();assert.equal(out.length,1);
 grounding='unknown';runtime.submit(input);for(let i=0;i<100 && !runtime.status().lastError;i++)await tick();assert.equal(out.length,1);assert.equal(runtime.status().lastError,'provider_failed');runtime.stop();
});

test('pipeline returns a sanitized error when the reasoner fails after SAM',async()=>{
 const server=createLocalServer({sam:async()=>({masks:[]}),reasoner:async()=>{throw Object.assign(new Error('secret'),{code:'REASONER_UPSTREAM_ERROR'});}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try { const response=await fetch(`http://127.0.0.1:${server.address().port}/api/analyze`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input,prompt:'cup'})});assert.equal(response.status,502);assert.deepEqual(await response.json(),{error:'provider_failed'}); }
 finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('gaze history preserves observed event details',async()=>{
 let evidence;
 const server=createLocalServer({sam:async()=>({masks:[]}),reasoner:async args=>{evidence=args.evidence;return {scenarios:[]};}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const data=structuredClone(input);Object.assign(data.events[0],{type:'fixated',endAt:4,dwellValidMs:1,x:.2,y:.3,candidateObjectIds:['object-1']});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/analyze`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:data,prompt:'cup'})});assert.equal(response.status,200);
  assert.deepEqual(JSON.parse(evidence.find(e=>e.id==='e').text),{type:'fixated',endAt:4,dwellValidMs:1,x:.2,y:.3,candidateObjectIds:['object-1']});
  data.events[0].endAt=6;const bad=await fetch(`http://127.0.0.1:${server.address().port}/api/analyze`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:data,prompt:'cup'})});assert.equal(bad.status,400);
 } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('configured status remains unverified until a response',async()=>{
 const analyzer=createServerAnalyzer({remoteConsent:true,samPrompt:'cup',sessionId:'test',journal:await ProviderJournal.open({storage:new EphemeralStorage(),sessionId:'test'}),fetchImpl:async()=>({ok:true,json:async()=>({frame:{frameId:'f',observedAt:4},scenarios:[]})})});const runtime=new RuntimeFacade({sessionId:'s',analyzer,now:()=>100,minIntervalMs:0});assert.equal(runtime.status().reasoner,'configured_unverified');runtime.start();runtime.submit(input);for(let i=0;i<100 && runtime.status().reasoner!=='responded_unverified';i++)await tick();assert.equal(runtime.status().reasoner,'responded_unverified');assert.equal(runtime.status().wonder,'blocked');runtime.stop();
});


test('reasoner diagnostics are bounded and reconstructed',async()=>{
 const diagnostic={responseStatus:'incomplete',incompleteReason:'max_output_tokens',outputTypes:['reasoning'],textLength:0,secret:'not returned'};
 const server=createLocalServer({sam:async()=>({masks:[]}),reasoner:async()=>{throw Object.assign(new Error('secret'),{code:'REASONER_INCOMPLETE',diagnostic});}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/analyze`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input,prompt:'cup'})});const body=await response.json();assert.equal(body.providerCode,'REASONER_INCOMPLETE');assert.deepEqual(body.diagnostic,{responseStatus:'incomplete',incompleteReason:'max_output_tokens',outputTypes:['reasoning'],textLength:0});}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('runtime forwards only bounded provider metadata after a validated response',async()=>{
 const out=[]; const reasoner={provider:'Meta',model:'muse-spark-1.3',requestId:'req-1',usage:{inputTokens:12,outputTokens:3,cachedInputTokens:0,secret:'hidden'},secret:'hidden'};
 const analyzer={kind:'server_provider',run:async()=>({scenarios:[scenario],reasoner})};
 const runtime=new RuntimeFacade({sessionId:'s',analyzer,now:()=>100,minIntervalMs:0,publish:value=>out.push(value)});
 runtime.start();runtime.submit(input);await tick();
 assert.deepEqual(out[0].reasoner,{provider:'Meta',model:'muse-spark-1.3',requestId:'req-1',usage:{inputTokens:12,outputTokens:3,cachedInputTokens:0}});
 runtime.stop();
});
