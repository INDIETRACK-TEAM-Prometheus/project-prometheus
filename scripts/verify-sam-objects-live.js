import { open } from 'node:fs/promises';
import { segmentSam } from '../server/sam-adapter.js';
import { makeScene, iou, projectMask, width, height } from './sam-scene.js';
const path='docs/evidence/sam-objects-exploration-live-v2.json';
const file=await open(path,'wx');
const scene=makeScene();
const blue=Uint8Array.from({length:width*height},(_,i)=>Number((i%width-186)**2+(Math.floor(i/width)-90)**2<36**2));
const evidence={scenario:'One synthetic scene; red square, blue circle, green rectangle',prompt:'objects',input:{width,height,sha256:scene.sha256},estimatedCostUsd:0.0025,costBasis:'local provider policy reservation; not actual billing',status:'started',startedAtUtc:new Date().toISOString()};
const save=async()=>{await file.truncate(0);await file.writeFile(JSON.stringify(evidence,null,2)+'\n',{encoding:'utf8'});};
await save();
const start=performance.now();
try {
 const result=await segmentSam({imageDataUrl:`data:image/png;base64,${scene.png.toString('base64')}`,prompt:'objects'});
 const masks=[]; for(const mask of result.masks){try{masks.push(projectMask(mask,width,height));}catch{}}
 const best=truth=>masks.length?Math.max(...masks.map(mask=>iou(mask,truth))):null;
 Object.assign(evidence,{status:'completed',maskCount:result.masks.length,validMaskCount:masks.length,redBestIoU:best(scene.truth),blueBestIoU:best(blue),providerLatencyMs:result.latencyMs,model:result.model});
} catch(error) { evidence.status='failed'; evidence.errorCode=['SAM_NOT_CONFIGURED','PROVIDER_NETWORK_ERROR','PROVIDER_RATE_LIMITED','SAM_UPSTREAM_ERROR','SAM_INVALID_RESPONSE','SAM_TIMEOUT'].includes(error?.code)?error.code:'OTHER_FAILURE'; }
evidence.elapsedMs=Math.round(performance.now()-start); evidence.finishedAtUtc=new Date().toISOString();
await file.truncate(0); await file.write(JSON.stringify(evidence,null,2)+'\n',0,'utf8'); await file.close();
console.log(JSON.stringify(evidence));
if(evidence.status!=='completed')process.exitCode=1;

