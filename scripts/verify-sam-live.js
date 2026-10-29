import { writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createLocalServer } from '../server.js';
import { makeScene, iou, projectMask, width, height, square } from './sam-scene.js';

const scene=makeScene();
const numberOrNull=value=>Number.isFinite(value)?value:null;
const evidence={
  schemaVersion:1, scenario:'synthetic red square', provider:'Meta', providerModel:'sam-3.1',
  endpoint:'https://api.meta.ai/v1/responses', prompt:'red square',
  input:{width,height,sha256:scene.sha256,groundTruth:square},
  // Frozen before the request. This single synthetic test is not product acceptance.
  criteria:{minimumBestMaskIoU:0.8,requiredMaskDimensions:[width,height],minimumMaskCount:1,requiredReturnedModel:'sam-3.1',projection:'half-open source bounds, nearest pixel-center scaling to full source raster'},
  status:'not_run', result:null
};
await mkdir('docs/evidence',{recursive:true}); await mkdir('fixtures',{recursive:true});
await writeFile('fixtures/sam-synthetic.png',scene.png);
const save=()=>writeFile('docs/evidence/sam-live.json',JSON.stringify(evidence,null,2)+'\n');
await save();
const server=createLocalServer();
try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  evidence.startedAtUtc=new Date().toISOString(); await save();
  const start=performance.now();
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/sam/segment`,{
    method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(120000),
    body:JSON.stringify({frame:{frameId:'synthetic-red-square',observedAt:0},imageDataUrl:`data:image/png;base64,${scene.png.toString('base64')}`,prompt:evidence.prompt})
  });
  const latencyMs=Math.round(performance.now()-start);
  const body=await response.json();
  if (!response.ok) {
    evidence.status='failed'; evidence.result={httpStatus:response.status,latencyMs,errorCode:typeof body?.error==='string' && /^[a-z0-9_]{1,64}$/.test(body.error)?body.error:'request_failed'};
  } else {
    const masks=Array.isArray(body.masks)?body.masks:[];
    const valid=[];
    for (const m of masks) { try { valid.push({mask:m, projected:projectMask(m,width,height)}); } catch {} }
    const scores=valid.map(({projected})=>iou(projected,scene.truth));
    const bestIoU=scores.length?Math.max(...scores):null;
    const provenance=body;
    const returnedModel=provenance.model==='sam-3.1'?'sam-3.1':null;
    evidence.status=valid.length>=1 && bestIoU>=evidence.criteria.minimumBestMaskIoU && returnedModel===evidence.criteria.requiredReturnedModel?'passed':'failed';
    evidence.result={httpStatus:response.status,latencyMs,maskCount:masks.length,validMaskCount:valid.length,bestIoU,
      provenance:{model:returnedModel,provider:provenance.provider==='Meta'?'Meta':null,requestId:typeof provenance.requestId==='string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(provenance.requestId)?provenance.requestId:null,parserVersion:typeof provenance.parserVersion==='string' && /^[a-zA-Z0-9_.-]{1,40}$/.test(provenance.parserVersion)?provenance.parserVersion:null,providerLatencyMs:numberOrNull(provenance.latencyMs)},
      responseSample:{encoding:'base64 byte per pixel, row-major, 0 or 1',masks:valid.map(({mask:m})=>({sourceWidth:m.sourceWidth,sourceHeight:m.sourceHeight,width:m.width,height:m.height,bounds:Object.fromEntries(['left','top','right','bottom'].map(k=>[k,numberOrNull(m?.bounds?.[k])])),confidence:numberOrNull(m?.confidence),rasterBase64:Buffer.from(m.raster).toString('base64')}))}};
  }
} catch {
  evidence.status='failed'; evidence.result={errorCode:'local_or_network_failure'};
} finally {
  evidence.finishedAtUtc=new Date().toISOString(); await save(); if(server.listening) await new Promise(resolve=>server.close(resolve));
}
console.log(`SAM live probe: ${evidence.status}; see docs/evidence/sam-live.json`);
if(evidence.status!=='passed') process.exitCode=1;





