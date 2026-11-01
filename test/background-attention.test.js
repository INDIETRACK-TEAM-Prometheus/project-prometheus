import test from 'node:test';
import assert from 'node:assert/strict';
import {BackgroundAttentionCoordinator} from '../src/runtime/background-attention.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
function snapshot({frameId='f1', observedAt=10, processedAt=11, key=`${frameId}`, gazeX=.2, objectIds=['cup'], objectVersions, evidenceIds=[frameId], mapVersion=1}={}) {
  return {
    stateKey:key,
    frame:{frameId,observedAt,processedAt},
    gaze:{frameId,x:gazeX,y:.4,observedAt,processedAt},
    observedUntil:observedAt,
    processedAt,
    candidates:objectIds.map(objectId=>({objectId})),
    dependencies:{mapId:'map',mapVersion,objectIds,evidenceIds,expiresAt:1000,...(objectVersions?{objectVersions}:{})}
  };
}
const output = (id, target='cup') => ({scenarios:[{scenario_id:id,possible_next_action:'Look toward the next visible object',horizon_ms:1000,grounding_refs:[id],assumptions:[],status:'active'}],nextGaze:{rankedTargetIds:[target]}});

test('latest-only background work keeps one active and one pending snapshot without cancelling for new frames', async () => {
  const calls=[], published=[];
  const coordinator=new BackgroundAttentionCoordinator({work:(value,{signal})=>{const item=deferred();calls.push({value,signal,resolve:item.resolve});return item.promise;},publish:value=>published.push(value),now:()=>12,minIntervalMs:0,timeoutMs:1000});
  coordinator.start('s');
  assert.deepEqual(coordinator.observe(snapshot({frameId:'f1',key:'one'})),{accepted:true,coalesced:false});
  await flush();
  coordinator.observe(snapshot({frameId:'f2',key:'two'}));
  coordinator.observe(snapshot({frameId:'f3',key:'three'}));
  assert.equal(calls.length,1);
  assert.equal(calls[0].signal.aborted,false);
  assert.equal(coordinator.status().pending,true);
  assert.equal(coordinator.status().maxPending,1);
  assert.equal(coordinator.status().metrics.dropped,1);
  calls[0].resolve(output('f1'));
  await flush(); await flush();
  assert.equal(calls.length,2);
  assert.equal(calls[1].value.frame.frameId,'f3');
  calls[1].resolve(output('f3'));
  await flush();
  assert.deepEqual(published.map(value=>[value.frameId,value.deliveryState]),[['f1','generated'],['f3','generated']]);
  assert.equal(coordinator.status().metrics.maxConcurrent,1);
  assert.equal(coordinator.status().pending,false);
  coordinator.stop();
});

test('pause, resume, stop and session restart suppress stale work and accept a fresh snapshot', async () => {
  const calls=[], published=[];
  const coordinator=new BackgroundAttentionCoordinator({work:(value,{signal})=>{const item=deferred();calls.push({value,signal,resolve:item.resolve});return item.promise;},publish:value=>published.push(value),now:()=>12,minIntervalMs:0,timeoutMs:1000});
  coordinator.start('first'); coordinator.observe(snapshot({frameId:'old',key:'old'})); await flush();
  assert.equal(coordinator.pause(),true); assert.equal(calls[0].signal.aborted,true);
  assert.equal(coordinator.observe(snapshot({frameId:'paused'})).reason,'paused');
  coordinator.resume(); coordinator.observe(snapshot({frameId:'resumed',key:'resumed'}));
  calls[0].resolve(output('old')); await flush(); await flush();
  assert.equal(calls.length,2); assert.equal(calls[1].value.frame.frameId,'resumed');
  calls[1].resolve(output('resumed')); await flush();
  assert.deepEqual(published.map(value=>value.frameId),['resumed']);
  coordinator.observe(snapshot({frameId:'stopped'})); await flush();
  const stoppedCall=calls[2]; assert.ok(stoppedCall);
  coordinator.stop(); assert.equal(stoppedCall.signal.aborted,true);
  stoppedCall.resolve(output('stopped')); await flush();
  assert.equal(coordinator.observe(snapshot()).reason,'stopped');
  coordinator.start('second'); coordinator.observe(snapshot({frameId:'new-session',key:'new'})); await flush();
  calls[3].resolve(output('new-session')); await flush();
  assert.deepEqual(published.map(value=>value.frameId),['resumed','new-session']);
  coordinator.stop();
});

