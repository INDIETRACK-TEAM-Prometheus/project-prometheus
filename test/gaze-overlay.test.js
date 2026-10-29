import test from 'node:test';
import assert from 'node:assert/strict';
import {gazeViewportPoint,gazeMarkerPosition} from '../src/gaze/overlay.js';

const rect={left:100,top:50,width:400,height:200,right:500,bottom:250};
const valid=rawScreenXY=>({valid:true,rawScreenXY});

test('maps a valid screen estimate into the world viewport in CSS-pixel geometry',()=>{
  assert.deepEqual(gazeViewportPoint(valid({x:300,y:150}),rect),{x:.5,y:.5});
  assert.deepEqual(gazeViewportPoint(valid({x:100,y:50}),rect),{x:0,y:0});
  assert.deepEqual(gazeViewportPoint(valid({x:499.5,y:249.5}),rect),{x:.99875,y:.9975});
});

test('withholds invalid, non-finite, outside, or degenerate viewport coordinates',()=>{
  assert.equal(gazeViewportPoint({...valid({x:300,y:150}),valid:false},rect),null);
  assert.equal(gazeViewportPoint(valid({x:500,y:150}),rect),null);
  assert.equal(gazeViewportPoint(valid({x:300,y:250}),rect),null);
  assert.equal(gazeViewportPoint(valid({x:NaN,y:150}),rect),null);
  assert.equal(gazeViewportPoint(valid({x:300,y:150}),{...rect,width:0}),null);
});

test('centers the fixed-size marker at the exact normalized point and hides it outside live tracking',()=>{
  assert.deepEqual(gazeMarkerPosition({x:.5,y:.25},{active:true}),{left:'50%',top:'25%'});
  assert.deepEqual(gazeMarkerPosition({x:0,y:0},{active:true}),{left:'0%',top:'0%'});
  for (const state of [{active:false},{active:true,paused:true},{active:true,calibrating:true}]) assert.equal(gazeMarkerPosition({x:.5,y:.5},state),null);
  assert.equal(gazeMarkerPosition({x:1,y:.5},{active:true}),null);
  assert.equal(gazeMarkerPosition({x:.5,y:NaN},{active:true}),null);
});
