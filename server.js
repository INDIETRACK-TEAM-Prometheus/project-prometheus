import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { segmentSam } from './server/sam-adapter.js';
import { reasonScenarios } from './server/reasoner-adapter.js';
import { project } from './src/runtime/facade.js';
import { validateNextGaze } from './src/runtime/next-gaze.js';
import { createRecordingStore } from './server/recording-store.js';
import { createCalibrationStageLog } from './server/calibration-stage-log.js';
import { createConfiguredDepthProvider } from './server/depth-provider.js';
import { createRemoteGazeProvider, validScreenCm } from './server/gaze-provider.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const files = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
for (const file of ['app.js','core.js','gaze/index.js','gaze/webcam.js','gaze/remote-webcam.js','gaze/webeyetrack-worker.js','gaze/webeyetrack-bootstrap.js','gaze/overlay.js','gaze/frozen-demo.js','gaze/uncalibrated.js','gaze/persistence.js','spatial/world.js','spatial/geometry.js','spatial/tracker.js','spatial/scene-diagnostic.js','memory/index.js','memory/session.js','memory/provisional-tracking.js','evaluation/ledger.js','runtime/facade.js','runtime/perception.js','runtime/exploration.js','runtime/server-providers.js','runtime/provider-journal.js','runtime/cache.js','runtime/clock.js','runtime/contracts.js','runtime/next-gaze.js','runtime/scheduler.js']) files.set(`/src/${file}`, [`src/${file}`, 'text/javascript; charset=utf-8']);
// Optional user-provided local assets. Never proxy arbitrary URLs or expose paths.
for (const [name,type] of [['vision_bundle.mjs','text/javascript; charset=utf-8'],['vision_wasm_internal.js','text/javascript; charset=utf-8'],['vision_wasm_internal.wasm','application/wasm'],['vision_wasm_nosimd_internal.js','text/javascript; charset=utf-8'],['vision_wasm_nosimd_internal.wasm','application/wasm'],['face_landmarker.task','application/octet-stream']]) files.set(`/vendor/${name}`,[`vendor/${name}`,type]);
files.set('/vendor/webeyetrack.js',['node_modules/webeyetrack/dist/index.js','text/javascript; charset=utf-8']);
// The official WebEyeTrack demo, served as-is next to the app for side-by-side comparison.
files.set('/webeyetrack-official.html',['webeyetrack-official.html','text/html; charset=utf-8']);
files.set('/src/gaze/official-webeyetrack.js',['src/gaze/official-webeyetrack.js','text/javascript; charset=utf-8']);
files.set('/src/gaze/official-webeyetrack-worker.js',['src/gaze/official-webeyetrack-worker.js','text/javascript; charset=utf-8']);
files.set('/src/gaze/fixation.js',['src/gaze/fixation.js','text/javascript; charset=utf-8']);
files.set('/src/spatial/gaze-target.js',['src/spatial/gaze-target.js','text/javascript; charset=utf-8']);
files.set('/src/gaze/webeyetrack-adaptation.js',['src/gaze/webeyetrack-adaptation.js','text/javascript; charset=utf-8']);
files.set('/src/gaze/local-recorder.js',['src/gaze/local-recorder.js','text/javascript; charset=utf-8']);
files.set('/src/spatial/mask-association.js',['src/spatial/mask-association.js','text/javascript; charset=utf-8']);
files.set('/src/spatial/depth-artifact.js',['src/spatial/depth-artifact.js','text/javascript; charset=utf-8']);
files.set('/node_modules/munkres/dist/munkres.mjs',['node_modules/munkres/dist/munkres.mjs','text/javascript; charset=utf-8']);
for(const name of ['calibration-profile.js','calibration-window.js','display-filter.js','eye-sphere.js','accuracy-protocol.js','accuracy-report.js','accuracy-session.js']) files.set(`/src/gaze/${name}`,[`src/gaze/${name}`,'text/javascript; charset=utf-8']);
for(const name of ['background-attention.js','background-browser.js','live-tracking.js']) files.set(`/src/runtime/${name}`,[`src/runtime/${name}`,'text/javascript; charset=utf-8']);
files.set('/web/model.json',['vendor/webeyetrack-model/model.json','application/json; charset=utf-8']);
files.set('/web/group1-shard1of1.bin',['vendor/webeyetrack-model/group1-shard1of1.bin','application/octet-stream']);
const maxBody = 8 * 1024 * 1024;
const maxGazeFrameBody = 512 * 1024;
const maxGazeTargetBody = 2 * 1024 * 1024 + 64 * 1024;
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
function json(res, status, body) {
  if (!res.destroyed && !res.writableEnded) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(body)); }
}
function logApiStage(logger, route, stage, status = null) {
  try { logger(JSON.stringify({event:'api_stage',route,stage,status})); } catch {}
}
function localRequest(req) {
  if (!loopback(req.socket.remoteAddress) || !loopback(req.socket.localAddress)) return false;
  const host = req.headers.host;
  const port = req.socket.localPort;
  if (!['127.0.0.1', 'localhost', '[::1]'].some(h => host === `${h}:${port}`)) return false;
  if (req.headers.origin && req.headers.origin !== `${req.socket.encrypted ? 'https' : 'http'}://${host}`) return false;
  return !req.headers['sec-fetch-site'] || ['same-origin','none'].includes(req.headers['sec-fetch-site']);
}
function validInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!['frame','imageDataUrl','prompt'].includes(k))) return false;
  const f = value.frame;
  if (!f || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).sort().join(',') !== 'frameId,observedAt' || typeof f.frameId !== 'string' || !f.frameId.trim() || f.frameId.length > 128 || !Number.isFinite(f.observedAt) || f.observedAt < 0) return false;
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 256 || typeof value.imageDataUrl !== 'string') return false;
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.imageDataUrl);
  if (!match || match[2].length % 4 || Buffer.from(match[2], 'base64').toString('base64') !== match[2]) return false;
  const bytes = Buffer.from(match[2], 'base64');
  return match[1] === 'png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
}
// Compact depth evidence from src/runtime/background-browser.js: per-candidate foreground statistics only.
function validDepthEvidence(depth,frame,issuedAtMs,candidates){
  const exactKeys=(value,keys)=>value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
  const metres=value=>Number.isFinite(value) && value>0 && value<=20;
  const ids=new Set(candidates.map(candidate=>candidate.objectId));
  if(!exactKeys(depth,['artifactSha256','modelId','modelSha256','observedAtMs','availableAtMs','units','convention','depthSource','objects','relations','gazeDepthM']) || !/^[0-9a-f]{64}$/.test(depth.artifactSha256) || !/^[0-9a-f]{64}$/.test(depth.modelSha256) || typeof depth.modelId!=='string' || !/^[!-~]{1,128}$/.test(depth.modelId) || depth.observedAtMs!==frame?.observedAt || !Number.isFinite(depth.availableAtMs) || depth.availableAtMs<depth.observedAtMs || depth.availableAtMs>issuedAtMs || depth.units!=='m' || depth.convention!=='axial_z' || depth.depthSource!=='monocular_estimated_depth' || !(depth.gazeDepthM===null || metres(depth.gazeDepthM)) || !Array.isArray(depth.objects) || depth.objects.length>10 || !Array.isArray(depth.relations) || depth.relations.length>45) return false;
  const ok=new Set();
  for(const o of depth.objects){
    const missing=o?.status==='missing';
    if(!exactKeys(o,['objectId','status','validFraction','medianDepthM','q1M','q3M',...(missing?['missingReason']:[])]) || !ids.has(o.objectId) || !Number.isFinite(o.validFraction) || o.validFraction<0 || o.validFraction>1) return false;
    if(missing){ if(o.medianDepthM!==null || o.q1M!==null || o.q3M!==null || typeof o.missingReason!=='string' || !/^[a-z_]{1,64}$/.test(o.missingReason)) return false; }
    else if(o.status!=='ok' || ![o.q1M,o.medianDepthM,o.q3M].every(metres) || o.q1M>o.medianDepthM || o.medianDepthM>o.q3M) return false;
    else ok.add(o.objectId);
  }
  return new Set(depth.objects.map(o=>o.objectId)).size===depth.objects.length && depth.relations.every(r=>exactKeys(r,['nearObjectId','farObjectId']) && ok.has(r.nearObjectId) && ok.has(r.farObjectId) && r.nearObjectId!==r.farObjectId);
}
export function createLocalServer({sam = segmentSam, reasoner = reasonScenarios, samTimeoutMs = 30000, httpsOptions, logger = line => console.info(line),recordingStore=createRecordingStore({root:path.join(root,'data','recordings')}),calibrationStageLog=createCalibrationStageLog({root:path.join(root,'data','diagnostics')}),depthProvider=createConfiguredDepthProvider(),computeProfile=process.env.PROMETHEUS_COMPUTE_PROFILE??'cloud',gazeProvider:configuredGazeProvider,gazeRemoteUrl=process.env.PROMETHEUS_GAZE_REMOTE_URL} = {}) {
  if (!['cloud','local'].includes(computeProfile)) throw new TypeError('PROMETHEUS_COMPUTE_PROFILE must be cloud or local');
  const gazeProvider=configuredGazeProvider??(computeProfile==='cloud'?createRemoteGazeProvider({baseUrl:gazeRemoteUrl}):null);
  const configuredDepthProvider=depthProvider;
  if(computeProfile==='cloud'&&depthProvider.kind==='local_depth_provider')depthProvider={kind:'cloud_depth_unavailable',async infer(){throw Object.assign(new Error('remote depth worker required by cloud profile'),{code:'DEPTH_CLOUD_GPU_REQUIRED'});},async close(){}};
  let inFlight = 0;
  const handler = async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if(pathname==='/api/runtime/config'){
      if(req.method!=='GET'||!localRequest(req)){req.resume();json(res,403,{error:'forbidden'});return;}
      req.resume();
      json(res,200,{computeProfile,gazeBackend:computeProfile==='cloud'?'remote_gpu':'browser_local'});
      return;
    }
    if(pathname==='/api/gaze/health'){
      if(req.method!=='GET'||!localRequest(req)){req.resume();json(res,403,{error:'forbidden'});return;}
      req.resume();
      if(computeProfile==='local'){json(res,200,{ready:true,backend:'browser_local'});return;}
      const health=await gazeProvider.health();
      json(res,200,{ready:health.ready===true,backend:'remote_gpu',...(health.model?{model:health.model}:{})});
      return;
    }
    if(pathname==='/api/gaze/sessions'){
      if(req.method!=='POST'||!localRequest(req)||computeProfile!=='cloud'){req.resume();json(res,403,{error:'forbidden'});return;}
      if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')){req.resume();json(res,415,{error:'unsupported_media_type'});return;}
      try{
        let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>70*1024){req.resume();json(res,413,{error:'too_large'});return;}chunks.push(chunk);}
        const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['screenPxDimensions','screenCmDimensions','adapter'].includes(key))||(input.screenCmDimensions!==undefined&&!validScreenCm(input.screenCmDimensions))||(input.screenPxDimensions!==undefined&&(!Array.isArray(input.screenPxDimensions)||input.screenPxDimensions.length!==2||!input.screenPxDimensions.every(value=>Number.isInteger(value)&&value>0&&value<=10000)))){json(res,400,{error:'invalid_request'});return;}
        json(res,201,await gazeProvider.createSession(input));
      }catch(error){const code=typeof error?.code==='string'&&/^GAZE_[A-Z_]+$/.test(error.code)?error.code:'GAZE_INVALID_REQUEST';const status=code==='GAZE_SESSION_UNAVAILABLE'?404:code==='GAZE_REMOTE_TIMEOUT'?504:code==='GAZE_INVALID_REQUEST'?400:code==='GAZE_ADAPTER_INCOMPATIBLE'?409:503;json(res,status,{error:'gaze_unavailable',code});}
      return;
    }
    const gazeSession=/^\/api\/gaze\/sessions\/([A-Za-z0-9_-]{1,128})(?:\/(candidate\/start|candidate\/accept|candidate\/discard|candidate\/adapt|calibration\/sample|calibration\/target|calibration\/click|frame))?$/.exec(pathname);
    if(gazeSession){
      const [,sessionId,operation]=gazeSession;
      if(!localRequest(req)||computeProfile!=='cloud'){req.resume();json(res,403,{error:'forbidden'});return;}
      const respondError=error=>{const code=typeof error?.code==='string'&&/^GAZE_[A-Z_]+$/.test(error.code)?error.code:'GAZE_REMOTE_UNAVAILABLE';const route=`gaze_${operation??'session'}`;const status=code==='GAZE_PROVIDER_BUSY'?429:code==='GAZE_REMOTE_TIMEOUT'?504:code==='GAZE_SESSION_UNAVAILABLE'?404:code==='GAZE_INVALID_REQUEST'?400:503;const cause=typeof error?.cause==='string'&&/^[A-Za-z0-9_]{3,48}$/.test(error.cause)?`:${error.cause}`:'';logApiStage(logger,route,`failed:${code}${cause}`,status);json(res,status,{error:'gaze_unavailable',code});};
      if(!operation&&req.method==='DELETE'){
        req.resume();try{await gazeProvider.deleteSession(sessionId);json(res,200,{deleted:true});}catch(error){respondError(error);}return;
      }
      if(operation==='frame'&&req.method==='POST'){
        if(req.headers['content-type']!=='image/jpeg'){req.resume();json(res,415,{error:'unsupported_media_type'});return;}
        const frameIdText=req.headers['x-frame-id'],captureText=req.headers['x-capture-timestamp-ms'],frameId=Number(frameIdText),captureTimestampMs=Number(captureText);
        if(typeof frameIdText!=='string'||!/^[1-9]\d*$/.test(frameIdText)||!Number.isSafeInteger(frameId)||typeof captureText!=='string'||!captureText.trim()||!Number.isFinite(captureTimestampMs)||captureTimestampMs<0){req.resume();json(res,400,{error:'invalid_request'});return;}
        const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});
        try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>maxGazeFrameBody){req.resume();json(res,413,{error:'too_large'});return;}chunks.push(chunk);}const result=await gazeProvider.frame({sessionId,frameId,captureTimestampMs,bytes:Buffer.concat(chunks),signal:abort.signal});json(res,200,result);}
        catch(error){respondError(error);}return;
      }
      if(operation==='candidate/adapt'&&req.method==='POST'){
        req.resume();try{json(res,200,await gazeProvider.finalizeCandidate(sessionId));}catch(error){respondError(error);}return;
      }
      if(operation==='calibration/target'&&req.method==='POST'){
        if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')){req.resume();json(res,415,{error:'unsupported_media_type'});return;}
        const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});
        try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>maxGazeTargetBody){req.resume();json(res,413,{error:'too_large'});return;}chunks.push(chunk);}
          let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{json(res,400,{error:'invalid_request'});return;}
          if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='frames,phase,pointIndex,target'){json(res,400,{error:'invalid_request'});return;}
          json(res,200,await gazeProvider.calibrationTarget({sessionId,...input,signal:abort.signal}));}
        catch(error){respondError(error);}return;
      }
      if(operation==='calibration/click'&&req.method==='POST'){
        if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')){req.resume();json(res,415,{error:'unsupported_media_type'});return;}
        const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});
        try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>maxGazeTargetBody){req.resume();json(res,413,{error:'too_large'});return;}chunks.push(chunk);}
          let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{json(res,400,{error:'invalid_request'});return;}
          if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='frames,target'){json(res,400,{error:'invalid_request'});return;}
          json(res,200,await gazeProvider.clickCorrection({sessionId,...input,signal:abort.signal}));}
        catch(error){respondError(error);}return;
      }
      if(['candidate/start','candidate/accept','candidate/discard'].includes(operation)&&req.method==='POST'){
        req.resume();try{if(operation==='candidate/start'){await gazeProvider.startCandidate(sessionId);json(res,200,{status:'ready'});}else if(operation==='candidate/accept'){json(res,200,await gazeProvider.acceptCandidate(sessionId));}else{await gazeProvider.discardCandidate(sessionId);json(res,200,{status:'ready'});}}catch(error){respondError(error);}return;
      }
      if(operation==='calibration/sample'&&req.method==='POST'){
        if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')){req.resume();json(res,415,{error:'unsupported_media_type'});return;}
        try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>2048){req.resume();json(res,413,{error:'too_large'});return;}chunks.push(chunk);}const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='frameId,pointIndex,target'){json(res,400,{error:'invalid_request'});return;}json(res,200,await gazeProvider.addCalibrationSample({...input,sessionId}));}
        catch(error){respondError(error);}return;
      }
      req.resume();json(res,404,{error:'not_found'});return;
    }
    if(pathname==='/api/depth/status'){
      if(req.method!=='GET'||!localRequest(req)){req.resume();json(res,403,{error:'forbidden'});return;}
      req.resume();
      const backend=depthProvider.kind==='remote_depth_provider'?'colab_gpu':depthProvider.kind==='local_depth_provider'?'local_cpu':'unavailable';
      json(res,200,{backend});
      return;
    }
    if(pathname==='/api/depth/estimate'){
      if(req.method!=='POST'||!localRequest(req)){req.resume();json(res,403,{error:'forbidden'});return;}
      if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')){req.resume();json(res,415,{error:'unsupported_media_type'});return;}
      const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});
      try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>maxBody){req.resume();json(res,413,{error:'too_large'});return;}chunks.push(chunk);}
        const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!input||Object.keys(input).sort().join(',')!=='frame,imageDataUrl'){json(res,400,{error:'invalid_request'});return;}
        const result=await depthProvider.infer({...input,signal:abort.signal});json(res,200,result);
      }catch(error){const code=typeof error?.code==='string'&&/^DEPTH_[A-Z_]+$/.test(error.code)?error.code:'DEPTH_INVALID_REQUEST';json(res,code==='DEPTH_PROVIDER_BUSY'?429:503,{error:'depth_unavailable',code});}
      return;
    }
    if(pathname==='/api/diagnostics/calibration-stage'){
      const expectedOrigin=`${req.socket.encrypted?'https':'http'}://${req.headers.host}`;
      if(req.method!=='POST'||req.headers.origin!==expectedOrigin||!localRequest(req)){req.resume();json(res,403,{error:'forbidden'});return;}
      if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')){req.resume();json(res,415,{error:'unsupported_media_type'});return;}
      const length=req.headers['content-length'];
      if(length&&(!/^\d+$/.test(length)||Number(length)>1024)){req.resume();json(res,413,{error:'too_large'});return;}
      try{
        let size=0;const chunks=[];
        for await(const chunk of req){size+=chunk.length;if(size>1024){req.resume();json(res,413,{error:'too_large'});return;}chunks.push(chunk);}
        let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{json(res,400,{error:'invalid_request'});return;}
        if(!await calibrationStageLog.append(input)){json(res,400,{error:'invalid_request'});return;}
        json(res,202,{recorded:true});
      }catch{req.resume();json(res,500,{error:'diagnostic_unavailable'});}
      return;
    }
    if(pathname==='/api/recordings'){
      if(!['GET','DELETE'].includes(req.method)||!localRequest(req)){req.resume();json(res,403,{error:'forbidden'});return;}
      req.resume();
      try{json(res,200,req.method==='GET'?await recordingStore.list():await recordingStore.deleteAll());}catch{json(res,500,{error:'local_recording_store_failed'});}
      return;
    }
    if(pathname.startsWith('/api/recordings/')){
      if(req.method!=='POST'||!localRequest(req)){req.resume();json(res,403,{error:'forbidden'});return;}
      try{
        if(pathname==='/api/recordings/start'){req.resume();json(res,200,await recordingStore.start());return;}
        const match=/^\/api\/recordings\/([a-f0-9-]{36})\/(stop|chunks\/(\d{1,8}))$/.exec(pathname);
        if(!match){req.resume();json(res,404,{error:'not_found'});return;}
        if(match[2]==='stop'){req.resume();json(res,200,await recordingStore.stop(match[1]));return;}
        if(req.headers['content-type']!=='video/webm'){req.resume();json(res,415,{error:'unsupported_media_type'});return;}
        let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>maxBody){req.resume();json(res,413,{error:'too_large'});return;}chunks.push(chunk);}
        json(res,200,await recordingStore.append(match[1],Number(match[3]),Buffer.concat(chunks)));return;
      }catch{req.resume();json(res,409,{error:'local_recording_write_failed'});return;}
    }
    const route = ({'/api/sam/segment':'sam_segment','/api/analyze':'analyze','/api/reason':'reason','/api/reason-provisional':'reason_provisional'})[pathname];
    if (route && req.method === 'POST') {
      let terminal = false;
      const stage = (name, status) => logApiStage(logger, route, name, status);
      const finish = (name, status) => { if (!terminal) { terminal = true; stage(name, status); } };
      const reject = (status, body) => { finish('request_rejected', status); json(res, status, body); };
      stage('request_received');
      if (!localRequest(req)) { reject(403, {error:'forbidden'}); req.resume(); return; }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) { reject(415, {error:'unsupported_media_type'}); req.resume(); return; }
      const length = req.headers['content-length'];
      if (length && (!/^\d+$/.test(length) || Number(length) > maxBody)) { reject(413, {error:'request_too_large'}); req.resume(); return; }
      if (inFlight >= 2) { reject(429, {error:'busy'}); req.resume(); return; }
      inFlight++;
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); finish('request_failed', 504); json(res,504,{error:'timeout'}); req.resume(); }, pathname !== '/api/sam/segment' ? 100000 : samTimeoutMs);
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      try {
        let size = 0, chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > maxBody) { reject(413,{error:'request_too_large'}); req.resume(); return; } chunks.push(chunk); }
        let input; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(400,{error:'invalid_request'}); return; }
        if (pathname === '/api/reason-provisional') {
          const exact=(value,keys)=>value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
          const frame=input?.frame, gaze=input?.gazePoint, boxes=input?.masks, candidates=input?.candidates, hasCandidates=Object.hasOwn(input??{},'candidates'), depth=input?.depth, hasDepth=Object.hasOwn(input??{},'depth'), gazeTarget=input?.gazeTarget, hasGazeTarget=Object.hasOwn(input??{},'gazeTarget');
          // The object nearest the fixation (ranked client-side by box distance); it must be one of the candidates.
          const validGazeTarget=!hasGazeTarget || (hasCandidates && exact(gazeTarget,['objectId','distance','rankedObjectIds']) && candidates.some(candidate=>candidate?.objectId===gazeTarget.objectId) && Number.isFinite(gazeTarget.distance) && gazeTarget.distance>=0 && gazeTarget.distance<=1 && Array.isArray(gazeTarget.rankedObjectIds) && gazeTarget.rankedObjectIds.length>=1 && gazeTarget.rankedObjectIds.length<=3 && gazeTarget.rankedObjectIds[0]===gazeTarget.objectId && new Set(gazeTarget.rankedObjectIds).size===gazeTarget.rankedObjectIds.length && gazeTarget.rankedObjectIds.every(id=>candidates.some(candidate=>candidate?.objectId===id)));
          const validBoxes=Array.isArray(boxes) && boxes.length<=10 && boxes.every(box=>exact(box,['left','top','right','bottom']) && [box.left,box.top,box.right,box.bottom].every(Number.isInteger) && box.left>=0 && box.top>=0 && box.right<=frame?.width && box.bottom<=frame?.height && box.right>box.left && box.bottom>box.top);
          const validCandidates=!hasCandidates || (Array.isArray(candidates) && candidates.length>0 && candidates.length<=10 && candidates.length<=(boxes?.length??0) && new Set(candidates.map(candidate=>candidate?.objectId)).size===candidates.length && candidates.every(candidate=>exact(candidate,['objectId','bounds']) && typeof candidate.objectId==='string' && /^[!-~]{1,128}$/.test(candidate.objectId) && exact(candidate.bounds,['left','top','right','bottom']) && boxes.some(box=>['left','top','right','bottom'].every(key=>candidate.bounds[key]===box[key]))));
          if (!exact(input,['consentScope','timingStatus','frame','imageDataUrl','gazePoint','issuedAtMs','masks',...(hasCandidates?['candidates']:[]),...(hasDepth?['depth']:[]),...(hasGazeTarget?['gazeTarget']:[])]) || !validGazeTarget || (hasDepth && !validDepthEvidence(depth,frame,input.issuedAtMs,hasCandidates?candidates:[])) || input.consentScope!=='provisional_spark' || input.timingStatus!=='provisional' || !exact(frame,['frameId','observedAt','width','height']) || typeof frame.frameId!=='string' || !frame.frameId.trim() || frame.frameId.length>128 || !Number.isFinite(frame.observedAt) || frame.observedAt<0 || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width<1 || frame.height<1 || frame.width*frame.height>1048576 || !exact(gaze,['x','y','sampleAtMs','processedAtMs','timestampKind','estimateStatus']) || !Number.isFinite(gaze.x) || gaze.x<0 || gaze.x>=1 || !Number.isFinite(gaze.y) || gaze.y<0 || gaze.y>=1 || !Number.isFinite(gaze.sampleAtMs) || gaze.sampleAtMs<0 || !Number.isFinite(gaze.processedAtMs) || gaze.processedAtMs<gaze.sampleAtMs || !['browser_capture_estimate','callback_time_not_capture'].includes(gaze.timestampKind) || !['uncalibrated_estimate','validated_calibration_estimate'].includes(gaze.estimateStatus) || (gaze.timestampKind==='callback_time_not_capture'&&gaze.estimateStatus!=='uncalibrated_estimate') || !Number.isFinite(input.issuedAtMs) || input.issuedAtMs<Math.max(frame.observedAt,gaze.processedAtMs) || !validBoxes || !validCandidates || !validInput({frame:{frameId:frame.frameId,observedAt:frame.observedAt},imageDataUrl:input.imageDataUrl,prompt:'provisional scene'})) { reject(400,{error:'invalid_request'}); return; }
          stage('request_validated');
          const observedUntil=Math.max(frame.observedAt,gaze.sampleAtMs);
          const timestampBasis=gaze.timestampKind==='browser_capture_estimate'?'browser_capture_estimate':'callback_time_not_capture';
          const calibrationStatus=gaze.estimateStatus==='uncalibrated_estimate'?'uncalibrated':'validated_calibration';
          const depthEvidence=hasDepth?[{id:`depth-${depth.artifactSha256.slice(0,16)}`,kind:'depth',text:JSON.stringify({source:'Depth Anything V2 Metric monocular estimate on this scene frame; scene-surface axial depth in metres, not binocular fixation depth; IQR is map spread, not confidence',modelId:depth.modelId,objects:depth.objects,relations:depth.relations,gazeDepthM:depth.gazeDepthM}),observedAt:frame.observedAt,processedAt:depth.availableAtMs,causalStatus:'provisional'}]:[];
          const evidence=[{id:frame.frameId,kind:'scene',text:JSON.stringify({timingStatus:'provisional',calibrationStatus,timestampBasis,gazePoint:{x:gaze.x,y:gaze.y,sampleAtMs:gaze.sampleAtMs,processedAtMs:gaze.processedAtMs,timestampKind:gaze.timestampKind,estimateStatus:gaze.estimateStatus},sam:{maskCount:boxes.length,bounds:boxes},...(hasGazeTarget?{gazeTarget:{objectId:gazeTarget.objectId,distanceFractionOfDiagonal:gazeTarget.distance,rankedObjectIds:gazeTarget.rankedObjectIds,note:'object nearest the median gaze of the last 0.8 s; webcam gaze error is about 10% of the screen'}}:{})}),observedAt:frame.observedAt,processedAt:input.issuedAtMs,causalStatus:'provisional'},...depthEvidence];
          stage('reasoner_started');
          const result=await reasoner({timingStatus:'provisional',observedUntil,issuedAt:input.issuedAtMs,evidence,imageDataUrl:input.imageDataUrl,signal:controller.signal,...(hasCandidates?{candidates}: {})});
          if (!Array.isArray(result.scenarios)) throw new Error('invalid provisional reasoner response');
          let nextGaze=null;
          if(hasCandidates) { nextGaze=result.nextGaze??null; try { validateNextGaze(nextGaze,candidates); } catch { throw Object.assign(new Error('invalid provisional next gaze'),{code:'REASONER_JSON_INVALID'}); } }
          stage('reasoner_completed');
          if (!controller.signal.aborted) { finish('request_completed', 200); json(res,200,{timingStatus:'provisional',frame:{frameId:frame.frameId,observedAt:frame.observedAt},scenarios:result.scenarios,...(hasCandidates?{nextGaze}:{}),reasoner:{provider:result.provider,model:result.model,requestId:result.requestId,latencyMs:result.latencyMs,usage:result.usage,estimatedCostUsd:result.estimatedCostUsd}}); }
          return;
        }
        if (pathname === '/api/analyze' || pathname === '/api/reason') {
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== (pathname === '/api/analyze' ? 'input,prompt' : 'input') || !input.input?.frame) { reject(400,{error:'invalid_request'}); return; }
          let safe;
          try {
            const source = input.input;
            const times = [source.frame.processedAt, source.gaze?.processedAt, ...(source.events || []).map(e=>e.processedAt), ...(source.context?.memory || []).map(m=>m.processedAt)];
            const issuedAt = Math.max(...times);
            safe = project(source, issuedAt);
            if (safe.frame.causalStatus !== 'online_causal' || !['synthetic','sensor'].includes(safe.frame.provenanceKind) || !validInput({frame:{frameId:safe.frame.frameId,observedAt:safe.frame.observedAt},imageDataUrl:safe.frame.imageData,prompt:pathname === '/api/analyze' ? input.prompt : 'scene'})) throw new Error();
            const evidenceItems = [...safe.events.filter(e=>safe.dependencies.evidenceIds.includes(e.eventId)).map(e=>e.eventId),...safe.context.memory.filter(m=>safe.dependencies.evidenceIds.includes(m.evidenceId)).map(m=>m.evidenceId),...(safe.dependencies.evidenceIds.includes(safe.frame.frameId)?[safe.frame.frameId]:[])];
            if (evidenceItems.length > 100 || new Set(evidenceItems).size !== evidenceItems.length || evidenceItems.some(id=>id.length>128) || (safe.frame.sceneText?.length ?? 0)>800 || safe.context.memory.some(m=>!m.text.trim() || m.text.length>2000)) throw new Error();
          } catch { reject(400,{error:'invalid_request'}); return; }
          stage('request_validated');
          let segmented = null;
          if (pathname === '/api/analyze') { stage('sam_started'); segmented = await sam({imageDataUrl:safe.frame.imageData,prompt:input.prompt,signal:controller.signal}); stage('sam_completed'); }
          if (controller.signal.aborted) return;
          const allowed = new Set(safe.dependencies.evidenceIds), evidence = [];
          const issuedAt = Math.max(safe.frame.processedAt,safe.gaze.processedAt,...safe.events.map(e=>e.processedAt),...safe.context.memory.map(m=>m.processedAt));
          if (allowed.has(safe.frame.frameId)) {
            const boxes = segmented?.masks.slice(0,10).map(m=>m.bounds) ?? null;
            evidence.push({id:safe.frame.frameId,kind:'scene',text:JSON.stringify({sceneText:safe.frame.sceneText ?? null,gaze:{x:safe.gaze.x,y:safe.gaze.y},segmentationBounds:boxes,segmentationCount:segmented?.masks.length ?? null,provenanceKind:safe.frame.provenanceKind}),observedAt:safe.frame.observedAt,processedAt:issuedAt,causalStatus:'online_causal'});
          }
          for (const e of safe.events) if (allowed.has(e.eventId)) evidence.push({id:e.eventId,kind:'gaze',text:JSON.stringify({type:e.type??null,endAt:e.endAt??null,dwellValidMs:e.dwellValidMs??null,x:e.x??null,y:e.y??null,candidateObjectIds:e.candidateObjectIds??[]}),observedAt:e.observedAt,processedAt:e.processedAt,causalStatus:'online_causal'});
          for (const m of safe.context.memory) if (allowed.has(m.evidenceId)) evidence.push({id:m.evidenceId,kind:'memory',text:m.text,observedAt:m.observedAt,processedAt:m.processedAt,causalStatus:'online_causal'});
          stage('reasoner_started');
          const result = await reasoner({observedUntil:safe.observedUntil,issuedAt,evidence,imageDataUrl:safe.frame.imageData,signal:controller.signal,...(safe.candidates?.length ? {candidates:safe.candidates} : {})});
          const nextGaze=result.nextGaze ?? null; validateNextGaze(nextGaze,safe.candidates ?? []); if (!safe.candidates?.length && nextGaze!==null) throw new Error('no candidate space');
          stage('reasoner_completed');
          if (!controller.signal.aborted) { finish('request_completed', 200); json(res,200,{nextGaze,frame:{frameId:safe.frame.frameId,observedAt:safe.frame.observedAt},scenarios:result.scenarios,...(segmented ? {sam:{provider:segmented.provider,model:segmented.model,requestId:segmented.requestId,latencyMs:segmented.latencyMs,parserVersion:segmented.parserVersion,maskCount:segmented.masks.length,bounds:segmented.masks.map(m=>m.bounds)}} : {}),reasoner:{provider:result.provider,model:result.model,requestId:result.requestId,latencyMs:result.latencyMs,usage:result.usage,estimatedCostUsd:result.estimatedCostUsd}}); }
          return;
        }
        if (!validInput(input)) { reject(400,{error:'invalid_request'}); return; }
        stage('request_validated');
        stage('sam_started');
        const result = await sam({imageDataUrl:input.imageDataUrl,prompt:input.prompt,signal:controller.signal});
        if (controller.signal.aborted) { json(res,504,{error:'timeout'}); return; }
        stage('sam_completed');
        finish('request_completed', 200);
        json(res,200,{frame:input.frame,masks:result.masks,provider:result.provider,model:result.model,requestId:result.requestId,latencyMs:result.latencyMs,parserVersion:result.parserVersion});
      } catch (error) {
        const code = error?.code;
        const status = ['PROVIDER_RATE_LIMITED','PROVIDER_BUSY','PROVIDER_MIN_INTERVAL','PROVIDER_BUDGET_EXCEEDED','PROVIDER_CIRCUIT_OPEN'].includes(code) ? 429 : ['SAM_NOT_CONFIGURED','REASONER_NOT_CONFIGURED'].includes(code) ? 503 : ['SAM_TIMEOUT','REASONER_TIMEOUT'].includes(code) || controller.signal.aborted ? 504 : 502;
        const body={error:status === 429 ? 'provider_limited' : status === 503 ? 'provider_unavailable' : status === 504 ? 'timeout' : 'provider_failed'};
        if (['REASONER_INCOMPLETE','REASONER_WRONG_MODEL','REASONER_LANE_INVALID','REASONER_JSON_INVALID','REASONER_GROUNDING_INVALID','REASONER_INVALID_RESPONSE','REASONER_TIMEOUT','REASONER_ACCESS_DENIED','REASONER_NOT_CONFIGURED','SAM_INVALID_RESPONSE','SAM_TIMEOUT','SAM_NOT_CONFIGURED'].includes(code)) body.providerCode=code;
        if (pathname==='/api/reason-provisional' && ['PROVIDER_RATE_LIMITED','PROVIDER_BUSY','PROVIDER_MIN_INTERVAL','PROVIDER_BUDGET_EXCEEDED','PROVIDER_CIRCUIT_OPEN','PROVIDER_NETWORK_ERROR'].includes(code)) body.providerCode=code;
        const d=error?.diagnostic;
        if (body.providerCode?.startsWith('REASONER_') && d && ['completed','incomplete','failed','in_progress','cancelled','unknown'].includes(d.responseStatus) && (d.incompleteReason===null || ['max_output_tokens','content_filter','other'].includes(d.incompleteReason)) && Array.isArray(d.outputTypes) && d.outputTypes.length<=10 && d.outputTypes.every(x=>['message','reasoning','other'].includes(x)) && (d.textLength===null || Number.isInteger(d.textLength) && d.textLength>=0 && d.textLength<=262144)) body.diagnostic={responseStatus:d.responseStatus,incompleteReason:d.incompleteReason,outputTypes:d.outputTypes,textLength:d.textLength};
        if (['PROVIDER_HTTP_ERROR','PROVIDER_RATE_LIMITED'].includes(code) && Number.isInteger(error.status) && error.status>=400 && error.status<=599) body.upstreamStatus=error.status;
        finish('request_failed', status);
        json(res,status,body);
      } finally { clearTimeout(timer); inFlight--; }
      return;
    }
    const entry = files.get(pathname);
    if (req.method !== 'GET' || !entry) { res.writeHead(404); res.end('Not found'); return; }
    try { const data = await readFile(path.join(root, entry[0])); res.writeHead(200, {'Content-Type': entry[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}); res.end(data); }
    catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end('Unavailable'); }
  };
  const server=httpsOptions ? https.createServer(httpsOptions, handler) : http.createServer(handler);
  server.on('close',()=>{void depthProvider.close?.();if(configuredDepthProvider!==depthProvider)void configuredDepthProvider.close?.();void gazeProvider?.close?.();});
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const certPath = process.env.PROMETHEUS_HTTPS_CERT;
  const keyPath = process.env.PROMETHEUS_HTTPS_KEY;
  if (Boolean(certPath) !== Boolean(keyPath)) throw new Error('Set both PROMETHEUS_HTTPS_CERT and PROMETHEUS_HTTPS_KEY to enable HTTPS.');
  const httpsOptions = certPath ? {cert: await readFile(certPath), key: await readFile(keyPath)} : undefined;
  const server = createLocalServer({httpsOptions});
  const url = httpsOptions ? 'https://127.0.0.1:4173' : 'http://127.0.0.1:4173';
  server.listen(4173, '127.0.0.1', () => console.log(`Prometheus: ${url}`));
}




