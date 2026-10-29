// Internal, provider-independent geometry. Camera coordinates: +x right, +y down,
// +z forward; transforms are row-major camera-to-world rigid matrices in metres.
const dot = (a,b) => a.reduce((s,x,i)=>s+x*b[i],0);
const add = (a,b) => a.map((x,i)=>x+b[i]);
const scale = (a,s) => a.map(x=>x*s);
const sub = (a,b) => a.map((x,i)=>x-b[i]);
const norm = a => Math.hypot(...a);
const finite3 = a => Array.isArray(a) && a.length===3 && a.every(Number.isFinite);
const unavailable = reason => ({status:'unavailable', point:null, reason});
function validTransform(m) {
  if (!Array.isArray(m) || m.length!==16 || !m.every(Number.isFinite) || m.slice(12).some((v,i)=>Math.abs(v-[0,0,0,1][i])>1e-8)) return false;
  const rows=[[m[0],m[1],m[2]],[m[4],m[5],m[6]],[m[8],m[9],m[10]]];
  const det=dot(rows[0],[rows[1][1]*rows[2][2]-rows[1][2]*rows[2][1],rows[1][2]*rows[2][0]-rows[1][0]*rows[2][2],rows[1][0]*rows[2][1]-rows[1][1]*rows[2][0]]);
  return Math.abs(det-1)<1e-6 && rows.every((r,i)=>rows.every((s,j)=>Math.abs(dot(r,s)-(i===j?1:0))<1e-6));
}
function transform(m,p,w=1) { return [0,1,2].map(i=>m[i*4]*p[0]+m[i*4+1]*p[1]+m[i*4+2]*p[2]+m[i*4+3]*w); }
export function pixelRay(pixel, intrinsics, cameraToWorld) {
  const {fx,fy,cx,cy}=intrinsics ?? {};
  if (!Array.isArray(pixel) || pixel.length!==2 || !pixel.every(Number.isFinite) || ![fx,fy,cx,cy].every(Number.isFinite) || fx<=0 || fy<=0 || !validTransform(cameraToWorld)) return {status:'unavailable',reason:'invalid_calibration_or_pose',ray:null};
  const cameraDirection=[(pixel[0]-cx)/fx,(pixel[1]-cy)/fy,1];
  const unit=scale(cameraDirection,1/norm(cameraDirection));
  return {status:'ok',ray:{origin:transform(cameraToWorld,[0,0,0]),direction:transform(cameraToWorld,unit,0),cameraDirection}};
}
export function unprojectDepth({pixel,intrinsics,cameraToWorld,depth,units,convention,depthSource,valid=true,metricScaleKnown=true,provenance}) {
  const ray=pixelRay(pixel,intrinsics,cameraToWorld);
  if (ray.status!=='ok') return unavailable(ray.reason);
  if (!valid || !Number.isFinite(depth) || depth<=0) return unavailable('invalid_depth');
  if (units!=='m' || !metricScaleKnown) return unavailable('metric_depth_unavailable');
  if (!['axial_z','ray_range'].includes(convention)) return unavailable('unsupported_depth_convention');
  if (!['engine_geometry','dataset_estimated_depth','sensor_depth','monocular_estimated_depth'].includes(depthSource) || !provenance) return unavailable('missing_depth_provenance');
  const camera=convention==='axial_z' ? scale(ray.ray.cameraDirection,depth) : scale(ray.ray.cameraDirection,depth/norm(ray.ray.cameraDirection));
  return {status:'ok',point:transform(cameraToWorld,camera),depthSource,convention,units,provenance};
}
// A tiny virtual-geometry fixture, not a renderer or segmentation result. No
// engine object IDs are emitted. Sphere and finite rectangle surface support.
export function firstSurface(ray, surfaces, provenance) {
  if (!ray || !finite3(ray.origin) || !finite3(ray.direction) || Math.abs(norm(ray.direction)-1)>1e-6 || !Array.isArray(surfaces) || !provenance) return unavailable('invalid_ray_or_geometry');
  let nearest=Infinity;
  for (const s of surfaces) {
    let t=Infinity;
    if (s.type==='sphere' && finite3(s.center) && Number.isFinite(s.radius) && s.radius>0) {
      const oc=sub(ray.origin,s.center), b=dot(oc,ray.direction), disc=b*b-dot(oc,oc)+s.radius*s.radius;
      if (disc>=0) { const roots=[-b-Math.sqrt(disc),-b+Math.sqrt(disc)].filter(x=>x>1e-9); if (roots.length) t=Math.min(...roots); }
    } else if (s.type==='rectangle' && finite3(s.center) && finite3(s.u) && finite3(s.v) && Math.abs(dot(s.u,s.v))<1e-6 && Math.abs(norm(s.u)-1)<1e-6 && Math.abs(norm(s.v)-1)<1e-6 && s.halfWidth>0 && s.halfHeight>0) {
      const n=[s.u[1]*s.v[2]-s.u[2]*s.v[1],s.u[2]*s.v[0]-s.u[0]*s.v[2],s.u[0]*s.v[1]-s.u[1]*s.v[0]], den=dot(n,ray.direction);
      if (Math.abs(den)>1e-9) { const candidate=dot(n,sub(s.center,ray.origin))/den, p=sub(add(ray.origin,scale(ray.direction,candidate)),s.center); if (candidate>1e-9 && Math.abs(dot(p,s.u))<=s.halfWidth && Math.abs(dot(p,s.v))<=s.halfHeight) t=candidate; }
    } else return unavailable('unsupported_or_invalid_surface');
    nearest=Math.min(nearest,t);
  }
  return Number.isFinite(nearest) ? {status:'hit',point:add(ray.origin,scale(ray.direction,nearest)),range:nearest,depthSource:'engine_geometry',provenance} : {status:'no_hit',point:null,reason:'no_visible_surface',provenance};
}

