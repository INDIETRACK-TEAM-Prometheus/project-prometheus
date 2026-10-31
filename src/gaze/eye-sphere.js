const vec = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0);
const length = v => Math.hypot(...v);
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
export function eyeSphereMotion(previous,current,{maxGapMs=250}={}) {
  const dt=current?.observedAt-previous?.observedAt;
  if(!Number.isFinite(maxGapMs)||maxGapMs<=0)throw new TypeError('invalid gap');
  if(!Number.isFinite(dt)||dt<=0||dt>maxGapMs||previous?.eye!==current?.eye||previous?.coordinateFrameId!==current?.coordinateFrameId||!Array.isArray(previous?.nodes)||!Array.isArray(current?.nodes)||previous.nodes.length!==current.nodes.length)return {status:'unavailable',reason:'incompatible_or_discontinuous_frames',nodes:[]};
  const old=new Map(previous.nodes.map(n=>[n.id,n]));
  const nodes=[];
  for(const n of current.nodes){const p=old.get(n.id);if(!p||!vec(p.normal)||!vec(n.normal)||!vec(p.positionM)||!vec(n.positionM))return {status:'unavailable',reason:'node_mismatch',nodes:[]};
    const c=Math.max(-1,Math.min(1,dot(p.normal,n.normal)));
    nodes.push({id:n.id,velocityMps:n.positionM.map((v,i)=>(v-p.positionM[i])*1000/dt),angularSpeedRadPerSec:Math.acos(c)*1000/dt});
  }
  return {status:'ok',dtMs:dt,nodes};
}
