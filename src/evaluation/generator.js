import {open,readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {canonicalJson,conditionSpecs,endpointNames,fail,manifestHash,sha256Hex,validateManifest} from './manifest.js';

export const GENESIS_HASH='0'.repeat(64);
const idPattern=/^[A-Za-z0-9_-]{1,64}$/;
const objectIdPattern=/^[A-Za-z0-9_:-]{1,128}$/;
const shaPattern=/^[a-f0-9]{64}$/;
const codePattern=/^[A-Z0-9_]{1,80}$/;
const forbiddenKey=/label|target|future|ground[_-]?truth|truth|annotation|answer|outcome|next[_-]?(look|interaction|gaze)/i;
const statuses=['ok','timeout','parse_failed','provider_failed','budget_exhausted'];
const adapterParseCodes=new Set(['REASONER_INVALID_RESPONSE','REASONER_INCOMPLETE','REASONER_WRONG_MODEL','REASONER_LANE_INVALID','REASONER_JSON_INVALID','REASONER_GROUNDING_INVALID']);
const maxArtifactBytes=16*1024*1024;

const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const shape=(o,req,opt=[])=>isObject(o)&&req.every(k=>Object.hasOwn(o,k))&&Object.keys(o).every(k=>req.includes(k)||opt.includes(k));
const num=(v,min=0)=>Number.isFinite(v)&&v>=min;
const unit=v=>Number.isFinite(v)&&v>=0&&v<=1;
const sha=v=>typeof v==='string'&&shaPattern.test(v);
const text=v=>typeof v==='string'&&v.length>0&&v.length<=2000;
const nullable=(v,test)=>v===null||test(v);

// ---------- ledger chain ----------
export function chainLine(seq,type,prevHash,payload){
 const body={seq,type,prevHash,payload};
 const hash=sha256Hex(canonicalJson(body));
 return {hash,text:canonicalJson({...body,hash})};
}

const recordKeys=['decisionId','participantId','sessionId','condition','diagnostic','endpoint','horizonMs','observedUntilMs','candidateIds','promptSha256','promptBytes','artifacts','gazeSourceSampleId','gazeTransform','newestInputObservedAtMs','issuedAtMs','availableAtMs','renderedAtMs','latencyMs','status','errorCode','responseSha256','result','provider','usage','costUsd','costSource'];

export function validateRecordPayload(p){
 const bad=detail=>{throw fail('LEDGER_INVALID',`record ${p?.decisionId??'?'}: ${detail}`);};
 if(!shape(p,recordKeys)||Object.keys(p).length!==recordKeys.length)bad('fields');
 if(![p.decisionId,p.participantId,p.sessionId].every(v=>typeof v==='string'&&idPattern.test(v)))bad('ids');
 if(!Object.hasOwn(conditionSpecs,p.condition)||p.diagnostic!==conditionSpecs[p.condition].diagnostic)bad('condition');
 if(!endpointNames.includes(p.endpoint)||![1000,3000,5000].includes(p.horizonMs)||!num(p.observedUntilMs)||!num(p.newestInputObservedAtMs)||p.newestInputObservedAtMs>p.observedUntilMs)bad('timing');
 if(!Array.isArray(p.candidateIds)||!p.candidateIds.length||p.candidateIds.length>20||new Set(p.candidateIds).size!==p.candidateIds.length||p.candidateIds.some(v=>!objectIdPattern.test(v)))bad('candidateIds');
 if(!sha(p.promptSha256)||!Number.isInteger(p.promptBytes)||p.promptBytes<1)bad('prompt');
 if(!Array.isArray(p.artifacts)||p.artifacts.some(a=>!shape(a,['id','sha256'])||Object.keys(a).length!==2||!idPattern.test(a.id)||!sha(a.sha256)))bad('artifacts');
 const gt=p.gazeTransform;
 if(!nullable(p.gazeSourceSampleId,v=>idPattern.test(v))||!(gt===null||(shape(gt,['method','seed'])&&gt.method==='shuffle'&&idPattern.test(gt.seed))||(shape(gt,['method','shiftMs'])&&gt.method==='backward_time_shift'&&Number.isInteger(gt.shiftMs)&&gt.shiftMs>0)||(shape(gt,['method'])&&gt.method==='oracle_gaze')))bad('gaze');
 if(!statuses.includes(p.status)||!nullable(p.errorCode,v=>codePattern.test(v))||!nullable(p.responseSha256,sha)||!['provider_estimate','planned_estimate','none'].includes(p.costSource)||!num(p.costUsd))bad('status');
 for(const key of ['issuedAtMs','availableAtMs','renderedAtMs','latencyMs'])if(!nullable(p[key],v=>num(v)))bad(key);
 if(p.provider!==null&&(!shape(p.provider,['model','requestId'])||!text(p.provider.model)||!nullable(p.provider.requestId,text)))bad('provider');
 if(p.usage!==null&&(!shape(p.usage,['inputTokens','outputTokens','cachedInputTokens'])||![p.usage.inputTokens,p.usage.outputTokens].every(v=>Number.isSafeInteger(v)&&v>=0)||!nullable(p.usage.cachedInputTokens,v=>Number.isSafeInteger(v)&&v>=0)))bad('usage');
 if(p.result!==null){
  const r=p.result;
  if(!shape(r,['abstained','rankedTargetIds','probabilities'])||typeof r.abstained!=='boolean'||!Array.isArray(r.rankedTargetIds)||r.rankedTargetIds.length>3||new Set(r.rankedTargetIds).size!==r.rankedTargetIds.length||r.rankedTargetIds.some(v=>!objectIdPattern.test(v))||(r.abstained?r.rankedTargetIds.length!==0:r.rankedTargetIds.length===0))bad('result');
  if(r.probabilities!==null){
   if(r.abstained||!Array.isArray(r.probabilities)||r.probabilities.length!==p.candidateIds.length||r.probabilities.some(v=>!unit(v))||Math.abs(r.probabilities.reduce((a,b)=>a+b,0)-1)>1e-6)bad('probabilities');
   const first=p.candidateIds.indexOf(r.rankedTargetIds[0]);
   if(first<0||r.probabilities[first]+1e-6<Math.max(...r.probabilities))bad('probabilities not maximal at top rank');
  }
 }
 if(p.status==='ok'){
  if(p.result===null||p.errorCode!==null||p.issuedAtMs===null||p.availableAtMs===null||p.latencyMs===null||p.availableAtMs<p.issuedAtMs||p.issuedAtMs<p.observedUntilMs||p.responseSha256===null)bad('ok record incomplete');
  if(p.renderedAtMs!==null&&p.renderedAtMs<p.availableAtMs)bad('rendered before available');
 } else {
  if(p.result!==null||p.availableAtMs!==null||p.renderedAtMs!==null||p.errorCode===null)bad('failed record must carry no result/availability');
  if(p.status==='budget_exhausted'&&(p.issuedAtMs!==null||p.latencyMs!==null||p.responseSha256!==null||p.costUsd!==0||p.costSource!=='none'))bad('budget_exhausted record must not show a call');
  if(p.status!=='budget_exhausted'&&p.issuedAtMs===null)bad('failed call must record issue time');
 }
 return p;
}

const headerKeys=['schemaVersion','kind','studyId','manifestSha256','thresholdVersion','provenance','createdAtMs','limits','plannedCells'];
const footerKeys=['recordCount','closedAtMs','callsMade','spentUsd'];

export function verifyLedgerText(text,{allowOpen=false}={}){
 if(typeof text!=='string'||text.length===0||!text.endsWith('\n'))throw fail('LEDGER_TAMPERED','empty or truncated line');
 const lines=text.slice(0,-1).split('\n');
 let prev=GENESIS_HASH,header=null,footer=null;const records=[];
 for(let i=0;i<lines.length;i++){
  let row;try{row=JSON.parse(lines[i]);}catch{throw fail('LEDGER_TAMPERED',`line ${i}: unparsable`);}
  if(!shape(row,['seq','type','prevHash','payload','hash'])||Object.keys(row).length!==5||row.seq!==i||row.prevHash!==prev||!['header','record','footer'].includes(row.type))throw fail('LEDGER_TAMPERED',`line ${i}: chain`);
  let expected;try{expected=sha256Hex(canonicalJson({seq:row.seq,type:row.type,prevHash:row.prevHash,payload:row.payload}));}catch{throw fail('LEDGER_TAMPERED',`line ${i}: payload`);}
  if(expected!==row.hash)throw fail('LEDGER_TAMPERED',`line ${i}: hash`);
  prev=row.hash;
  if(footer)throw fail('LEDGER_TAMPERED',`line ${i}: data after footer`);
  if(i===0){
   if(row.type!=='header'||!shape(row.payload,headerKeys)||Object.keys(row.payload).length!==headerKeys.length)throw fail('LEDGER_INVALID','header');
   const h=row.payload;
   if(h.schemaVersion!==1||h.kind!=='prometheus_generation_ledger'||!idPattern.test(h.studyId)||!sha(h.manifestSha256)||!idPattern.test(h.thresholdVersion)||!['synthetic','provider'].includes(h.provenance)||!num(h.createdAtMs)||!isObject(h.limits)||!Number.isInteger(h.plannedCells)||h.plannedCells<1)throw fail('LEDGER_INVALID','header fields');
   header=h;
  } else if(row.type==='record'){records.push(validateRecordPayload(row.payload));}
  else if(row.type==='footer'){
   if(!shape(row.payload,footerKeys)||Object.keys(row.payload).length!==footerKeys.length||row.payload.recordCount!==records.length||!num(row.payload.closedAtMs))throw fail('LEDGER_INVALID','footer');
   footer=row.payload;
  } else throw fail('LEDGER_INVALID',`line ${i}: second header`);
 }
 if(!footer&&!allowOpen)throw fail('LEDGER_UNCLOSED','footer missing (truncated or run aborted)');
 if(footer&&header.plannedCells!==records.length)throw fail('LEDGER_INVALID','record count differs from plan');
 return {header,records,footer,tailHash:prev,lineCount:lines.length};
}

class LedgerWriter{
 constructor(handle){this.handle=handle;this.seq=0;this.prev=GENESIS_HASH;}
 static async create(path){return new LedgerWriter(await open(path,'wx'));} // exclusive create: refuses an existing file
 async append(type,payload){const line=chainLine(this.seq,type,this.prev,payload);await this.handle.write(`${line.text}\n`);this.seq++;this.prev=line.hash;return line.hash;}
 async close(){try{await this.handle.sync();}finally{await this.handle.close();}}
}

// ---------- decisions and artifacts ----------
function scanKeys(value,path='decision',depth=0){
 if(depth>12)throw fail('DECISION_INVALID','too deep');
 if(Array.isArray(value))return value.forEach((v,i)=>scanKeys(v,`${path}[${i}]`,depth+1));
 if(!isObject(value))return;
 for(const key of Object.keys(value)){
  if(forbiddenKey.test(key))throw fail('LABEL_LEAK',`${path}.${key}`);
  scanKeys(value[key],`${path}.${key}`,depth+1);
 }
}
export const forbiddenInputKey=key=>forbiddenKey.test(key);

const imageTypes=['image/png','image/jpeg'];
function artifactOk(a,cutoff,types){
 return shape(a,['id','sha256','observedAtMs','processedAtMs','mediaType'],['path','base64','text'])&&idPattern.test(a.id)&&sha(a.sha256)&&num(a.observedAtMs)&&num(a.processedAtMs)&&a.observedAtMs<=a.processedAtMs&&types.includes(a.mediaType)&&['path','base64','text'].filter(k=>a[k]!==undefined).length===1&&(a.path===undefined||(typeof a.path==='string'&&a.path.length>0))&&(a.base64===undefined||typeof a.base64==='string')&&(a.text===undefined||typeof a.text==='string')&&(!imageTypes.includes(a.mediaType)||a.text===undefined);
}
const rectOk=(r,max=1)=>shape(r,['left','top','right','bottom'])&&Object.keys(r).length===4&&[r.left,r.top,r.right,r.bottom].every(v=>Number.isFinite(v)&&v>=0&&v<=max)&&r.right>r.left&&r.bottom>r.top;
const boundsOk=b=>shape(b,['left','top','right','bottom'])&&[b.left,b.top,b.right,b.bottom].every(v=>Number.isFinite(v)&&v>=0)&&b.right>b.left&&b.bottom>b.top;

function* artifactsOf(d){
 yield d.scene;yield d.gaze.crop;
 for(const c of Object.values(d.gazeControls??{}))yield c.crop;
 for(const o of d.samObjects??[])yield o.mask;
 for(const variant of Object.values(d.samInputs??{}))for(const c of variant)yield c.artifact;
 if(d.depth)yield d.depth.artifact;
 for(const o of d.oracle?.mask??[])yield o.mask;
 if(d.oracle?.depth)yield d.oracle.depth.artifact;
}

export function validateDecision(d){
 scanKeys(d);
 const bad=detail=>{throw fail('DECISION_INVALID',`${d?.decisionId??'?'}: ${detail}`);};
 if(!shape(d,['decisionId','participantId','sessionId','frameId','observedUntilMs','issuedAtMs','candidates','scene','gaze'],['renderLatencyMs','gazeControls','samObjects','samInputs','depth','history','spatialMemory','proactive','oracle']))bad('fields');
 if(![d.decisionId,d.participantId,d.sessionId,d.frameId].every(v=>typeof v==='string'&&idPattern.test(v))||!num(d.observedUntilMs)||!num(d.issuedAtMs)||d.issuedAtMs<d.observedUntilMs||(d.renderLatencyMs!==undefined&&!num(d.renderLatencyMs)))bad('identity/timing');
 const cutoff=d.observedUntilMs;
 if(!Array.isArray(d.candidates)||!d.candidates.length||d.candidates.length>20||d.candidates.some(c=>!shape(c,['objectId','bounds'])||Object.keys(c).length!==2||!objectIdPattern.test(c.objectId)||!boundsOk(c.bounds)))bad('candidates');
 const ids=new Set(d.candidates.map(c=>c.objectId));if(ids.size!==d.candidates.length)bad('duplicate candidate');
 const causal=(item,kind)=>{if(!(item.observedAtMs<=cutoff&&item.processedAtMs<=cutoff))throw fail('FUTURE_INPUT',`${d.decisionId}: ${kind} not available by cutoff`);};
 const art=(a,types,kind)=>{if(!artifactOk(a,cutoff,types))bad(`${kind} artifact`);causal(a,kind);};
 art(d.scene,imageTypes,'scene');
 const gaze=(g,kind)=>{
  if(!shape(g,['sampleId','x','y','observedAtMs','processedAtMs','crop','rect'])||Object.keys(g).length!==7||!idPattern.test(g.sampleId)||!unit(g.x)||!unit(g.y)||!num(g.observedAtMs)||!num(g.processedAtMs)||g.observedAtMs>g.processedAtMs||!rectOk(g.rect))bad(`${kind} gaze`);
  causal(g,kind);art(g.crop,imageTypes,`${kind}.crop`);
 };
 gaze(d.gaze,'gaze');
 if(d.gazeControls!==undefined){
  if(!shape(d.gazeControls,[],['shuffled','timeShifted','oracle']))bad('gazeControls');
  for(const [k,g] of Object.entries(d.gazeControls))gaze(g,`gazeControls.${k}`);
 }
 const samObject=o=>{if(!shape(o,['objectId','areaPx','bounds','mask'])||Object.keys(o).length!==4||!ids.has(o.objectId)||!Number.isInteger(o.areaPx)||o.areaPx<1||!boundsOk(o.bounds))bad('mask object');art(o.mask,imageTypes,'mask');};
 if(d.samObjects!==undefined){if(!Array.isArray(d.samObjects)||d.samObjects.length>20)bad('samObjects');d.samObjects.forEach(samObject);}
 if(d.samInputs!==undefined){
  if(!shape(d.samInputs,[],['bboxCrop','maskForeground']))bad('samInputs');
  for(const list of Object.values(d.samInputs)){
   if(!Array.isArray(list)||list.length>20)bad('samInputs list');
   for(const c of list){if(!shape(c,['objectId','widthPx','heightPx','areaPx','artifact'])||Object.keys(c).length!==5||!ids.has(c.objectId)||![c.widthPx,c.heightPx,c.areaPx].every(v=>Number.isInteger(v)&&v>0)||c.areaPx!==c.widthPx*c.heightPx)bad('crop input');art(c.artifact,imageTypes,'crop');}
  }
 }
 if(d.depth!==undefined){if(!shape(d.depth,['artifact','source'])||d.depth.source!=='depth_anything_v2_metric')bad('depth');art(d.depth.artifact,['application/json'],'depth');}
 const items=(list,kind,extraOk)=>{
  if(list===undefined)return;if(!Array.isArray(list)||list.length>50)bad(kind);
  const seen=new Set();
  for(const it of list){if(!isObject(it)||!idPattern.test(it.id)||seen.has(it.id)||!num(it.observedAtMs)||!num(it.processedAtMs)||it.observedAtMs>it.processedAtMs||!extraOk(it))bad(`${kind} item`);seen.add(it.id);causal(it,kind);}
 };
 items(d.history,'history',it=>shape(it,['id','text','observedAtMs','processedAtMs'])&&text(it.text));
 items(d.proactive,'proactive',it=>shape(it,['id','text','observedAtMs','processedAtMs'])&&text(it.text));
 items(d.spatialMemory,'spatialMemory',it=>shape(it,['id','objectId','x','y','z','stateVersion','relations','retrieval','observedAtMs','processedAtMs'])&&objectIdPattern.test(it.objectId)&&Number.isFinite(it.x)&&Number.isFinite(it.y)&&nullable(it.z,Number.isFinite)&&Number.isInteger(it.stateVersion)&&it.stateVersion>=0&&Array.isArray(it.relations)&&it.relations.length<=10&&it.relations.every(r=>shape(r,['relation','objectId'])&&Object.keys(r).length===2&&idPattern.test(r.relation)&&objectIdPattern.test(r.objectId))&&shape(it.retrieval,['method','rank'])&&idPattern.test(it.retrieval.method)&&Number.isInteger(it.retrieval.rank)&&it.retrieval.rank>=0);
 if(d.oracle!==undefined){
  if(!shape(d.oracle,[],['mask','depth']))bad('oracle');
  if(d.oracle.mask!==undefined){if(!Array.isArray(d.oracle.mask)||d.oracle.mask.length>20)bad('oracle.mask');d.oracle.mask.forEach(samObject);}
  if(d.oracle.depth!==undefined){if(!shape(d.oracle.depth,['artifact','source'])||d.oracle.depth.source!=='engine_ground_truth')bad('oracle.depth');art(d.oracle.depth.artifact,['application/json'],'oracle.depth');}
 }
 return d;
}

function safePath(baseDir,p){
 const full=resolve(baseDir,p),rel=relative(resolve(baseDir),full);
 if(rel===''||rel.startsWith('..')||isAbsolute(rel))throw fail('ARTIFACT_PATH_ESCAPE',p);
 return full;
}
function magicOk(type,bytes){return type==='image/png'?bytes.length>8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):type==='image/jpeg'?bytes.length>3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255:true;}