test('related invalidation aborts current work while unrelated objects retain it', async () => {
  const calls=[], published=[];
  const coordinator=new BackgroundAttentionCoordinator({work:(value,{signal})=>{const item=deferred();calls.push({value,signal,resolve:item.resolve});return item.promise;},publish:value=>published.push(value),now:()=>12,minIntervalMs:0,timeoutMs:1000});
  coordinator.start('s'); coordinator.observe(snapshot({frameId:'f1',key:'first'})); await flush();
  assert.equal(coordinator.invalidate({type:'object_moved',objectId:'other'}),0);
  assert.equal(calls[0].signal.aborted,false);
  assert.equal(coordinator.invalidate({type:'object_moved',objectId:'cup'}),0);
  assert.equal(calls[0].signal.aborted,true);
  calls[0].resolve(output('f1')); await flush();
  assert.deepEqual(published,[]);
  assert.equal(coordinator.status().metrics.invalidatedResults,1);
  coordinator.stop();
});

test('causal snapshots and generated grounding are validated; next targets must be in the candidate space', async () => {
  let now=12; const published=[];
  const coordinator=new BackgroundAttentionCoordinator({work:async value=>({scenarios:[{scenario_id:'scenario',possible_next_action:'Observe an object',horizon_ms:1000,grounding_refs:value.dependencies.evidenceIds,assumptions:[],status:'active'}]}),nextTargets:async()=>({rankedTargetIds:['not-a-candidate']}),publish:value=>published.push(value),now:()=>now,minIntervalMs:0,timeoutMs:1000});
  coordinator.start('s');
  assert.throws(()=>coordinator.observe({...snapshot(),observedUntil:10,context:{memory:[{evidenceId:'future',observedAt:11,processedAt:11,causalStatus:'online_causal'}]},dependencies:{...snapshot().dependencies,evidenceIds:['f1','future']}}),/noncausal/);
  assert.throws(()=>coordinator.observe({...snapshot(),dependencies:{...snapshot().dependencies,evidenceIds:['unknown']}}),/unknown evidence/);
  coordinator.observe(snapshot({frameId:'f1',key:'bad-result'})); await flush();
  assert.deepEqual(published,[]);
  assert.equal(coordinator.status().metrics.workFailures,1);
  assert.equal(coordinator.status().metrics.cacheErrors,0);
  coordinator.stop();
  now=13;
});

test('cache hits preserve original evidence and source cutoff, and unchanged state refreshes after TTL', async () => {
  let now=12; const calls=[], published=[];
  const coordinator=new BackgroundAttentionCoordinator({work:async value=>{calls.push(value.frame.frameId);return output(value.dependencies.evidenceIds[0]);},publish:value=>published.push(value),now:()=>now,cacheTtlMs:100,refreshIntervalMs:100,minIntervalMs:0,timeoutMs:1000});
  coordinator.start('s'); coordinator.observe(snapshot({frameId:'f1',key:'state-a'})); await flush();
  now=22; coordinator.observe(snapshot({frameId:'f2',observedAt:20,processedAt:21,key:'state-b'})); await flush();
  now=32; coordinator.observe(snapshot({frameId:'f3',observedAt:30,processedAt:31,key:'state-a'})); await flush();
  assert.deepEqual(calls,['f1','f2']);
  assert.equal(published[2].deliveryState,'cache_hit');
  assert.equal(published[2].frameId,'f1');
  assert.equal(published[2].dependencies.evidenceIds[0],'f1');
  assert.equal(published[2].sourceAgeMs,22);
  assert.equal(published[2].timings.generationMs,null);
  now=33; assert.equal(coordinator.observe(snapshot({frameId:'f3b',observedAt:30,processedAt:32,key:'state-a'})).reason,'duplicate');
  now=133; coordinator.observe(snapshot({frameId:'f4',observedAt:130,processedAt:132,key:'state-a'})); await flush();
  assert.deepEqual(calls,['f1','f2','f4']);
  assert.equal(published.at(-1).deliveryState,'generated');
  assert.equal(coordinator.status().metrics.generationCallsPerMinute,3);
  coordinator.stop();
});

