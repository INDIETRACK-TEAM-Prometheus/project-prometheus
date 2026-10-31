import test from 'node:test';
import assert from 'node:assert/strict';
import {createCausalDisplayFilter} from '../src/gaze/display-filter.js';

test('causal One-Euro display filter passes the first sample and smooths later motion',()=>{
  const filter = createCausalDisplayFilter();
  const first = filter.update({x:.2,y:.5},0);
  const second = filter.update({x:.8,y:.5},16);
  assert.deepEqual(first.point,{x:.2,y:.5});
  assert.equal(first.filtered,false);
  assert.equal(second.status,'ready');
  assert.equal(second.filtered,true);
  assert.ok(second.point.x > first.point.x && second.point.x < .8);
  assert.deepEqual(second.rawPoint,{x:.8,y:.5});
});

test('invalid, duplicate, backward, and too-close timestamps are withheld and reset state',()=>{
  const filter = createCausalDisplayFilter();
  filter.update({x:.4,y:.5},20);
  assert.equal(filter.update({x:.6,y:.5},20).reason,'timestamp_not_increasing');
  assert.equal(filter.update({x:.6,y:.5},19).filtered,false);
  assert.equal(filter.update({x:.6,y:.5},18).reason,'timestamp_not_increasing');
  filter.update({x:.6,y:.5},30);
  assert.equal(filter.update({x:.6,y:.5},30.5).reason,'dt_too_small');
  assert.equal(filter.update({x:NaN,y:.5},40).reason,'point_invalid');
  assert.equal(filter.update({x:.6,y:.5},50,{valid:false}).reason,'sample_invalid');
  const fresh = filter.update({x:.6,y:.5},60);
  assert.equal(fresh.filtered,false);
  assert.deepEqual(fresh.point,{x:.6,y:.5});
});

test('long gaps start a new unfiltered segment instead of carrying old position',()=>{
  const filter = createCausalDisplayFilter({maxDeltaMs:100});
  filter.update({x:.1,y:.2},10);
  const result = filter.update({x:.9,y:.8},500);
  assert.equal(result.status,'ready');
  assert.equal(result.filtered,false);
  assert.equal(result.reset,true);
  assert.equal(result.reason,'time_gap_reset');
  assert.deepEqual(result.point,{x:.9,y:.8});
});

test('invalid filter settings are rejected',()=>{
  assert.throws(()=>createCausalDisplayFilter({minCutoff:0}));
  assert.throws(()=>createCausalDisplayFilter({maxDeltaMs:0}));
});