// Re-hash every referenced artifact immediately before use.
export async function loadArtifact(a,baseDir){
 let bytes;
 if(a.path!==undefined){bytes=await readFile(safePath(baseDir,a.path));}
 else if(a.base64!==undefined){bytes=Buffer.from(a.base64,'base64');if(bytes.toString('base64')!==a.base64)throw fail('ARTIFACT_INVALID',a.id);}
 else bytes=Buffer.from(a.text,'utf8');
 if(bytes.length>maxArtifactBytes)throw fail('ARTIFACT_INVALID',`${a.id}: too large`);
 if(sha256Hex(bytes)!==a.sha256)throw fail('ARTIFACT_HASH_MISMATCH',a.id);
 if(!magicOk(a.mediaType,bytes))throw fail('ARTIFACT_INVALID',`${a.id}: media type`);
 return {id:a.id,sha256:a.sha256,mediaType:a.mediaType,text:imageTypes.includes(a.mediaType)?null:bytes.toString('utf8'),dataUrl:imageTypes.includes(a.mediaType)?`data:${a.mediaType};base64,${bytes.toString('base64')}`:null};
}

export async function prepareDecision(decision,{baseDir='.'}={}){
 const d=validateDecision(decision),loaded=new Map();
 for(const a of artifactsOf(d)){
  const prior=loaded.get(a.id);
  if(prior){if(prior.sha256!==a.sha256)throw fail('ARTIFACT_ID_CONFLICT',a.id);continue;}
  loaded.set(a.id,await loadArtifact(a,baseDir));
 }
 return {decision:d,loaded};
}

