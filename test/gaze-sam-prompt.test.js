import test from 'node:test';
import assert from 'node:assert/strict';
import {gazeSamPrompt,requestStartupSceneAnalysis} from '../src/app.js';
test('gaze point prompt maps normalized image coordinates to pixel edges',()=>{
 const frame={width:640,height:480};
 assert.equal(gazeSamPrompt(frame,{x:0,y:0}),'<0f>1<|point;x=0;y=0;w=640;h=480|>');
 assert.equal(gazeSamPrompt(frame,{x:0.999999,y:0.999999}),'<0f>1<|point;x=639;y=479;w=640;h=480|>');
 for(const gaze of [null,{x:1,y:0},{x:-0.1,y:0},{x:NaN,y:0},{x:0,y:1}]) assert.throws(()=>gazeSamPrompt(frame,gaze));
});

test('startup SAM analyzes the scene without a gaze prompt and requires the combined consent',async()=>{
 const frame={frameId:'scene-1',renderTsMs:12,viewport:{width:2,height:1}},rgba=new Uint8Array(8);let request;
 const diagnostic={run:(...args)=>{request=args;return Promise.resolve({status:'ok'});}};
 assert.deepEqual(await requestStartupSceneAnalysis({consent:false,frame,rgba,diagnostic}),{status:'withheld'});assert.equal(request,undefined);
 assert.deepEqual(await requestStartupSceneAnalysis({consent:true,frame,rgba,diagnostic}),{status:'ok'});
 assert.deepEqual(request[0],{frameId:'scene-1',observedAt:12,width:2,height:1});assert.equal(request[1],rgba);assert.equal(request[2],'objects');
 assert.deepEqual(await requestStartupSceneAnalysis({consent:true,frame,rgba:new Uint8Array(4),diagnostic}),{status:'failed'});
});
