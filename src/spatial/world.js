import {pixelRay} from './geometry.js';

// Synthetic metric scene; geometry and labels are private to the simulator.
const I=(x=0,y=0,z=0)=>[1,0,0,x,0,1,0,y,0,0,1,z,0,0,0,1];
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function box(center,size,color) {
  const [x,y,z]=center,[a,b,c]=size.map(v=>v/2);
  const p=[[x-a,y-b,z-c],[x+a,y-b,z-c],[x+a,y+b,z-c],[x-a,y+b,z-c],[x-a,y-b,z+c],[x+a,y-b,z+c],[x+a,y+b,z+c],[x-a,y+b,z+c]];
  const faces=[[0,1,2,3],[5,4,7,6],[4,0,3,7],[1,5,6,2],[4,5,1,0],[3,2,6,7]];
  return faces.flatMap((f,i)=>[[f[0],f[1],f[2]],[f[0],f[2],f[3]]].map(ids=>({vertices:ids.map(j=>p[j]),color:color.map(v=>v*[1,.65,.8,.9,1,.7][i])})));
}
function sceneAt(ms) {
  const t=ms/1000;
  return [
    ...box([0,1.6,7],[15,.15,16],[.28,.34,.30]),
    ...box([0,-.2,13],[15,4,.2],[.48,.58,.53]),
    ...box([-2,.7,6],[1.4,1.7,1.4],[.72,.43,.20]),
    ...box([2,.65,8],[1.4,1.8,1.4],[.36,.53,.73]),
    ...box([1.7*Math.sin(t*.7),.65,4.5],[.8,1.8,.8],[.82,.24,.18]),
    ...box([2.5*Math.cos(t*.45),1.1,9],[1.4,.8,.9],[.90,.70,.18])
  ];
}
function cameraAt(ms,width,height) {
  const position=[.35*Math.sin(ms/5000),0,0], focal=height/(2*Math.tan(Math.PI/6));
  return {position,intrinsics:{fx:focal,fy:focal,cx:width/2,cy:height/2},cameraToWorld:I(...position)};
}
function intersect(origin,dir,tri) {
  const [a,b,c]=tri.vertices, e1=sub(b,a),e2=sub(c,a),h=cross(dir,e2),det=dot(e1,h);
  if (Math.abs(det)<1e-9) return Infinity;
  const inv=1/det,s=sub(origin,a),u=inv*dot(s,h); if(u<0||u>1)return Infinity;
  const q=cross(s,e1),v=inv*dot(dir,q); if(v<0||u+v>1)return Infinity;
  const t=inv*dot(e2,q); return t>1e-6?t:Infinity;
}
// Pure, deterministic metric fixture; exposes current visible hit only, no IDs.
export function sampleWorld(timeMs,width,height,x,y) {
  if (![timeMs,width,height,x,y].every(Number.isFinite)||width<=0||height<=0||x<0||y<0||x>=width||y>=height) return {status:'unavailable',point:null,reason:'invalid_viewport_or_pixel'};
  const camera=cameraAt(timeMs,width,height),ray=pixelRay([x,y],camera.intrinsics,camera.cameraToWorld).ray;
  let distance=Infinity;
  for(const triangle of sceneAt(timeMs)) distance=Math.min(distance,intersect(ray.origin,ray.direction,triangle));
  if(!Number.isFinite(distance))return {status:'no_hit',point:null,reason:'no_visible_surface',depthSource:'engine_geometry'};
  const point=ray.origin.map((v,i)=>v+distance*ray.direction[i]);
  return {status:'hit',point,rayRangeM:distance,axialZM:point[2]-camera.position[2],depthSource:'engine_geometry',provenance:'synthetic_webgl_current_geometry'};
}
function shader(gl,type,source) { const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(`WebGL shader: ${gl.getShaderInfoLog(s)}`);return s; }
export function createWorld(canvas, {maxFrameHistory=300,maxFramePins=4}={}) {
  if (!Number.isInteger(maxFrameHistory)||maxFrameHistory<1||maxFrameHistory>1000 || !Number.isInteger(maxFramePins)||maxFramePins<1||maxFramePins>32) throw new Error('invalid frame history limit');
  const gl=canvas?.getContext('webgl',{preserveDrawingBuffer:true,antialias:true});
  if(!gl) throw new Error('WebGL unavailable');
  const vs=shader(gl,gl.VERTEX_SHADER,'attribute vec3 position; attribute vec3 color; varying vec3 c; uniform vec3 eye; uniform vec2 scale; void main(){vec3 p=position-eye; gl_Position=vec4(p.x*scale.x,-p.y*scale.y,1.002002*p.z-0.2002002,p.z); c=color;}');
  const fs=shader(gl,gl.FRAGMENT_SHADER,'precision mediump float; varying vec3 c; void main(){gl_FragColor=vec4(c,1.0);}');
  const program=gl.createProgram(); gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(`WebGL program: ${gl.getProgramInfoLog(program)}`);
  const buffer=gl.createBuffer(); let currentMs=null, frameWidth=0, frameHeight=0, serial=0, handle=null, disposed=false;
  const frames=new Map(),pins=new Map(); let currentFrame=null;
  function render(timeMs=performance.now()) {
    if(disposed)throw new Error('world disposed');
    if(!Number.isFinite(timeMs))throw new Error('invalid time');
    const width=canvas.width,height=canvas.height;if(!width||!height)throw new Error('empty canvas');
    const camera=cameraAt(timeMs,width,height),data=[];
    for(const tri of sceneAt(timeMs))for(const v of tri.vertices)data.push(...v,...tri.color);
    gl.viewport(0,0,width,height);gl.clearColor(.65,.78,.81,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.DYNAMIC_DRAW);
    for(const [name,offset] of [['position',0],['color',12]]) {const loc=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,3,gl.FLOAT,false,24,offset);}
    gl.uniform3fv(gl.getUniformLocation(program,'eye'),camera.position);gl.uniform2f(gl.getUniformLocation(program,'scale'),2*camera.intrinsics.fx/width,2*camera.intrinsics.fy/height);gl.drawArrays(gl.TRIANGLES,0,data.length/6);
    currentMs=timeMs;frameWidth=width;frameHeight=height;serial++;
    currentFrame=Object.freeze({frameId:`synthetic-${serial}`,renderTsMs:currentMs,image:canvas,intrinsics:Object.freeze({...camera.intrinsics}),cameraToWorld:Object.freeze([...camera.cameraToWorld]),viewport:Object.freeze({width,height}),depthSource:'engine_geometry',provenance:'synthetic_webgl',presentTsEstimateMs:null,displayUncertaintyMs:null});
    frames.set(currentFrame.frameId,currentFrame);while(frames.size>maxFrameHistory)frames.delete(frames.keys().next().value);
    return currentFrame;
  }
  function getFrame() {
    if(currentMs===null||canvas.width!==frameWidth||canvas.height!==frameHeight)return null;
    return currentFrame;
  }
  function markPresented({presentMs,displayUncertaintyMs}={}) {
    if(!getFrame() || !Number.isFinite(presentMs) || presentMs<currentMs || !Number.isFinite(displayUncertaintyMs) || displayUncertaintyMs<=0) return {status:'unavailable',reason:'invalid_presentation_estimate'};
    currentFrame=Object.freeze({...currentFrame,presentTsEstimateMs:presentMs,displayUncertaintyMs});frames.set(currentFrame.frameId,currentFrame);
    return {status:'ok',frame:currentFrame};
  }
  function getHistoricalFrame(frameId){return pins.get(frameId)?.frame ?? frames.get(frameId) ?? null;}
  function raycastFrame(frame,x,y){
    const snapshot=frame && (pins.get(frame.frameId)?.frame ?? frames.get(frame.frameId));
    if(!snapshot || snapshot.renderTsMs!==frame.renderTsMs) return {status:'unavailable',point:null,reason:'frame_unavailable_or_evicted'};
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=snapshot.viewport.width||y>=snapshot.viewport.height)return {status:'unavailable',point:null,reason:'invalid_viewport_or_pixel'};
    const ray=pixelRay([x,y],snapshot.intrinsics,snapshot.cameraToWorld).ray;
    let distance=Infinity;for(const triangle of sceneAt(snapshot.renderTsMs))distance=Math.min(distance,intersect(ray.origin,ray.direction,triangle));
    if(!Number.isFinite(distance))return {status:'no_hit',point:null,reason:'no_visible_surface',depthSource:'engine_geometry'};
    const point=ray.origin.map((v,i)=>v+distance*ray.direction[i]);
    return {status:'hit',point,rayRangeM:distance,axialZM:point[2]-snapshot.cameraToWorld[11],depthSource:'engine_geometry',provenance:'synthetic_webgl_current_geometry'};
  }
  function pinFrame(frame) {
    const snapshot=frame && (pins.get(frame.frameId)?.frame ?? frames.get(frame.frameId));
    if(!snapshot || snapshot.renderTsMs!==frame.renderTsMs || disposed)return {status:'unavailable',reason:'frame_unavailable_or_evicted'};
    const pin=pins.get(snapshot.frameId);if(pin){pin.count++;return {status:'ok'};}
    if(pins.size>=maxFramePins)return {status:'unavailable',reason:'pin_limit'};
    pins.set(snapshot.frameId,{frame:snapshot,count:1});return {status:'ok'};
  }
  function releaseFrame(frame) {
    const pin=frame && pins.get(frame.frameId);if(!pin || pin.frame.renderTsMs!==frame.renderTsMs)return false;
    if(--pin.count===0)pins.delete(frame.frameId);return true;
  }
  function samplePinnedDepth(frame) {
    const pinned=frame && pins.get(frame.frameId)?.frame;
    if(!pinned || pinned.renderTsMs!==frame.renderTsMs || disposed)return null;
    const width=32,height=32,values=new Float32Array(width*height),triangles=sceneAt(pinned.renderTsMs);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      const ray=pixelRay([(x+.5)*pinned.viewport.width/width,(y+.5)*pinned.viewport.height/height],pinned.intrinsics,pinned.cameraToWorld).ray;
      let distance=Infinity;for(const triangle of triangles)distance=Math.min(distance,intersect(ray.origin,ray.direction,triangle));
      values[y*width+x]=Number.isFinite(distance)?distance*ray.direction[2]:NaN;
    }
    return {frameId:pinned.frameId,observedAt:pinned.renderTsMs,width,height,values};
  }
  function samplePinnedSurface(frame,pixel,processedAt) {
    const pinned=frame && pins.get(frame.frameId)?.frame;
    if(!pinned || pinned.renderTsMs!==frame.observedAt || frame.coordinateFrameId!=='synthetic-world-frame' || !Array.isArray(pixel) || pixel.length!==2 || !Number.isFinite(processedAt) || processedAt<pinned.renderTsMs)return null;
    const hit=raycastFrame(pinned,pixel[0],pixel[1]);if(hit.status!=='hit')return null;
    return {frameId:pinned.frameId,observedAt:pinned.renderTsMs,processedAt,coordinateFrameId:frame.coordinateFrameId,point:hit.point,depthSource:hit.depthSource,units:'m',provenance:hit.provenance};
  }
  function raycast(x,y){const f=getFrame();return !f?{status:'unavailable',point:null,reason:'no_rendered_frame_or_viewport_changed'}:raycastFrame(f,x,y);}
  function getDepthAt(x,y){const h=raycast(x,y);return h.status==='hit'?{status:'ok',value:h.axialZM,units:'m',convention:'axial_z',depthSource:h.depthSource,provenance:h.provenance}:{status:h.status,value:null,reason:h.reason};}
  function project(point) {
    if(!getFrame()||!Array.isArray(point)||point.length!==3||!point.every(Number.isFinite))return {status:'unavailable',pixel:null,reason:'frame_or_point_unavailable'};
    const c=cameraAt(currentMs,canvas.width,canvas.height),p=sub(point,c.position);if(p[2]<=.1||p[2]>=100)return {status:'unavailable',pixel:null,reason:'outside_depth_range'};
    return {status:'ok',pixel:[c.intrinsics.cx+c.intrinsics.fx*p[0]/p[2],c.intrinsics.cy+c.intrinsics.fy*p[1]/p[2]],axialZM:p[2]};
  }
  function animate(){if(disposed)throw new Error('world disposed');if(handle!==null)return;const tick=ts=>{render(ts);handle=requestAnimationFrame(tick);};handle=requestAnimationFrame(tick);}
  function dispose(){if(handle!==null)cancelAnimationFrame(handle);handle=null;disposed=true;frames.clear();pins.clear();currentFrame=null;currentMs=null;gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);}
  return {animate,render,getFrame,getHistoricalFrame,markPresented,getDepthAt,project,raycast,raycastFrame,pinFrame,releaseFrame,samplePinnedDepth,samplePinnedSurface,dispose};
}