// ---------- deterministic prompt input ----------
const need=(value,d,condition,what)=>{if(value===undefined||value===null||(Array.isArray(value)&&!value.length))throw fail('MISSING_INPUT',`${d.decisionId}:${condition}:${what}`);return value;};

export function buildPromptInput(prepared,condition,horizonMs,endpoint,manifest){
 const spec=conditionSpecs[condition];if(!spec)throw fail('UNKNOWN_CONDITION',condition);
 if(!endpointNames.includes(endpoint)||![1000,3000,5000].includes(horizonMs))throw fail('PROMPT_INVALID','endpoint/horizon');
 const {decision:d,loaded}=prepared,evidence=[],images=[],digests=new Map();
 let gazeSourceSampleId=null,gazeTransform=null;
 const use=a=>{const x=loaded.get(a.id);digests.set(a.id,{id:a.id,sha256:a.sha256});return x;};
 const push=(id,kind,body,observedAt,processedAt)=>evidence.push({id,kind,text:typeof body==='string'?body:canonicalJson(body),observedAt,processedAt,causalStatus:kind.startsWith('oracle')?'oracle_diagnostic':'online_causal'});
 const maskObjects=(list,kind)=>{
  need(list,d,condition,kind);
  push(`${kind}-${d.decisionId}`,kind,list.map(o=>({objectId:o.objectId,areaPx:o.areaPx,bounds:o.bounds,maskSha256:use(o.mask).sha256})),Math.max(...list.map(o=>o.mask.observedAtMs)),Math.max(...list.map(o=>o.mask.processedAtMs)));
 };
 const cropVariant=kind=>{
  const bbox=need(d.samInputs?.bboxCrop,d,condition,'samInputs.bboxCrop'),fg=need(d.samInputs?.maskForeground,d,condition,'samInputs.maskForeground');
  const key=c=>`${c.objectId}:${c.widthPx}x${c.heightPx}:${c.areaPx}`;
  if(bbox.length!==fg.length||bbox.map(key).sort().join('|')!==fg.map(key).sort().join('|'))throw fail('CROP_MISMATCH',`${d.decisionId}: bbox crop and mask foreground must match in object, size and area`);
  const list=kind==='sam_bbox_crop'?bbox:fg;
  for(const c of list){const x=use(c.artifact);images.push({id:c.artifact.id,role:kind,dataUrl:x.dataUrl});}
  push(`${kind}-${d.decisionId}`,kind,{variant:kind,objects:list.map(c=>({objectId:c.objectId,widthPx:c.widthPx,heightPx:c.heightPx,areaPx:c.areaPx,sha256:c.artifact.sha256}))},Math.max(...list.map(c=>c.artifact.observedAtMs)),Math.max(...list.map(c=>c.artifact.processedAtMs)));
 };
 for(const kind of spec.kinds){
  if(kind==='scene'){use(d.scene);push(`scene-${d.scene.id}`,'scene',{frameId:d.frameId,image:'attached'},d.scene.observedAtMs,d.scene.processedAtMs);}
  else if(kind==='gaze_crop'){
   const source=spec.gazeSource??'current';let g=d.gaze;
   if(source!=='current'){
    g=need(d.gazeControls?.[source],d,condition,`gazeControls.${source}`);
    if(source==='shuffled'){if(g.sampleId===d.gaze.sampleId)throw fail('CONTROL_INVALID',`${d.decisionId}: shuffled gaze equals current sample`);gazeTransform={method:'shuffle',seed:manifest.controls.gazeShuffleSeed};}
    else if(source==='timeShifted'){const shift=d.gaze.observedAtMs-g.observedAtMs;if(!Number.isInteger(shift)||shift<manifest.controls.minGazeTimeShiftMs)throw fail('CONTROL_INVALID',`${d.decisionId}: time shift below minimum`);gazeTransform={method:'backward_time_shift',shiftMs:shift};}
    else gazeTransform={method:'oracle_gaze'};
   }
   gazeSourceSampleId=g.sampleId;use(g.crop);
   push(`gaze-${g.sampleId}`,'gaze_crop',{x:g.x,y:g.y,cropRect:g.rect,cropSha256:g.crop.sha256},g.observedAtMs,g.processedAtMs);
  }
  else if(kind==='sam_objects')maskObjects(d.samObjects,'sam_objects');
  else if(kind==='oracle_mask')maskObjects(d.oracle?.mask,'oracle_mask');
  else if(kind==='sam_bbox_crop'||kind==='sam_mask_foreground')cropVariant(kind);
  else if(kind==='depth'||kind==='oracle_depth'){
   const holder=need(kind==='depth'?d.depth:d.oracle?.depth,d,condition,kind),x=use(holder.artifact);
   push(`${kind}-${holder.artifact.id}`,kind,x.text,holder.artifact.observedAtMs,holder.artifact.processedAtMs);
  }
  else if(kind==='history'||kind==='proactive')for(const it of need(d[kind],d,condition,kind))push(it.id,kind,it.text,it.observedAtMs,it.processedAtMs);
  else if(kind==='spatial_memory')for(const it of need(d.spatialMemory,d,condition,'spatialMemory'))push(it.id,'spatial_memory',{objectId:it.objectId,x:it.x,y:it.y,z:it.z,stateVersion:it.stateVersion,relations:it.relations,retrieval:it.retrieval},it.observedAtMs,it.processedAtMs);
 }
 if(new Set(evidence.map(e=>e.id)).size!==evidence.length)throw fail('PROMPT_INVALID','duplicate evidence id');
 if(evidence.length>100||Buffer.byteLength(JSON.stringify(evidence))>16384)throw fail('PROMPT_TOO_LARGE',`${d.decisionId}:${condition}`);
 const promptInput={task:endpoint,observedUntil:d.observedUntilMs,issuedAt:d.issuedAtMs,evidence,imageDataUrl:use(d.scene).dataUrl,horizonMs,candidates:d.candidates.map(c=>({objectId:c.objectId,bounds:c.bounds})),...(images.length?{images}:{})};
 const serialized=canonicalJson(promptInput);
 if(forbiddenKey.test(Object.keys(promptInput).join(' '))||scanPrompt(promptInput))throw fail('LABEL_LEAK','prompt input');
 return {promptInput,serialized,meta:{candidateIds:d.candidates.map(c=>c.objectId),gazeSourceSampleId,gazeTransform,newestInputObservedAtMs:Math.max(...evidence.map(e=>e.observedAt)),artifacts:[...digests.values()].sort((a,b)=>a.id<b.id?-1:1)}};
}
function scanPrompt(promptInput){
 try{scanKeys({...promptInput,imageDataUrl:undefined},'promptInput');return false;}catch(error){if(error.code==='LABEL_LEAK')return true;throw error;}
}

