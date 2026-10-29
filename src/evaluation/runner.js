import {createHash} from 'node:crypto';
import {projectProfile} from './ledger.js';
import {validateNextGaze} from '../runtime/next-gaze.js';

const profiles=['scene_only','current_gaze','full_history','spatial_memory'];
const horizons=[1000,3000,5000];
const id=x=>typeof x==='string' && /^[A-Za-z0-9_-]{1,64}$/.test(x);
const targetId=x=>typeof x==='string' && /^[A-Za-z0-9_:-]{1,128}$/.test(x);
const text=x=>typeof x==='string' && x.length>0 && x.length<=2000;

function makeRequest(entry,profile,horizonMs) {
 const p=projectProfile(entry,profile,{horizonMs});
 const scene={sceneText:p.frame.sceneText,provenanceKind:p.frame.provenanceKind};
 if(p.gaze)scene.gaze={x:p.gaze.x,y:p.gaze.y};
 const evidence=[{id:p.frame.frameId,kind:'scene',text:JSON.stringify(scene),observedAt:p.frame.observedAt,processedAt:p.frame.processedAt,causalStatus:'online_causal'}];
 for(const e of p.events ?? [])evidence.push({id:e.eventId,kind:'gaze',text:JSON.stringify({type:e.type,endAt:e.endAt,dwellValidMs:e.dwellValidMs,...(e.x==null?{}:{x:e.x,y:e.y}),...(e.candidateObjectIds==null?{}:{candidateObjectIds:e.candidateObjectIds})}),observedAt:e.observedAt,processedAt:e.processedAt,causalStatus:'online_causal'});
 for(const m of p.memory ?? [])evidence.push({id:m.evidenceId,kind:'memory',text:m.text,observedAt:m.observedAt,processedAt:m.processedAt,causalStatus:'online_causal'});
 if(evidence.length>100 || new Set(evidence.map(e=>e.id)).size!==evidence.length || evidence.some(e=>!text(e.id)||e.id.length>128||!text(e.text)) || Buffer.byteLength(JSON.stringify(evidence))>16384)throw Error('invalid replay evidence');
 const imageDataUrl=p.frame.imageData,match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(imageDataUrl);
 if(!match || imageDataUrl.length>8*1024*1024 || match[2].length%4)throw Error('invalid scene image');
 const image=Buffer.from(match[2],'base64');
 if(image.toString('base64')!==match[2] || (match[1]==='png'?!image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):image.length<3||image[0]!==255||image[1]!==216||image[2]!==255))throw Error('invalid scene image');
 return {observedUntil:p.observedUntil,issuedAt:entry.issuedAt,evidence,imageDataUrl,horizonMs,...(p.candidates ? {candidates:p.candidates} : {})};
}

