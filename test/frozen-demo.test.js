import test from 'node:test';
import assert from 'node:assert/strict';
import {createFrozenGazeAutomation} from '../src/gaze/frozen-demo.js';

test('frozen gaze automation runs no more than once per interval and stops cleanly',async()=>{
 let now=0,nextId=0;const timers=new Map(),calls=[];
 const automation=createFrozenGazeAutomation({run:()=>calls.push(now),now:()=>now,intervalMs:5000,setTimer:(fn,delay)=>{const id=++nextId;timers.set(id,{fn,due:now+delay});return id;},clearTimer:id=>timers.delete(id)});
 const advance=async to=>{now=to;for(const [id,timer] of [...timers])if(timer.due<=now){timers.delete(id);timer.fn();}await Promise.resolve();await Promise.resolve();};
 assert.equal(automation.start(),true);await advance(0);assert.deepEqual(calls,[0]);
 await advance(4999);assert.deepEqual(calls,[0]);await advance(5000);assert.deepEqual(calls,[0,5000]);
 automation.stop();await advance(10000);assert.deepEqual(calls,[0,5000]);assert.equal(automation.status().active,false);assert.equal(automation.status().timerPending,false);
});

test('async runs stay serialized and wait a full interval after completion',async()=>{
 let now=0,nextId=0,finish;const timers=new Map(),calls=[];
 const automation=createFrozenGazeAutomation({run:()=>{calls.push(now);if(calls.length===1)return new Promise(resolve=>finish=resolve);},now:()=>now,intervalMs:5000,setTimer:(fn,delay)=>{const id=++nextId;timers.set(id,{fn,due:now+delay});return id;},clearTimer:id=>timers.delete(id)});
 const advance=async to=>{now=to;for(const [id,timer] of [...timers])if(timer.due<=now){timers.delete(id);timer.fn();}await Promise.resolve();await Promise.resolve();};
 automation.start();await advance(0);assert.deepEqual(calls,[0]);
 await advance(4999);assert.deepEqual(calls,[0]);finish();await Promise.resolve();await Promise.resolve();
 await advance(9998);assert.deepEqual(calls,[0]);await advance(9999);assert.deepEqual(calls,[0,9999]);
 automation.stop();
});

test('stop and restart do not overlap an unfinished run or reset its interval',async()=>{
 let now=0,nextId=0,finish;const timers=new Map(),calls=[];
 const automation=createFrozenGazeAutomation({run:()=>{calls.push(now);if(calls.length===1)return new Promise(resolve=>finish=resolve);},now:()=>now,intervalMs:5000,setTimer:(fn,delay)=>{const id=++nextId;timers.set(id,{fn,due:now+delay});return id;},clearTimer:id=>timers.delete(id)});
 const advance=async to=>{now=to;for(const [id,timer] of [...timers])if(timer.due<=now){timers.delete(id);timer.fn();}await Promise.resolve();await Promise.resolve();};
 automation.start();await advance(0);automation.stop();automation.start();await advance(4999);assert.deepEqual(calls,[0]);
 finish();await Promise.resolve();await Promise.resolve();await advance(9998);assert.deepEqual(calls,[0]);await advance(9999);assert.deepEqual(calls,[0,9999]);
 automation.stop();
});