// ---------- provider output ----------
export function parseProviderResult(raw,endpoint,candidateIds){
 const bad=()=>{throw fail('RESPONSE_PARSE_FAILED');};
 const v=isObject(raw)?raw[endpoint==='next_look_onset'?'nextGaze':'nextInteraction']:undefined;
 if(!isObject(v)||!Object.keys(v).every(k=>k==='rankedTargetIds'||k==='probabilities')||!Array.isArray(v.rankedTargetIds)||v.rankedTargetIds.length>3||new Set(v.rankedTargetIds).size!==v.rankedTargetIds.length)bad();
 const allowed=new Set([...candidateIds,'unknown','outside_view']);
 if(v.rankedTargetIds.some(id=>typeof id!=='string'||!allowed.has(id)))bad();
 const ranked=v.rankedTargetIds,probs=v.probabilities===undefined?null:v.probabilities;
 if(!ranked.length||ranked[0]==='unknown'){if(probs!==null)bad();return {abstained:true,rankedTargetIds:[],probabilities:null};}
 if(probs!==null){
  const first=candidateIds.indexOf(ranked[0]);
  if(!Array.isArray(probs)||probs.length!==candidateIds.length||probs.some(p=>!unit(p))||Math.abs(probs.reduce((a,b)=>a+b,0)-1)>1e-6||first<0||probs[first]+1e-6<Math.max(...probs))bad();
 }
 return {abstained:false,rankedTargetIds:[...ranked],probabilities:probs===null?null:[...probs]};
}

