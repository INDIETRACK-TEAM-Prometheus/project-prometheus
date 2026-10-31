import {unprojectDepth} from './geometry.js';
import {associateMasks} from './mask-association.js';
const nonempty = x => typeof x === 'string' && x.length > 0;
const finite = x => Number.isFinite(x) && x >= 0;
const clone = x => structuredClone(x);

// SAM crop raster uses half-open source-image bounds. Coordinates refer to pixel centers.
export function maskContains(mask,x,y) {
  const b=mask.bounds;
  if (x<b.left || x>=b.right || y<b.top || y>=b.bottom) return false;
  const mx=Math.floor((x-b.left)*mask.width/(b.right-b.left)), my=Math.floor((y-b.top)*mask.height/(b.bottom-b.top));
  return mask.raster[my*mask.width+mx]===1;
}
function validateMask(m,w,h) {
  const b=m?.bounds;
  return m && m.sourceWidth===w && m.sourceHeight===h && Number.isInteger(m.width) && m.width>0 && Number.isInteger(m.height) && m.height>0 && m.width*m.height<=1048576 && Array.isArray(m.raster) && m.raster.length===m.width*m.height && m.raster.every(x=>x===0 || x===1) && b && [b.left,b.top,b.right,b.bottom].every(Number.isInteger) && b.left>=0 && b.top>=0 && b.right<=w && b.bottom<=h && b.right>b.left && b.bottom>b.top;
}
function feature(mask,rgba,w) {
  const b=mask.bounds; let count=0,sumX=0,sumY=0;const color=[0,0,0];
  for(let y=b.top;y<b.bottom;y++) for(let x=b.left;x<b.right;x++) if(maskContains(mask,x+.5,y+.5)) {count++;sumX+=x+.5;sumY+=y+.5;const offset=(y*w+x)*4;for(let channel=0;channel<3;channel++)color[channel]+=rgba[offset+channel];}
  if (!count) throw new TypeError('empty mask');
  const centerX=sumX/count,centerY=sumY/count;let best=null,bestDistance=Infinity;
  for(let y=b.top;y<b.bottom;y++) for(let x=b.left;x<b.right;x++) if(maskContains(mask,x+.5,y+.5)) {const distance=(x+.5-centerX)**2+(y+.5-centerY)**2;if(distance<bestDistance){best=[x+.5,y+.5];bestDistance=distance;}}
  return {pixel:best,color:color.map(value=>value/count)};
}
function metricPoint(pixel,depth,frameId,observedAt,processedAt) {
  if (!depth || depth.frameId!==frameId || depth.observedAt!==observedAt || !finite(depth.processedAt) || depth.processedAt<depth.observedAt || depth.processedAt>processedAt || depth.causalStatus!=='online_causal' || !Number.isInteger(depth.width) || !Number.isInteger(depth.height) || !Array.isArray(depth.values) || depth.values.length!==depth.width*depth.height) return {status:'unavailable',point:null,reason:'unaligned_depth'};
  const x=Math.floor(pixel[0]),y=Math.floor(pixel[1]);
  if(x<0 || y<0 || x>=depth.width || y>=depth.height) return {status:'unavailable',point:null,reason:'outside_depth'};
  return unprojectDepth({...depth,pixel,depth:depth.values[y*depth.width+x]});
}
function sampledPoint(pixel, sampleSurface, frameId, observedAt, processedAt, coordinateFrameId) {
  if(typeof sampleSurface!=='function' || !nonempty(coordinateFrameId)) return {point:null,source:null};
  try {
    const hit=sampleSurface(pixel);
    if(!hit || hit.frameId!==frameId || hit.observedAt!==observedAt || hit.coordinateFrameId!==coordinateFrameId || !finite(hit.processedAt) || hit.processedAt<observedAt || hit.processedAt>processedAt || hit.depthSource!=='engine_geometry' || hit.units!=='m' || !nonempty(hit.provenance) || !Array.isArray(hit.point) || hit.point.length!==3 || !hit.point.every(Number.isFinite)) return {point:null,source:null};
    return {point:[...hit.point],source:{depthSource:hit.depthSource,units:hit.units,provenance:hit.provenance,frameId,observedAt,coordinateFrameId}};
  } catch { return {point:null,source:null}; }
}
export class ObjectTracker {
  constructor({maxObjects=100,maxObservations=1000,maxGapMs=1000,maxPropagationMs=200,maxMaskPixels=2000000}={}) {
    if (![maxObjects,maxObservations,maxMaskPixels].every(v=>Number.isInteger(v)&&v>0) || ![maxGapMs,maxPropagationMs].every(finite)) throw new TypeError('invalid limits');
    Object.assign(this,{maxObjects,maxObservations,maxGapMs,maxPropagationMs,maxMaskPixels});this.objects=new Map();this.observations=[];this.lineage=[];this.clock=-1;this.processedClock=-1;this.serial=0;this.frameIds=new Set();
  }
  update({frameId,observedAt,processedAt,causalStatus,provenance,rgba,width,height,masks,depth=null,gaze=null,coordinateFrameId=null,sampleSurface=null}) {
    if(!nonempty(frameId)||this.frameIds.has(frameId)||!finite(observedAt)||!finite(processedAt)||processedAt<observedAt||processedAt<this.processedClock||observedAt<=this.clock||causalStatus!=='online_causal'||!nonempty(provenance)||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>1048576||!rgba||rgba.length!==width*height*4||!Array.isArray(masks)||masks.length>this.maxObjects||masks.some(m=>!validateMask(m,width,height))||depth && (depth.width!==width||depth.height!==height)||gaze && (gaze.frameId!==frameId||(gaze.framePresentTsEstimateMs!==undefined && (!finite(gaze.framePresentTsEstimateMs)||gaze.framePresentTsEstimateMs<observedAt||gaze.framePresentTsEstimateMs>gaze.observedAt))||gaze.causalStatus!=='online_causal'||(!finite(gaze.observedAt)||gaze.observedAt<observedAt||gaze.observedAt!==observedAt && (!finite(gaze.syncUncertaintyMs)||!finite(gaze.frameSyncUncertaintyMs)||!finite(gaze.framePresentTsEstimateMs ?? observedAt)||(gaze.framePresentTsEstimateMs ?? observedAt)<observedAt||(gaze.framePresentTsEstimateMs ?? observedAt)>gaze.observedAt||!finite(gaze.alignmentBudgetMs)||gaze.observedAt-(gaze.framePresentTsEstimateMs ?? observedAt)+gaze.syncUncertaintyMs+gaze.frameSyncUncertaintyMs>gaze.alignmentBudgetMs))||!finite(gaze.processedAt)||gaze.processedAt<gaze.observedAt||gaze.processedAt>processedAt||!Array.isArray(gaze.pixel)||gaze.pixel.length!==2||!gaze.pixel.every(Number.isFinite))) throw new TypeError('invalid frame or mask');
    const detections=masks.map((mask,i)=>({mask,features:feature(mask,rgba,width),detectionId:`${frameId}:${i}`}));
    const recent=[...this.objects.values()].filter(o=>observedAt-o.observedAt<=this.maxGapMs);
    const association=associateMasks(recent.map(o=>({objectId:o.objectId,mask:o.mask,appearance:o.color})),detections.map(d=>({mask:d.mask,appearance:d.features.color})));
    const matches=new Map(association.matches.map(match=>[match.detectionIndex,match.objectId]));
    const candidates=association.candidates.map(item=>item.candidates.map(candidate=>({objectId:candidate.objectId,score:candidate.iou})));
    const ambiguous=new Set(association.ambiguous.map(item=>item.detectionIndex)); const observations=[];
    const creates=detections.length-matches.size;
    if(this.objects.size+creates>this.maxObjects) throw new Error('object_capacity');
    const linkedIds=new Set(matches.values());
    const retained=[...this.objects.values()].filter(o=>!linkedIds.has(o.objectId)).reduce((n,o)=>n+(o.mask?.width??0)*(o.mask?.height??0),0);
    if(retained+masks.reduce((n,m)=>n+m.width*m.height,0)>this.maxMaskPixels) throw new Error('mask_capacity');
    for(let i=0;i<detections.length;i++) {
      const d=detections[i], c=candidates[i], linked=matches.has(i), objectId=linked?matches.get(i):`object-${++this.serial}`;
      if(!linked && this.objects.size>=this.maxObjects) throw new Error('object_capacity');
      const locate=pixel=>depth ? metricPoint(pixel,depth,frameId,observedAt,processedAt) : sampledPoint(pixel,sampleSurface,frameId,observedAt,processedAt,coordinateFrameId); const point=locate(d.features.pixel); const gazePoint=gaze && maskContains(d.mask,...gaze.pixel)?locate(gaze.pixel):null;
      const observation={observationId:`${frameId}:${i}`,detectionId:d.detectionId,objectId,frameId,observedAt,processedAt,identityStatus:ambiguous.has(i)?'ambiguous':linked?'linked':'tentative',candidateObjectIds:c.map(x=>x.objectId),sourceKind:'segmentation',causalStatus,provenance,bounds:clone(d.mask.bounds),surfacePointWorld:point.point,surfaceProvenance:point.source??null,objectAnchorWorld:null,gazeHitPointWorld:gazePoint?.point??null,gazeHitProvenance:gazePoint?.source??null,evidenceIds:[frameId],associationRevision:0};
      const previous=linked?this.objects.get(objectId):null;
      observations.push(observation);this.objects.set(objectId,{objectId,observedAt,bounds:clone(d.mask.bounds),color:d.features.color,mask:clone(d.mask),frameId,observationId:observation.observationId});
      if(linked) this.lineage.push({observationId:observation.observationId,objectId,active:true,previous:{...previous,mask:null}});
    }
    this.clock=observedAt;this.processedClock=processedAt;this.frameIds.add(frameId);this.observations.push(...observations);
    while(this.observations.length>this.maxObservations) this.observations.shift();
    while(this.frameIds.size>this.maxObservations) this.frameIds.delete(this.frameIds.values().next().value);
    while(this.lineage.length>this.maxObservations) this.lineage.shift();
    return clone(observations);
  }
  states(now) {
    if(!finite(now)||now<this.clock) throw new TypeError('invalid time');
    return [...this.objects.values()].map(o=>({objectId:o.objectId,visibilityState:o.observedAt===now?'visible':'unknown',lastSeenAt:o.observedAt,lastSeenFrameId:o.frameId,positionMeaning:'last_seen_not_current'}));
  }
  propagated(objectId,now) {
    const o=this.objects.get(objectId); if(!o||!o.mask||!finite(now)||now<this.clock||now<o.observedAt||now-o.observedAt>this.maxPropagationMs) return null;
    return {objectId,sourceKind:'tracker',method:'static_carry_forward',sourceFrameId:o.frameId,observedAt:o.observedAt,ageMs:now-o.observedAt,mask:clone(o.mask)};
  }
  revokeLink(observationId, processedAt) {
    const link=this.lineage.findLast(l=>l.observationId===observationId&&l.active), obs=this.observations.find(o=>o.observationId===observationId);
    if(!link||!obs||this.objects.size>=this.maxObjects) return null;
    if(!finite(processedAt)||processedAt<obs.processedAt||processedAt<this.processedClock) throw new TypeError('invalid revision time');
    const original=this.objects.get(link.objectId); if(!original || original.observationId!==observationId) return null;
    const objectId=`object-${++this.serial}`; link.active=false;
    const revised={...obs,observationId:`${obs.observationId}:revision:${obs.associationRevision+1}`,objectId,processedAt,identityStatus:'tentative',associationRevision:obs.associationRevision+1,supersedesObservationId:obs.observationId};
    this.observations.push(revised); if(this.observations.length>this.maxObservations) this.observations.shift();
    this.objects.set(objectId,{...original,objectId});
    this.objects.set(link.objectId,link.previous);
    return clone(revised);
  }
}


