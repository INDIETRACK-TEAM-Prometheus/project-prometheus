import test from 'node:test';
import assert from 'node:assert/strict';
import {ObjectTracker,maskContains} from '../src/spatial/tracker.js';
import {ExperienceMemory} from '../src/memory/index.js';
const W=20,H=10,I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const crop=(x,y,w=3,h=3)=>({sourceWidth:W,sourceHeight:H,width:w,height:h,bounds:{left:x,top:y,right:x+w,bottom:y+h},raster:Array(w*h).fill(1)});
function frame(id,t,items,extra={}) {
 const rgba=new Uint8Array(W*H*4);for(const {m,color} of items)for(let y=m.bounds.top;y<m.bounds.bottom;y++)for(let x=m.bounds.left;x<m.bounds.right;x++)rgba.set([...color,255],(y*W+x)*4);
 return {frameId:id,observedAt:t,processedAt:t+1,causalStatus:'online_causal',provenance:'synthetic-frame',rgba,width:W,height:H,masks:items.map(x=>x.m),depth:{frameId:id,observedAt:t,processedAt:t+1,width:W,height:H,values:Array(W*H).fill(2),causalStatus:'online_causal',intrinsics:{fx:10,fy:10,cx:10,cy:5},cameraToWorld:I,units:'m',convention:'axial_z',depthSource:'engine_geometry',provenance:'synthetic-depth'},...extra};
}
const item=(x,color)=>({m:crop(x,2),color});
test('moving synthetic detections preserve identity and occlusion remains last seen',()=>{
 const tracker=new ObjectTracker({maxGapMs:1000,maxPropagationMs:100});
 // Ground-truth labels are test assertions only, never input to the tracker.
 const a=tracker.update(frame('f1',10,[item(1,[255,0,0]),item(14,[0,0,255])]));
 const b=tracker.update(frame('f2',20,[item(3,[255,0,0]),item(12,[0,0,255])]));
 assert.deepEqual(b.map(o=>o.objectId),a.map(o=>o.objectId));assert.ok(b.every(o=>o.identityStatus==='linked'));
 tracker.update(frame('f3',30,[item(5,[255,0,0])]));const hidden=tracker.states(30).find(o=>o.objectId===a[1].objectId);assert.equal(hidden.visibilityState,'unknown');assert.equal(hidden.lastSeenAt,20);
 assert.equal(tracker.propagated(a[1].objectId,121),null);assert.equal(tracker.propagated(a[1].objectId,100).sourceKind,'tracker');
 const d=tracker.update(frame('f4',40,[item(7,[255,0,0]),item(10,[0,0,255])]));assert.equal(d[1].objectId,a[1].objectId);
});
test('SAM per-frame ids are ignored and stale masks do not carry IDs past the configured gap',()=>{
 const make=(id,t,samId)=>frame(id,t,[{...item(2,[100,100,100]),m:{...crop(2,2),objectId:samId}}]);
 const tracker=new ObjectTracker();const first=tracker.update(make('sam-1',10,'sam-object-1'))[0];
 const near=tracker.update(make('sam-2',20,'sam-object-2'))[0];assert.equal(near.objectId,first.objectId);assert.equal(near.identityStatus,'linked');
 const far=tracker.update(make('sam-3',5021,'sam-object-3'))[0];assert.notEqual(far.objectId,first.objectId);assert.equal(far.identityStatus,'tentative');assert.deepEqual(far.candidateObjectIds,[]);

 const optedIn=new ObjectTracker({maxGapMs:6000});const old=optedIn.update(make('slow-1',10,'one'))[0];
 const later=optedIn.update(make('slow-2',5021,'two'))[0];assert.equal(later.objectId,old.objectId);assert.equal(later.identityStatus,'linked');
});
test('ambiguous candidates stay separate, and a link can be revoked without deleting old evidence',()=>{
 const tracker=new ObjectTracker();const first=tracker.update(frame('a',1,[item(2,[100,100,100]),item(6,[100,100,100])]));
 const ambiguous=tracker.update(frame('b',2,[item(4,[100,100,100])]));assert.equal(ambiguous[0].identityStatus,'ambiguous');assert.equal(ambiguous[0].candidateObjectIds.length,2);assert.ok(!first.some(o=>o.objectId===ambiguous[0].objectId));
 const t=new ObjectTracker();const start=t.update(frame('x',1,[item(2,[255,0,0])]));const next=t.update(frame('y',2,[item(3,[255,0,0])]));const revision=t.revokeLink(next[0].observationId,3);assert.notEqual(revision.objectId,start[0].objectId);assert.equal(revision.associationRevision,1);assert.equal(t.states(2).find(x=>x.objectId===start[0].objectId).lastSeenAt,1);
 const memory=new ExperienceMemory();memory.observe(start[0]);memory.observe(next[0]);assert.equal(memory.lastSeen(start[0].objectId).frameId,'y');
});
test('crop raster maps mask pixels to aligned depth while gaze contact and anchor stay distinct',()=>{
 const m=crop(4,2);m.raster[0]=0;assert.equal(maskContains(m,4.5,2.5),false);assert.equal(maskContains(m,5.5,2.5),true);
 const tracker=new ObjectTracker();const [o]=tracker.update(frame('z',5,[{m,color:[10,20,30]}],{gaze:{frameId:'z',observedAt:5,processedAt:6,causalStatus:'online_causal',pixel:[5.5,2.5]}}));assert.ok(o.surfacePointWorld);assert.ok(o.gazeHitPointWorld);assert.equal(o.objectAnchorWorld,null);assert.notDeepEqual(o.surfacePointWorld,o.gazeHitPointWorld);
 const invalid=frame('q',6,[item(5,[10,20,30])]);invalid.depth.frameId='other';const [unavailable]=tracker.update(invalid);assert.equal(unavailable.surfacePointWorld,null);
 assert.throws(()=>tracker.update({...frame('r',7,[item(5,[10,20,30])]),causalStatus:'offline_assisted'}));
});

test('tracker rejects misaligned gaze and enforces frame and mask limits',()=>{
 const tracker=new ObjectTracker({maxMaskPixels:9,maxObjects:2});tracker.update(frame('one',1,[item(1,[1,2,3])]));
 assert.throws(()=>tracker.update(frame('two',2,[item(10,[8,9,10])])),/mask_capacity/);
 assert.throws(()=>tracker.update(frame('two',2,[item(2,[1,2,3])],{gaze:{frameId:'other',observedAt:2,processedAt:3,causalStatus:'online_causal',pixel:[2,2]}})),/invalid/);
 const aligned=tracker.update(frame('two',2,[item(2,[1,2,3])]));assert.equal(aligned.length,1);
});
