import {ProviderJournal} from '../src/runtime/provider-journal.js';
import {EphemeralStorage} from '../src/memory/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalServer} from '../server.js';
import {createServerReasoner} from '../src/runtime/server-providers.js';
import {RuntimeFacade} from '../src/runtime/facade.js';
const input={frame:{frameId:'f',observedAt:4,processedAt:5,imageData:'data:image/png;base64,iVBORw0KGgo=',causalStatus:'online_causal',provenanceKind:'synthetic'},gaze:{x:.2,y:.3,observedAt:4,processedAt:5},events:[{eventId:'e',observedAt:3,processedAt:5,type:'fixated',endAt:4,dwellValidMs:1,x:.2,y:.3,candidateObjectIds:['o']}],context:{memory:[{evidenceId:'m',text:'Object last seen at position [1,2,3]',observedAt:2,processedAt:3,causalStatus:'online_causal'}]},dependencies:{mapId:'map',mapVersion:1,objectIds:['o'],evidenceIds:['f','e','m'],expiresAt:500}};
const scenario={scenario_id:'s',possible_next_action:'observe',horizon_ms:1000,grounding_refs:['e','m'],assumptions:[],status:'active'};
test('reason-only endpoint sends causal observed evidence and image once, never SAM',async()=>{
 let calls=0,args;const server=createLocalServer({sam:async()=>{throw Error('SAM must not run');},reasoner:async input=>{calls++;args=input;return {scenarios:[scenario],model:'muse-spark-1.3',usage:null,estimatedCostUsd:null};}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {const base=`http://127.0.0.1:${server.address().port}`;const post=value=>fetch(base+'/api/reason',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
 const result=await post({input});assert.equal(result.status,200);const body=await result.json();assert.deepEqual(body.scenarios,[scenario]);assert.equal(body.reasoner.model,'muse-spark-1.3');assert.equal(body.sam,undefined);assert.equal(args.imageDataUrl,input.frame.imageData);assert.equal(args.evidence.find(x=>x.id==='m').text,input.context.memory[0].text);assert.equal(JSON.parse(args.evidence.find(x=>x.id==='e').text).type,'fixated');
 for(const mutate of [v=>v.input.events[0].groundTruth='answer',v=>v.input.context.memory[0].observedAt=7,v=>v.input.frame.future={goal:'secret'},v=>v.prompt='cup',v=>v.input.frame.imageData='bad']){const value=structuredClone({input});mutate(value);assert.equal((await post(value)).status,400);}assert.equal(calls,1);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('reason-only adapter requires consent, verifies provenance and propagates abort',async()=>{
 assert.throws(()=>createServerReasoner());assert.throws(()=>createServerReasoner({remoteConsent:false}));let signal,resolve;const published=[];
 const analyzer=createServerReasoner({remoteConsent:true,sessionId:'test',journal:await ProviderJournal.open({storage:new EphemeralStorage(),sessionId:'test'}),fetchImpl:(_url,options)=>{signal=options.signal;return new Promise(r=>resolve=r);}});
 const runtime=new RuntimeFacade({sessionId:'s',analyzer,now:()=>100,minIntervalMs:0,publish:x=>published.push(x)});runtime.start();runtime.submit(input);for(let i=0;i<100 && !signal;i++)await new Promise(r=>setTimeout(r,1));assert.ok(signal);runtime.stop();assert.equal(signal.aborted,true);resolve({ok:true,json:async()=>({frame:{frameId:'f',observedAt:4},scenarios:[scenario]})});await new Promise(r=>setTimeout(r,0));assert.deepEqual(published,[]);
 const bad=createServerReasoner({remoteConsent:true,sessionId:'test',journal:await ProviderJournal.open({storage:new EphemeralStorage(),sessionId:'test'}),fetchImpl:async()=>({ok:true,json:async()=>({frame:{frameId:'wrong',observedAt:4},scenarios:[]})})});await assert.rejects(()=>bad.run(input));
});

test('reason-only endpoint respects explicit gaze-time cutoff while preserving frame time',async()=>{
 let received;const server=createLocalServer({reasoner:async args=>{received=args;return {scenarios:[]};}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {const base=`http://127.0.0.1:${server.address().port}`;const data=structuredClone(input);data.frame.observedAt=100;data.frame.processedAt=120;data.gaze.observedAt=110;data.gaze.processedAt=120;data.events=[];data.context.memory=[];data.dependencies.evidenceIds=['f'];data.observedUntil=110;const post=()=>fetch(base+'/api/reason',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:data})});assert.equal((await post()).status,200);assert.equal(received.observedUntil,110);assert.equal(received.evidence[0].observedAt,100);
 data.observedUntil=105;assert.equal((await post()).status,400);data.observedUntil=110;data.frame.observedAt=111;assert.equal((await post()).status,400);data.frame.observedAt=100;data.context.memory=[{evidenceId:'future',text:'x',observedAt:111,processedAt:120,causalStatus:'online_causal'}];assert.equal((await post()).status,400);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('provisional follow-up requires its own scope and never upgrades estimated timing to causal',async()=>{
 let calls=0,received;const server=createLocalServer({reasoner:async args=>{calls++;received=args;return {scenarios:[scenario],model:'muse-spark-1.3',usage:null,estimatedCostUsd:null};}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const base=`http://127.0.0.1:${server.address().port}`;const post=value=>fetch(base+'/api/reason-provisional',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
  const request={consentScope:'provisional_spark',timingStatus:'provisional',frame:{frameId:'frozen-1',observedAt:100,width:4,height:2},imageDataUrl:'data:image/png;base64,iVBORw0KGgo=',gazePoint:{x:.4,y:.3,captureAtMs:1600,processedAtMs:1650},issuedAtMs:1700,masks:[{left:1,top:0,right:3,bottom:2}]};
  const response=await post(request);assert.equal(response.status,200);const body=await response.json();assert.equal(body.timingStatus,'provisional');assert.deepEqual(body.scenarios,[scenario]);assert.equal(received.timingStatus,'provisional');assert.equal(received.evidence[0].causalStatus,'provisional');assert.equal(received.imageDataUrl,request.imageDataUrl);assert.deepEqual(JSON.parse(received.evidence[0].text),{timingStatus:'provisional',timestampBasis:'browser_estimates',gazePoint:request.gazePoint,sam:{maskCount:1,bounds:request.masks}});
  for(const mutate of [value=>delete value.consentScope,value=>value.timingStatus='online_causal',value=>value.issuedAtMs=1600,value=>value.masks[0].right=5]){const invalid=structuredClone(request);mutate(invalid);assert.equal((await post(invalid)).status,400);}assert.equal(calls,1);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
