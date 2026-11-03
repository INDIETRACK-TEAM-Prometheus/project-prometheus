import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createLocalServer} from '../server.js';
test('recording route rejects cross-site writes and preserves chunk bytes',async()=>{
 const calls=[],id='12345678-1234-1234-1234-123456789abc';
 const recordingStore={start:async()=>({sessionId:id}),append:async(...args)=>{calls.push(args);return {chunks:1};},stop:async()=>({sessionId:id})};
 const server=createLocalServer({recordingStore});server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
   const rejected=await fetch(base+'/api/recordings/start',{method:'POST',headers:{Origin:'https://attacker.invalid'}});assert.equal(rejected.status,403);
   const opened=await fetch(base+'/api/recordings/start',{method:'POST'});assert.equal((await opened.json()).sessionId,id);
   const chunk=await fetch(base+`/api/recordings/${id}/chunks/0`,{method:'POST',headers:{'Content-Type':'video/webm'},body:Buffer.from([1,2,3])});assert.equal(chunk.status,200);assert.deepEqual(calls[0],[id,0,Buffer.from([1,2,3])]);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('recording list and delete are loopback-only and report store results',async()=>{
 let deletes=0;const recordingStore={list:async()=>({recordings:[],totalBytes:0}),deleteAll:async()=>{deletes++;return {deleted:['a'],failed:[],skippedActive:[],freedBytes:3};}};
 const server=createLocalServer({recordingStore});server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
   assert.equal((await fetch(base+'/api/recordings',{method:'DELETE',headers:{Origin:'https://attacker.invalid'}})).status,403);
   assert.equal((await fetch(base+'/api/recordings',{method:'POST'})).status,403);assert.equal(deletes,0);
   assert.deepEqual(await (await fetch(base+'/api/recordings')).json(),{recordings:[],totalBytes:0});
   const removed=await fetch(base+'/api/recordings',{method:'DELETE'});assert.equal(removed.status,200);assert.deepEqual((await removed.json()).deleted,['a']);assert.equal(deletes,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('full-screen page exposes the data panel and discloses local recording',async()=>{
 const server=createLocalServer();server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const page=await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
   assert.match(page,/<button id="dataPanel" aria-controls="sessionPanel"/);assert.match(page,/<footer id="sessionPanel"/);
   assert.match(page,/class="demo-disclosure">[^<]*recorded only to data\/recordings on this device/);assert.match(page,/id="deleteRecordings"/);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