test('timeout aborts work but holds its single slot until an uncooperative callback settles', async () => {
  const calls=[], published=[];
  const coordinator=new BackgroundAttentionCoordinator({work:(value,{signal})=>{const item=deferred();calls.push({signal,resolve:item.resolve});return item.promise;},publish:value=>published.push(value),now:()=>12,minIntervalMs:0,timeoutMs:10});
  coordinator.start('s'); coordinator.observe(snapshot()); await flush();
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(calls[0].signal.aborted,true);
  assert.equal(coordinator.status().running,true);
  assert.equal(coordinator.status().metrics.timeouts,1);
  calls[0].resolve(output('f1')); await flush();
  assert.deepEqual(published,[]);
  assert.equal(coordinator.status().running,false);
  coordinator.stop();
});

// ---- persistent object dependencies (A03 / G4-C) ----
const DIGEST = 'a'.repeat(64);
function sized({frameId='f1', at=10, key=frameId, objectIds=['cup'], expiresAt=1e9}={}) {
  return {...snapshot({frameId, observedAt:at, processedAt:at, key, objectIds, evidenceIds:[frameId]}), frame:{frameId, observedAt:at, processedAt:at, width:16, height:16}, dependencies:{mapId:'map', mapVersion:1, objectIds, evidenceIds:[frameId], expiresAt}};
}
const trackedOutput = (ids, extra={}) => ({...output('x', ids[0]), nextGaze:{rankedTargetIds:[ids[0]]}, objectDependencies:{objectIds:ids, objectVersions:Object.fromEntries(ids.map(id=>[id, DIGEST]))}, candidateSpace:{frameId:extra.frameId ?? 'f1', observedAt:extra.at ?? 10, candidates:ids.map((objectId, i)=>({objectId, bounds:{left:i, top:0, right:i+4, bottom:4}, maskDigest:DIGEST, identityStatus:'linked', area:16})), provenance:{frameId:extra.frameId ?? 'f1', observedAt:extra.at ?? 10, samModel:'sam-3.1', samRequestId:null}}});
const grounded = (value, frameId) => ({...value, scenarios:value.scenarios.map(s=>({...s, grounding_refs:[frameId]}))});

test('persistent track IDs become cache dependencies: unrelated change keeps the cache, related change invalidates it', async () => {
  const published=[];
  const coordinator=new BackgroundAttentionCoordinator({work:async()=>grounded(trackedOutput(['trk:a:1','trk:a:2']),'f1'),publish:value=>published.push(value),now:()=>12,minIntervalMs:0,timeoutMs:1000});
  coordinator.start('s'); coordinator.observe(sized({frameId:'f1',key:'state'})); await flush();
  assert.equal(published.length,1);
  assert.deepEqual(published[0].dependencies.objectIds,['cup','trk:a:1','trk:a:2']);
  assert.equal(published[0].dependencies.objectVersions['trk:a:1'],DIGEST);
  assert.equal(published[0].candidateSpace.candidates[0].objectId,'trk:a:1');
  assert.deepEqual(published[0].nextGaze,{rankedTargetIds:['trk:a:1']});
  // A later request carries only snapshot-time dependencies; the cached result is still served.
  assert.ok(coordinator.getPrepared(coordinator.latest));
  assert.equal(coordinator.invalidate({type:'object_moved',objectId:'trk:a:3'}),0);
  assert.equal(coordinator.invalidate({type:'object_deleted',objectId:'unrelated'}),0);
  assert.ok(coordinator.getPrepared(coordinator.latest));
  assert.equal(coordinator.invalidate({type:'identity_changed',objectId:'trk:a:2'}),1);
  assert.equal(coordinator.getPrepared(coordinator.latest),null);
  coordinator.stop();
});

