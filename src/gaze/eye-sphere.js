const vec = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0);
const length = v => Math.hypot(...v);
export const NODE_SOURCES = Object.freeze(['modeled_sphere', 'observed_point']);
function rotation(q) {
  if (!Array.isArray(q) || q.length !== 9 || !q.every(Number.isFinite)) throw new TypeError('rotation matrix required');
  const rows=[q.slice(0,3),q.slice(3,6),q.slice(6,9)];
  const det=q[0]*(q[4]*q[8]-q[5]*q[7])-q[1]*(q[3]*q[8]-q[5]*q[6])+q[2]*(q[3]*q[7]-q[4]*q[6]);
  if(rows.some(r=>Math.abs(length(r)-1)>1e-6)||Math.abs(dot(rows[0],rows[1]))>1e-6||Math.abs(dot(rows[0],rows[2]))>1e-6||Math.abs(dot(rows[1],rows[2]))>1e-6||Math.abs(det-1)>1e-6)throw new TypeError('proper orthonormal rotation required');
  return v=>rows.map(r=>dot(r,v));
}
// Model nodes cover a sphere; they are not independently detected anatomy or gaze rays.
export function createEyeSphere({eye,centerM,radiusM,rotationMatrix=[1,0,0,0,1,0,0,0,1],count=32,coordinateFrameId,observedAt}={}) {
  if(!['left','right'].includes(eye)||!vec(centerM)||!Number.isFinite(radiusM)||radiusM<=0||!Number.isInteger(count)||count<30||count>1024||typeof coordinateFrameId!=='string'||!coordinateFrameId||!Number.isFinite(observedAt)||observedAt<0)throw new TypeError('invalid eye sphere');
  const rotate=rotation(rotationMatrix),golden=Math.PI*(3-Math.sqrt(5));
  const nodes=Array.from({length:count},(_,i)=>{
    const y=1-2*(i+.5)/count,r=Math.sqrt(1-y*y),a=i*golden;
    const normal=rotate([r*Math.cos(a),y,r*Math.sin(a)]);
    return {id:`${eye}:sphere:${i}`,eye,source:'modeled_sphere',observed:false,positionM:normal.map((v,k)=>centerM[k]+radiusM*v),normal};
  });
  return {eye,coordinateFrameId,observedAt,units:'m',centerM:[...centerM],radiusM,nodes};
}
// Rigid frame change p' = R p + t, n' = R n. Node ids, provenance flags and observedAt are preserved.
export function transformEyeSphere(sphere,{rotationMatrix,translationM=[0,0,0],coordinateFrameId}={}) {
  if(!Array.isArray(sphere?.nodes)||!vec(sphere.centerM)||!vec(translationM)||typeof coordinateFrameId!=='string'||!coordinateFrameId)throw new TypeError('invalid eye sphere transform');
  const rotate=rotation(rotationMatrix),place=p=>rotate(p).map((v,i)=>v+translationM[i]);
  return {...sphere,coordinateFrameId,centerM:place(sphere.centerM),nodes:sphere.nodes.map(n=>({...n,positionM:place(n.positionM),normal:rotate(n.normal)}))};
}
// Numerical contract check (G1-C): >=30 unique model nodes per eye, unit normals, outward, provenance on 100% of nodes.
export function validateEyeSphere(sphere,{minModelNodes=30,tolerance=1e-6}={}) {
  const errors=[],nodes=Array.isArray(sphere?.nodes)?sphere.nodes:[];
  if(!['left','right'].includes(sphere?.eye)||!vec(sphere?.centerM)||!Number.isFinite(sphere?.radiusM)||sphere.radiusM<=0||sphere?.units!=='m'||!sphere?.coordinateFrameId)errors.push('invalid_sphere_header');
  let maxNormError=0,maxRadiusError=0,outwardViolations=0,provenanceOk=0;
  const ids=new Set(),positions=new Set(),model=nodes.filter(n=>n?.source==='modeled_sphere');
  for(const n of nodes){
    if(NODE_SOURCES.includes(n?.source)&&typeof n.observed==='boolean'&&n.observed===(n.source==='observed_point')&&n.eye===sphere?.eye)provenanceOk++;
    if(typeof n?.id!=='string'||ids.has(n.id))errors.push('duplicate_or_missing_node_id');else ids.add(n.id);
    if(!vec(n?.normal)||!vec(n?.positionM)){errors.push('invalid_node_vectors');continue;}
    maxNormError=Math.max(maxNormError,Math.abs(length(n.normal)-1));
    const offset=n.positionM.map((v,i)=>v-sphere.centerM[i]),distance=length(offset);
    if(!(dot(n.normal,offset)>0))outwardViolations++;
    else if(distance>0&&n.normal.some((v,i)=>Math.abs(v-offset[i]/distance)>tolerance))errors.push('normal_not_radial');
    if(n.source==='modeled_sphere'){maxRadiusError=Math.max(maxRadiusError,Math.abs(distance-sphere.radiusM));positions.add(n.positionM.map(v=>v.toFixed(9)).join());}
  }
  if(model.length<minModelNodes)errors.push('too_few_model_nodes');
  if(positions.size!==model.length)errors.push('duplicate_model_positions');
  if(maxNormError>tolerance)errors.push('normal_not_unit');
  if(maxRadiusError>tolerance)errors.push('model_node_off_sphere');
  if(outwardViolations)errors.push('normal_not_outward');
  if(nodes.length&&provenanceOk!==nodes.length)errors.push('provenance_incomplete');
  return {ok:errors.length===0&&nodes.length>0,errors:[...new Set(errors)],modelNodeCount:model.length,observedNodeCount:nodes.filter(n=>n?.source==='observed_point').length,uniqueModelNodeCount:positions.size,maxNormError,maxRadiusError,outwardViolations,provenanceCoverage:nodes.length?provenanceOk/nodes.length:0};
}
// Motion compares modeled nodes only; observed-point nodes change identity between frames.
export function eyeSphereMotion(previous,current,{maxGapMs=250}={}) {
  const dt=current?.observedAt-previous?.observedAt;
  if(!Number.isFinite(maxGapMs)||maxGapMs<=0)throw new TypeError('invalid gap');
  const modeled=s=>Array.isArray(s?.nodes)?s.nodes.filter(n=>n?.source!=='observed_point'):null,before=modeled(previous),after=modeled(current);
  if(!Number.isFinite(dt)||dt<=0||dt>maxGapMs||previous?.eye!==current?.eye||previous?.coordinateFrameId!==current?.coordinateFrameId||!before||!after||before.length!==after.length)return {status:'unavailable',reason:'incompatible_or_discontinuous_frames',nodes:[]};
  const old=new Map(before.map(n=>[n.id,n]));
  const nodes=[];
  for(const n of after){const p=old.get(n.id);if(!p||!vec(p.normal)||!vec(n.normal)||!vec(p.positionM)||!vec(n.positionM))return {status:'unavailable',reason:'node_mismatch',nodes:[]};
    const cross=[p.normal[1]*n.normal[2]-p.normal[2]*n.normal[1],p.normal[2]*n.normal[0]-p.normal[0]*n.normal[2],p.normal[0]*n.normal[1]-p.normal[1]*n.normal[0]];
    nodes.push({id:n.id,velocityMps:n.positionM.map((v,i)=>(v-p.positionM[i])*1000/dt),angularSpeedRadPerSec:Math.atan2(length(cross),dot(p.normal,n.normal))*1000/dt});
  }
  return {status:'ok',dtMs:dt,nodes};
}
