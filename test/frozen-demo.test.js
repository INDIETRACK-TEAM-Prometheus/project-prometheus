import test from 'node:test';
import assert from 'node:assert/strict';
import {createFrozenGazeAutomation} from '../src/gaze/frozen-demo.js';

test('frozen gaze automation runs no more than once per interval and stops cleanly',()=>{
 let now=0,nextId=0;const timers=new Map(),calls=[];
 const automation=createFrozenGazeAutomation({run:()=>calls.push(now),now:()=>now,intervalMs:5000,setTimer:(fn,delay)=>{const id=++nextId;timers.set(id,{fn,due:now+delay});return id;},clearTimer:id=>timers.delete(id)});
 const advance=to=>{now=to;for(const [id,timer] of [...timers])if(timer.due<=now){timers.delete(id);timer.fn();}};
 assert.equal(automation.start(),true);advance(0);assert.deepEqual(calls,[0]);
 advance(4999);assert.deepEqual(calls,[0]);advance(5000);assert.deepEqual(calls,[0,5000]);
 automation.stop();advance(10000);assert.deepEqual(calls,[0,5000]);assert.equal(automation.status().active,false);assert.equal(automation.status().timerPending,false);
});
