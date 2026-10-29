import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pixelRay,unprojectDepth,firstSurface,associateMasks,compareAnchors} from '../src/spatial/geometry.js';
import {sampleWorld,createWorld} from '../src/spatial/world.js';
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], K={fx:100,fy:100,cx:50,cy:50};
test('pixel rays and depth conventions reconstruct metric surface with explicit camera frame',()=>{
  const args={pixel:[150,50],intrinsics:K,cameraToWorld:I,depth:2,units:'m',depthSource:'sensor_depth',provenance:'depth-1'};
  assert.deepEqual(unprojectDepth({...args,convention:'axial_z'}).point,[2,0,2]);
  const p=unprojectDepth({...args,convention:'ray_range'}).point;
  assert.ok(Math.abs(Math.hypot(...p)-2)<1e-12);
  assert.equal(unprojectDepth({...args,convention:'z_buffer'}).reason,'unsupported_depth_convention');
  assert.equal(unprojectDepth({...args,convention:'axial_z',metricScaleKnown:false}).reason,'metric_depth_unavailable');
  assert.equal(unprojectDepth({...args,convention:'axial_z',valid:false}).point,null);
  assert.equal(pixelRay([50,50],K,[...I.slice(0,15),0]).status,'unavailable');
});
test('first visible synthetic surface wins and empty scene is no_hit without engine identity',()=>{
  const ray=pixelRay([50,50],K,I).ray;
  const surfaces=[{type:'sphere',center:[0,0,8],radius:1,objectId:'ground-truth'},{type:'rectangle',center:[0,0,3],u:[1,0,0],v:[0,1,0],halfWidth:1,halfHeight:1}];
  const hit=firstSurface(ray,surfaces,'synthetic'); assert.deepEqual(hit.point,[0,0,3]); assert.equal(hit.objectId,undefined);
  assert.deepEqual(firstSurface(ray,[],'synthetic'),{status:'no_hit',point:null,reason:'no_visible_surface',provenance:'synthetic'});
});
test('uncertainty preserves multiple mask candidates and rejects future and noncausal input',()=>{
  const samples=[{xy:[0,0],weight:1},{xy:[2,0],weight:1}];
  const mask=(id,x)=>({detectionId:id,sourceKind:'segmentation',causalStatus:'online_causal',observedAt:4,provenance:'mask',contains:p=>p[0]===x});
  const ms=[mask('a',0),mask('b',2)]; assert.deepEqual(associateMasks(samples,ms,4).candidates.map(c=>c.score),[0.5,0.5]);
  assert.equal(associateMasks(samples,[{...ms[0],observedAt:5}],4).reason,'noncausal_or_unverified_mask');
  assert.equal(associateMasks(samples,[{...ms[0],causalStatus:'offline_assisted'}],4).status,'withheld');
  assert.equal(associateMasks(samples,[{...ms[0],sourceKind:'engine_truth'}],4).status,'withheld');
});
test('map correction does not create motion and gaze hit is not object anchor',()=>{
  const old={mapId:'m',mapVersion:1,coordinateFrameId:'world',objectAnchorWorld:[1,0,0],gazeHitPointWorld:[99,0,0]};
  const now={mapId:'m',mapVersion:2,coordinateFrameId:'world',objectAnchorWorld:[11,0,0],gazeHitPointWorld:[12,0,0]};
  const correction={matrix:[1,0,0,10,0,1,0,0,0,0,1,0,0,0,0,1],from:{mapId:'m',mapVersion:1,coordinateFrameId:'world'},to:{mapId:'m',mapVersion:2,coordinateFrameId:'world'},provenance:'map-estimator',uncertainty:{translationM:0.1,rotationRad:0.01}};
  assert.equal(compareAnchors(old,now).reason,'map_transform_unavailable');
  assert.equal(compareAnchors(old,{...old,coordinateFrameId:'other'}).reason,'map_transform_unavailable');
  assert.equal(compareAnchors(old,{...old,coordinateFrameId:undefined}).reason,'map_identity_unavailable');
  assert.equal(compareAnchors(old,{...old,coordinateFrameId:'other'}, {...correction,from:{mapId:'m',mapVersion:1,coordinateFrameId:'world'},to:{mapId:'m',mapVersion:1,coordinateFrameId:'other'}}).status,'comparable');
  assert.equal(compareAnchors(old,now,correction).distance,0);
  assert.equal(compareAnchors(old,now,{...correction,provenance:null}).reason,'map_transform_unavailable');
  assert.equal(compareAnchors(old,now,{...correction,to:{mapId:'other',mapVersion:2}}).reason,'map_transform_unavailable');
  assert.equal(compareAnchors({...old,mapId:undefined},{...old,mapId:undefined}).reason,'map_identity_unavailable');
  const moving=compareAnchors(old,{...now,objectAnchorWorld:[12,0,0]},correction);
  assert.deepEqual(moving.displacement,[1,0,0]);
  assert.deepEqual(moving.correction,correction);
  assert.deepEqual(old.objectAnchorWorld,[1,0,0]);
  assert.equal(compareAnchors({...old,objectAnchorWorld:null},now,correction).reason,'anchor_unavailable');
});
test('dynamic synthetic 3D surface gives metric front hit, occlusion and current-only samples',()=>{
  const front=sampleWorld(0,640,480,320,240), later=sampleWorld(3000,640,480,320,240);
  assert.equal(front.status,'hit');assert.ok(Math.abs(front.axialZM-4.1)<1e-9);
  assert.ok(later.axialZM>front.axialZM);assert.equal(front.objectId,undefined);
  assert.equal(sampleWorld(0,640,480,-1,0).reason,'invalid_viewport_or_pixel');
  assert.equal(sampleWorld(0,640,480,0,0).status,'no_hit');
  assert.deepEqual(sampleWorld(0,640,480,320,240),front);
});
test('frame history fixes raycast time, presentation estimate is explicit, eviction and dispose are bounded',()=>{
  const gl=new Proxy({getShaderParameter:()=>true,getProgramParameter:()=>true,getAttribLocation:()=>0,getUniformLocation:()=>0},{get:(o,k)=>k in o?o[k]:()=>({})});
  const canvas={width:640,height:480,getContext:()=>gl};
  const oldRequest=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame;let canceled=null;
  globalThis.requestAnimationFrame=()=>42;globalThis.cancelAnimationFrame=id=>{canceled=id;};
  try {
    const w=createWorld(canvas,{maxFrameHistory:2}); const f=w.render(0);
    assert.equal(f.presentTsEstimateMs,null);
    assert.equal(w.markPresented({presentMs:1,displayUncertaintyMs:0}).status,'unavailable');
    assert.equal(w.markPresented({presentMs:1,displayUncertaintyMs:5}).frame.displayUncertaintyMs,5);
    const first=w.raycastFrame(f,320,240);w.render(3000);
    assert.deepEqual(w.raycastFrame(f,320,240),first);
    assert.ok(w.raycast(320,240).axialZM>first.axialZM);
    w.render(4000);assert.equal(w.raycastFrame(f,320,240).reason,'frame_unavailable_or_evicted');
    w.animate();w.dispose();assert.equal(canceled,42);assert.equal(w.getFrame(),null);
    assert.throws(()=>w.render(5000),/disposed/);
  } finally {globalThis.requestAnimationFrame=oldRequest;globalThis.cancelAnimationFrame=oldCancel;}
});
test('pinned moving frame survives history eviction and releases without leaking geometry',()=>{
 const gl=new Proxy({getShaderParameter:()=>true,getProgramParameter:()=>true,getAttribLocation:()=>0,getUniformLocation:()=>0},{get:(o,k)=>k in o?o[k]:()=>({})});
 const w=createWorld({width:640,height:480,getContext:()=>gl},{maxFrameHistory:1,maxFramePins:1});
 const old=w.render(0), descriptor={frameId:old.frameId,observedAt:old.renderTsMs,coordinateFrameId:'synthetic-world-frame'};
 assert.equal(w.pinFrame(old).status,'ok');assert.equal(w.pinFrame(old).status,'ok');const next=w.render(3000);assert.equal(w.pinFrame(next).reason,'pin_limit');
 const depth=w.samplePinnedDepth(old);assert.equal(depth.frameId,old.frameId);assert.equal(depth.observedAt,0);assert.equal(depth.values.length,1024);const x=16,y=16,reference=sampleWorld(0,640,480,(x+.5)*640/32,(y+.5)*480/32);assert.ok(Math.abs(depth.values[y*32+x]-reference.axialZM)<1e-5);
 const hit=w.samplePinnedSurface(descriptor,[320,240],3001);assert.ok(Math.abs(hit.point[2]-4.1)<1e-9);assert.equal(hit.point[0],0);assert.equal(hit.point[1],0);assert.equal(hit.units,'m');assert.equal(hit.depthSource,'engine_geometry');assert.equal(hit.objectId,undefined);
 const off=w.samplePinnedSurface(descriptor,[340,240],3001),focal=480/(2*Math.tan(Math.PI/6));assert.ok(Math.abs(off.point[0]-20*off.point[2]/focal)<1e-9);assert.equal(w.releaseFrame({...old,renderTsMs:1}),false);
 assert.ok(w.raycast(320,240).axialZM>hit.point[2]);assert.equal(w.releaseFrame(old),true);assert.ok(w.samplePinnedSurface(descriptor,[320,240],3001));assert.equal(w.releaseFrame(old),true);assert.equal(w.samplePinnedSurface(descriptor,[320,240],3001),null);assert.equal(w.raycastFrame(old,320,240).reason,'frame_unavailable_or_evicted');assert.equal(w.samplePinnedDepth(old),null);w.dispose();
});
