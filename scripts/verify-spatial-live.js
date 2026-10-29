import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {segmentSam} from '../server/sam-adapter.js';
import {ObjectTracker} from '../src/spatial/tracker.js';
import {iou,projectMask} from './sam-scene.js';
const width=256,height=256;
function crc(data){let n=0xffffffff;for(const b of data){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^(0xedb88320&-(n&1));}return(n^0xffffffff)>>>0;}
function chunk(name,data){const type=Buffer.from(name),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);type.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([type,data])),data.length+8);return out;}
function scene(x){const raw=Buffer.alloc((width*3+1)*height),rgba=new Uint8Array(width*height*4),truth=new Uint8Array(width*height);for(let y=0;y<height;y++)for(let col=0;col<width;col++){const red=x!==null&&col>=x&&col<x+80&&y>=48&&y<128;const color=red?[230,35,35]:[245,245,245];truth[y*width+col]=Number(red);const j=y*(width*3+1)+1+col*3;raw.set(color,j);rgba.set([...color,255],(y*width+col)*4);}const h=Buffer.alloc(13);h.writeUInt32BE(width);h.writeUInt32BE(height,4);h[8]=8;h[9]=2;const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);return {png,rgba,truth,sha256:createHash('sha256').update(png).digest('hex')};}
const samples=[{name:'initial',x:32},{name:'moving',x:48},{name:'occluded',x:null},{name:'reappearance',x:64}];
const evidence={schemaVersion:1,scenario:'synthetic moving red square, fully occluded then reappearing',criteria:{minimumBestMaskIoU:0.8,negativeMaxMasks:0,requiredModel:'sam-3.1',identity:'same persistent object id for all visible frames',frozenBeforeCalls:true},status:'not_run',frames:[]};
await mkdir('docs/evidence',{recursive:true});const save=()=>writeFile('docs/evidence/spatial-live.json',JSON.stringify(evidence,null,2)+'\n');await save();
const tracker=new ObjectTracker({maxGapMs:1000});let firstId=null,success=true;
try {
 for(let index=0;index<samples.length;index++){
  const sample=samples[index],image=scene(sample.x),id=`synthetic-${sample.name}`,time=index*100;let result;
  try {result=await segmentSam({imageDataUrl:`data:image/png;base64,${image.png.toString('base64')}`,prompt:'red square'});}
  catch(error){evidence.frames.push({name:sample.name,sha256:image.sha256,status:'failed',error:['SAM_NOT_CONFIGURED','SAM_TIMEOUT','SAM_UPSTREAM_ERROR','SAM_INVALID_RESPONSE'].includes(error?.code)?error.code:'request_failed'});success=false;break;}
  const valid=[];for(const mask of result.masks){try{const pixels=projectMask(mask,width,height);valid.push({mask,score:sample.x===null?null:iou(pixels,image.truth)});}catch{}}
  const observations=tracker.update({frameId:id,observedAt:time,processedAt:time+1,causalStatus:'online_causal',provenance:'synthetic_png',width,height,rgba:image.rgba,masks:valid.map(v=>v.mask)});
  const best=sample.x===null?-1:valid.reduce((best,v,i)=>best<0||v.score>valid[best].score?i:best,-1);const score=best<0?null:valid[best].score;const selected=best<0?null:observations[best];
  if(selected&&!firstId)firstId=selected.objectId;
  const passed=result.model==='sam-3.1' && valid.length===result.masks.length && (sample.x===null?valid.length===0:score>=.8&&selected.objectId===firstId&&selected.identityStatus!=='ambiguous');success&&=passed;
  evidence.frames.push({name:sample.name,sha256:image.sha256,status:passed?'passed':'failed',model:result.model,requestId:result.requestId,providerLatencyMs:result.latencyMs,maskCount:result.masks.length,validMaskCount:valid.length,bestIoU:score,selectedObjectId:selected?.objectId??null,selectedIdentityStatus:selected?.identityStatus??null,ambiguousCount:observations.filter(o=>o.identityStatus==='ambiguous').length,lastSeen:sample.x===null&&firstId?tracker.states(time).find(o=>o.objectId===firstId)??null:null});await save();
 }
} catch {success=false;evidence.error='local_processing_failed';}
evidence.status=success&&evidence.frames.length===samples.length?'passed':'failed';await save();console.log(`Synthetic spatial probe: ${evidence.status}; see docs/evidence/spatial-live.json`);if(evidence.status!=='passed')process.exitCode=1;
