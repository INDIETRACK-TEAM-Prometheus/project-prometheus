import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRecordingStore} from '../server/recording-store.js';
test('local chunks are ordered, bounded and finalized on disk',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'prom-record-'));
 try{const store=createRecordingStore({root,maxSessionBytes:4,maxTotalBytes:8}),s=await store.start();
 await store.append(s.sessionId,0,Buffer.from('abc'));
 await assert.rejects(store.append(s.sessionId,0,Buffer.from('a')));
 await assert.rejects(store.append('../elsewhere',1,Buffer.from('a')));
 await assert.rejects(store.append(s.sessionId,1,Buffer.from('xx')));
 await store.stop(s.sessionId);await assert.rejects(store.append(s.sessionId,1,Buffer.from('a')));
 const m=JSON.parse(await readFile(path.join(root,s.sessionId,'manifest.json'),'utf8'));assert.equal(m.bytes,3);assert.ok(m.closedAtUtc);
 }finally{await rm(root,{recursive:true,force:true});}
});