function usageOf(raw){
 const u=raw?.usage;
 if(!isObject(u)||![u.inputTokens,u.outputTokens].every(v=>Number.isSafeInteger(v)&&v>=0))return null;
 const cached=u.cachedInputTokens??null;if(cached!==null&&!(Number.isSafeInteger(cached)&&cached>=0))return null;
 return {inputTokens:u.inputTokens,outputTokens:u.outputTokens,cachedInputTokens:cached};
}
const providerOf=raw=>typeof raw?.model==='string'&&raw.model.length>0&&raw.model.length<=2000?{model:raw.model,requestId:typeof raw.requestId==='string'&&raw.requestId.length>0&&raw.requestId.length<=2000?raw.requestId:null}:null;

// ---------- reasoner adapter bridge ----------
const adapterKinds={scene:'scene',gaze_crop:'gaze',sam_objects:'mask',depth:'memory',history:'memory',spatial_memory:'memory',proactive:'memory'};
export function adapterGaps(manifest){
 const m=validateManifest(manifest),gaps=[];
 if(m.endpoints.next_interaction)gaps.push('endpoint:next_interaction (adapter returns nextGaze only)');
 for(const c of m.conditions){const kinds=conditionSpecs[c].kinds.filter(k=>!Object.hasOwn(adapterKinds,k));if(kinds.length)gaps.push(`condition:${c} (${kinds.join(',')} cannot be sent through the single-image adapter)`);}
 return gaps;
}
export function toReasonerAdapterInput(promptInput){
 if(promptInput.images?.length)throw fail('ADAPTER_UNSUPPORTED_INPUT','extra images');
 const evidence=promptInput.evidence.map(e=>{
  if(!Object.hasOwn(adapterKinds,e.kind))throw fail('ADAPTER_UNSUPPORTED_INPUT',e.kind);
  const kind=adapterKinds[e.kind];
  return {id:e.id,kind,text:kind==='memory'?`[${e.kind}] ${e.text}`:e.text,observedAt:e.observedAt,processedAt:e.processedAt,causalStatus:e.causalStatus};
 });
 return {observedUntil:promptInput.observedUntil,issuedAt:promptInput.issuedAt,evidence,imageDataUrl:promptInput.imageDataUrl,horizonMs:promptInput.horizonMs,candidates:promptInput.candidates};
}

