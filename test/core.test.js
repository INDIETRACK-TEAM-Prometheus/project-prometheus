import {test} from 'node:test';
import assert from 'node:assert/strict';
import {alignGaze, EvidenceBuffer, Memory, invalidate, causalBundle} from '../src/core.js';

test('alignment uses estimated presentation, not arrival, and enforces total error budget',()=>{
  const frames=[{id:'later',presentMs:110,displayUncertaintyMs:3},{id:'shown',presentMs:90,displayUncertaintyMs:3}];
  assert.equal(alignGaze({valid:true,captureMs:100,syncUncertaintyMs:2},frames).frameId,'shown');
  assert.equal(alignGaze({valid:true,captureMs:100,syncUncertaintyMs:50},frames).status,'withheld');
  assert.equal(alignGaze({valid:false,captureMs:100},frames).reason,'invalid_gaze');
  for(const n of [null,NaN,-1,Infinity]) assert.equal(alignGaze({valid:true,captureMs:100,syncUncertaintyMs:n},frames).status,'withheld');
  assert.equal(alignGaze({valid:true,captureMs:100,syncUncertaintyMs:1},[{id:'bad',presentMs:90,displayUncertaintyMs:-1}]).status,'withheld');
});
test('pins survive ring eviction, share capacity, and record failures',()=>{
  const b=new EvidenceBuffer({maxAgeMs:10,maxBytes:100,maxPins:2,maxPinnedBytes:10,pinAgeMs:100});
  b.add({id:'f',at:0,bytes:8},0);assert.equal(b.pin('e1','f',1),true);assert.equal(b.pin('e2','f',2),true);
  b.trim(20);assert.equal(b.frames.size,0);assert.equal(b.pins.size,2);
  assert.equal(b.pin('e3','f',21),false);assert.equal(b.evictions.at(-1).reason,'pin_capacity');
  b.trim(102);assert.equal(b.evictions.at(-1).reason,'pin_age_limit');
});
test('history keeps prior observations and event insertion is idempotent',()=>{
  const m=new Memory();m.observeObject({objectId:'cup',observedAt:1,position:[1,0,0]});m.observeObject({objectId:'cup',observedAt:2,position:[2,0,0]});
  assert.deepEqual(m.lastSeen('cup',1).position,[1,0,0]);assert.deepEqual(m.lastSeen('cup').position,[2,0,0]);
  assert.equal(m.appendEvent({id:'g',type:'briefly_crossed',end:3}),true);assert.equal(m.appendEvent({id:'g'}),false);assert.equal(m.glimpses(3).length,1);m.clear();assert.equal(m.lastSeen('cup'),null);
});
test('unrelated changes preserve cache, relevant changes and expiry invalidate',()=>{
  const r={expiresAt:100,dependencies:{objectIds:['cup'],evidenceIds:['e'],mapIds:['m']}};
  assert.equal(invalidate(r,{objectId:'chair',reason:'moved'},10),r);
  assert.equal(invalidate(r,{objectId:'cup',reason:'moved'},10).stale,true);
  assert.equal(invalidate(r,{},100).invalidationReason,'expired');
});
test('online evidence excludes future, unverified causal status and evaluation fields',()=>{
  const r=causalBundle([{observedAt:1,causalStatus:'online_causal',groundTruth:'x',scenarioGoal:'y',future:'z',id:'a'},{observedAt:2,causalStatus:'offline_assisted'},{observedAt:11,causalStatus:'online_causal'}],10);
  assert.deepEqual(r,[{observedAt:1,causalStatus:'online_causal',id:'a'}]);
});
