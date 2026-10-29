import test from 'node:test';
import assert from 'node:assert/strict';
import {EvidenceRing,ExperienceMemory,causalReplay,MemoryService,EphemeralStorage,IndexedDBStorage} from '../src/memory/index.js';

test('T16: shared evidence is counted once, pin failure and expiry are explicit',()=>{
  const b=new EvidenceRing({maxAgeMs:10,maxBytes:10,maxPins:2,maxPinnedBytes:10,pinAgeMs:20});
  b.add({id:'frame',observedAt:0,bytes:8},0);
  assert.equal(b.pin('a',['frame'],1).ok,true); assert.equal(b.pin('b',['frame'],2).ok,true);
  assert.equal(b.pin('c',['frame'],3).reason,'pin_count_limit');
  b.tick(11); assert.equal(b.ring.size,0); assert.equal(b.get('a').items[0].id,'frame');
  b.tick(21); assert.equal(b.get('a'),null); assert.equal(b.evictions.at(-1).reason,'pin_age_limit');
  assert.equal(b.pin('missing',['no'],21).reason,'evidence_unavailable');
});
test('T05/T06/T07: immutable events, last-seen history and late revisions',()=>{
  const m=new ExperienceMemory();
  const event={eventId:'e1',type:'briefly_crossed',observedAt:1,processedAt:2,endAt:2,evidenceIds:['f'],associationRevision:0};
  assert.equal(m.appendEvent(event),true); assert.equal(m.appendEvent(event),false);
  m.appendEvent({...event,eventId:'e2',processedAt:9,associationRevision:1,supersedesEventId:'e1'});
  m.observe({observationId:'o1',objectId:'cup',observedAt:1,processedAt:2,lastSeenPosition:[1,0,0],visibilityState:'visible',evidenceIds:['f']});
  m.observe({observationId:'o2',objectId:'cup',observedAt:4,processedAt:5,lastSeenPosition:[2,0,0],visibilityState:'occluded',evidenceIds:['g']});
  assert.deepEqual(m.lastSeen('cup',2).lastSeenPosition,[1,0,0]);
  const latest=m.lastSeen('cup'); assert.equal(latest.positionMeaning,'last_seen_not_current'); latest.lastSeenPosition[0]=99;
  assert.equal(m.lastSeen('cup').lastSeenPosition[0],2); assert.equal(m.glimpses()[0].observedAt,1); assert.equal(m.glimpses().length,1);
});
test('T17: reversible identity and temporal relation do not alter source observations',()=>{
  const m=new ExperienceMemory();
  m.observe({observationId:'a',objectId:'a',observedAt:1,processedAt:1,lastSeenPosition:[0,0,0]});
  m.observe({observationId:'b',objectId:'b',observedAt:2,processedAt:2,lastSeenPosition:[3,0,0]});
  m.link({linkId:'l',objectIds:['a','b'],observedAt:3,processedAt:3});
  assert.equal(m.lastSeen('a').observationId,'b'); m.unlink('l'); assert.equal(m.lastSeen('a').observationId,'a');
  m.addRelation({relationId:'r',subjectId:'a',relation:'near',objectId:'b',validFrom:1,validTo:3,lastVerifiedAt:2,observedAt:1,processedAt:2,evidenceIds:['f']});
  assert.equal(m.relationsAt(2).length,1); assert.equal(m.relationsAt(3).length,0);
});
test('T20: evidence deletion invalidates derived records and retrieval',()=>{
  const m=new ExperienceMemory(); m.appendEvent({eventId:'e',type:'briefly_crossed',observedAt:1,processedAt:1,evidenceIds:['f']});
  m.addDerivation({id:'d',evidenceIds:['f']}); m.deleteEvidence('f');
  assert.deepEqual(m.glimpses(),[]); assert.equal(m.getDerivation('d').reason,'evidence_deleted');
});
test('T21: only available causal data at issue time is returned',()=>{
  const records=[{observedAt:1,processedAt:2,causalStatus:'online_causal',groundTruth:'secret'}, {observedAt:1,processedAt:3,causalStatus:'offline_assisted'}, {observedAt:1,processedAt:9,causalStatus:'online_causal'}, {observedAt:1,processedAt:1,causalStatus:'unknown'}];
  const result=causalReplay(records,5); assert.equal(result.length,1); assert.equal(result[0].groundTruth,undefined); assert.equal(result[0].depth,null); assert.equal(result[0].unavailableReasons.depth,'not_supplied');
});
test('service serializes ingestion, revises and deletes evidence with atomic snapshot',async()=>{
  const store=new EphemeralStorage(); store.durable=true;
  const options={sessionId:'s',storage:store,retentionConsent:true,retentionMs:60000};
  const s=await MemoryService.open(options);
  await s.ingestFrame({id:'f',observedAt:1,bytes:2},1);
  const event={eventId:'e',type:'briefly_crossed',observedAt:1,processedAt:2,associationRevision:0};
  assert.equal((await s.ingestEvent(event,['f'],2)).pin,'pinned');
  assert.equal((await s.ingestEvent(event,['f'],2)).inserted,false);
  await s.reviseEvent({...event,eventId:'e2',processedAt:4,associationRevision:1,supersedesEventId:'e',evidenceIds:['f']});
  await s.observe({observationId:'o',objectId:'cup',observedAt:1,processedAt:4,evidenceIds:['f'],lastSeenPosition:[1,2,3]});
  assert.equal((await s.retrieve({objectId:'cup',observedUntil:2})).lastSeen,null);
  assert.equal((await s.retrieve({observedUntil:2})).glimpses.length,1);
  await s.close();
  const resumed=await MemoryService.open(options);
  assert.equal((await resumed.retrieve({objectId:'cup'})).lastSeen.observationId,'o');
  assert.equal((await resumed.ingestEvent(event,['f'],4)).inserted,false);
  await resumed.deleteEvidence('f');
  assert.equal((await resumed.retrieve({objectId:'cup'})).lastSeen,null);
  await resumed.close();
  const again=await MemoryService.open(options); assert.equal((await again.retrieve()).glimpses.length,0);
  await assert.rejects(again.ingestFrame({id:'f',observedAt:5,bytes:2},5),/deleted/);
  await again.deleteSession(); assert.equal(await store.load('s'),null);
});
test('durable consent required, save failure rolls back, default close removes session',async()=>{
  const store=new EphemeralStorage(); store.durable=true;
  await assert.rejects(MemoryService.open({sessionId:'s',storage:store}),/consent/);
  const s=await MemoryService.open({sessionId:'s',storage:store,retentionConsent:true,retentionMs:60000});
  const save=store.save.bind(store); store.save=async()=>{throw new Error('quota');};
  await assert.rejects(s.ingestFrame({id:'f',observedAt:1,bytes:2},1),/quota/);
  store.save=save;
  assert.equal((await s.ingestEvent({eventId:'e',type:'briefly_crossed',observedAt:1,processedAt:1},['f'],1)).reason,'evidence_unavailable');
  const tmp=new EphemeralStorage(); const ephemeral=await MemoryService.open({sessionId:'tmp',storage:tmp});
  await ephemeral.ingestFrame({id:'f',observedAt:1,bytes:1},1); await ephemeral.close(); assert.equal(await tmp.load('tmp'),null);
  assert.throws(()=>new IndexedDBStorage({indexedDB:null}),/unavailable/);
});
test('injected clock governs retention on mutation, read and reopen',async()=>{
  let wall=1000; const clock=()=>wall; const store=new EphemeralStorage(); store.durable=true;
  const opts={sessionId:'retained',storage:store,retentionConsent:true,retentionMs:10,clock,retentionClock:clock};
  const s=await MemoryService.open(opts); await s.ingestFrame({id:'f',observedAt:0,bytes:1},0);
  wall=1010; await assert.rejects(s.retrieve(),/expired/); await assert.rejects(s.ingestFrame({id:'g',observedAt:1,bytes:1},1),/expired/);
  await s.close(); const fresh=await MemoryService.open(opts); assert.equal((await fresh.retrieve()).glimpses.length,0); assert.equal(await store.load('retained'),null);
});
test('pin expiry updates event validity and derivation; revisions supersede only after processing',async()=>{
  const s=await MemoryService.open({sessionId:'pin',ringOptions:{maxAgeMs:100,maxBytes:100,maxPins:3,maxPinnedBytes:100,pinAgeMs:5}});
  await s.ingestFrame({id:'f',observedAt:0,bytes:1},0);
  await s.ingestEvent({eventId:'e',type:'briefly_crossed',observedAt:0,processedAt:1,associationRevision:0},['f'],1);
  await s.addDerivation({id:'d',evidenceIds:['f'],eventIds:['e']});
  await s.reviseEvent({eventId:'e2',type:'briefly_crossed',observedAt:0,processedAt:3,associationRevision:1,supersedesEventId:'e',evidenceIds:['f']});
  assert.equal((await s.retrieve({observedUntil:2})).glimpses[0].eventId,'e');
  assert.deepEqual((await s.retrieve()).glimpses.map(e=>e.eventId),['e2']);
  await s.advanceTime(6); const event=(await s.retrieve()).glimpses[0];
  assert.equal(event.evidencePinState,'evidence_evicted'); assert.equal(event.evidenceEvictionReason,'pin_age_limit');
  assert.equal((await s.getDerivation('d')).valid,false);
  await s.addDerivation({id:'late',evidenceIds:['f']}); assert.equal((await s.getDerivation('late')).reason,'pin_age_limit');
});
test('record and byte quotas reject without modifying snapshot',async()=>{
  const store=new EphemeralStorage();
  const s=await MemoryService.open({sessionId:'limited',storage:store,maxRecords:1});
  await s.ingestFrame({id:'f',observedAt:0,bytes:1},0);
  await assert.rejects(s.observe({observationId:'o',objectId:'x',observedAt:0,processedAt:0}),/quota/);
  assert.equal((await s.retrieve({objectId:'x'})).lastSeen,null);
  const small=await MemoryService.open({sessionId:'bytes',maxSnapshotBytes:20});
  await assert.rejects(small.ingestFrame({id:'f',observedAt:0,bytes:1},0),/snapshot quota/);
});
test('close and delete wait for queued save and reject later writes',async()=>{
  const store=new EphemeralStorage(); let unblock; const original=store.save.bind(store);
  store.save=async (...args)=>{await new Promise(resolve=>{unblock=resolve;}); return original(...args);};
  const s=await MemoryService.open({sessionId:'race',storage:store});
  const write=s.ingestFrame({id:'f',observedAt:0,bytes:1},0);
  await new Promise(resolve=>setImmediate(resolve)); const closing=s.deleteSession();
  await assert.rejects(s.ingestFrame({id:'g',observedAt:1,bytes:1},1),/closed/);
  unblock(); await write; await closing; assert.equal(await store.load('race'),null);
  await assert.rejects(s.retrieve(),/closed/);
});
test('observation revisions preserve history and invalidate derivations without resurrecting deleted evidence',()=>{
  const m=new ExperienceMemory();
  const first={observationId:'o1',objectId:'a',observedAt:1,processedAt:2,associationRevision:0,evidenceIds:['frame'],lastSeenPosition:[1,0,0]};
  m.observe(first); m.addDerivation({id:'d',evidenceIds:['other'],observationIds:['o1']});
  const second={...first,observationId:'o2',objectId:'b',processedAt:5,associationRevision:1,supersedesObservationId:'o1'};
  m.observe(second); assert.equal(m.lastSeen('a',4).observationId,'o1'); assert.equal(m.lastSeen('b',4),null);
  assert.equal(m.lastSeen('a',5),null); assert.equal(m.lastSeen('b',5).observationId,'o2'); assert.equal(m.getDerivation('d').reason,'association_revised');
  m.addDerivation({id:'late',evidenceIds:['other'],observationIds:['o1']}); assert.equal(m.getDerivation('late').valid,false);
  const third={...second,observationId:'o3',objectId:'a',processedAt:8,associationRevision:2,supersedesObservationId:'o2'}; m.observe(third);
  assert.equal(m.lastSeen('b',7).observationId,'o2'); assert.equal(m.lastSeen('b',8),null); assert.equal(m.lastSeen('a',8).observationId,'o3');
  assert.throws(()=>m.observe({...third,observationId:'fork',supersedesObservationId:'o1'}),/revision/);
  assert.throws(()=>m.observe({...third,observationId:'missing',supersedesObservationId:'none'}),/missing/);
  m.addDerivation({id:'d3',evidenceIds:['other'],observationIds:['o3']}); m.deleteEvidence('frame');
  assert.equal(m.lastSeen('a'),null); assert.equal(m.lastSeen('b'),null); assert.equal(m.getDerivation('d3').reason,'evidence_deleted');
  assert.equal(m.observations.size,3);
});
test('perception cancellation skips queued and pending abortable writes',async()=>{
  const store=new EphemeralStorage(); let release; const save=store.save.bind(store); let block=true;
  store.save=async (...args)=>{if(block) await new Promise(r=>{release=r;}); return save(...args);};
  const memory=await MemoryService.open({sessionId:'cancel',storage:store,clock:()=>10});
  const earlier=memory.ingestFrame({id:'prior',observedAt:1,bytes:1},10); await new Promise(r=>setImmediate(r));
  const controller=new AbortController(); const payload={frame:{id:'frame',observedAt:2,bytes:1},observations:[{observationId:'o',objectId:'a',observedAt:2,processedAt:3,evidenceIds:['frame']}],event:null,now:10};
  const queued=memory.ingestPerception(payload,{signal:controller.signal}); controller.abort(); block=false; release(); await earlier;
  await assert.rejects(queued,/cancelled/); assert.equal((await memory.retrieve({objectId:'a'})).lastSeen,null);
  block=true; const during=new AbortController(); const writing=memory.ingestPerception(payload,{signal:during.signal}); await new Promise(r=>setImmediate(r)); during.abort(); block=false; release(); await assert.rejects(writing,/cancelled/);
  assert.equal((await memory.retrieve({objectId:'a'})).lastSeen,null); assert.equal((await store.load('cancel')).state.memory.observations.length,0); await memory.close();
});
test('attention history uses both cutoffs and suppresses superseded, deleted, evicted or unpinned evidence',async()=>{
 let now=30; const m=await MemoryService.open({sessionId:'history',clock:()=>now});
 const e=(id,obs,processed,type='fixated')=>({eventId:id,type,causalStatus:'online_causal',observedAt:obs,endAt:obs+2,processedAt:processed,dwellValidMs:2,candidateObjectIds:['object-'+id]});
 for(const [id,obs,processed] of [['a',1,5],['b',4,12],['future',25,28]]) {await m.ingestFrame({id:'f-'+id,observedAt:obs,bytes:1},now);await m.ingestEvent(e(id,obs,processed),['f-'+id],now);}
 let history=await m.attentionHistory({observedUntil:10,processedUntil:15});assert.deepEqual(history.map(x=>x.eventId),['a','b']);
 await m.ingestPerception({frame:{id:'f-revision',observedAt:1,bytes:1},observations:[],event:{...e('a',1,20),candidateObjectIds:['changed']},now});
 history=await m.attentionHistory({observedUntil:10,processedUntil:15});assert.deepEqual(history.map(x=>x.eventId),['a','b']);
 history=await m.attentionHistory({observedUntil:10,processedUntil:25});assert.deepEqual(history.map(x=>x.eventId),['a:association:1','b']);
 await m.deleteEvidence('f-revision');history=await m.attentionHistory({observedUntil:10,processedUntil:25});assert.deepEqual(history.map(x=>x.eventId),['b']);
 m.ring.evict('b','pin_age_limit');history=await m.attentionHistory({observedUntil:10,processedUntil:25});assert.deepEqual(history,[]);await m.close();
});
test('attention history selects newest twenty in stable chronological order',async()=>{
 const m=await MemoryService.open({sessionId:'bound',clock:()=>100});for(let i=0;i<25;i++){const id=String(i).padStart(2,'0');await m.ingestFrame({id:'f'+id,observedAt:i,bytes:1},100);await m.ingestEvent({eventId:'e'+id,type:'briefly_crossed',causalStatus:'online_causal',observedAt:i,endAt:i+1,processedAt:i+2,dwellValidMs:1},['f'+id],100);}
 const h=await m.attentionHistory({observedUntil:100,processedUntil:100});assert.equal(h.length,20);assert.equal(h[0].eventId,'e05');assert.equal(h[19].eventId,'e24');await m.close();
});

