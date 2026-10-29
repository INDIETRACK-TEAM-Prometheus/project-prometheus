import test from 'node:test';
import assert from 'node:assert/strict';
import {ObjectTracker} from '../src/spatial/tracker.js';
import {ExperienceMemory,MemoryService,EphemeralStorage} from '../src/memory/index.js';
const frame=(frameId,observedAt,x)=>{
  const width=20,height=10,rgba=new Uint8Array(width*height*4); for(let y=2;y<5;y++) for(let p=x;p<x+3;p++) rgba.set([255,0,0,255],(y*width+p)*4);
  return {frameId,observedAt,processedAt:observedAt+1,causalStatus:'online_causal',provenance:'synthetic',rgba,width,height,masks:[{sourceWidth:width,sourceHeight:height,width:3,height:3,bounds:{left:x,top:2,right:x+3,bottom:5},raster:Array(9).fill(1)}]};
};
test('tracker revocation is time-bounded in persisted memory and invalidates derived observation',async()=>{
  const tracker=new ObjectTracker(), memory=await MemoryService.open({sessionId:'revision',storage:new EphemeralStorage(),clock:()=>20});
  const [first]=tracker.update(frame('f1',1,2)), [linked]=tracker.update(frame('f2',2,3));
  await memory.observe(first); await memory.observe(linked);
  await memory.addDerivation({id:'derived',evidenceIds:['f2'],observationIds:[linked.observationId]});
  const revised=tracker.revokeLink(linked.observationId,10); assert.ok(revised); assert.equal(revised.processedAt,10);
  await memory.observe(revised);
  assert.equal((await memory.retrieve({objectId:first.objectId,observedUntil:9})).lastSeen.observationId,linked.observationId);
  assert.equal((await memory.retrieve({objectId:first.objectId,observedUntil:10})).lastSeen.observationId,first.observationId);
  assert.equal((await memory.retrieve({objectId:revised.objectId,observedUntil:10})).lastSeen.observationId,revised.observationId);
  assert.equal((await memory.getDerivation('derived')).reason,'association_revised');
  await memory.deleteEvidence('f2'); assert.equal((await memory.retrieve({objectId:revised.objectId})).lastSeen,null);
  await memory.close();
});