test('tracker-reported invalidations during work drop only dependent cache entries and survive a later failure', async () => {
  const published=[]; let step=0;
  const coordinator=new BackgroundAttentionCoordinator({work:async(value,{invalidate})=>{
    step++;
    if (step===1) return grounded(trackedOutput(['trk:a:1','trk:a:2']),'f1');
    if (step===2) { invalidate({type:'object_moved',objectId:'trk:a:1'}); return grounded(trackedOutput(['trk:a:2'],{frameId:'f2',at:20}),'f2'); }
    invalidate({type:'object_deleted',objectId:'trk:a:2'}); throw new Error('reason failed');
  },publish:value=>published.push(value),now:()=>30,minIntervalMs:0,timeoutMs:1000});
  coordinator.start('s');
  coordinator.observe(sized({frameId:'f1',at:10,key:'a'})); await flush();
  const requestA=coordinator.latest;
  coordinator.observe(sized({frameId:'f2',at:20,key:'b'})); await flush();
  const requestB=coordinator.latest;
  assert.equal(coordinator.getPrepared(requestA),null);
  assert.ok(coordinator.getPrepared(requestB));
  coordinator.observe(sized({frameId:'f3',at:25,key:'c'})); await flush();
  assert.equal(coordinator.getPrepared(requestB),null);
  assert.equal(coordinator.status().metrics.workFailures,1);
  assert.equal(coordinator.telemetry().counts.failed,1);
  coordinator.stop();
});

test('candidate spaces carry only linked persistent candidates and reject malformed provenance', async () => {
  const bad = [
    space => { space.candidates[0].identityStatus='tentative'; },
    space => { space.candidates[0].maskDigest='xyz'; },
    space => { space.candidates.push({...space.candidates[0]}); },
    space => { space.candidates[0].extra=1; },
    space => { space.provenance.frameId='other'; },
    space => { space.candidates[0].bounds.right=99; }
  ];
  for (const mutate of bad) {
    const published=[], value=grounded(trackedOutput(['trk:a:1']),'f1'); mutate(value.candidateSpace);
    const coordinator=new BackgroundAttentionCoordinator({work:async()=>value,publish:v=>published.push(v),now:()=>12,minIntervalMs:0,timeoutMs:1000});
    coordinator.start('s'); coordinator.observe(sized({frameId:'f1',key:'k'})); await flush();
    assert.deepEqual(published,[]); assert.equal(coordinator.status().metrics.workFailures,1);
    coordinator.stop();
  }
  const invalidDeps=new BackgroundAttentionCoordinator({work:async()=>({...grounded(trackedOutput(['trk:a:1']),'f1'),objectDependencies:{objectIds:['trk:a:1'],objectVersions:{other:DIGEST}}}),now:()=>12,minIntervalMs:0,timeoutMs:1000});
  invalidDeps.start('s'); invalidDeps.observe(sized({frameId:'f1',key:'k'})); await flush();
  assert.equal(invalidDeps.status().metrics.workFailures,1);
  invalidDeps.stop();
});

// ---- telemetry (A12 / G4-A, G4-D, G4-E) ----
function clocked(options={}) {
  const state={now:0,published:[]};
  const coordinator=new BackgroundAttentionCoordinator({work:async(value,{mark})=>{state.step?.(value,mark); return grounded(output('x'),value.frame.frameId);},publish:value=>state.published.push(value),now:()=>state.now,minIntervalMs:0,timeoutMs:1000,...options});
  state.coordinator=coordinator;
  state.cycle=async(n,duration,key=`k${n}`)=>{const at=state.now; state.step=()=>{state.now+=duration;}; coordinator.observe(sized({frameId:`f${n}`,at,key})); await flush();};
  return state;
}

test('telemetry reports exact nearest-rank percentiles, deadline flags and a bounded window', async () => {
  const t=clocked({deadlineMs:55,telemetrySamples:10});
  t.coordinator.start('s');
  for (let n=1;n<=10;n++) { await t.cycle(n,n*10); t.now+=1000; }
  let tel=t.coordinator.telemetry();
  assert.equal(tel.counts.generated,10); assert.equal(tel.counts.published,10);
  assert.deepEqual(tel.generated.latencyMs,{n:10,p50:50,p95:100,max:100});
  assert.equal(tel.generated.deadlineMet,5); assert.equal(tel.generated.deadlineMissed,5); assert.equal(tel.generated.deadlineMetRate,0.5);
  assert.deepEqual(tel.cached.latencyMs,{n:0,p50:null,p95:null,max:null});
  assert.equal(tel.cached.deadlineMetRate,null);
  assert.equal(tel.recent.length,8);
  // The window is bounded: an 11th cycle evicts the oldest (10 ms) sample but never grows past telemetrySamples.
  await t.cycle(11,5);
  tel=t.coordinator.telemetry();
  assert.equal(tel.retainedCycles,10);
  assert.deepEqual(tel.generated.latencyMs,{n:10,p50:50,p95:100,max:100});
  assert.equal(tel.counts.published,11);
  for (let n=12;n<=60;n++) await t.cycle(n,1);
  tel=t.coordinator.telemetry();
  assert.equal(tel.retainedCycles,10); assert.equal(t.coordinator.tel.cycles.length,10); assert.ok(t.coordinator.tel.publishes.length<=10);
  assert.deepEqual(tel.generated.latencyMs,{n:10,p50:1,p95:1,max:1});
  t.coordinator.stop();
});

