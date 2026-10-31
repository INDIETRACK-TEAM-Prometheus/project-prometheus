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
