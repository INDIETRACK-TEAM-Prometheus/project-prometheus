import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreparationDisplay} from '../src/app.js';

test('preparation display uses published metadata and clears on expiry or withdrawal', () => {
  const element={textContent:''}; let now=100, callback, delay, cancelled=0;
  const display=createPreparationDisplay({element,now:()=>now,setTimer:(fn,ms)=>{callback=fn;delay=ms;return 1;},clearTimer:()=>cancelled++});
  const record={deliveryState:'silent_ready',observedUntil:90,expiresAt:200,objectIds:['object'],evidenceIds:['one','two']};
  display.show(record);
  assert.match(element.textContent,/silent_ready.*90 ms.*200 ms.*1 objects.*2 evidence items/);
  assert.equal(delay,100);
  callback(); assert.equal(element.textContent,'No preparation');
  display.show(record); display.clear(); assert.equal(element.textContent,'No preparation'); assert.ok(cancelled>=1);
  now=200; display.show(record); assert.equal(element.textContent,'No preparation');
});

test('an old expiry callback cannot clear a newer published result', () => {
  const element={textContent:''}, timers=[]; let expirations=0;
  const display=createPreparationDisplay({element,now:()=>100,onExpire:()=>expirations++,setTimer:fn=>{timers.push(fn);return timers.length;},clearTimer:()=>{}});
  const record={deliveryState:'silent_ready',observedUntil:90,expiresAt:200,objectIds:[],evidenceIds:[]};
  display.show(record);
  display.show({...record,observedUntil:95,expiresAt:250});
  timers[0](); assert.match(element.textContent,/95 ms/); assert.equal(expirations,0);
  timers[1](); assert.equal(element.textContent,'No preparation'); assert.equal(expirations,1);
});