test('attention history excludes pinned records without online causal provenance',async()=>{
 const m=await MemoryService.open({sessionId:'provenance',clock:()=>10});
 for(const [id,status] of [['online','online_causal'],['offline','offline_assisted'],['unknown','unknown'],['missing',undefined]]) {
  await m.ingestFrame({id:'f-'+id,observedAt:1,bytes:1},10);
  await m.ingestEvent({eventId:id,type:'fixated',observedAt:1,endAt:2,processedAt:3,dwellValidMs:1,...(status ? {causalStatus:status} : {})},['f-'+id],10);
 }
 assert.deepEqual((await m.attentionHistory({observedUntil:5,processedUntil:5})).map(e=>e.eventId),['online']);
 await m.close();
});

test('durable expiry uses wall clock across monotonic resets and rejects ambiguous metadata',async()=>{
 const store=new EphemeralStorage();store.durable=true;let wall=1000,mono=500;
 const opts={sessionId:'restart',storage:store,retentionConsent:true,retentionMs:100,clock:()=>mono,retentionClock:()=>wall};
 const first=await MemoryService.open(opts);await first.ingestFrame({id:'f',observedAt:1,bytes:1},1);await first.close();
 const saved=await store.load('restart');assert.equal(saved.expiryClock,'unix_ms');assert.equal(saved.expiresAt,1100);
 mono=0;wall=1050;const resumed=await MemoryService.open(opts);assert.ok(resumed.ring.ring.has('f'));await resumed.close();
 wall=1100;const fresh=await MemoryService.open(opts);assert.equal(fresh.ring.ring.size,0);assert.equal(await store.load('restart'),null);await fresh.close();
 for(const expiry of [undefined,NaN,Infinity,-1]) {await store.save('restart',{...saved,expiryClock:expiry===undefined?undefined:'unix_ms',expiresAt:expiry});await assert.rejects(MemoryService.open(opts),/retention metadata/);assert.ok(await store.load('restart'));}
 await assert.rejects(MemoryService.open({...opts,maxSnapshotBytes:2*1024**3+1}),/quota/);
});

