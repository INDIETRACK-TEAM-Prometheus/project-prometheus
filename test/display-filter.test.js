import test from 'node:test';
import assert from 'node:assert/strict';
import {createCausalDisplayFilter,REMOTE_GAZE_DISPLAY_FILTER} from '../src/gaze/display-filter.js';

function createPreviousFilter() {
  const alpha=(cutoff,dt)=>1/(1+1/(2*Math.PI*cutoff)/dt);
  let previousRaw=null,previousFiltered=null,previousDerivative={x:0,y:0},previousTimestamp=null;
  return {update(point,timestampMs){
    if(previousTimestamp===null){previousRaw={...point};previousFiltered={...point};previousTimestamp=timestampMs;return {point:{...point}};}
    const dt=(timestampMs-previousTimestamp)/1000,filtered={},derivative={};
    for(const axis of ['x','y']){
      const rawDerivative=(point[axis]-previousRaw[axis])/dt;
      derivative[axis]=alpha(1,dt)*rawDerivative+(1-alpha(1,dt))*previousDerivative[axis];
      const pointAlpha=alpha(1.2+.02*Math.abs(derivative[axis]),dt);
      filtered[axis]=pointAlpha*point[axis]+(1-pointAlpha)*previousFiltered[axis];
    }
    previousRaw={...point};previousFiltered=filtered;previousDerivative=derivative;previousTimestamp=timestampMs;
    return {point:{...filtered}};
  }};
}

function syntheticJitterAndStep(createFilter) {
  let seed=20261101;
  const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
  const jitterFilter=createFilter(),errors=[];
  for(let i=0;i<600;i++){
    const result=jitterFilter.update({x:.5+(random()-.5)*.01,y:.5+(random()-.5)*.01},i*1000/60);
    if(i>=60)errors.push(result.point.x-.5);
  }
  const jitterRms=Math.sqrt(errors.reduce((sum,error)=>sum+error*error,0)/errors.length);
  const stepFilter=createFilter();
  for(let i=0;i<30;i++)stepFilter.update({x:.25,y:.5},i*1000/60);
  let crossingFrame=null;
  for(let i=30;i<90;i++){
    if(stepFilter.update({x:.75,y:.5},i*1000/60).point.x>=.70){crossingFrame=i;break;}
  }
  return {jitterRms,stepLagMs:(crossingFrame-30)*1000/60};
}

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

test('synthetic normalized jitter and step lag benchmark is reproducible',()=>{
  const previous=syntheticJitterAndStep(createPreviousFilter);
  const selected=syntheticJitterAndStep(()=>createCausalDisplayFilter());
  assert.ok(Math.abs(previous.jitterRms-.0007604008218602145)<1e-12);
  assert.ok(Math.abs(selected.jitterRms-.0007630459212059747)<1e-12);
  assert.equal(previous.stepLagMs,316.6666666666667);
  assert.equal(selected.stepLagMs,133.33333333333334);
  assert.ok(selected.jitterRms<=previous.jitterRms*1.01);
  assert.ok(selected.stepLagMs<previous.stepLagMs*.5);
});

test('the remote preset smooths noisy 10 Hz gaze more than the default without adding step lag',()=>{
  const bench=opts=>{
    let seed=7;const r=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
    const jitter=createCausalDisplayFilter(opts),errors=[];let t=0;
    for(let i=0;i<300;i++){t+=100*(.7+.6*r());const p=jitter.update({x:.5+(r()-.5)*.06,y:.5+(r()-.5)*.06},t);if(i>20)errors.push(p.point.x-.5);}
    const step=createCausalDisplayFilter(opts);t=0;for(let i=0;i<20;i++){t+=100;step.update({x:.25,y:.5},t);}
    let lag=null;const t0=t;for(let i=0;i<60;i++){t+=100;if(step.update({x:.75,y:.5},t).point.x>=.70){lag=t-t0;break;}}
    return {rms:Math.sqrt(errors.reduce((sum,e)=>sum+e*e,0)/errors.length),lag};
  };
  const base=bench(),remote=bench(REMOTE_GAZE_DISPLAY_FILTER);
  assert.ok(remote.rms<base.rms*.8,`${remote.rms} vs ${base.rms}`);
  assert.ok(remote.lag<=base.lag,`${remote.lag} vs ${base.lag}`);
});
