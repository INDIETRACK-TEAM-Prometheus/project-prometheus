import test from 'node:test';
import assert from 'node:assert/strict';
import {gazeSamPrompt} from '../src/app.js';
test('gaze point prompt maps normalized image coordinates to pixel edges',()=>{
 const frame={width:640,height:480};
 assert.equal(gazeSamPrompt(frame,{x:0,y:0}),'<0f>1<|point;x=0;y=0;w=640;h=480|>');
 assert.equal(gazeSamPrompt(frame,{x:0.999999,y:0.999999}),'<0f>1<|point;x=639;y=479;w=640;h=480|>');
 for(const gaze of [null,{x:1,y:0},{x:-0.1,y:0},{x:NaN,y:0},{x:0,y:1}]) assert.throws(()=>gazeSamPrompt(frame,gaze));
});