test('cached publishes and fresh generations are measured separately, with result age and effective Hz', async () => {
  const t=clocked({deadlineMs:100,cacheTtlMs:100000,refreshIntervalMs:100000});
  t.coordinator.start('s');
  await t.cycle(1,80,'A'); t.now=1000;
  await t.cycle(2,120,'B'); t.now=2000;
  await t.cycle(3,0,'A'); t.now=10000;
  const tel=t.coordinator.telemetry();
  assert.deepEqual(t.published.map(v=>v.deliveryState),['generated','generated','cache_hit']);
  assert.deepEqual(tel.generated.latencyMs,{n:2,p50:80,p95:120,max:120});
  assert.equal(tel.generated.deadlineMet,1); assert.equal(tel.generated.deadlineMissed,1);
  assert.deepEqual(tel.cached.latencyMs,{n:1,p50:0,p95:0,max:0});
  assert.equal(tel.cached.deadlineMetRate,1);
  // The cached result still reports the age of its original observation (frame 1 at t=0), not of the new frame.
  assert.deepEqual(tel.cached.resultAgeMs,{n:1,p50:2000,p95:2000,max:2000});
  assert.deepEqual(tel.generated.resultAgeMs,{n:2,p50:80,p95:120,max:120});
  assert.deepEqual(tel.effectiveHz,{all:0.3,generated:0.2,cache_hit:0.1});
  assert.equal(tel.counts.cacheHits,1);
  t.coordinator.stop();
});

test('stage times come from work marks and stay null when work does not report them', async () => {
  const t=clocked();
  t.coordinator.start('s');
  const at=t.now; t.step=(value,mark)=>{t.now+=30; mark('samDone'); t.now+=20; mark('reasonFirstByte'); mark('samDone'); t.now+=10; mark('bogus');};
  t.coordinator.observe(sized({frameId:'f1',at,key:'k1'})); await flush();
  await t.cycle(2,5);
  const tel=t.coordinator.telemetry();
  assert.deepEqual(tel.generated.samMs,{n:1,p50:30,p95:30,max:30});
  assert.deepEqual(tel.generated.reasonFirstByteMs,{n:1,p50:20,p95:20,max:20});
  const [first,second]=tel.recent;
  assert.equal(first.samDoneAt,30); assert.equal(first.reasonFirstByteAt,50); assert.equal(first.publishedAt,60); assert.equal(first.snapshotAt,0);
  assert.equal(second.samDoneAt,null); assert.equal(second.reasonFirstByteAt,null);
  t.coordinator.stop();
});