// ---------- planning (dry run) and generation ----------
function* cellsOf(m,decisions){
 for(const decision of decisions)for(const horizonMs of m.horizons)for(const endpoint of endpointNames)if(m.endpoints[endpoint])for(const condition of m.conditions)yield {decision,horizonMs,endpoint,condition};
}
function checkDecisions(decisions){
 if(!Array.isArray(decisions)||!decisions.length||decisions.length>100000)throw fail('DECISION_INVALID','decision list');
 const ids=new Set();
 for(const d of decisions){validateDecision(d);if(ids.has(d.decisionId))throw fail('DECISION_INVALID',`duplicate ${d.decisionId}`);ids.add(d.decisionId);}
}

export async function planComparison({manifest,decisions,baseDir='.'}={}){
 const m=validateManifest(manifest);checkDecisions(decisions);
 const cells=[];let promptBytes=0;
 for(const decision of decisions){
  const prepared=await prepareDecision(decision,{baseDir});
  for(const horizonMs of m.horizons)for(const endpoint of endpointNames)if(m.endpoints[endpoint])for(const condition of m.conditions){
   const built=buildPromptInput(prepared,condition,horizonMs,endpoint,m),bytes=Buffer.byteLength(built.serialized);promptBytes+=bytes;
   cells.push({decisionId:decision.decisionId,condition,diagnostic:conditionSpecs[condition].diagnostic,endpoint,horizonMs,promptSha256:sha256Hex(built.serialized),promptBytes:bytes,evidenceKinds:built.promptInput.evidence.map(e=>e.kind),artifactCount:built.meta.artifacts.length,imageCount:built.promptInput.images?.length??0});
  }
 }
 return {mode:'dry_run',providerCalled:false,manifestSha256:manifestHash(m),studyId:m.studyId,decisions:decisions.length,cells,totals:{cells:cells.length,promptBytes}};
}

