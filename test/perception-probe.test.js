import {ProviderJournal} from '../src/runtime/provider-journal.js';
import {EphemeralStorage} from '../src/memory/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalServer} from '../server.js';
import {MemoryService} from '../src/memory/index.js';
import {RuntimeFacade} from '../src/runtime/facade.js';
import {PerceptionPipeline} from '../src/runtime/perception.js';
import {createServerReasoner} from '../src/runtime/server-providers.js';

test('synthetic live probe contract completes over injected providers and retrieves namespaced memory',async()=>{
 let samCalls=0,reasonCalls=0;const mask={sourceWidth:2,sourceHeight:2,width:2,height:2,bounds:{left:0,top:0,right:2,bottom:2},raster:[1,1,1,1]};
 const server=createLocalServer({sam:async()=>{samCalls++;return {model:'sam-3.1',masks:[mask]};},reasoner:async({evidence})=>{reasonCalls++;assert.ok(evidence.some(e=>e.kind==='memory'));return {model:'muse-spark-1.3',scenarios:[]};}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`,now=()=>1000+performance.now(),memory=await MemoryService.open({sessionId:'probe',clock:now});let published;
 const analyzer=createServerReasoner({remoteConsent:true,sessionId:'test',journal:await ProviderJournal.open({storage:new EphemeralStorage(),sessionId:'test'}),fetchImpl:(url,options)=>fetch(base+url,options)});const runtime=new RuntimeFacade({sessionId:'probe',analyzer,now,minIntervalMs:0,publish:x=>published=x});runtime.start();
 const segment=async(f,{signal})=>{const r=await fetch(base+'/api/sam/segment',{method:'POST',headers:{'content-type':'application/json'},signal,body:JSON.stringify({frame:{frameId:f.frameId,observedAt:f.observedAt},imageDataUrl:f.imageData,prompt:'red square'})});return r.json();};
 const pipeline=new PerceptionPipeline({segment,segmentKind:'server_provider',memory,runtime,now,ttlMs:60000});pipeline.start('probe');
 const frame={frameId:'f',observedAt:1000,processedAt:1000,causalStatus:'online_causal',provenanceKind:'synthetic',mapId:'m',mapVersion:1,coordinateFrameId:'world',width:2,height:2,rgba:new Uint8Array([255,0,0,255,255,0,0,255,255,0,0,255,255,0,0,255]),imageData:'data:image/png;base64,iVBORw0KGgo=',depth:null,syncUncertaintyMs:0};
 const gaze={frameId:'f',observedAt:1000,processedAt:1000,causalStatus:'online_causal',x:.25,y:.25,syncUncertaintyMs:0};const event={eventId:'e',type:'fixated',causalStatus:'online_causal',observedAt:800,endAt:1000,processedAt:1000,dwellValidMs:200,x:.25,y:.25};
 try{assert.equal(pipeline.submit({frame,gaze,event}).accepted,true);await pipeline.current;while(runtime.scheduler.running)await new Promise(r=>setTimeout(r,5));assert.equal(pipeline.status().lastError,null);assert.equal(samCalls,1);assert.equal(reasonCalls,1);assert.equal(published.deliveryState,'silent_ready');const saved=await memory.retrieve({objectId:published.objectIds[0],observedUntil:now()});assert.ok(published.evidenceIds.includes(saved.lastSeen.observationId));assert.deepEqual(published.scenarios,[]);}
 finally{await pipeline.stop();runtime.stop();await memory.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