test('durable reads reject wall rollback and checkpoints reject future processed records',async()=>{
 let wall=1000,mono=20;const store=new EphemeralStorage();store.durable=true;
 const opts={sessionId:'rollback',storage:store,retentionConsent:true,retentionMs:100,clock:()=>mono,retentionClock:()=>wall};
 const m=await MemoryService.open(opts);await m.ingestFrame({id:'f',observedAt:1,bytes:1},1);
 await assert.rejects(m.observe({observationId:'future',objectId:'o',observedAt:1,processedAt:21}),/monotonic checkpoint/);
 assert.equal(m.memory.observations.size,0);wall=999;
 await assert.rejects(m.retrieve(),/retention clock/);await assert.rejects(m.getDerivation('x'),/retention clock/);await assert.rejects(m.attentionHistory({observedUntil:1,processedUntil:1}),/retention clock/);
 await m.close();await assert.rejects(MemoryService.open(opts),/retention metadata/);
 wall=1001;mono=0;const reopened=await MemoryService.open(opts);assert.equal(reopened.checkpointMonotonicMs,20);await reopened.close();
});

 test('committed withdrawals notify transitive identifiers, failed saves do not',async()=>{
  const storage=new EphemeralStorage(),m=await MemoryService.open({sessionId:'notify',storage,clock:()=>10});
  await m.ingestFrame({id:'f',observedAt:1,bytes:1},1);
  await m.observe({observationId:'o',objectId:'x',observedAt:1,processedAt:1,evidenceIds:['f']});
  await m.ingestEvent({eventId:'e',type:'briefly_crossed',observedAt:1,processedAt:1},['f'],1);
  const notices=[];m.subscribeInvalidations(ids=>notices.push(ids));const save=storage.save.bind(storage);storage.save=async()=>{throw Error('failed');};
  await assert.rejects(m.deleteEvidence('f'));assert.equal(notices.length,0);storage.save=save;
  await m.deleteEvidence('f');assert.deepEqual(new Set(notices[0]),new Set(['f','e','o']));await m.close();
 });

