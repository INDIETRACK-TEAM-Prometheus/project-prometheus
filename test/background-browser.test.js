import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackgroundBrowserWork} from '../src/runtime/background-browser.js';

const frame={frameId:'frame-1',observedAt:10,processedAt:11,width:4,height:4,imageData:'data:image/png;base64,AA=='};
const snapshot={frame,gaze:{frameId:'frame-1',x:.25,y:.75,observedAt:10,processedAt:11},observedUntil:10,processedAt:11,dependencies:{mapId:'map',mapVersion:1,objectIds:['cup'],evidenceIds:['frame-1']},candidates:[{objectId:'cup'}],events:[],context:{memory:[]}};

test('browser work captures then segments then reasons on one immutable frame without a world pause',async()=>{
  const calls=[];
  const work=createBackgroundBrowserWork({
    now:()=>12,
    capture:async value=>{calls.push('capture');assert.equal(value.frame.frameId,'frame-1');return {frame:{...frame}};},
    sam:async(value,{gaze,observedUntil})=>{calls.push('sam');assert.equal(value.frameId,'frame-1');assert.equal(gaze.frameId,value.frameId);assert.equal(observedUntil,10);return {frame:{frameId:'frame-1',observedAt:10},masks:[{objectId:'cup'}]};},
    reason:async input=>{calls.push('reason');assert.equal(input.frame.frameId,'frame-1');assert.deepEqual(input.masks,[{objectId:'cup'}]);assert.equal(input.gaze.frameId,'frame-1');return {frame:{frameId:'frame-1',observedAt:10},scenarios:[],nextGaze:{rankedTargetIds:['cup']}};}
  });
  const result=await work(snapshot,{signal:new AbortController().signal});
  assert.deepEqual(calls,['capture','sam','reason']);
  assert.deepEqual(result,{scenarios:[],nextGaze:{rankedTargetIds:['cup']}});
});

test('mismatched SAM or reasoner frame is rejected before it can be returned',async()=>{
  let reasonCalls=0;
  const badSam=createBackgroundBrowserWork({capture:async()=>frame,sam:async()=>({frame:{frameId:'wrong',observedAt:10},masks:[]}),reason:async()=>{reasonCalls++;return {frame:{frameId:'frame-1',observedAt:10},scenarios:[]};},now:()=>12});
  await assert.rejects(()=>badSam(snapshot,{signal:new AbortController().signal}),/provider frame mismatch/);
  assert.equal(reasonCalls,0);
  const badReason=createBackgroundBrowserWork({capture:async()=>frame,sam:async()=>({frame:{frameId:'frame-1',observedAt:10},masks:[]}),reason:async()=>({frame:{frameId:'frame-1',observedAt:9},scenarios:[]}),now:()=>12});
  await assert.rejects(()=>badReason(snapshot,{signal:new AbortController().signal}),/provider frame mismatch/);
});

test('gaze must join to the captured frame and cancellation prevents later provider calls',async()=>{
  let samCalls=0, reasonCalls=0;
  const mismatch=createBackgroundBrowserWork({capture:async()=>frame,sam:async()=>{samCalls++;return {frame:{frameId:'frame-1',observedAt:10},masks:[]};},reason:async()=>{reasonCalls++;return {frame:{frameId:'frame-1',observedAt:10},scenarios:[]};},now:()=>12});
  await assert.rejects(()=>mismatch({...snapshot,gaze:{...snapshot.gaze,frameId:'other'}},{signal:new AbortController().signal}),/frame and gaze do not match/);
  assert.equal(samCalls,0);
  const controller=new AbortController();
  const cancelled=createBackgroundBrowserWork({capture:async(_s,{signal})=>{assert.equal(signal,controller.signal);controller.abort();return frame;},sam:async()=>{samCalls++;},reason:async()=>{reasonCalls++;},now:()=>12});
  await assert.rejects(()=>cancelled(snapshot,{signal:controller.signal}),/cancelled/);
  assert.equal(samCalls,0); assert.equal(reasonCalls,0);
});
