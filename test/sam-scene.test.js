import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, iou, projectMask, width, height } from '../scripts/sam-scene.js';

test('synthetic scene and IoU are deterministic',()=>{
  const a=makeScene(), b=makeScene();
  assert.equal(a.sha256,b.sha256); assert.equal(a.truth.length,width*height);
  assert.equal(a.truth.reduce((sum,x)=>sum+x,0),6400);
  assert.equal(iou(a.truth,a.truth),1); assert.equal(iou(new Uint8Array(a.truth.length),a.truth),0);
  assert.throws(()=>iou([],a.truth));
  assert.deepEqual([...a.png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
});

test('cropped masks are placed at the offset and scaled by pixel centers',()=>{
  const crop={sourceWidth:6,sourceHeight:5,width:2,height:2,bounds:{left:2,top:1,right:6,bottom:5},raster:[1,0,0,1]};
  const projected=projectMask(crop,6,5);
  assert.deepEqual([...projected],[0,0,0,0,0,0, 0,0,1,1,0,0, 0,0,1,1,0,0, 0,0,0,0,1,1, 0,0,0,0,1,1]);
  assert.throws(()=>projectMask({...crop,sourceWidth:7},6,5));
  assert.throws(()=>projectMask({...crop,bounds:{...crop.bounds,right:7}},6,5));
});
