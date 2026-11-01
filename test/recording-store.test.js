import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,stat} from 'node:fs/promises';
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
test('delete removes closed sessions, keeps an open one and frees quota',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'prom-record-'));
 try{const store=createRecordingStore({root,maxSessionBytes:4,maxTotalBytes:6}),closed=await store.start();
 await store.append(closed.sessionId,0,Buffer.from('abcd'));await store.stop(closed.sessionId);
 const open=await store.start();await store.append(open.sessionId,0,Buffer.from('xy'));
 await mkdir(path.join(root,'not-a-recording'));
 const listed=await store.list();assert.equal(listed.recordings.length,2);assert.equal(listed.totalBytes,listed.recordings.reduce((s,r)=>s+r.bytes,0));
 assert.deepEqual(listed.recordings.filter(r=>r.active).map(r=>r.sessionId),[open.sessionId]);
 const result=await store.deleteAll();
 assert.deepEqual(result.deleted,[closed.sessionId]);assert.deepEqual(result.skippedActive,[open.sessionId]);assert.deepEqual(result.failed,[]);assert.equal(result.freedBytes,4);
 await assert.rejects(stat(path.join(root,closed.sessionId)));await stat(path.join(root,'not-a-recording'));
 const next=await store.start();await store.append(next.sessionId,0,Buffer.from('1234'));
 await assert.rejects(store.append(next.sessionId,1,Buffer.from('z')),/recording_quota_exceeded/);
 }finally{await rm(root,{recursive:true,force:true});}
});
