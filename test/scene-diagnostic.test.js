import test from 'node:test';
import assert from 'node:assert/strict';
import {flipRgba,maskOverlay,createSceneDiagnostic} from '../src/spatial/scene-diagnostic.js';
test('flips bottom-left framebuffer and places mask in top-left source coordinates',()=>{
 assert.deepEqual([...flipRgba(Uint8Array.from([1,2,3,4,5,6,7,8]),1,2)],[5,6,7,8,1,2,3,4]);
 const mask={sourceWidth:3,sourceHeight:2,width:1,height:1,bounds:{left:2,top:1,right:3,bottom:2},raster:[1]};
 const overlay=maskOverlay([mask],3,2);assert.equal(overlay[5*4+3],120);assert.equal(overlay[2*4+3],0);
});
test('rejects mismatched frames and never displays a cancelled late result',async()=>{
 let finish,displayed=0;const frame={frameId:'f',observedAt:1,width:1,height:1};
 const runner=createSceneDiagnostic({encode:async()=> 'png',request:()=>new Promise(r=>finish=r),display:()=>displayed++});
 let pending=runner.run(frame,new Uint8Array(4));await Promise.resolve();finish({frame:{frameId:'different',observedAt:1},masks:[]});assert.equal((await pending).status,'failed');assert.equal(displayed,0);
 pending=runner.run(frame,new Uint8Array(4));await Promise.resolve();assert.equal((await runner.run(frame,new Uint8Array(4))).status,'busy');runner.cancel();finish({frame:{frameId:'f',observedAt:1},masks:[]});assert.equal((await pending).status,'cancelled');assert.equal(displayed,0);
});
test('successful response renders only its matching frozen frame',async()=>{
 let rendered;const frame={frameId:'f',observedAt:10,width:1,height:1};
 const runner=createSceneDiagnostic({sampleDepth:f=>({frameId:f.frameId,observedAt:f.observedAt,values:new Float32Array([4]),width:1,height:1}),encode:async()=> 'png',request:async(body)=>{assert.deepEqual(body.frame,{frameId:'f',observedAt:10});return {frame:body.frame,masks:[],provider:'Meta',model:'sam-3.1'};},display:value=>rendered=value});
 assert.equal((await runner.run(frame,Uint8Array.from([1,2,3,4]))).status,'ok');assert.deepEqual(rendered.frame,frame);assert.deepEqual([...rendered.pixels],[1,2,3,4]);
});

test('unavailable, failing or mismatched depth does not suppress the RGB and mask result',async()=>{
 const frame={frameId:'f',observedAt:10,width:1,height:1};
 const mask={sourceWidth:1,sourceHeight:1,width:1,height:1,bounds:{left:0,top:0,right:1,bottom:1},raster:[1]};
 for(const sampleDepth of [()=>null,()=>{throw new Error('unavailable');},()=>({frameId:'other',observedAt:10})]) {
  let rendered,held=0;
  const runner=createSceneDiagnostic({pin:()=>{held++;return true;},release:()=>held--,sampleDepth,encode:async()=> 'png',request:async({frame})=>({frame,masks:[mask]}),display:value=>rendered=value});
  assert.equal((await runner.run(frame,Uint8Array.from([1,2,3,4]))).status,'ok');
  assert.equal(rendered.depth,null);assert.deepEqual([...rendered.pixels],[1,2,3,4]);assert.equal(rendered.overlay[3],120);assert.equal(held,0);
 }
});

test('pins the same frame through a delayed result and releases on success, failure and cancel',async()=>{
 let finish,held=0,sampled=0,shown=0;const frame={frameId:'fixed',observedAt:2,width:1,height:1};
 const runner=createSceneDiagnostic({pin:f=>{assert.equal(f,frame);held++;return true;},release:()=>held--,sampleDepth:f=>{assert.equal(held,1);sampled++;return {frameId:f.frameId,observedAt:f.observedAt,width:1,height:1,values:new Float32Array([3])};},encode:async()=> 'png',request:()=>new Promise(r=>finish=r),display:()=>shown++});
 let pending=runner.run(frame,new Uint8Array(4));await Promise.resolve();assert.equal(held,1);finish({frame:{frameId:'fixed',observedAt:2},masks:[]});assert.equal((await pending).status,'ok');assert.equal(held,0);assert.equal(sampled,1);assert.equal(shown,1);
 pending=runner.run(frame,new Uint8Array(4));await Promise.resolve();runner.cancel();assert.equal(held,0);finish({frame:{frameId:'fixed',observedAt:2},masks:[]});assert.equal((await pending).status,'cancelled');assert.equal(sampled,1);
 pending=runner.run(frame,new Uint8Array(4));await Promise.resolve();finish({frame:{frameId:'wrong',observedAt:2},masks:[]});assert.equal((await pending).status,'failed');assert.equal(held,0);
});
