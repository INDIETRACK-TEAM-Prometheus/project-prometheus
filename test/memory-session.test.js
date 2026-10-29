import test from 'node:test';
import assert from 'node:assert/strict';
import {openDurableSession,deleteDurableSlot} from '../src/memory/session.js';
import {IndexedDBStorage} from '../src/memory/index.js';

function storage(){const map=new Map();return {durable:true,load:async id=>structuredClone(map.get(id)??null),save:async(id,x)=>map.set(id,structuredClone(x)),delete:async id=>map.delete(id)};}
function locks(){let active=false;return {request:async(_key,_options,callback)=>{if(active)return callback(null);active=true;try{return await callback({});}finally{active=false;}}};}
test('exclusive lock, consent and restart time age evidence without renewal',async()=>{
 let page=10,wall=1000;const disk=storage(),exclusive=locks(),options={sessionId:'pseudonym',retentionConsent:true,retentionMs:30000,storage:disk,locks:exclusive,pageNow:()=>page,wallNow:()=>wall};
 await assert.rejects(openDurableSession({...options,retentionConsent:false}));const first=await openDurableSession(options);await assert.rejects(openDurableSession(options),/elsewhere/);await first.memory.ingestFrame({id:'f',observedAt:5,bytes:1},10);await first.close();
 page=1;wall=12000;const second=await openDurableSession({...options,mode:'reopen'});assert.ok(page+second.offset>=11010);assert.equal(second.memory.ring.ring.has('f'),false);await second.close({remove:true});
});

test('create refuses existing slot and reopen rejects missing, expired or rolled-back state',async()=>{
 let page=10,wall=1000;const disk=storage(),exclusive=locks(),options={sessionId:'slot',retentionConsent:true,retentionMs:100,storage:disk,locks:exclusive,pageNow:()=>page,wallNow:()=>wall};await assert.rejects(openDurableSession({...options,mode:'reopen'}),/unavailable/);const first=await openDurableSession(options);await first.close();await assert.rejects(openDurableSession(options),/exists/);wall=999;await assert.rejects(openDurableSession({...options,mode:'reopen'}));wall=1100;await assert.rejects(openDurableSession({...options,mode:'reopen'}),/expired/);assert.equal(await disk.load('slot'),null);const replacement=await openDurableSession(options);await replacement.close({remove:true});
});

test('expired deletion failure is surfaced and lock is released',async()=>{
 let wall=1000;const disk=storage(),exclusive=locks(),options={sessionId:'slot',retentionConsent:true,retentionMs:100,storage:disk,locks:exclusive,pageNow:()=>10,wallNow:()=>wall};
 const first=await openDurableSession(options);await first.close();wall=1100;const remove=disk.delete;disk.delete=async()=>{throw Error('delete failed');};
 await assert.rejects(openDurableSession({...options,mode:'reopen'}),/delete failed/);assert.ok(await disk.load('slot'));disk.delete=remove;
 await assert.rejects(openDurableSession({...options,mode:'reopen'}),/expired/);assert.equal(await disk.load('slot'),null);
});

test('expired-looking snapshots with ambiguous retention metadata are preserved',async()=>{
 let wall=1000;const disk=storage(),exclusive=locks(),options={sessionId:'slot',retentionConsent:true,retentionMs:100,storage:disk,locks:exclusive,pageNow:()=>10,wallNow:()=>wall};
 const first=await openDurableSession(options);await first.close();const valid=await disk.load('slot');wall=1100;
 for(const changes of [{expiryClock:undefined},{expiryClock:'monotonic_ms'},{checkpointMonotonicMs:NaN},{checkpointWallMs:1101},{checkpointWallMs:-1}]){
  const ambiguous={...valid,...changes};await disk.save('slot',ambiguous);
  for(const mode of ['create','reopen']){await assert.rejects(openDurableSession({...options,mode}));assert.deepEqual(await disk.load('slot'),ambiguous);}
 }
});

 test('provider crash survives reopen and removal deletes journal',async()=>{
 const disk=storage(),exclusive=locks(),options={sessionId:'slot',retentionConsent:true,retentionMs:1000,storage:disk,locks:exclusive,pageNow:()=>10,wallNow:()=>1000};
 const first=await openDurableSession(options);const id='a'.repeat(64);let calls=0;
 await assert.rejects(first.journal.run(id,async()=>{calls++;throw Error('injected crash');}));await first.close();
 const reopened=await openDurableSession({...options,mode:'reopen'});await assert.rejects(reopened.journal.run(id,async()=>{calls++;}),/uncertain/);assert.equal(calls,1);
 assert.deepEqual((await disk.load('provider-journal:slot')).entries,[{id,state:'uncertain'}]);await reopened.close({remove:true});assert.equal(await disk.load('provider-journal:slot'),null);assert.equal(await disk.load('slot'),null);
 });


test('atomic slot deletion failure preserves both records and can be retried',async()=>{
 let wall=1000,fail=false;const disk=storage(),exclusive=locks(),options={sessionId:'local-research',retentionConsent:true,retentionMs:100,storage:disk,locks:exclusive,pageNow:()=>10,wallNow:()=>wall};
 disk.deleteMany=async ids=>{if(fail)throw Error('transaction aborted');for(const id of ids)await disk.delete(id);};
 const first=await openDurableSession(options);await first.journal.run('a'.repeat(64),async()=>{});await first.close();wall=1100;fail=true;
 await assert.rejects(openDurableSession({...options,mode:'reopen'}),/transaction aborted/);assert.ok(await disk.load('local-research'));assert.ok(await disk.load('provider-journal:local-research'));
 await assert.rejects(deleteDurableSlot({sessionId:'local-research',storage:disk,locks:exclusive}),/transaction aborted/);assert.ok(await disk.load('local-research'));assert.ok(await disk.load('provider-journal:local-research'));
 fail=false;await deleteDurableSlot({sessionId:'local-research',storage:disk,locks:exclusive});assert.equal(await disk.load('local-research'),null);assert.equal(await disk.load('provider-journal:local-research'),null);
});

test('IndexedDB deletes both keys in one transaction and rejects an abort',async()=>{
 let transactions=0,keys=[],abort=false;const db={transaction(){transactions++;const tx={error:null,objectStore(){return {delete(id){keys.push(id);return {result:undefined};}};},abort(){}};queueMicrotask(()=>abort?tx.onabort():tx.oncomplete());return tx;}};
 const disk=new IndexedDBStorage({indexedDB:{}});disk.dbPromise=Promise.resolve(db);await disk.deleteMany(['slot','provider-journal:slot']);assert.equal(transactions,1);assert.deepEqual(keys,['slot','provider-journal:slot']);abort=true;await assert.rejects(disk.deleteMany(['slot','provider-journal:slot']),/aborted/);
});