test('dropped, failed, stale and superseded results are counted and reset per session', async () => {
  const calls=[]; let now=12;
  const coordinator=new BackgroundAttentionCoordinator({work:(value,{signal})=>{const item=deferred();calls.push({value,signal,...item});return item.promise;},publish:()=>{},now:()=>now,minIntervalMs:0,timeoutMs:1000});
  coordinator.start('s');
  coordinator.observe(sized({frameId:'f1',at:10,key:'a'})); await flush();
  coordinator.observe(sized({frameId:'f2',at:10,key:'b'}));
  coordinator.observe(sized({frameId:'f3',at:10,key:'c'}));
  assert.equal(coordinator.telemetry().counts.dropped,1);
  calls[0].resolve(grounded(output('x'),'f1')); await flush(); await flush();
  assert.equal(calls[1].value.frame.frameId,'f3');
  calls[1].resolve({}); await flush(); // invalid result counts as a failed cycle
  assert.equal(coordinator.telemetry().counts.failed,1);
  coordinator.observe(sized({frameId:'f4',at:10,key:'d'})); await flush();
  coordinator.invalidate({type:'object_moved',objectId:'cup'});
  calls[2].resolve(grounded(output('x'),'f4')); await flush();
  assert.equal(coordinator.telemetry().counts.stale,1);
  coordinator.observe(sized({frameId:'f5',at:10,key:'e',objectIds:['other']})); await flush();
  coordinator.lastPublishedSequence=1e6; // a newer result is already out
  calls[3].resolve(grounded(output('x','other'),'f5')); await flush();
  assert.equal(coordinator.telemetry().counts.superseded,1);
  const counts=coordinator.telemetry().counts;
  assert.equal(counts.published,1); assert.equal(counts.observed,5);
  assert.deepEqual(coordinator.telemetry().recent.map(c=>c.outcome),['generated','failed','stale','superseded']);
  coordinator.stop();
  coordinator.start('t'); // new session: counters restart
  assert.equal(coordinator.telemetry().counts.observed,0);
  coordinator.stop();
});

test('stale results never overwrite newer ones and stop issues no further provider calls', async () => {
  const calls=[], published=[];
  const coordinator=new BackgroundAttentionCoordinator({work:(value,{signal})=>{const item=deferred();calls.push({value,signal,...item});return item.promise;},publish:value=>published.push(value),now:()=>12,minIntervalMs:0,timeoutMs:1000});
  coordinator.start('s');
  coordinator.observe(sized({frameId:'old',at:10,key:'old'})); await flush();
  coordinator.pause(); coordinator.resume();
  coordinator.observe(sized({frameId:'new',at:10,key:'new'}));
  calls[0].resolve(grounded(output('x'),'old')); await flush(); await flush();
  assert.equal(calls.length,2);
  calls[1].resolve(grounded(output('x'),'new')); await flush();
  assert.deepEqual(published.map(v=>v.frameId),['new']);
  assert.equal(coordinator.telemetry().counts.stale,1);
  // Stop with one call running and one snapshot pending: neither a settle nor a timer may start another call.
  coordinator.observe(sized({frameId:'run',at:10,key:'run'})); await flush();
  coordinator.observe(sized({frameId:'queued',at:10,key:'queued'}));
  coordinator.stop();
  calls[2].resolve(grounded(output('x'),'run')); await flush(); await flush();
  assert.equal(calls.length,3); assert.equal(published.length,1);
  assert.equal(coordinator.observe(sized({frameId:'after',at:10,key:'after'})).reason,'stopped');
  assert.equal(calls.length,3);
});

test('stop clears a scheduled dispatch so no provider call fires later', async () => {
  const calls=[];
  const coordinator=new BackgroundAttentionCoordinator({work:async()=>{calls.push(1);return grounded(output('x'),'f1');},publish:()=>{},now:()=>12,minIntervalMs:60,timeoutMs:1000});
  coordinator.start('s');
  coordinator.observe(sized({frameId:'f1',at:10,key:'a'})); await flush();
  assert.equal(calls.length,1);
  coordinator.observe(sized({frameId:'f2',at:10,key:'b'}));
  coordinator.stop();
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(calls.length,1);
});

test('invalid telemetry configuration is rejected', () => {
  for (const bad of [{deadlineMs:0},{telemetrySamples:0},{telemetrySamples:5000},{telemetryWindowMs:0},{deadlineMs:-1}]) assert.throws(()=>new BackgroundAttentionCoordinator({work:async()=>{},...bad}),/invalid background attention/);
});

test('constructor snapshot option drives polling without observe calls and stops on stop', async () => {
  let polls = 0, frame = 0;
  const calls = [];
  const coordinator = new BackgroundAttentionCoordinator({snapshot:() => { polls++; frame++; return snapshot({frameId:`p${frame}`, key:`p${frame}`, observedAt:frame, processedAt:frame}); }, work:value => { calls.push(value.frame.frameId); return {scenarios:[]}; }, intervalMs:5, minIntervalMs:0, now:() => 500});
  coordinator.start('s');
  try {
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.ok(polls >= 2, `polled ${polls} times`);
    assert.ok(calls.length >= 1, `work called ${calls.length} times`);
  } finally { coordinator.stop(); }
  const after = polls;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(polls, after);
});
