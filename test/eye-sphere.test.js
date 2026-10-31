import test from 'node:test';
import assert from 'node:assert/strict';
import {createEyeSphere,eyeSphereMotion} from '../src/gaze/eye-sphere.js';
const settings={eye:'left',centerM:[.03,0,1],radiusM:.012,coordinateFrameId:'camera',observedAt:0};
test('each eye has >=30 unique sphere points and outward unit normals',()=>{
  for(const eye of ['left','right']){const s=createEyeSphere({...settings,eye});assert.equal(new Set(s.nodes.map(n=>n.id)).size,32);for(const n of s.nodes){assert.ok(Math.abs(Math.hypot(...n.normal)-1)<1e-12);assert.ok(Math.abs(Math.hypot(...n.positionM.map((v,i)=>v-s.centerM[i]))-s.radiusM)<1e-12);assert.equal(n.observed,false);}}
  assert.throws(()=>createEyeSphere({...settings,count:29}));
});
test('rigid eye rotation changes normals and produces temporal motion',()=>{
  const a=createEyeSphere(settings),b=createEyeSphere({...settings,observedAt:100,rotationMatrix:[0,-1,0,1,0,0,0,0,1]});
  assert.ok(Math.abs(b.nodes[0].normal[0]+a.nodes[0].normal[1])<1e-12);
  assert.equal(eyeSphereMotion(a,b).status,'ok');assert.ok(eyeSphereMotion(a,b).nodes.some(n=>n.angularSpeedRadPerSec>0));
  assert.equal(eyeSphereMotion(a,{...b,observedAt:300}).status,'unavailable');
  assert.equal(eyeSphereMotion(a,{...b,coordinateFrameId:'other'}).status,'unavailable');
  assert.throws(()=>createEyeSphere({...settings,rotationMatrix:[-1,0,0,0,1,0,0,0,1]}));
});
