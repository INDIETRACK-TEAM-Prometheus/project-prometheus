import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {ProviderJournal,providerOperationId} from '../src/runtime/provider-journal.js';
if(!globalThis.crypto) globalThis.crypto=webcrypto;
const disk=()=>{const data=new Map();return {durable:true,load:async k=>structuredClone(data.get(k)??null),save:async(k,v)=>data.set(k,structuredClone(v)),delete:async k=>data.delete(k),data};};
const opts=storage=>({storage,sessionId:'session',retentionConsent:true,expiresAt:200,now:()=>100,maxEntries:2});
test('a crash or failed request remains uncertain on reopen and cannot be replayed',async()=>{
 const storage=disk(), id=await providerOperationId('session','reason','frame');let calls=0;
 const journal=await ProviderJournal.open(opts(storage));await assert.rejects(journal.run(id,async()=>{calls++;throw Error('network');}));
 const reopened=await ProviderJournal.open(opts(storage));await assert.rejects(reopened.run(id,async()=>calls++),/uncertain/);assert.equal(calls,1);
 assert.doesNotMatch(JSON.stringify([...storage.data]),/frame|reason/);
});
test('completed and concurrent duplicate calls are suppressed; full and failed storage fail closed',async()=>{
 const storage=disk(),journal=await ProviderJournal.open(opts(storage)),a=await providerOperationId('session','sam','a'),b=await providerOperationId('session','sam','b'),c=await providerOperationId('session','sam','c');let calls=0,finish;
 const first=journal.run(a,()=>{calls++;return new Promise(r=>finish=r);});await new Promise(r=>setTimeout(r,0));await assert.rejects(journal.run(a,()=>calls++),/uncertain/);finish('ok');assert.equal(await first,'ok');
 const reopened=await ProviderJournal.open(opts(storage));await assert.rejects(reopened.run(a,()=>calls++),/completed/);await reopened.run(b,async()=>calls++);await assert.rejects(reopened.run(c,()=>calls++),/full/);assert.equal(calls,2);
 await reopened.delete();assert.equal(storage.data.size,0);
 const broken=disk();broken.save=async()=>{throw Error('storage');};const j=await ProviderJournal.open(opts(broken));await assert.rejects(j.run(a,()=>calls++),/storage/);assert.equal(calls,2);
});
test('durable journals require consent and valid expiry',async()=>{const s=disk();await assert.rejects(ProviderJournal.open({...opts(s),retentionConsent:false}));await assert.rejects(ProviderJournal.open({...opts(s),expiresAt:100}));});
test('expiry during a provider call withholds its result and does not write completion',async()=>{
 const storage=disk();let now=100,finish;const journal=await ProviderJournal.open({...opts(storage),now:()=>now});
 const pending=journal.run('a'.repeat(64),()=>new Promise(resolve=>{finish=resolve;}));
 while(!finish) await new Promise(resolve=>setTimeout(resolve,0));
 now=200;finish('late result');await assert.rejects(pending,/expired/);
 assert.equal((await storage.load('provider-journal:session')).entries[0].state,'uncertain');
 await journal.close();
});
test('expiry during the claim prevents the provider call',async()=>{
 const storage=disk();let now=100,calls=0;const save=storage.save;storage.save=async(...args)=>{await save(...args);now=200;};
 const journal=await ProviderJournal.open({...opts(storage),now:()=>now});
 await assert.rejects(journal.run('b'.repeat(64),async()=>{calls++;}),/expired/);assert.equal(calls,0);await journal.close();
});
