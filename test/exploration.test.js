import test from 'node:test';
import assert from 'node:assert/strict';
import {createExploration} from '../src/runtime/exploration.js';
test('exploration requires consent, skips busy work and limits requests',()=>{
 let allowed=false, time=0, busy=false, calls=0;const p={status:()=>({running:busy,pending:false}),submit:x=>{calls++;assert.equal(x.gaze,null);return {accepted:true}}};
 const e=createExploration({allowed:()=>allowed,pipeline:()=>p,snapshot:()=>({frameId:'f'}),now:()=>time});
 assert.equal(e.tick().reason,'disabled');allowed=true;busy=true;assert.equal(e.tick().reason,'busy');busy=false;assert.equal(e.tick().accepted,true);time=4999;assert.equal(e.tick().reason,'rate_limited');time=5000;assert.equal(e.tick().accepted,true);assert.equal(calls,2);
});