test('eviction invalidates derivations through observation evidence, including later derivations',async()=>{
 const m=await MemoryService.open({sessionId:'observation-eviction',clock:()=>10,ringOptions:{maxAgeMs:5}});
 await m.ingestFrame({id:'f',observedAt:1,bytes:1},1);
 await m.observe({observationId:'o',objectId:'x',observedAt:1,processedAt:1,evidenceIds:['f']});
 await m.addDerivation({id:'early',evidenceIds:['other'],observationIds:['o']});
 await m.advanceTime(6);
 assert.equal((await m.getDerivation('early')).reason,'ring_age_limit');
 await m.addDerivation({id:'late',evidenceIds:['other'],observationIds:['o']});
 assert.equal((await m.getDerivation('late')).reason,'ring_age_limit');
 await m.close();
});

test('evicted evidence IDs cannot be reintroduced through ingestion paths',async()=>{
 const m=await MemoryService.open({sessionId:'no-reuse',clock:()=>10,ringOptions:{maxAgeMs:5}});
 const old={id:'old',observedAt:1,bytes:1};
 await m.ingestFrame(old,1); await m.advanceTime(6);
 await assert.rejects(m.ingestFrame(old,6),/evidence was evicted/);
 await assert.rejects(m.pinFrameForEvent(old,'e',6),/evidence was evicted/);
 await assert.rejects(m.ingestPerception({frame:old,observations:[],event:null,now:6}),/evidence was evicted/);
 assert.equal(m.ring.evictions.length,1);
 assert.equal(await m.ingestFrame({id:'new',observedAt:6,bytes:1},6),true);
 await m.close();
});
