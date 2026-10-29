import {open,mkdir} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {makeScene} from './sam-scene.js';
import {segmentSam} from '../server/sam-adapter.js';
import {reasonScenarios} from '../server/reasoner-adapter.js';

// Explicitly invoked only: two provider generations followed by two status-only reads.
const report={schemaVersion:1,scenario:'synthetic image; explicit store:false requests',criteria:{models:['sam-3.1','muse-spark-1.3'],retrieval:'Record only HTTP status, no retrieval bodies; 404 is not proof of zero retention'},status:'not_run',samples:[]};
await mkdir('docs/evidence',{recursive:true});let file;try{file=await open('docs/evidence/store-false-live.json','wx');}catch{console.error('Evidence file exists or cannot be created; no request made.');process.exitCode=1;}
if(file){
 const save=async()=>{const data=Buffer.from(JSON.stringify(report,null,2)+'\n');await file.truncate(0);await file.write(data,0,data.length,0);};await save();
 const safeCode=error=>['SAM_NOT_CONFIGURED','SAM_TIMEOUT','SAM_INVALID_RESPONSE','SAM_UPSTREAM_ERROR','REASONER_NOT_CONFIGURED','REASONER_TIMEOUT','REASONER_INVALID_RESPONSE','REASONER_INCOMPLETE','REASONER_WRONG_MODEL','REASONER_LANE_INVALID','REASONER_JSON_INVALID','REASONER_GROUNDING_INVALID','PROVIDER_RATE_LIMITED','PROVIDER_HTTP_ERROR','PROVIDER_NETWORK_ERROR','PROVIDER_BUSY','PROVIDER_MIN_INTERVAL','PROVIDER_BUDGET_EXCEEDED','PROVIDER_CIRCUIT_OPEN'].includes(error?.code)?error.code:'request_failed';
 async function statusOnly(id){if(typeof id!=='string'||!/^resp_[A-Za-z0-9_-]{1,128}$/.test(id))return null;try{const response=await fetch(`https://api.meta.ai/v1/responses/${id}`,{method:'GET',redirect:'error',headers:{authorization:`Bearer ${process.env.META_API_KEY}`},signal:AbortSignal.timeout(15000)});await response.body?.cancel();return response.status;}catch{return null;}}
 try{
  if(!process.env.META_API_KEY)throw Object.assign(Error('not configured'),{code:'SAM_NOT_CONFIGURED'});
  const scene=makeScene(),imageDataUrl=`data:image/png;base64,${scene.png.toString('base64')}`;
  const sam=await segmentSam({imageDataUrl,prompt:'red square'});report.samples.push({model:sam.model,providerLatencyMs:sam.latencyMs,retrievalHttpStatus:await statusOnly(sam.requestId)});await save();
  await new Promise(resolve=>setTimeout(resolve,300));
  const reasoner=await reasonScenarios({observedUntil:1,issuedAt:1,evidence:[{id:'synthetic-frame',kind:'scene',text:'Synthetic scene image.',observedAt:1,processedAt:1,causalStatus:'online_causal'}],imageDataUrl});report.samples.push({model:reasoner.model,providerLatencyMs:reasoner.latencyMs,retrievalHttpStatus:await statusOnly(reasoner.requestId)});report.status='observed';
 }catch(error){report.status='failed';report.error=safeCode(error);}
 finally{report.finishedAtUtc=new Date().toISOString();await save();await file.close();}
 console.log(`Store-false probe: ${report.status}; see docs/evidence/store-false-live.json`);if(report.status!=='observed')process.exitCode=1;
}
