import {open,mkdir} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {makeScene,iou,projectMask,width,height} from './sam-scene.js';
import {createLocalServer} from '../server.js';
import {MemoryService,EphemeralStorage} from '../src/memory/index.js';
import {ProviderJournal} from '../src/runtime/provider-journal.js';
import {RuntimeFacade} from '../src/runtime/facade.js';
import {createServerReasoner} from '../src/runtime/server-providers.js';
import {PerceptionPipeline} from '../src/runtime/perception.js';

// All sensor timing and geometry below are synthetic, not browser or camera measurements.
const scene=makeScene(),start=performance.now(),now=()=>1000+performance.now()-start;
function rgbaFromPng(png){let pos=8,parts=[];while(pos<png.length){const n=png.readUInt32BE(pos),name=png.toString('ascii',pos+4,pos+8);if(name==='IDAT')parts.push(png.subarray(pos+8,pos+8+n));pos+=12+n;}const raw=inflateSync(Buffer.concat(parts)),rgba=new Uint8Array(width*height*4);for(let y=0;y<height;y++){if(raw[y*(width*3+1)]!==0)throw Error('unsupported PNG filter');for(let x=0;x<width;x++){const i=y*(width*3+1)+1+x*3,j=(y*width+x)*4;rgba[j]=raw[i];rgba[j+1]=raw[i+1];rgba[j+2]=raw[i+2];rgba[j+3]=255;}}return rgba;}
const observedAt=1000,processedAt=1000,frameId='synthetic-perception-frame';
const frame={frameId,observedAt,processedAt,causalStatus:'online_causal',provenanceKind:'synthetic',mapId:'synthetic-map',mapVersion:1,coordinateFrameId:'synthetic-world',width,height,rgba:rgbaFromPng(scene.png),imageData:`data:image/png;base64,${scene.png.toString('base64')}`,syncUncertaintyMs:0,depth:{frameId,observedAt,processedAt,causalStatus:'online_causal',width,height,values:Array(width*height).fill(2),intrinsics:{fx:200,fy:200,cx:128,cy:128},cameraToWorld:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],units:'m',convention:'axial_z',depthSource:'engine_geometry',provenance:'synthetic-constant-depth'}};
const gaze={frameId,observedAt,processedAt,causalStatus:'online_causal',x:72/256,y:88/256,syncUncertaintyMs:0};
const event={eventId:'synthetic-event',type:'fixated',causalStatus:'online_causal',observedAt:800,endAt:1000,processedAt,dwellValidMs:200,x:gaze.x,y:gaze.y};
const hash=createHash('sha256').update(JSON.stringify({frame:{...frame,rgba:Array.from(frame.rgba)},gaze,event})).digest('hex');
const evidence={schemaVersion:1,scenario:'synthetic PNG with synthetic gaze, depth and pose',inputHashSha256:hash,criteria:{samModel:'sam-3.1',reasonerModel:'muse-spark-1.3',minimumBestMaskIoU:0.8,requiresStoredObservationAndReferencedMemory:true,maxGroundedScenarios:5,deliveryState:'silent_ready',submitAfterStop:'stopped',stopNoStalePublication:'in-flight case separately tested, not verified by this successful real call'},status:'not_run',result:null};
await mkdir('docs/evidence',{recursive:true});let file;try{file=await open('docs/evidence/perception-live.json','wx');}catch{console.error('Evidence file already exists or cannot be created; no request made.');process.exitCode=1;}
if(file){
 const save=async()=>{const data=Buffer.from(JSON.stringify(evidence,null,2)+'\n');await file.truncate(0);await file.write(data,0,data.length,0);};await save();
 const server=createLocalServer();let memory,runtime,pipeline,segmentResult,reasonMetadata,reasonError,published=[];
 try{
  if(!process.env.META_API_KEY)throw Error('not_configured');
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const base=`http://127.0.0.1:${server.address().port}`;
  const fetchReason=async(url,options)=>{const response=await fetch(base+url,options);const body=await response.clone().json();if(response.ok)reasonMetadata=body.reasoner;else reasonError={status:response.status,error:body.error,providerCode:body.providerCode??null,upstreamStatus:body.upstreamStatus??null};return response;};
  const journal=await ProviderJournal.open({storage:new EphemeralStorage(),sessionId:'synthetic-perception'});
  const analyzer=createServerReasoner({remoteConsent:true,sessionId:'synthetic-perception',journal,fetchImpl:fetchReason});
  memory=await MemoryService.open({sessionId:'synthetic-perception',clock:now});
  runtime=new RuntimeFacade({sessionId:'synthetic-perception',analyzer,now,timeoutMs:60000,minIntervalMs:0,publish:value=>published.push(value)});runtime.start();
  pipeline=new PerceptionPipeline({memory,runtime,now,segmentKind:'server_provider',ttlMs:60000,timeoutMs:30000,alignmentBudgetMs:50,segment:async(f,{signal})=>{const response=await fetch(base+'/api/sam/segment',{method:'POST',headers:{'content-type':'application/json'},signal,body:JSON.stringify({frame:{frameId:f.frameId,observedAt:f.observedAt},imageDataUrl:f.imageData,prompt:'red square'})});const body=await response.json();if(!response.ok){segmentResult={status:response.status,error:body.error,providerCode:body.providerCode??null,upstreamStatus:body.upstreamStatus??null};throw Error('segmentation_failed');}segmentResult=body;return body;}});
  pipeline.start('synthetic-perception');const accepted=pipeline.submit({frame,gaze,event});if(!accepted.accepted)throw Error('alignment_or_input_unavailable');await pipeline.current;
  while(runtime.scheduler.running)await new Promise(resolve=>setTimeout(resolve,25));
  const tracked=pipeline.tracker.observations;const results=[];for(const mask of segmentResult?.masks??[]){try{results.push(iou(projectMask(mask,width,height),scene.truth));}catch{results.push(null);}}const best=results.length?Math.max(...results.filter(Number.isFinite)):null;
  const retrieved=[];for(const objectId of published[0]?.objectIds??[]){const item=(await memory.retrieve({objectId,observedUntil:now()})).lastSeen;if(item)retrieved.push(item.observationId);}
  const result=published[0]??null,refs=result?.evidenceIds??[],memoryRef=retrieved.some(id=>refs.includes(id));
  const scenarioCount=result?.scenarios?.length??null;const passed=segmentResult?.model==='sam-3.1'&&reasonMetadata?.model==='muse-spark-1.3'&&Number.isFinite(best)&&best>=.8&&tracked.length>0&&memoryRef&&published.length===1&&result.deliveryState==='silent_ready'&&Number.isInteger(scenarioCount)&&scenarioCount<=5;
  evidence.status=passed?'passed':'failed';evidence.result={sam:{model:segmentResult?.model??null,requestId:segmentResult?.requestId??null,providerLatencyMs:segmentResult?.latencyMs??null,maskCount:segmentResult?.masks?.length??0,bestIoU:Number.isFinite(best)?best:null,error:segmentResult?.error??null},reasoner:reasonMetadata??null,reasonerError:reasonError??null,observationCount:tracked.length,retrievedObservationIds:retrieved,memoryReferencePresent:memoryRef,scenarioCount,outcome:scenarioCount===0?'abstained':scenarioCount>0?'scenarios':'no_result',deliveryState:result?.deliveryState??null,runtimeError:runtime.status().lastError,perceptionError:pipeline.status().lastError,elapsedMs:Math.round(performance.now()-start)};
  await pipeline.stop();runtime.stop();evidence.result.submitAfterStop=runtime.submit({}).reason;evidence.result.inFlightStopTest='not_evaluated';if(evidence.result.submitAfterStop!=='stopped')evidence.status='failed';
 }catch(error){evidence.status='failed';evidence.result={error:['not_configured','alignment_or_input_unavailable'].includes(error?.message)?error.message:'local_or_provider_failure',reasonerError:reasonError??null};}
 finally{if(pipeline)await pipeline.stop();if(runtime?.started)runtime.stop();if(memory)await memory.close();if(server.listening)await new Promise(resolve=>server.close(resolve));evidence.finishedAtUtc=new Date().toISOString();await save();await file.close();}
 console.log(`Synthetic perception probe: ${evidence.status}; see docs/evidence/perception-live.json`);if(evidence.status!=='passed')process.exitCode=1;
}
