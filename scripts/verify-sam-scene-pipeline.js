import {open} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {createLocalServer} from '../server.js';
import {makeScene, iou, projectMask, width, height, square} from './sam-scene.js';
import {PerceptionPipeline} from '../src/runtime/perception.js';
import {MemoryService, EphemeralStorage} from '../src/memory/index.js';

const mock=process.argv.includes('--mock');
const scene=makeScene();
// makeScene emits one IDAT chunk with unfiltered RGB rows.
const idat=scene.png.indexOf(Buffer.from('IDAT'));
const rows=inflateSync(scene.png.subarray(idat+4,idat+4+scene.png.readUInt32BE(idat-4)));
const rgba=new Uint8Array(width*height*4);
for(let y=0;y<height;y++) for(let x=0;x<width;x++) {const s=y*(width*3+1)+1+x*3,d=(y*width+x)*4; rgba.set(rows.subarray(s,s+3),d);rgba[d+3]=255;}
const target='docs/evidence/sam-scene-pipeline-live.json';
let file, server, memory, pipeline, requestCount=0, runtimeCalls=0, resultBody=null, httpStatus=null;
const report={schemaVersion:1,scenario:'synthetic red square scene exploration',input:{sha256:scene.sha256,width,height,groundTruth:square},criteria:{minimumBestMaskIoU:0.8,minimumMaskCount:1,model:'sam-3.1'},status:'failed'};
try {
  if(!mock) file=await open(target,'wx');
  const mockMask={sourceWidth:width,sourceHeight:height,width:square.width,height:square.height,bounds:{left:square.x,top:square.y,right:square.x+square.width,bottom:square.y+square.height},raster:Array(square.width*square.height).fill(1)};
  server=mock?createLocalServer({sam:async()=>({model:'sam-3.1',provider:'Meta',masks:[mockMask]})}):createLocalServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const now=()=>performance.now(), observedAt=now();
  memory=await MemoryService.open({sessionId:'scene-probe',storage:new EphemeralStorage(),clock:now});
  pipeline=new PerceptionPipeline({segmentKind:'server_provider',identityNamespace:'scene-probe',memory,now,timeoutMs:35000,runtime:{submit:()=>{runtimeCalls++;return {accepted:true};}},segment:async(frame,{signal})=>{
    if(++requestCount!==1) throw new Error('request limit');
    if(mock) {httpStatus=200;resultBody={frame:{frameId:frame.frameId,observedAt:frame.observedAt},model:'sam-3.1',masks:[mockMask]};return resultBody;}
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/sam/segment`,{method:'POST',headers:{'content-type':'application/json'},signal,body:JSON.stringify({frame:{frameId:frame.frameId,observedAt:frame.observedAt},imageDataUrl:frame.imageData,prompt:'red square'})});
    httpStatus=response.status;if(!response.ok) throw new Error('segmentation unavailable');
    resultBody=await response.json();return resultBody;
  }});
  pipeline.start('scene-probe');
  const accepted=pipeline.submit({frame:{frameId:'synthetic-red-square',observedAt,processedAt:observedAt,causalStatus:'online_causal',provenanceKind:'synthetic',mapId:'synthetic-map',mapVersion:1,coordinateFrameId:'synthetic-world-frame',width,height,rgba,imageData:`data:image/png;base64,${scene.png.toString('base64')}`,depth:null,syncUncertaintyMs:0},gaze:null,event:null});
  await pipeline.current;
  const masks=resultBody?.masks ?? []; const scores=masks.map(m=>iou(projectMask(m,width,height),scene.truth));
  const observations=[...memory.memory.observations.values()];
  const retrieved=await Promise.all(observations.map(o=>memory.retrieve({objectId:o.objectId,observedUntil:now()})));
  const memoryRows=retrieved.map(x=>x.lastSeen).filter(Boolean);
  const bestIoU=scores.length?Math.max(...scores):null;
  const noGaze=memoryRows.every(o=>o.gazeHitPointWorld==null && o.gazeHitProvenance==null);
  report.result={accepted:accepted.accepted,httpStatus,requestCount,model:resultBody?.model==='sam-3.1'?'sam-3.1':null,maskCount:masks.length,bestIoU,pipeline:pipeline.status(),observationCount:observations.length,retrievedObservationCount:memoryRows.length,eventCount:memory.memory.events.size,runtimeCalls,noGaze};
  report.status=accepted.accepted && requestCount===1 && httpStatus===200 && resultBody?.model==='sam-3.1' && bestIoU>=0.8 && pipeline.status().commits===1 && observations.length>0 && memoryRows.length===observations.length && noGaze && memory.memory.events.size===0 && runtimeCalls===0?'passed':'failed';
} catch {report.result={error:'probe_failed',requestCount,httpStatus};}
finally {
  if(pipeline) await pipeline.stop(); if(memory) await memory.close(); if(server?.listening) await new Promise(resolve=>server.close(resolve));
  if(file){await file.writeFile(JSON.stringify(report,null,2)+'\n');await file.close();}
}
console.log(`Scene pipeline ${mock?'mock':'live'} probe: ${report.status}${mock?'':`; evidence: ${target}`}`);
if(report.status!=='passed') process.exitCode=1;