// Discrete uncertainty samples and normalized scores; scores are not calibrated probabilities.
// Masks are external observed segmentation/tracker outputs, never engine truth.
export function associateMasks(samples, masks, observedUntil) {
  if (!Number.isFinite(observedUntil) || !Array.isArray(samples) || !samples.length || samples.some(s=>!Array.isArray(s.xy)||s.xy.length!==2||!s.xy.every(Number.isFinite)||!Number.isFinite(s.weight)||s.weight<0) || !Array.isArray(masks)) return {status:'unavailable',candidates:[],reason:'invalid_association_input'};
  if (masks.some(m=>m.causalStatus!=='online_causal'||!Number.isFinite(m.observedAt)||m.observedAt>observedUntil||!m.provenance||!['segmentation','tracker'].includes(m.sourceKind))) return {status:'withheld',candidates:[],reason:'noncausal_or_unverified_mask'};
  const total=samples.reduce((a,s)=>a+s.weight,0); if (!total) return {status:'unavailable',candidates:[],reason:'zero_sample_weight'};
  const candidates=masks.map(m=>({detectionId:m.detectionId,score:samples.reduce((a,s)=>a+(m.contains(s.xy)?s.weight:0),0)/total,sourceKind:m.sourceKind,provenance:m.provenance})).filter(c=>c.score>0);
  return {status:'ok',candidates,scoreMeaning:'sample_coverage_not_probability'};
}

// Cross-map comparison requires a supplied transform with source and uncertainty.
export function compareAnchors(oldObservation,newObservation,correction) {
  if (!finite3(oldObservation?.objectAnchorWorld) || !finite3(newObservation?.objectAnchorWorld)) return {status:'unknown',reason:'anchor_unavailable',displacement:null};
  const mapValid=o=>typeof o.mapId==='string' && o.mapId.length>0 && Number.isInteger(o.mapVersion) && o.mapVersion>=0 && typeof o.coordinateFrameId==='string' && o.coordinateFrameId.length>0;
  if (!mapValid(oldObservation) || !mapValid(newObservation)) return {status:'unknown',reason:'map_identity_unavailable',displacement:null};
  const changed=oldObservation.mapId!==newObservation.mapId || oldObservation.mapVersion!==newObservation.mapVersion || oldObservation.coordinateFrameId!==newObservation.coordinateFrameId;
  let matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  if (changed) {
    if (!correction || !validTransform(correction.matrix) || correction.from?.mapId!==oldObservation.mapId || correction.from?.mapVersion!==oldObservation.mapVersion || correction.from?.coordinateFrameId!==oldObservation.coordinateFrameId || correction.to?.mapId!==newObservation.mapId || correction.to?.mapVersion!==newObservation.mapVersion || correction.to?.coordinateFrameId!==newObservation.coordinateFrameId || typeof correction.provenance!=='string' || !correction.provenance || !Number.isFinite(correction.uncertainty?.translationM) || correction.uncertainty.translationM<0 || !Number.isFinite(correction.uncertainty?.rotationRad) || correction.uncertainty.rotationRad<0) return {status:'unknown',reason:'map_transform_unavailable',displacement:null};
    matrix=correction.matrix;
  }
  const displacement=sub(newObservation.objectAnchorWorld,transform(matrix,oldObservation.objectAnchorWorld));
  return {status:'comparable',displacement,distance:norm(displacement),oldMap:{id:oldObservation.mapId,version:oldObservation.mapVersion},newMap:{id:newObservation.mapId,version:newObservation.mapVersion},oldToNew:matrix.slice(),correction:changed?structuredClone(correction):null};
}
