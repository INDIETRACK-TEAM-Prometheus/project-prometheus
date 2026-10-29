import {ObjectTracker} from '../spatial/tracker.js';
import {maskContains} from '../spatial/tracker.js';

const exact=(x,keys)=>x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).every(k=>keys.includes(k));
const finite=x=>Number.isFinite(x) && x>=0;
const text=x=>typeof x==='string' && x.length>0 && x.length<=128;
const frameKeys=['frameId','observedAt','processedAt','causalStatus','provenanceKind','mapId','mapVersion','coordinateFrameId','width','height','rgba','imageData','depth','syncUncertaintyMs','presentTsEstimateMs','timingUnavailableReason'];
const gazeKeys=['frameId','observedAt','processedAt','causalStatus','x','y','syncUncertaintyMs'];
const eventKeys=['eventId','type','causalStatus','observedAt','endAt','processedAt','dwellValidMs','x','y'];
const depthKeys=['frameId','observedAt','processedAt','causalStatus','width','height','values','intrinsics','cameraToWorld','units','convention','depthSource','provenance'];
function validate({frame:f,gaze:g,event:e},now,budget) {
  if (!exact(f,frameKeys) || !text(f.frameId) || !text(f.mapId) || !text(f.coordinateFrameId) || !Number.isInteger(f.mapVersion) || f.mapVersion<0 || f.causalStatus!=='online_causal' || !['sensor','synthetic'].includes(f.provenanceKind) || !finite(f.observedAt) || !finite(f.processedAt) || f.processedAt<f.observedAt || f.processedAt>now || !Number.isInteger(f.width) || !Number.isInteger(f.height) || f.width<1 || f.height<1 || f.width*f.height>1048576 || !(f.rgba instanceof Uint8Array || f.rgba instanceof Uint8ClampedArray) || f.rgba.length!==f.width*f.height*4 || typeof f.imageData!=='string' || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(f.imageData) || f.imageData.length>6000000) return false;
  const timingUnavailable=f.presentTsEstimateMs===null && f.syncUncertaintyMs===null && f.timingUnavailableReason==='display_presentation_not_measured';
  const presented=f.presentTsEstimateMs === undefined ? f.observedAt : f.presentTsEstimateMs;
  if (!timingUnavailable && (!finite(f.syncUncertaintyMs) || !finite(presented) || presented<f.observedAt || (g && presented>g.observedAt))) return false;
  if (timingUnavailable && (g || e != null)) return false;
  if (!g) return e == null && f.depth == null;
  if (!exact(g,gazeKeys) || g.frameId!==f.frameId || g.causalStatus!=='online_causal' || !finite(g.observedAt) || !finite(g.processedAt) || g.processedAt<g.observedAt || g.processedAt>now || g.observedAt<f.observedAt || !finite(g.syncUncertaintyMs) || g.observedAt-presented+g.syncUncertaintyMs+f.syncUncertaintyMs>budget || !Number.isFinite(g.x) || !Number.isFinite(g.y) || g.x<0 || g.x>=1 || g.y<0 || g.y>=1) return false;
  if (f.depth != null) { const d=f.depth; if (!exact(d,depthKeys) || d.frameId!==f.frameId || d.observedAt!==f.observedAt || d.causalStatus!=='online_causal' || !finite(d.processedAt) || d.processedAt<d.observedAt || d.processedAt>now || d.width!==f.width || d.height!==f.height || !Array.isArray(d.values) || d.values.length!==d.width*d.height || !exact(d.intrinsics,['fx','fy','cx','cy']) || !Array.isArray(d.cameraToWorld) || d.cameraToWorld.length!==16 || !d.cameraToWorld.every(Number.isFinite)) return false; }
  if (e != null && (!exact(e,eventKeys) || e.causalStatus!=='online_causal' || !text(e.eventId) || !['fixated','briefly_crossed'].includes(e.type) || !finite(e.observedAt) || !finite(e.endAt) || e.endAt<e.observedAt || e.endAt>g.observedAt || !finite(e.processedAt) || e.processedAt<e.endAt || e.processedAt>now || !finite(e.dwellValidMs) || e.dwellValidMs>e.endAt-e.observedAt || !Number.isFinite(e.x) || !Number.isFinite(e.y) || e.x<0 || e.x>=1 || e.y<0 || e.y>=1)) return false;
  return true;
}
export class PerceptionPipeline {
  constructor({segment,segmentKind='local_fixture',identityNamespace='',memory,runtime,now=()=>performance.now(),timeoutMs=30000,alignmentBudgetMs=50,ttlMs=5000,pinFrame=null,releaseFrame=null,sampleSurface=null,onDecision=null,onExplorationResult=null}={}) {
    if(typeof identityNamespace!=='string' || identityNamespace.length>36 || (onExplorationResult!==null && typeof onExplorationResult!=='function') || (onDecision!==null && typeof onDecision!=='function') || (sampleSurface!==null && (typeof sampleSurface!=='function'||typeof pinFrame!=='function'||typeof releaseFrame!=='function')) || (sampleSurface===null && (pinFrame!==null || releaseFrame!==null)) || !['local_fixture','server_provider'].includes(segmentKind)||typeof segment!=='function'||typeof memory?.ingestPerception!=='function'||typeof memory?.retrieve!=='function'||typeof memory?.attentionHistory!=='function'||typeof runtime?.submit!=='function'||typeof now!=='function'||!finite(alignmentBudgetMs)||!finite(ttlMs)||ttlMs===0||!finite(timeoutMs)||timeoutMs===0) throw new TypeError('invalid perception configuration');
    Object.assign(this,{segment,segmentKind,identityNamespace,memory,runtime,now,timeoutMs,alignmentBudgetMs,ttlMs,pinFrame,releaseFrame,sampleSurface,onDecision,onExplorationResult}); this.lastError=null; this.commits=0; this.active=false; this.running=false; this.pending=null; this.generation=0; this.dropped=0; this.invalidationVersion=0;
  }
  start(sessionId) { if(this.active||this.running||!text(sessionId)) throw new Error('busy or invalid session'); this.active=true; this.generation++; this.tracker=new ObjectTracker(); this.mapKey=null; this.mapEpoch=0; this.lastError=null; this.unsubscribeInvalidations=this.memory.subscribeInvalidations?.(ids=>{ this.invalidationVersion++; for(const evidenceId of ids) this.runtime.invalidate?.({type:'evidence_withdrawn',evidenceId}); }); }
  submit(input) {
    if(!this.active) return {accepted:false,reason:'stopped'};
    const now=this.now(); if(!finite(now)||!exact(input,['frame','gaze','event','mapCorrection'])||!validate(input,now,this.alignmentBudgetMs)) { this.lastError='alignment_or_input_unavailable'; return {accepted:false,reason:this.lastError}; }
    const request=structuredClone(input);
    if(this.pinFrame) { try { if(this.pinFrame(request.frame)!==true) { this.lastError='frame_pin_unavailable'; return {accepted:false,reason:this.lastError}; } } catch { this.lastError='frame_pin_unavailable'; return {accepted:false,reason:this.lastError}; } }
    const nextMap=JSON.stringify([input.frame.mapId,input.frame.mapVersion,input.frame.coordinateFrameId]); if(this.mapKey!==null && nextMap!==this.mapKey) this.runtime.invalidate?.({type:'map',mapId:JSON.parse(this.mapKey)[0]});
    if(this.running) { if(request.gaze && this.currentExploration) this.controller?.abort(); if(this.pending) { this.dropped++; this.release(this.pending.frame); } this.pending=request; } else this.run(request,this.generation);
    return {accepted:true};
  }
  release(frame) { if(this.releaseFrame) { try { this.releaseFrame(frame); } catch {} } }
  status() { return {active:this.active,running:this.running,pending:!!this.pending,dropped:this.dropped,commits:this.commits,lastError:this.lastError}; }
  stop() { this.active=false; this.generation++; this.unsubscribeInvalidations?.(); this.unsubscribeInvalidations=null; if(this.pending) this.release(this.pending.frame); this.pending=null; this.controller?.abort(); return this.current ?? Promise.resolve(); }
  run(input,generation) {
    this.running=true; this.currentExploration=!input.gaze; const invalidationVersion=this.invalidationVersion; const controller=new AbortController(); this.controller=controller;
    const alive=()=>this.active && this.generation===generation && !controller.signal.aborted;
    const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    this.current=(async()=>{
      let trackerBefore, tracker, committed=false, stage='segmentation_failed';
      try {
        const result=await this.segment(structuredClone(input.frame),{signal:controller.signal,gaze:input.gaze ? structuredClone(input.gaze) : null});
        if(!alive()) return;
        if(this.segmentKind==='server_provider' && (result?.model!=='sam-3.1' || result?.frame?.frameId!==input.frame.frameId || result?.frame?.observedAt!==input.frame.observedAt)) { this.lastError='segmentation_mismatch'; return; }
        stage='tracking_failed';
        const processedAt=this.now(); if(!finite(processedAt)||processedAt<input.frame.processedAt||(input.gaze && processedAt<input.gaze.processedAt)) return;
        const f=input.frame,g=input.gaze;
        const mapKey=JSON.stringify([f.mapId,f.mapVersion,f.coordinateFrameId]); const mapChanged=this.mapKey!==null && this.mapKey!==mapKey; if(input.mapCorrection && (!mapChanged || input.mapCorrection.from?.mapId!==JSON.parse(this.mapKey)[0] || input.mapCorrection.from?.mapVersion!==JSON.parse(this.mapKey)[1] || input.mapCorrection.from?.coordinateFrameId!==JSON.parse(this.mapKey)[2])) throw new Error('invalid correction source'); const epoch=this.mapEpoch+(mapChanged?1:0); tracker=mapChanged?new ObjectTracker():this.tracker;
        trackerBefore=structuredClone({objects:tracker.objects,observations:tracker.observations,lineage:tracker.lineage,clock:tracker.clock,processedClock:tracker.processedClock,serial:tracker.serial,frameIds:tracker.frameIds});
        const observations=tracker.update({frameId:f.frameId,observedAt:f.observedAt,processedAt,causalStatus:f.causalStatus,provenance:f.provenanceKind,rgba:f.rgba,width:f.width,height:f.height,masks:result?.masks,depth:f.depth ?? null,coordinateFrameId:f.coordinateFrameId,sampleSurface:this.sampleSurface ? pixel=>this.sampleSurface(f,pixel,processedAt) : null,gaze:g ? {frameId:f.frameId,observedAt:g.observedAt,processedAt,causalStatus:g.causalStatus,pixel:[g.x*f.width,g.y*f.height],syncUncertaintyMs:g.syncUncertaintyMs,frameSyncUncertaintyMs:f.syncUncertaintyMs,framePresentTsEstimateMs:(f.presentTsEstimateMs === undefined ? f.observedAt : f.presentTsEstimateMs),alignmentBudgetMs:this.alignmentBudgetMs} : null});
        const conflicts=new Map();
        for(const o of observations) {
          if(o.identityStatus==='ambiguous') for(const id of o.candidateObjectIds) conflicts.set(id,'identity_changed');
          const previous=trackerBefore.objects.get(o.objectId);
          if(previous && JSON.stringify(previous.bounds)!==JSON.stringify(o.bounds)) conflicts.set(o.objectId,'observation_conflict');
        }
        for(const o of observations) { o.objectId=`p${this.identityNamespace}${generation}:${epoch}:${o.objectId}`; o.candidateObjectIds=o.candidateObjectIds.map(id=>`p${this.identityNamespace}${generation}:${epoch}:${id}`); o.mapId=f.mapId; o.mapVersion=f.mapVersion; o.coordinateFrameId=f.coordinateFrameId; }
        const point=input.event ?? g;
        const candidates=point ? observations.filter((o,i)=>maskContains(result.masks[i],point.x*f.width,point.y*f.height)).map(o=>o.objectId).slice(0,20) : [];
        const event=input.event ? {...input.event,processedAt,candidateObjectIds:candidates} : null;
        const evidence={id:f.frameId,observedAt:f.observedAt,bytes:f.rgba.byteLength+f.imageData.length*2,rgba:f.rgba,imageData:f.imageData,width:f.width,height:f.height,format:'rgba8_top_left',provenance:f.provenanceKind,mapId:f.mapId,mapVersion:f.mapVersion,coordinateFrameId:f.coordinateFrameId};
        if(!alive()) return;
        stage='memory_failed'; const stored=await this.memory.ingestPerception({frame:evidence,observations,event,mapCorrection:input.mapCorrection,now:processedAt},{signal:controller.signal}); committed=true; if(!alive()) return; if(mapChanged) this.runtime.invalidate?.({type:'map',mapId:JSON.parse(this.mapKey)[0]}); else for(const [id,type] of conflicts) this.runtime.invalidate?.({type,objectId:'p'+this.identityNamespace+generation+':'+epoch+':'+id}); this.tracker=tracker; this.mapKey=mapKey; this.mapEpoch=epoch;
        if(!alive()) return;
        if(!g) { this.lastError=null; this.commits++; try { this.onExplorationResult?.({count:observations.length}); } catch {} return; }
        const memory=[];
        for(const objectId of [...new Set(observations.map(o=>o.objectId))].slice(0,20)) {
          const prior=(await this.memory.retrieve({objectId,observedUntil:processedAt})).lastSeen;
          if(!alive()) return;
          const historical=f.observedAt>0 ? (await this.memory.retrieve({objectId,observedUntil:f.observedAt-Number.EPSILON*Math.max(1,f.observedAt)})).lastSeen : null;
          if(!alive()) return;
          for(const item of [prior,historical]) if(item && item.mapId===f.mapId && item.mapVersion===f.mapVersion && item.observedAt<=g.observedAt && item.causalStatus==='online_causal' && !memory.some(m=>m.evidenceId===item.observationId)) memory.push({evidenceId:item.observationId,text:JSON.stringify({objectId,bounds:item.bounds,identityStatus:item.identityStatus,mapId:item.mapId,mapVersion:item.mapVersion,coordinateFrameId:item.coordinateFrameId,surfacePointWorld:item.surfacePointWorld,surfaceProvenance:item.surfaceProvenance,gazeHitPointWorld:item.gazeHitPointWorld,gazeHitProvenance:item.gazeHitProvenance,objectAnchorWorld:null,positionMeaning:'last_seen_not_current'}),observedAt:item.observedAt,processedAt:item.processedAt,causalStatus:'online_causal'});
        }
        if(!alive()) return;
        if(this.pending) return;
        let memoryBytes=0; for(let i=0;i<memory.length;) { const bytes=new TextEncoder().encode(JSON.stringify(memory[i])).length; if(memoryBytes+bytes>8192) memory.splice(i,1); else { memoryBytes+=bytes; i++; } }
        const history=await this.memory.attentionHistory({observedUntil:g.observedAt,processedUntil:processedAt,limit:20});
        if(!alive() || this.pending) return;
        const eventInput=[]; let eventBytes=0;
        for(const e of history.slice().reverse()) {
          if(e.causalStatus!=='online_causal' || e.eventId===f.frameId || memory.some(m=>m.evidenceId===e.eventId) || typeof e.eventId!=='string' || !e.eventId || e.eventId.length>128 || !finite(e.dwellValidMs) || e.dwellValidMs>e.endAt-e.observedAt) continue;
          const event={eventId:e.eventId,type:e.type,observedAt:e.observedAt,endAt:e.endAt,processedAt:e.processedAt,dwellValidMs:e.dwellValidMs};
          if(e.x!=null && e.y!=null && Number.isFinite(e.x) && Number.isFinite(e.y) && e.x>=0 && e.x<1 && e.y>=0 && e.y<1) {event.x=e.x;event.y=e.y;}
          if(Array.isArray(e.candidateObjectIds) && e.candidateObjectIds.length<=20 && e.candidateObjectIds.every(id=>typeof id==='string' && id.length>0 && id.length<=64)) event.candidateObjectIds=e.candidateObjectIds;
          const bytes=new TextEncoder().encode(JSON.stringify(event)).length;
          if(eventBytes+bytes>6144) break;
          eventBytes+=bytes; eventInput.push(event);
        }
        eventInput.reverse();
        if(invalidationVersion!==this.invalidationVersion) return;
        stage='runtime_failed'; const runtimeInput={candidates:observations.filter(o=>o.identityStatus==='linked').slice(0,20).map(o=>({objectId:o.objectId,bounds:o.bounds})),observedUntil:g.observedAt,frame:{frameId:f.frameId,observedAt:f.observedAt,processedAt,imageData:f.imageData,sceneText:null,causalStatus:f.causalStatus,provenanceKind:f.provenanceKind},gaze:{x:g.x,y:g.y,observedAt:g.observedAt,processedAt:g.processedAt},events:eventInput,context:{memory},dependencies:{mapId:f.mapId,mapVersion:f.mapVersion,objectIds:[...new Set(observations.map(o=>o.objectId))],evidenceIds:[f.frameId,...eventInput.map(e=>e.eventId),...memory.map(m=>m.evidenceId)],expiresAt:processedAt+this.ttlMs}};
        const submitted=this.runtime.submit(runtimeInput);
        if(!submitted?.accepted) { this.lastError='runtime_rejected'; return; }
        if(this.onDecision) { const summary=structuredClone(runtimeInput); delete summary.frame.imageData; const presentAt=f.presentTsEstimateMs === undefined ? f.observedAt : f.presentTsEstimateMs; try { this.onDecision(summary,{renderAt:f.observedAt,presentAt,gazeAt:g.observedAt,frameUncertaintyMs:f.syncUncertaintyMs,gazeUncertaintyMs:g.syncUncertaintyMs,totalErrorMs:g.observedAt-presentAt+f.syncUncertaintyMs+g.syncUncertaintyMs,budgetMs:this.alignmentBudgetMs,issuedAt:processedAt}); } catch {} }
        this.lastError=null; this.commits++;
      } catch { if(trackerBefore && !committed) Object.assign(tracker,trackerBefore); if(alive()) this.lastError=stage; }
      finally { clearTimeout(timer); this.release(input.frame); this.running=false; this.controller=null; const next=this.pending; this.pending=null; if(this.active && next) this.run(next,this.generation); }
    })();
  }
}





