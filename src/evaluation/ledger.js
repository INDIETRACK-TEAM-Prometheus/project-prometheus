import {validateNextGaze} from '../runtime/next-gaze.js';
const keys=(x,allowed)=>x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).every(k=>allowed.includes(k));
const num=x=>Number.isFinite(x)&&x>=0;
const str=x=>typeof x==='string'&&x.length>0&&x.length<=2000;
const bytes=x=>new TextEncoder().encode(JSON.stringify(x)).byteLength;
const clone=x=>structuredClone(x);
const profileNames=['scene_only','current_gaze','full_history','spatial_memory'];
function validate(input,alignment,issuedAt,horizonMs) {
 if(!keys(input,['frame','gaze','events','context','dependencies','observedUntil','candidates'])||!num(issuedAt)||!num(horizonMs)||!num(input.observedUntil)||input.observedUntil>issuedAt)throw Error('invalid decision');
 const f=input.frame,g=input.gaze,a=alignment;
 if(input.candidates!==undefined && (!Array.isArray(input.candidates)||input.candidates.length>20||input.candidates.some(c=>!keys(c,['objectId','bounds'])||!str(c.objectId)||!input.dependencies?.objectIds?.includes(c.objectId)||!keys(c.bounds,['left','top','right','bottom'])||![c.bounds.left,c.bounds.top,c.bounds.right,c.bounds.bottom].every(Number.isFinite)||c.bounds.left<0||c.bounds.top<0||c.bounds.right<=c.bounds.left||c.bounds.bottom<=c.bounds.top)||new Set(input.candidates.map(c=>c.objectId)).size!==input.candidates.length))throw Error('invalid candidates');
 if(!keys(f,['frameId','observedAt','processedAt','imageData','sceneText','causalStatus','provenanceKind'])||!str(f.frameId)||!num(f.observedAt)||!num(f.processedAt)||f.observedAt>input.observedUntil||f.processedAt>issuedAt||f.processedAt<f.observedAt||f.causalStatus!=='online_causal'||!['synthetic','sensor'].includes(f.provenanceKind)||typeof f.imageData!=='string'||!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(f.imageData)||(f.sceneText!=null&&!str(f.sceneText)))throw Error('invalid frame');
 if(!keys(g,['x','y','observedAt','processedAt'])||!num(g.observedAt)||!num(g.processedAt)||g.observedAt>input.observedUntil||g.processedAt>issuedAt||g.processedAt<g.observedAt||![g.x,g.y].every(v=>Number.isFinite(v)&&v>=0&&v<1))throw Error('invalid gaze');
 if(!keys(a,['presentTsEstimateMs','frameSyncUncertaintyMs','gazeSyncUncertaintyMs','alignmentBudgetMs'])||![a.presentTsEstimateMs,a.frameSyncUncertaintyMs,a.gazeSyncUncertaintyMs,a.alignmentBudgetMs].every(num)||a.presentTsEstimateMs<f.observedAt||a.presentTsEstimateMs>g.observedAt||g.observedAt-a.presentTsEstimateMs+a.frameSyncUncertaintyMs+a.gazeSyncUncertaintyMs>a.alignmentBudgetMs)throw Error('unverified alignment');
 if(!Array.isArray(input.events)||input.events.length>100||!keys(input.context,['memory'])||!Array.isArray(input.context.memory)||input.context.memory.length>100)throw Error('invalid context');
 for(const e of input.events)if(!keys(e,['eventId','type','observedAt','endAt','processedAt','dwellValidMs','x','y','candidateObjectIds'])||!str(e.eventId)||!num(e.observedAt)||!num(e.processedAt)||e.observedAt>input.observedUntil||e.processedAt>issuedAt||e.processedAt<e.observedAt||!['fixated','briefly_crossed'].includes(e.type)||!num(e.dwellValidMs)||((e.x!=null||e.y!=null)&&![e.x,e.y].every(v=>Number.isFinite(v)&&v>=0&&v<1))||(e.candidateObjectIds!=null&&(!Array.isArray(e.candidateObjectIds)||!e.candidateObjectIds.every(str)))||!num(e.endAt)||e.endAt<e.observedAt||e.endAt>input.observedUntil||e.endAt>e.processedAt||e.dwellValidMs>e.endAt-e.observedAt)throw Error('invalid event');
 for(const m of input.context.memory)if(!keys(m,['evidenceId','text','observedAt','processedAt','causalStatus'])||!str(m.evidenceId)||!str(m.text)||!num(m.observedAt)||!num(m.processedAt)||m.observedAt>input.observedUntil||m.processedAt>issuedAt||m.processedAt<m.observedAt||m.causalStatus!=='online_causal')throw Error('invalid memory');
 if(!keys(input.dependencies,['mapId','mapVersion','objectIds','evidenceIds','expiresAt'])||!str(input.dependencies.mapId)||!Number.isInteger(input.dependencies.mapVersion)||input.dependencies.mapVersion<0||!Array.isArray(input.dependencies.evidenceIds)||!input.dependencies.evidenceIds.every(str)||!Array.isArray(input.dependencies.objectIds)||!input.dependencies.objectIds.every(str)||!num(input.dependencies.expiresAt))throw Error('invalid dependencies');
}
export class EvaluationLedger {
 constructor({maxBytes=10*1024*1024,maxDecisions=100}={}){if(!Number.isInteger(maxBytes)||maxBytes<1||!Number.isInteger(maxDecisions)||maxDecisions<1)throw Error('invalid limit');Object.assign(this,{maxBytes,maxDecisions});this.clear();}
 clear(){this.entries=[];this.bytes=0;this.evictions={count:0,lastReason:null};}
 record(input,alignment,{issuedAt,horizonMs=1000}={}){
  validate(input,alignment,issuedAt,horizonMs);
  const entry={input:clone(input),alignment:clone(alignment),issuedAt,horizonMs,decisionStatus:'accepted_not_issued',replayStatus:'not_executed',heldOutLabel:null,outcome:null};
  const size=bytes(entry);if(size>this.maxBytes){this.evictions.count++;this.evictions.lastReason='entry_exceeds_byte_limit';return {stored:false,reason:this.evictions.lastReason};}
  while(this.entries.length && (this.entries.length>=this.maxDecisions||this.bytes+size>this.maxBytes)){const old=this.entries.shift();this.bytes-=bytes(old);this.evictions.count++;this.evictions.lastReason='capacity_eviction';}
  this.entries.push(entry);this.bytes+=size;return {stored:true};
 }
 withdrawEvidence(ids){
  const withdrawn=new Set(ids); this.entries=this.entries.filter(entry=>!entry.input.dependencies.evidenceIds.some(id=>withdrawn.has(id)) && !withdrawn.has(entry.input.frame.frameId)); this.bytes=this.entries.reduce((total,entry)=>total+bytes(entry),0);
 }
 recordOutcome(frameId,scenarios,reasoner,nextGaze=null){
  const entry=[...this.entries].reverse().find(e=>e.input.frame.frameId===frameId);if(!entry || !Array.isArray(scenarios)||scenarios.length>5)return false;
  try {validateNextGaze(nextGaze,entry.input.candidates ?? []); if(!entry.input.candidates?.length && nextGaze!==null) return false;} catch {return false;}
  const safe=[];for(const s of scenarios){if(!keys(s,['scenario_id','possible_next_action','horizon_ms','grounding_refs','assumptions','status'])||!str(s.scenario_id)||!str(s.possible_next_action)||!num(s.horizon_ms)||!Array.isArray(s.grounding_refs)||!s.grounding_refs.every(ref=>str(ref)&&entry.input.dependencies.evidenceIds.includes(ref))||(s.status==='active'&&!s.grounding_refs.length)||safe.some(previous=>previous.scenario_id===s.scenario_id)||!Array.isArray(s.assumptions)||!s.assumptions.every(str)||!['active','withdrawn','abstained'].includes(s.status))return false;safe.push(clone(s));}
  if(reasoner!=null && (!keys(reasoner,['provider','model','requestId','usage']) || ![reasoner.provider,reasoner.model,reasoner.requestId].every(v=>v==null||str(v)) || (reasoner.usage!=null&&(!keys(reasoner.usage,['inputTokens','outputTokens','cachedInputTokens'])||!Object.values(reasoner.usage).every(v=>v==null||(Number.isSafeInteger(v)&&v>=0))))))return false;
  const oldSize=bytes(entry),next={...entry,outcome:{source:'runtime_published_result',scenarios:safe,nextGaze:clone(nextGaze),...(reasoner==null?{}:{reasoner:clone(reasoner)})}};const newSize=bytes(next);if(this.bytes-oldSize+newSize>this.maxBytes){this.evictions.count++;this.evictions.lastReason='outcome_exceeds_byte_limit';return false;}Object.assign(entry,next);this.bytes+=newSize-oldSize;return true;
 }
 export(){return {schemaVersion:1,kind:'local_research_trace',replayStatus:'not_executed',profiles:profileNames,decisions:clone(this.entries),evictions:clone(this.evictions),bytes:this.bytes};}
}
export function projectProfile(entry,profile,{horizonMs=entry.horizonMs}={}){
 if(!profileNames.includes(profile))throw Error('invalid profile');
 if(![1000,3000,5000].includes(horizonMs))throw Error('invalid horizon');
 validate(entry.input,entry.alignment,entry.issuedAt,entry.horizonMs);
 const {frame,gaze,events,context,observedUntil}=entry.input;
 const output={profile,frame:clone(frame),observedUntil,horizonMs,replayStatus:'not_executed',...(entry.input.candidates?.length ? {candidates:clone(entry.input.candidates)} : {})};
 if(profile!=='scene_only')output.gaze=clone(gaze);
 if(profile==='full_history'||profile==='spatial_memory')output.events=clone(events);
 if(profile==='spatial_memory'){output.memory=clone(context.memory);output.dependencies=clone(entry.input.dependencies);}
 return output;
}