// Group IDs are supplied separately and never become model evidence.
export async function runEvaluation({groups,execute=false,externalTransfer=false,maxCalls,estimatedBudgetUsd,estimatedCallUsd=0.05,maxDecisions=1,reasoner,kind='fixture',comparisons=[]}={}) {
 if(!Array.isArray(groups)||!groups.length||!Number.isInteger(maxDecisions)||maxDecisions<1||maxDecisions>100||!['fixture','provider'].includes(kind))throw Error('invalid evaluation configuration');
 if(execute && (!externalTransfer||typeof reasoner!=='function'||!Number.isInteger(maxCalls)||maxCalls<1||!Number.isFinite(estimatedBudgetUsd)||estimatedBudgetUsd<=0||!Number.isFinite(estimatedCallUsd)||estimatedCallUsd<=0))throw Error('execution consent and limits required');
 const fingerprints=new Map(),participants=new Map(),scenes=new Map(),prepared=[];
 for(const group of groups){
  if(!id(group?.participantId)||!id(group?.sceneId)||!['train','validation','test'].includes(group?.split)||group.trace?.kind!=='local_research_trace'||group.trace?.schemaVersion!==1||!Array.isArray(group.trace.decisions)||group.trace.decisions.length>100)throw Error('invalid group or trace');
  for(const [seen,key,label] of [[participants,group.participantId,'participant'],[scenes,group.sceneId,'scene']]){const prior=seen.get(key);if(prior && prior!==group.split)throw Error(`${label} crosses splits`);seen.set(key,group.split);}
  for(const entry of group.trace.decisions){
   const requests=[];for(const horizon of horizons)for(const profile of profiles)requests.push({profile,horizonMs:horizon,request:makeRequest(entry,profile,horizon)});
   const fingerprint=createHash('sha256').update(entry.input.frame.imageData).digest('hex');
   const prior=fingerprints.get(fingerprint);if(prior && prior!==group.split)throw Error('scene fingerprint crosses splits');fingerprints.set(fingerprint,group.split);
   prepared.push({participantId:group.participantId,sceneId:group.sceneId,split:group.split,fingerprint,requests});
  }
 }
 const chosen=prepared.slice(0,maxDecisions),cells=[];let calls=0,reservedUsd=0;
 // Explicit categorical target IDs must be independently defined in the same label space.
 if(!Array.isArray(comparisons))throw Error('invalid comparisons');
 const seenComparisons=new Set();
 for(const c of comparisons){
  const key=`${c?.decision}:${c?.profile}:${c?.horizonMs}`;
  if(!Number.isInteger(c?.decision)||!chosen[c.decision]||chosen[c.decision].split!=='test'||!profiles.includes(c.profile)||!horizons.includes(c.horizonMs)||!targetId(c.targetId)||typeof c.abstained!=='boolean'||!Array.isArray(c.rankedTargetIds)||c.rankedTargetIds.some(x=>!targetId(x))||new Set(c.rankedTargetIds).size!==c.rankedTargetIds.length||(c.abstained?c.rankedTargetIds.length!==0:c.rankedTargetIds.length===0)||seenComparisons.has(key))throw Error('invalid comparison');
  if(c.probabilities!==undefined && (c.abstained||!Array.isArray(c.probabilities)||c.probabilities.length!==c.rankedTargetIds.length||c.probabilities.some(x=>!Number.isFinite(x)||x<0||x>1)||Math.abs(c.probabilities.reduce((a,b)=>a+b,0)-1)>1e-9||c.probabilities.some((x,i)=>i>0&&x>c.probabilities[i-1])))throw Error('invalid comparison probabilities');
  seenComparisons.add(key);
 }
 const metrics=[];
 for(const horizonMs of horizons)for(const profile of profiles){
  const rows=comparisons.filter(c=>c.profile===profile&&c.horizonMs===horizonMs),answered=rows.filter(c=>!c.abstained),probabilistic=answered.filter(c=>c.probabilities!==undefined);
  metrics.push({profile,horizonMs,status:rows.length?'assessed':'not_assessed',labeled:rows.length,answered:answered.length,coverage:rows.length?answered.length/rows.length:null,top1:answered.length?answered.filter(c=>c.rankedTargetIds[0]===c.targetId).length/answered.length:null,top3:answered.length?answered.filter(c=>c.rankedTargetIds.slice(0,3).includes(c.targetId)).length/answered.length:null,uncertainty:probabilistic.length?{count:probabilistic.length,meanTop1Probability:probabilistic.reduce((sum,c)=>sum+c.probabilities[0],0)/probabilistic.length,meanBrierScore:probabilistic.reduce((sum,c)=>sum+c.probabilities.reduce((v,p,i)=>v+(p-(c.rankedTargetIds[i]===c.targetId?1:0))**2,0)+(c.rankedTargetIds.includes(c.targetId)?0:1),0)/probabilistic.length}:null});
 }

 for(let index=0;index<chosen.length;index++)for(const cell of chosen[index].requests){
  const row={decision:index,participantId:chosen[index].participantId,sceneId:chosen[index].sceneId,split:chosen[index].split,fingerprint:chosen[index].fingerprint,profile:cell.profile,horizonMs:cell.horizonMs,status:'not_executed',latencyMs:null,usage:null,estimatedCostUsd:null,abstained:null};cells.push(row);
  if(!execute)continue;
  if(calls>=maxCalls || reservedUsd+estimatedCallUsd>estimatedBudgetUsd+Number.EPSILON){row.status='limit_reached';continue;}
  calls++;reservedUsd+=estimatedCallUsd;const started=performance.now();
  try {const result=await reasoner(structuredClone(cell.request));if(!Array.isArray(result?.scenarios)||result.scenarios.some(s=>s.horizon_ms!==cell.horizonMs))throw Error('invalid result horizon');validateNextGaze(result.nextGaze ?? null,cell.request.candidates ?? []);if(!cell.request.candidates?.length && result.nextGaze != null)throw Error('no candidate space');row.nextGaze=result.nextGaze ?? null;row.status='completed';row.latencyMs=performance.now()-started;row.usage=result.usage??null;row.estimatedCostUsd=Number.isFinite(result.estimatedCostUsd)&&result.estimatedCostUsd>=0?result.estimatedCostUsd:null;if(row.estimatedCostUsd!==null)reservedUsd+=Math.max(0,row.estimatedCostUsd-estimatedCallUsd);row.abstained=result.scenarios.length===0||result.scenarios.every(s=>s.status==='abstained');}
  catch(error){row.status='failed';row.latencyMs=performance.now()-started;row.error=typeof error?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.code)?error.code:'REPLAY_FAILED';}
 }
 return {schemaVersion:1,kind:'paired_replay_report',source:kind,mode:execute?'executed':'dry_run',calls,reservedUsd,estimatedBudgetUsd:execute?estimatedBudgetUsd:null,cells,completeness:{completed:cells.filter(c=>c.status==='completed').length,total:cells.length},accuracy:null,improvement:null,nextGazeMetrics:metrics,t08Status:'not_assessed'};
}