const classify=(error,timedOut)=>{
 const code=typeof error?.code==='string'&&codePattern.test(error.code)?error.code:null;
 if(timedOut||(code&&/TIMEOUT/.test(code)))return {status:'timeout',errorCode:code&&/TIMEOUT/.test(code)?code:'GENERATOR_TIMEOUT'};
 if(code&&(adapterParseCodes.has(code)||code==='RESPONSE_PARSE_FAILED'))return {status:'parse_failed',errorCode:code};
 return {status:'provider_failed',errorCode:code??'PROVIDER_FAILED'};
};

export async function generateComparison({manifest,decisions,callProvider,ledgerPath,baseDir='.',externalTransfer=false,maxCalls,budgetUsd,estimatedCallUsd=0.05,timeoutMs=60000,provenance,rawResponseDir=null,signal,now=()=>performance.now(),wallNow=()=>Date.now()}={}){
 if(typeof callProvider!=='function'||externalTransfer!==true||!Number.isInteger(maxCalls)||maxCalls<1||!Number.isFinite(budgetUsd)||budgetUsd<=0||!Number.isFinite(estimatedCallUsd)||estimatedCallUsd<=0||!Number.isInteger(timeoutMs)||timeoutMs<1||!['synthetic','provider'].includes(provenance)||typeof ledgerPath!=='string'||!ledgerPath)throw fail('EXECUTION_CONSENT_REQUIRED','callProvider, externalTransfer, maxCalls, budgetUsd, provenance and ledgerPath are required');
 const m=validateManifest(manifest),mHash=manifestHash(m);checkDecisions(decisions);
 for(const decision of decisions)await prepareDecision(decision,{baseDir}); // fail before the ledger exists if any artifact digest is wrong
 const plannedCells=decisions.length*m.horizons.length*m.conditions.length*Object.keys(m.endpoints).length;
 const ledger=await LedgerWriter.create(ledgerPath);
 const counts=Object.fromEntries(statuses.map(s=>[s,0]));let calls=0,spent=0;
 try{
  await ledger.append('header',{schemaVersion:1,kind:'prometheus_generation_ledger',studyId:m.studyId,manifestSha256:mHash,thresholdVersion:m.thresholdVersion,provenance,createdAtMs:wallNow(),limits:{maxCalls,budgetUsd,estimatedCallUsd},plannedCells});
  if(rawResponseDir)await mkdir(rawResponseDir,{recursive:true});
  for(const decision of decisions){
   const prepared=await prepareDecision(decision,{baseDir}); // re-hash immediately before use
   for(const horizonMs of m.horizons)for(const endpoint of endpointNames)if(m.endpoints[endpoint])for(const condition of m.conditions){
    if(signal?.aborted)throw fail('GENERATION_ABORTED');
    const built=buildPromptInput(prepared,condition,horizonMs,endpoint,m);
    const record={decisionId:decision.decisionId,participantId:decision.participantId,sessionId:decision.sessionId,condition,diagnostic:conditionSpecs[condition].diagnostic,endpoint,horizonMs,observedUntilMs:decision.observedUntilMs,candidateIds:built.meta.candidateIds,promptSha256:sha256Hex(built.serialized),promptBytes:Buffer.byteLength(built.serialized),artifacts:built.meta.artifacts,gazeSourceSampleId:built.meta.gazeSourceSampleId,gazeTransform:built.meta.gazeTransform,newestInputObservedAtMs:built.meta.newestInputObservedAtMs,issuedAtMs:null,availableAtMs:null,renderedAtMs:null,latencyMs:null,status:'budget_exhausted',errorCode:'BUDGET_EXHAUSTED',responseSha256:null,result:null,provider:null,usage:null,costUsd:0,costSource:'none'};
    if(calls>=maxCalls||spent+estimatedCallUsd>budgetUsd+1e-12){counts.budget_exhausted++;await ledger.append('record',validateRecordPayload(record));continue;}
    calls++;
    const controller=new AbortController();let timedOut=false,timer;
    const onAbort=()=>controller.abort();signal?.addEventListener('abort',onAbort,{once:true});
    const started=now();let raw,failure=null;
    try{
     const guard=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(fail('GENERATOR_TIMEOUT'));},timeoutMs);});
     raw=await Promise.race([Promise.resolve().then(()=>callProvider(structuredClone(built.promptInput),{signal:controller.signal,endpoint})),guard]);
    }catch(error){failure=error;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
    const latencyMs=Math.max(0,Math.round(now()-started));
    if(signal?.aborted)throw fail('GENERATION_ABORTED');
    record.issuedAtMs=decision.issuedAtMs;record.latencyMs=latencyMs;
    let responseSha256=null;
    if(!failure){
     try{responseSha256=sha256Hex(canonicalJson(raw));}catch{failure=fail('RESPONSE_PARSE_FAILED');}
    }
    if(!failure){
     try{
      record.result=parseProviderResult(raw,endpoint,built.meta.candidateIds);
      Object.assign(record,{status:'ok',errorCode:null,responseSha256,availableAtMs:decision.issuedAtMs+latencyMs,renderedAtMs:decision.renderLatencyMs===undefined?null:decision.issuedAtMs+latencyMs+decision.renderLatencyMs,provider:providerOf(raw),usage:usageOf(raw)});
     }catch(error){failure=error;}
    }
    if(failure){Object.assign(record,{result:null,availableAtMs:null,renderedAtMs:null,responseSha256,...classify(failure,timedOut)});}
    const reported=typeof raw?.estimatedCostUsd==='number'&&Number.isFinite(raw.estimatedCostUsd)&&raw.estimatedCostUsd>=0;
    record.costUsd=reported?raw.estimatedCostUsd:estimatedCallUsd;record.costSource=reported?'provider_estimate':'planned_estimate';
    spent+=record.costUsd;counts[record.status]++;
    if(rawResponseDir&&responseSha256){try{await writeFile(resolve(rawResponseDir,`${responseSha256}.json`),canonicalJson(raw),{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}}
    await ledger.append('record',validateRecordPayload(record));
   }
  }
  const tailHash=await ledger.append('footer',{recordCount:plannedCells,closedAtMs:wallNow(),callsMade:calls,spentUsd:spent});
  return {ledgerPath,manifestSha256:mHash,tailHash,plannedCells,calls,spentUsd:spent,statusCounts:counts,provenance};
 } finally {await ledger.close();}
}
