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
