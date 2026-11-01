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

// ---- G1-C numerical contract, transforms and provenance -------------------------------------------------------
import {validateEyeSphere,transformEyeSphere} from '../src/gaze/eye-sphere.js';
import {rotationMatrixFromAxisAngle} from '../src/gaze/eye-fit.js';
const matVec=(m,v)=>[0,1,2].map(i=>m[3*i]*v[0]+m[3*i+1]*v[1]+m[3*i+2]*v[2]);
const transpose=m=>[m[0],m[3],m[6],m[1],m[4],m[7],m[2],m[5],m[8]];
test('validateEyeSphere certifies >=30 unique model nodes, unit outward normals and 100% provenance for both eyes',()=>{
  for(const eye of ['left','right']){
    const s=createEyeSphere({...settings,eye,count:64,rotationMatrix:rotationMatrixFromAxisAngle([1,2,3],.7)}),v=validateEyeSphere(s);
    assert.deepEqual(v.errors,[]);assert.equal(v.ok,true);assert.equal(v.modelNodeCount,64);assert.equal(v.uniqueModelNodeCount,64);assert.equal(v.observedNodeCount,0);
    assert.ok(v.maxNormError<=1e-6);assert.ok(v.maxRadiusError<=1e-12);assert.equal(v.outwardViolations,0);assert.equal(v.provenanceCoverage,1);
  }
});
test('validateEyeSphere rejects bad normals, inward normals, too few nodes, duplicates and missing provenance',()=>{
  const base=createEyeSphere(settings),clone=()=>structuredClone(base);
  let s=clone();s.nodes[3].normal=s.nodes[3].normal.map(v=>v*1.00001);assert.ok(validateEyeSphere(s).errors.includes('normal_not_unit'));
  s=clone();s.nodes[4].normal=s.nodes[4].normal.map(v=>-v);assert.ok(validateEyeSphere(s).errors.includes('normal_not_outward'));
  s=clone();s.nodes=s.nodes.slice(0,29);assert.ok(validateEyeSphere(s).errors.includes('too_few_model_nodes'));
  s=clone();s.nodes[5].positionM=[...s.nodes[6].positionM];assert.ok(validateEyeSphere(s).errors.includes('duplicate_model_positions'));
  s=clone();delete s.nodes[7].observed;assert.ok(validateEyeSphere(s).errors.includes('provenance_incomplete'));assert.ok(validateEyeSphere(s).provenanceCoverage<1);
  s=clone();s.nodes[8].observed=true;assert.ok(validateEyeSphere(s).errors.includes('provenance_incomplete'));
  s=clone();s.nodes[9].id=s.nodes[10].id;assert.ok(validateEyeSphere(s).errors.includes('duplicate_or_missing_node_id'));
  s=clone();s.nodes[11].positionM=s.nodes[11].positionM.map((v,i)=>v+(i?0:1e-4));assert.ok(validateEyeSphere(s).errors.includes('model_node_off_sphere'));
  assert.equal(validateEyeSphere({}).ok,false);assert.equal(validateEyeSphere(null).ok,false);
});
test('rigid frame transform preserves ids, provenance, unit outward normals and round-trips',()=>{
  const R=rotationMatrixFromAxisAngle([0,1,0],Math.PI/2),t=[0.1,-0.2,0.3],a=createEyeSphere(settings);
  const b=transformEyeSphere(a,{rotationMatrix:R,translationM:t,coordinateFrameId:'world'});
  assert.equal(b.coordinateFrameId,'world');
  a.nodes.forEach((n,i)=>{const p=matVec(R,n.positionM).map((v,k)=>v+t[k]);assert.ok(p.every((v,k)=>Math.abs(v-b.nodes[i].positionM[k])<1e-12));assert.equal(b.nodes[i].id,n.id);assert.equal(b.nodes[i].observed,false);});
  assert.ok(Math.abs(matVec(R,a.centerM)[0]+t[0]-b.centerM[0])<1e-12);
  assert.equal(validateEyeSphere(b).ok,true);
  const back=transformEyeSphere(b,{rotationMatrix:transpose(R),translationM:matVec(transpose(R),t).map(v=>-v),coordinateFrameId:'camera'});
  a.nodes.forEach((n,i)=>assert.ok(n.positionM.every((v,k)=>Math.abs(v-back.nodes[i].positionM[k])<1e-12)));
  assert.equal(validateEyeSphere(back).ok,true);
  assert.throws(()=>transformEyeSphere(a,{rotationMatrix:[2,0,0,0,1,0,0,0,1],coordinateFrameId:'x'}),TypeError);
  assert.throws(()=>transformEyeSphere(a,{rotationMatrix:R,coordinateFrameId:''}),TypeError);
  assert.equal(a.coordinateFrameId,'camera');
});
test('rotation about an axis gives per-node angular speed equal to the analytic angle for its polar angle; observed nodes are ignored by motion',()=>{
  const a=createEyeSphere(settings),R=rotationMatrixFromAxisAngle([0,1,0],.1),b={...a,observedAt:100,nodes:a.nodes.map(n=>({...n,normal:matVec(R,n.normal)}))};
  const m=eyeSphereMotion(a,b);assert.equal(m.status,'ok');
  m.nodes.forEach((n,i)=>{const sin2=a.nodes[i].normal[0]**2+a.nodes[i].normal[2]**2;assert.ok(Math.abs(n.angularSpeedRadPerSec-Math.acos(1-sin2*(1-Math.cos(.1)))*10)<1e-9);});
  const withObserved=(s,id)=>({...s,nodes:[...s.nodes,{id:`left:observed:${id}`,eye:'left',source:'observed_point',observed:true,positionM:[.03,0,.99],normal:[0,0,-1]}]});
  assert.equal(eyeSphereMotion(withObserved(a,1),withObserved(b,2)).status,'ok');
  assert.equal(eyeSphereMotion(withObserved(a,1),withObserved(b,2)).nodes.length,32);
});
