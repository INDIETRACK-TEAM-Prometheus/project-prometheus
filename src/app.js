import {createWorld} from './spatial/world.js';
import {createWebcamGazeController} from './gaze/webcam.js';
import {fitCalibration, calibrationMetrics} from './gaze/index.js';
import {MemoryService,EphemeralStorage} from './memory/index.js';
import {ProviderJournal,providerOperationId} from './runtime/provider-journal.js';
import {RuntimeFacade} from './runtime/facade.js';
import {alignGaze} from './core.js';
import {convertClock,createTimingTemplate,validateTimingCalibration} from './runtime/clock.js';
import {createSceneDiagnostic,flipRgba} from './spatial/scene-diagnostic.js';
import {PerceptionPipeline} from './runtime/perception.js';
import {createExploration} from './runtime/exploration.js';
import {createServerReasoner} from './runtime/server-providers.js';
import {openDurableSession,deleteDurableSlot} from './memory/session.js';
import {EvaluationLedger} from './evaluation/ledger.js';
import {selectFrozenSceneGaze,createFrozenGazeAutomation} from './gaze/frozen-demo.js';

// Only aggregate pilot measurements are exported; no video, landmarks or device ID.
export function gazeSamPrompt(frame, gaze) {
  if (!gaze || !Number.isInteger(frame?.width) || !Number.isInteger(frame?.height) || frame.width<1 || frame.height<1 || !Number.isFinite(gaze.x) || !Number.isFinite(gaze.y) || gaze.x<0 || gaze.x>=1 || gaze.y<0 || gaze.y>=1) throw new TypeError('invalid gaze point');
  return `<0f>1<|point;x=${Math.floor(gaze.x*frame.width)};y=${Math.floor(gaze.y*frame.height)};w=${frame.width};h=${frame.height}|>`;
}
export const provisionalSparkMinIntervalMs=30000;
export async function sendProvisionalSparkRequest({consent,frame,imageDataUrl,gazePoint,gazeTiming,masks,issuedAtMs,signal,fetchImpl=fetch}={}) {
  if(consent!==true)return {status:'withheld',reason:'consent_required'};
  if(!frame?.frameId||!Number.isFinite(frame.observedAt)||!Number.isInteger(frame.width)||!Number.isInteger(frame.height)||frame.width<1||frame.height<1||frame.width*frame.height>1048576||typeof imageDataUrl!=='string'||!Array.isArray(masks)||!Number.isFinite(gazePoint?.x)||gazePoint.x<0||gazePoint.x>=1||!Number.isFinite(gazePoint?.y)||gazePoint.y<0||gazePoint.y>=1||!Number.isFinite(gazeTiming?.captureAtMs)||!Number.isFinite(gazeTiming?.processedAtMs)||!Number.isFinite(issuedAtMs)||issuedAtMs<Math.max(frame.observedAt,gazeTiming.processedAtMs)||typeof fetchImpl!=='function')return {status:'failed'};
  if(signal?.aborted)return {status:'cancelled'};
  const body={consentScope:'provisional_spark',timingStatus:'provisional',frame:{frameId:frame.frameId,observedAt:frame.observedAt,width:frame.width,height:frame.height},imageDataUrl,gazePoint:{x:gazePoint.x,y:gazePoint.y,captureAtMs:gazeTiming.captureAtMs,processedAtMs:gazeTiming.processedAtMs},issuedAtMs,masks:masks.slice(0,10).map(mask=>mask?.bounds)};
  try {
    const response=await fetchImpl('/api/reason-provisional',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});
    if(signal?.aborted)return {status:'cancelled'};
    if(!response.ok)return {status:'failed'};
    const result=await response.json();
    if(signal?.aborted)return {status:'cancelled'};
    if(result?.timingStatus!=='provisional'||result.frame?.frameId!==frame.frameId||result.frame?.observedAt!==frame.observedAt||!Array.isArray(result.scenarios))return {status:'failed'};
    return {status:'ok',result};
  } catch {return {status:signal?.aborted?'cancelled':'failed'};}
}
export function timingPresentations(frame, calibration) {
  if(!frame?.frameId||!Number.isFinite(frame.renderTsMs)||calibration?.status!=='measurement_record_validated')return frame;
  const presentationByRegion={};
  for(const [region,model] of Object.entries(calibration.displayModels)){
    const result=convertClock(frame.renderTsMs,model);
    if(result.status==='ok')presentationByRegion[region]={presentTsEstimateMs:result.sessionMs,displayUncertaintyMs:result.uncertaintyMs};
  }
  return {...frame,presentationByRegion};
}
export function validSamConcept(value) { return typeof value==='string' && value.length<=256 && value.trim().length>0; }

export function createPreparationDisplay({element,now,onExpire=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}) {
  let timer=null, generation=0;
  function clear() { generation++;if(timer!==null)clearTimer(timer);timer=null;element.textContent='사전 준비 없음'; }
  function show(record) {
    clear();
    const remaining=record.expiresAt-now();
    if(record.deliveryState!=='silent_ready' || !Number.isFinite(record.observedUntil) || !Number.isFinite(remaining) || remaining<=0 || !Array.isArray(record.objectIds) || !Array.isArray(record.evidenceIds))return;
    element.textContent=`사전 준비: silent_ready · 관측 기준 ${record.observedUntil.toFixed(0)} ms · 만료 ${record.expiresAt.toFixed(0)} ms (세션 시계) · 객체 ${record.objectIds.length}개 · 증거 ${record.evidenceIds.length}개`;
    const token=generation;
    timer=setTimer(()=>{if(token!==generation)return;clear();onExpire();},remaining);
  }
  return {show,clear};
}

export function pilotReport(pilot, now, queue) {
  const end=pilot.stoppedAt ?? now;
  const durationMs=Math.max(0,end-pilot.startedAt-(pilot.pausedMs ?? 0)-(pilot.pauseStartedAt == null?0:end-pilot.pauseStartedAt));
  const valid=pilot.samples>0 && pilot.validSamples>0 && pilot.calibration?.passed===true && !pilot.calibration.invalidatedAtUtc;
  return {schemaVersion:1, startedAtUtc:pilot.startedAtUtc, exportedAtUtc:new Date().toISOString(), durationMs,
    pilot30Minutes:{targetMs:1800000,elapsed:durationMs>=1800000,status:durationMs>=1800000 && valid?'completed_with_valid_samples':'not_passed'},
    samples:pilot.samples,validGazeSamples:pilot.validSamples,faceDetectedSamples:pilot.faces,
    sampleRateHz:durationMs>0?pilot.samples*1000/durationMs:null, timestampKinds:{...pilot.timestampKinds},captureIntervalsMs:{count:pilot.intervalCount,mean:pilot.intervalCount?pilot.intervalSum/pilot.intervalCount:null,max:pilot.intervalCount?pilot.intervalMax:null},
    inferenceMs:{count:pilot.inferenceCount,mean:pilot.inferenceCount?pilot.inferenceSum/pilot.inferenceCount:null,max:pilot.inferenceCount?pilot.inferenceMax:null},
    cameraSettings:{...pilot.cameraSettings},calibration:pilot.calibration,queue:{pending:queue?.pending ?? null,dropped:queue?.dropped ?? null,peakPending:pilot.peakPending},
    opticalTimingUncertaintyMs:null,opticalTimingUnavailableReason:'capture and display optical timing not measured',cameraClockSync:{status:'unmeasured',sourceClockId:'browser_video_capture_estimate',offsetMs:null,driftPpm:null,uncertaintyMs:null,reason:'optical_reference_measurement_required'},scenePresentation:{presentTsEstimateMs:null,displayUncertaintyMs:null,reason:'display_presentation_not_measured'},sceneAssociation:'withheld_unverified_timing',frozenSceneDemo:pilot.frozenSceneDemo ?? {status:'not_used',timingStatus:'unverified',opticalTimingUncertaintyMs:null},syncGate:{status:'not_passed',t15:'not_run'},rawVideoIncluded:false,rawLandmarksIncluded:false};
}

export function createAlignedHandoff({isAllowed,getPipeline,encode,now,onFrame=()=>{},mapId='synthetic-world',coordinateFrameId='synthetic-world-frame'}) {
  return ({frame,gaze,event})=>{
    const pipeline=getPipeline();
    if(!isAllowed() || !pipeline || gaze?.sceneAssociationEligible!==true || gaze.timestampKind!=='browser_capture_estimate' || !Number.isFinite(gaze.syncUncertaintyMs) || !Number.isFinite(frame?.displayUncertaintyMs) || !frame.evidence || frame.evidence.id!==frame.frameId || alignGaze({valid:true,captureMs:gaze.timestampMs,syncUncertaintyMs:gaze.syncUncertaintyMs},[{id:frame.frameId,presentMs:frame.presentTsEstimateMs,displayUncertaintyMs:frame.displayUncertaintyMs}]).status!=='aligned')return {accepted:false,reason:'consent_or_alignment_unavailable'};
    const width=frame.viewport.width,height=frame.viewport.height,rgba=flipRgba(frame.evidence.rgba,width,height);
    const imageData=encode(rgba,width,height);if(!isAllowed() || pipeline!==getPipeline())return {accepted:false,reason:'cancelled'};
    onFrame({frameId:frame.frameId,observedAt:frame.renderTsMs,imageData});
    return pipeline.submit({frame:{frameId:frame.frameId,observedAt:frame.renderTsMs,presentTsEstimateMs:frame.presentTsEstimateMs,processedAt:now(),causalStatus:'online_causal',provenanceKind:'synthetic',mapId,mapVersion:1,coordinateFrameId,width,height,rgba,imageData,depth:null,syncUncertaintyMs:frame.displayUncertaintyMs},gaze:{frameId:frame.frameId,observedAt:gaze.timestampMs,processedAt:gaze.processedMs,causalStatus:'online_causal',x:gaze.viewportXY.x,y:gaze.viewportXY.y,syncUncertaintyMs:gaze.syncUncertaintyMs},event});
  };
}

export function createResearchTrace({isEnabled,ledger,onStatus=()=>{}}) {
  const frames=new Map(); let frameBytes=0;
  function clearFrames(){frames.clear();frameBytes=0;}
  return {
    clear(){clearFrames();ledger.clear();},
    cancelPending(){clearFrames();},
    withdrawEvidence(ids){for(const id of ids){const frame=frames.get(id);if(frame){frameBytes-=frame.imageData.length*2;frames.delete(id);}}ledger.withdrawEvidence(ids);},
    rememberFrame(frame){
      if(!isEnabled())return;
      const size=frame.imageData.length*2;if(size>ledger.maxBytes-ledger.bytes)return;
      const old=frames.get(frame.frameId);if(old)frameBytes-=old.imageData.length*2;
      frames.delete(frame.frameId);frames.set(frame.frameId,{...frame});frameBytes+=size;
      while(frames.size>ledger.maxDecisions || frameBytes+ledger.bytes>ledger.maxBytes){const key=frames.keys().next().value;frameBytes-=frames.get(key).imageData.length*2;frames.delete(key);}
    },
    decision(bundle,proof) {
      if(!isEnabled())return {stored:false,reason:'consent_required'};
      try {
        const frame=frames.get(bundle.frame?.frameId);
        if(!frame || frame.observedAt!==bundle.frame?.observedAt)return {stored:false,reason:'scene_image_unavailable'};
        clearFrames();
        bundle={...bundle,frame:{...bundle.frame,imageData:frame.imageData}};
        const alignment={presentTsEstimateMs:proof.presentAt,frameSyncUncertaintyMs:proof.frameUncertaintyMs,gazeSyncUncertaintyMs:proof.gazeUncertaintyMs,alignmentBudgetMs:proof.budgetMs};
        if(proof.renderAt!==bundle.frame?.observedAt || proof.gazeAt!==bundle.gaze?.observedAt)return {stored:false,reason:'alignment_mismatch'};
        const result=ledger.record(bundle,alignment,{issuedAt:proof.issuedAt,horizonMs:1000});onStatus(result);return result;
      } catch {const result={stored:false,reason:'invalid_or_unavailable_evidence'};onStatus(result);return result;}
    },
    outcome(frameId,scenarios,reasoner,nextGaze=null){clearFrames();return isEnabled() && ledger.recordOutcome(frameId,scenarios,reasoner,nextGaze);}
  };
}

// Immutable copies of the rendered RGBA framebuffer, not the live canvas.
export class FrameHistory {
  constructor({maxAgeMs=10000,maxBytes=128*1024*1024}={}) {this.maxAgeMs=maxAgeMs;this.maxBytes=maxBytes;this.frames=[];this.bytes=0;}
  add(frame, rgba, now) {
    if(!frame?.frameId || !(rgba instanceof Uint8Array) || rgba.byteLength!==frame.viewport.width*frame.viewport.height*4) return false;
    const bytes=rgba.byteLength; if(bytes>this.maxBytes)return false;
    const {image,...metadata}=frame;const evidence={id:frame.frameId,observedAt:frame.renderTsMs,bytes,rgba:rgba.slice(),width:frame.viewport.width,height:frame.viewport.height,format:'rgba8_bottom_left',provenance:'synthetic_framebuffer_copy'};
    this.frames.push({...metadata,evidence});this.bytes+=bytes;this.trim(now);return true;
  }
  trim(now) {while(this.frames.length && (now-this.frames[0].renderTsMs>this.maxAgeMs || this.bytes>this.maxBytes))this.bytes-=this.frames.shift().evidence.bytes;}
  at(captureMs,region=null) {
    for(const frame of [...this.frames].reverse()){
      const presentation=region?frame.presentationByRegion?.[region]:null;
      const presentMs=presentation?.presentTsEstimateMs??(region?null:frame.presentTsEstimateMs);
      if(presentMs!=null&&presentMs<=captureMs)return presentation?{...frame,presentTsEstimateMs:presentMs,displayUncertaintyMs:presentation.displayUncertaintyMs,displayRegion:region}:frame;
    }
    return null;
  }
  clear(){this.frames=[];this.bytes=0;}
}

export function mapSessionEvidence(sample,frame,offset,epoch,viewportXY) {
  const timedSample={...sample,viewportXY,timestampMs:Number.isFinite(sample.timestampMs)?sample.timestampMs+offset:sample.timestampMs,processedMs:Number.isFinite(sample.processedMs)?sample.processedMs+offset:sample.processedMs};
  const presentationByRegion=frame?.presentationByRegion?Object.fromEntries(Object.entries(frame.presentationByRegion).map(([id,p])=>[id,{...p,presentTsEstimateMs:p.presentTsEstimateMs+offset}])):undefined;
  const timedFrame=frame?{...frame,...(presentationByRegion?{presentationByRegion}:{}),frameId:epoch+frame.frameId,renderTsMs:frame.renderTsMs+offset,presentTsEstimateMs:frame.presentTsEstimateMs==null?null:frame.presentTsEstimateMs+offset,evidence:{...frame.evidence,id:epoch+frame.evidence.id,observedAt:frame.evidence.observedAt+offset}}:null;
  return {sample:timedSample,frame:timedFrame};
}

export function resolveWorldFrame(world,frame,offset,epoch) {
  if(!frame?.frameId?.startsWith(epoch))return null;
  const original=world.getHistoricalFrame(frame.frameId.slice(epoch.length));
  return original && original.renderTsMs+offset===frame.observedAt ? original : null;
}

// Dependency injection permits real wiring and race tests without camera hardware.
export function createCoordinator({controller, memory, runtime, onState=()=>{}, onAligned=()=>{}, maxPending=64, namespace=''}) {
  let generation=0, active=false, paused=false, draining=false, attention=null, eventNumber=0, pending=0, dropped=0, resetScheduled=false, chain=Promise.resolve();
  async function finish(now, token) {
    const a=attention; attention=null;
    if(!a)return {recorded:false,reason:'no_completed_event'};
    if(a.last<=a.start || !active || token!==generation){await memory.releaseEventPin(a.eventId);return {recorded:false,reason:'no_completed_event'};}
    const duration=a.last-a.start;
    const event={eventId:a.eventId,type:duration>=150?'fixated':'briefly_crossed',causalStatus:'online_causal',observedAt:a.start,processedAt:now,endAt:a.last,dwellValidMs:duration,candidateObjectIds:[],quality:'unassociated_screen_gaze'};
    let result;try{result=await memory.ingestEvent(event,[a.frameId],now,{requireExistingPin:true});}catch(error){await memory.releaseEventPin(a.eventId);throw error;}
    if(active && token===generation && a.frame && a.gaze){try{onAligned({frame:a.frame,gaze:a.gaze,event:{eventId:event.eventId,type:event.type,causalStatus:event.causalStatus,observedAt:event.observedAt,endAt:event.endAt,processedAt:event.processedAt,dwellValidMs:event.dwellValidMs,x:a.gaze.viewportXY.x,y:a.gaze.viewportXY.y}});}catch{}}
    return {recorded:true,...result};
  }
  async function process(sample,frame,token) {
    if(!active || token!==generation) return {recorded:false,reason:'stopped'};
    const now=Number.isFinite(sample?.processedMs)?sample.processedMs:performance.now();
    if (!sample?.valid || !sample.viewportXY) return finish(now,token);
    if(sample.sceneAssociationEligible!==true || sample.timestampKind!=='browser_capture_estimate' || !Number.isFinite(sample.timestampMs) || sample.timestampMs<0 || !Number.isFinite(sample.syncUncertaintyMs) || sample.syncUncertaintyMs<0) {await finish(now,token);return {recorded:false,reason:'unverified_camera_timing'};}
    if (!frame || frame.presentTsEstimateMs == null || frame.displayUncertaintyMs == null) {await finish(now,token);return {recorded:false,reason:'alignment_unavailable'};}
    const aligned=alignGaze({valid:true,captureMs:sample.timestampMs,syncUncertaintyMs:sample.syncUncertaintyMs},[{id:frame.frameId,presentMs:frame.presentTsEstimateMs,displayUncertaintyMs:frame.displayUncertaintyMs}]);
    if(aligned.status!=='aligned' || !frame.evidence || frame.evidence.id!==frame.frameId) {await finish(now,token);return {recorded:false,reason:'alignment_or_evidence_unavailable'};}
    if(attention && (sample.timestampMs<=attention.last || sample.timestampMs-attention.last>100 || Math.hypot(sample.viewportXY.x-attention.xy.x,sample.viewportXY.y-attention.xy.y)>.025)) await finish(now,token);
    if(!active || token!==generation || paused)return {recorded:false,reason:'stopped'};
    if(!attention) {
      const rawEvidence={...frame.evidence,id:`attention-raw-${frame.frameId}`};
      const eventId=`${namespace}attention-${++eventNumber}`;
      const pin=await memory.pinFrameForEvent(rawEvidence,eventId,now);
      if(!active || token!==generation || paused){await memory.releaseEventPin(eventId);return {recorded:false,reason:'stopped'};}
      attention={eventId,pin,start:sample.timestampMs,last:sample.timestampMs,xy:sample.viewportXY,frameId:rawEvidence.id,frame,gaze:sample};
    } else {attention.last=sample.timestampMs;attention.frame=frame;attention.gaze=sample;}
    return {recorded:false,reason:'collecting'};
  }
  return {
    async start() {
      if(draining || active) return {started:false,reason:'busy'};
      const token=++generation; onState('starting');
      try {
        const settings=await controller.start({userInitiated:true,cameraConsent:true});
        if (token!==generation) return {started:false,reason:'cancelled'};
        if (!settings) return {started:false,reason:'cancelled'};
        runtime.start(); active=true; paused=false; onState('active'); return {started:true,settings};
      } catch(error) { if(token===generation) { controller.stop(); onState('error'); } return {started:false,reason:'start_failed',error}; }
    },
    stop() { const token=++generation; active=false; paused=false; draining=true;const old=attention;attention=null;if(old)chain=chain.then(()=>memory.releaseEventPin(old.eventId));controller.stop();runtime.stop();onState('stopping');return chain.then(()=>{if(token===generation){draining=false;onState('stopped');}}); },
    pause() {if(!active || paused)return false; paused=true;generation++;const old=attention;attention=null;if(old)chain=chain.then(()=>memory.releaseEventPin(old.eventId));return true;},
    resume() {if(!active || !paused)return false;paused=false;return true;},
    async clear() { await this.stop(); await memory.close(); },
    replaceMemory(next) { memory=next; },
    status() { return {...runtime.status(),active,paused,pending,dropped}; },
    acceptSample(sample, frame) {
      if (!active || paused) return Promise.resolve({recorded:false,reason:paused?'paused':'stopped'});
      if(pending>=maxPending) { dropped++; if(!resetScheduled){resetScheduled=true;const token=generation;chain=chain.then(async()=>{if(token===generation){const old=attention;attention=null;if(old)await memory.releaseEventPin(old.eventId);}resetScheduled=false;}).catch(()=>{resetScheduled=false;});} return Promise.resolve({recorded:false,reason:'sample_queue_full'}); }
      const token=generation;pending++;
      const result=chain.then(()=>process(sample,frame,token)).finally(()=>pending--);chain=result.catch(()=>{});return result;
    }
  };
}

async function boot() {
  const $=s=>document.querySelector(s), canvas=$('#world'), video=$('#camera');
  const state=$('#state'), message=$('#message'), gazeStatus=$('#gazeStatus'), memoryStatus=$('#memoryStatus');
  const start=$('#start'), stop=$('#stop'), calibrate=$('#calibrate');
  let world=null, latest=null, candidate=null, coordinator=null, controller=null, calibrationStage=null, sequence=0, training=[], validation=[], screenSize=null, lastCopy=0, lastHistoryFrameId=null, maintenance=Promise.resolve(), timer=null,timingCalibration=null,pendingAligned=null,cameraSessionId=null,sceneFrozen=false,frozenScene=null,frozenGazeExpiry=null,frozenGazeResolve=null,frozenGazeGeneration=0,frozenGazeRequest=false,diagnosticPurpose='scene',diagnosticGazePoint=null,diagnosticGazeTiming=null,diagnosticRequestNumber=0,provisionalSparkController=null,provisionalSparkGeneration=0,provisionalSparkRequestNumber=0,lastProvisionalSparkAt=-Infinity,cameraStartPending=false;
  const clockSessionId=crypto.randomUUID();
  const history=new FrameHistory();
  let pilot=null, pilotTimer=null;
  function updatePilot() {
    if(!pilot)return;
    const end=pilot.stoppedAt ?? performance.now();const seconds=Math.floor(Math.max(0,end-pilot.startedAt-(pilot.pausedMs??0)-(pilot.pauseStartedAt==null?0:end-pilot.pauseStartedAt))/1000);
    $('#pilotStatus').textContent=`관찰 ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} / 30:00 · 샘플 ${pilot.samples}`;
  }
  $('#exportPilot').addEventListener('click',()=>{
    if(!pilot){message.textContent='내보낼 세션이 없습니다.';return;}
    const data=pilotReport(pilot,performance.now(),coordinator?.status());
    if(timingCalibration){data.opticalTimingUncertaintyMs=Math.max(timingCalibration.cameraClockModel.uncertaintyMs,...Object.values(timingCalibration.displayModels).map(m=>m.uncertaintyMs));data.opticalTimingUnavailableReason=null;data.cameraClockSync={status:'operator_supplied_measurement_record_loaded',sourceClockId:timingCalibration.sourceClockId,offsetMs:timingCalibration.cameraClockModel.sessionAnchorMs-timingCalibration.cameraClockModel.sourceAnchorMs,driftPpm:timingCalibration.cameraClockModel.driftPpm,uncertaintyMs:timingCalibration.cameraClockModel.uncertaintyMs,profileId:timingCalibration.profileId,evidenceSha256:timingCalibration.reference.evidenceSha256};data.scenePresentation={status:'operator_supplied_optical_measurements_loaded',regions:Object.fromEntries(Object.entries(timingCalibration.displayModels).map(([id,m])=>[id,{offsetMs:m.sessionAnchorMs-m.sourceAnchorMs,driftPpm:m.driftPpm,uncertaintyMs:m.uncertaintyMs}]))};data.sceneAssociation='runtime_alignment_active_t15_unverified';data.syncGate={status:'not_passed',t15:'not_run'};}
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='prometheus-pilot-summary.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    message.textContent='요약을 내보냈습니다. 영상, 랜드마크, 카메라 ID는 포함하지 않습니다.';
  });
  function timingSetup(){return {userAgent:navigator.userAgent,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio:window.devicePixelRatio||1,screenX:window.screenX,screenY:window.screenY,screenWidth:screen.width,screenHeight:screen.height},camera:{modelLabel:$('#timingCameraLabel').value.trim(),width:video.videoWidth,height:video.videoHeight,frameRate:pilot?.cameraSettings.reportedFrameRate??null}};}
  function sameTimingSetup(a,b){return a?.userAgent===b.userAgent&&['width','height','devicePixelRatio','screenX','screenY','screenWidth','screenHeight'].every(key=>a.viewport?.[key]===b.viewport[key])&&['modelLabel','width','height','frameRate'].every(key=>a.camera?.[key]===b.camera[key]);}
  $('#exportTimingTemplate').addEventListener('click',()=>{
    const setup=timingSetup();if(!coordinator?.status().active||!cameraSessionId||!setup.camera.modelLabel||!setup.camera.frameRate){$('#timingStatus').textContent='카메라를 시작하고 모델 라벨과 실제 프레임 속도를 확인하세요.';return;}
    const data=createTimingTemplate({browserSessionId:clockSessionId,cameraSessionId,setup});
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='prometheus-optical-timing-template.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    $('#timingStatus').textContent='현재 브라우저 세션 전용 템플릿 내보냄 · 실제 측정쌍과 원본 로그가 필요합니다.';
  });
  $('#loadTiming').addEventListener('click',async()=>{
    try{
      if(!coordinator?.status().active||!pilot||latest?.timestampKind!=='browser_capture_estimate'||!Number.isFinite(latest?.captureSourceMs))throw new Error('captureTime이 있는 카메라 세션을 시작하고 측정 카메라 라벨을 입력하세요.');
      const manifest=$('#timingProfile').files[0],evidence=$('#timingEvidence').files[0];if(!manifest||!evidence)throw new Error('측정 manifest와 원본 광학 로그 파일을 모두 선택하세요.');
      const profile=JSON.parse(await manifest.text()),record=validateTimingCalibration(profile,{browserSessionId:clockSessionId,cameraSessionId,setup:timingSetup(),performanceNowMs:performance.now(),captureSourceMs:latest.captureSourceMs});
      const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await evidence.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');
      if(record.reference.evidenceFile!==evidence.name||record.reference.evidenceSha256.toLowerCase()!==digest)throw new Error('원본 로그 파일 이름 또는 SHA-256이 manifest와 다릅니다.');
      controller.setTimingCalibration(record);timingCalibration=record;pendingAligned=null;pilot.timingCalibration={profileId:record.profileId,referenceFile:evidence.name,evidenceSha256:digest,intendedDurationMs:record.intendedDurationMs,t15Status:'not_run'};
      $('#timingStatus').textContent=`외부 광학 측정 기록 적용 · clock drift ${record.cameraClockModel.driftPpm.toFixed(1)} ppm · 카메라 불확실성 ${record.cameraClockModel.uncertaintyMs.toFixed(2)} ms · T15 미실행`;
      $('#runGazeSam').disabled=true;$('#gazeSamStatus').textContent='다음 정렬된 프레임 대기 · 네트워크 전송은 버튼 입력 필요';
    }catch(error){timingCalibration=null;pendingAligned=null;controller?.setTimingCalibration(null);$('#timingStatus').textContent=`정렬 보류 · ${error?.message||'측정 기록 확인 실패'}`;$('#runGazeSam').disabled=true;}
  });
  const sizeCanvas=()=>{const r=canvas.getBoundingClientRect(), d=window.devicePixelRatio||1;canvas.width=Math.max(1,Math.round(r.width*d));canvas.height=Math.max(1,Math.round(r.height*d));};
  sizeCanvas();
  try { world=createWorld(canvas);
    const draw=ts=>{
      if(!sceneFrozen)world.render(ts);history.trim(ts);
      const current=world.getFrame();
      if(coordinator?.status().active && current && current.frameId!==lastHistoryFrameId && ts-lastCopy>=200){try{const f=timingPresentations(current,timingCalibration),bytes=canvas.width*canvas.height*4;if(bytes>history.maxBytes)throw Error('frame exceeds budget');const gl=canvas.getContext('webgl'),rgba=new Uint8Array(bytes);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,rgba);history.add(f,rgba,ts);lastCopy=ts;lastHistoryFrameId=current.frameId;}catch{memoryStatus.textContent='장면 증거 복사 실패';}}
      requestAnimationFrame(draw);
    };requestAnimationFrame(draw);
    $('.worldfoot').innerHTML='<span>시선 연결 <strong>시간 정렬 보류</strong></span><span>Depth <strong>engine geometry</strong></span><span>마스크 <strong>API 차단</strong></span>'; }
  catch { message.textContent='WebGL을 사용할 수 없어 3D 장면을 표시할 수 없습니다.'; }
  for(const id of ['leftEye','rightEye']) {const container=$('#'+id);container.innerHTML='<canvas width="320" height="150"></canvas><small>카메라 시작 및 눈 검출 필요</small>';}
  let journalSessionId=crypto.randomUUID(),journal=await ProviderJournal.open({storage:new EphemeralStorage(),sessionId:journalSessionId});
  const journalCall=async(route,frameId,call)=>{const current=journal,id=journalSessionId;return current.run(await providerOperationId(id,route,frameId),call);};
  let diagnosticLayers=null;
  function drawDiagnostic(){
    if(!diagnosticLayers)return;
    const {frame,pixels,overlay,depth}=diagnosticLayers,c=$('#sceneSnapshot');c.width=frame.width;c.height=frame.height;
    const ctx=c.getContext('2d');
    if($('#showSceneRgb').checked)ctx.putImageData(new ImageData(pixels,frame.width,frame.height),0,0);
    if(depth && $('#showSceneDepth').checked){const layer=document.createElement('canvas');layer.width=depth.width;layer.height=depth.height;const data=new Uint8ClampedArray(depth.width*depth.height*4);for(let i=0;i<depth.values.length;i++){const v=depth.values[i];if(Number.isFinite(v)){const shade=Math.round(255*(1-Math.min(v,15)/15));data.set([shade,shade,shade,255],i*4);}}layer.getContext('2d').putImageData(new ImageData(data,depth.width,depth.height),0,0);ctx.imageSmoothingEnabled=false;ctx.drawImage(layer,0,0,frame.width,frame.height);}
    if($('#showSceneMask').checked){const layer=document.createElement('canvas');layer.width=frame.width;layer.height=frame.height;layer.getContext('2d').putImageData(new ImageData(overlay,frame.width,frame.height),0,0);ctx.drawImage(layer,0,0);}
    if(diagnosticLayers.gazePoint){const x=diagnosticLayers.gazePoint.x*frame.width,y=diagnosticLayers.gazePoint.y*frame.height;ctx.save();ctx.strokeStyle='#fff';ctx.lineWidth=Math.max(2,frame.width/320);ctx.beginPath();ctx.arc(x,y,Math.max(7,frame.width/100),0,Math.PI*2);ctx.moveTo(x-Math.max(10,frame.width/80),y);ctx.lineTo(x+Math.max(10,frame.width/80),y);ctx.moveTo(x,y-Math.max(10,frame.width/80));ctx.lineTo(x,y+Math.max(10,frame.width/80));ctx.stroke();ctx.restore();}
    c.hidden=false;
  }
  for(const id of ['showSceneRgb','showSceneMask','showSceneDepth'])$('#'+id).addEventListener('change',drawDiagnostic);
  const diagnostic=createSceneDiagnostic({
    pin:frame=>world.pinFrame({frameId:frame.frameId,renderTsMs:frame.observedAt}).status==='ok',
    release:frame=>world.releaseFrame({frameId:frame.frameId,renderTsMs:frame.observedAt}),
    sampleDepth:frame=>world.samplePinnedDepth({frameId:frame.frameId,renderTsMs:frame.observedAt}),
    encode:async(pixels,width,height)=>{const c=document.createElement('canvas');c.width=width;c.height=height;c.getContext('2d').putImageData(new ImageData(pixels,width,height),0,0);return c.toDataURL('image/png');},
    request:async(body,signal)=>journalCall('scene-diagnostic',`${epoch}${body.frame.frameId}:${++diagnosticRequestNumber}`,async()=>{if(signal?.aborted)throw new Error('operation cancelled');const response=await fetch('/api/sam/segment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});if(!response.ok)throw new Error('diagnostic unavailable');return response.json();}),
    display:({frame,pixels,overlay,depth,count,provider,model,masks,imageDataUrl})=>{
      diagnosticLayers={frame,pixels,overlay,depth,gazePoint:diagnosticPurpose==='frozen-gaze-demo'?diagnosticGazePoint:null};drawDiagnostic();
      $('#runtimeStatus').textContent=diagnosticPurpose==='frozen-gaze-demo'?'SAM 응답 확인 · 잠정 Spark 동의 확인 중':'SAM 응답 확인 · Spark 대기';
      $('#sceneStatus').textContent=diagnosticPurpose==='frozen-gaze-demo'
        ? `잠정 고정 장면 시험 · ${frame.frameId} · 웹캠 시선점 ${diagnosticGazePoint.x.toFixed(3)}, ${diagnosticGazePoint.y.toFixed(3)} · 시간 미검증 · ${provider==='Meta'?'Meta':'provider unknown'} ${model==='sam-3.1'?'SAM 3.1':'model unknown'} · 같은 프레임 마스크 ${count}개`
        : `고정 프레임 ${frame.frameId} · 관측 ${frame.observedAt.toFixed(1)} ms · 처리 ${performance.now().toFixed(1)} ms · ${provider==='Meta'?'Meta':'provider unknown'} ${model==='sam-3.1'?'SAM 3.1':'model unknown'} · 마스크 ${count}개`;
      if(diagnosticPurpose==='frozen-gaze-demo')void requestProvisionalSpark({frame,imageDataUrl,masks,gazePoint:diagnosticGazePoint,gazeTiming:diagnosticGazeTiming});
    }
  });
  function cancelDiagnostic(){diagnostic.cancel();cancelProvisionalSpark();diagnosticLayers=null;diagnosticGazePoint=null;diagnosticGazeTiming=null;diagnosticPurpose='scene';$('#runScene').disabled=false;$('#sceneSnapshot').hidden=true;$('#sceneStatus').textContent='장면 진단 취소됨';}
  function calibrationPassed(){return pilot?.calibration?.passed===true&&!pilot.calibration.invalidatedAtUtc;}
  function frozenGazeAllowed(){const session=coordinator?.status();return !!session?.active&&!session.paused&&calibrationPassed()&&$('#localConsent').checked&&$('#remoteConsent').checked;}
  function provisionalSparkAllowed(frame){return frozenGazeAllowed()&&$('#provisionalSparkConsent').checked&&sceneFrozen&&frozenScene?.frame.frameId===frame?.frameId&&frozenScene.frame.observedAt===frame?.observedAt;}
  function cancelProvisionalSpark(status='잠정 Spark 결과 폐기 · 물리적 시간 정렬 미검증'){
    provisionalSparkGeneration++;const pending=provisionalSparkController;provisionalSparkController=null;pending?.abort();$('#provisionalSparkScenarios').replaceChildren();$('#provisionalSparkStatus').textContent=status;
  }
  async function requestProvisionalSpark({frame,imageDataUrl,masks,gazePoint,gazeTiming}){
    if(!provisionalSparkAllowed(frame)){
      if(!$('#provisionalSparkConsent').checked)$('#provisionalSparkStatus').textContent='SAM 결과만 표시 · 잠정 Spark 별도 동의 필요 · 물리적 시간 정렬 미검증';
      return;
    }
    if(provisionalSparkController){$('#provisionalSparkStatus').textContent='잠정 Spark 분석 중 · 시간 정렬 미검증';return;}
    const now=performance.now(),remaining=provisionalSparkMinIntervalMs-(now-lastProvisionalSparkAt);
    if(remaining>0){$('#provisionalSparkStatus').textContent=`잠정 Spark 대기 · 다음 호출까지 ${Math.ceil(remaining/1000)}초 · 물리적 시간 정렬 미검증`;return;}
    const token=++provisionalSparkGeneration,requestController=new AbortController();provisionalSparkController=requestController;lastProvisionalSparkAt=now;
    $('#provisionalSparkStatus').textContent='잠정 Spark 유료 분석 중 · 물리적 시간 정렬 미검증';
    const id=`${epoch}${frame.frameId}:${++provisionalSparkRequestNumber}`;
    let outcome;
    try{outcome=await journalCall('provisional-spark',id,()=>sendProvisionalSparkRequest({consent:true,frame,imageDataUrl,gazePoint,gazeTiming,masks,issuedAtMs:performance.now(),signal:requestController.signal}));}catch{outcome={status:requestController.signal.aborted?'cancelled':'failed'};}
    if(token!==provisionalSparkGeneration||requestController.signal.aborted||!provisionalSparkAllowed(frame)){if(provisionalSparkController===requestController)provisionalSparkController=null;return;}
    if(outcome.status==='ok'){
      const scenarios=outcome.result.scenarios.filter(s=>typeof s?.possible_next_action==='string').slice(0,5),list=$('#provisionalSparkScenarios');list.replaceChildren();
      for(const scenario of scenarios){const li=document.createElement('li');li.textContent=scenario.possible_next_action;list.appendChild(li);}
      $('#runtimeStatus').textContent='SAM + Spark 잠정 응답 · 시간 정렬 미검증';
      $('#provisionalSparkStatus').textContent=scenarios.length?`잠정 Spark 가설 ${scenarios.length}개 · 프레임 ${frame.frameId} · 물리적 시간 정렬 미검증`:`Spark가 시나리오를 보류했습니다 · 잠정 · 물리적 시간 정렬 미검증`;
    }else if(outcome.status==='failed')$('#provisionalSparkStatus').textContent='Spark 요청 실패 또는 예산 제한 · SAM 결과는 유지 · 물리적 시간 정렬 미검증';
    if(provisionalSparkController===requestController)provisionalSparkController=null;
  }
  function updateFrozenGazeControls(){
    $('#resumeWorld').disabled=!sceneFrozen&&!frozenGazeAutomation.status().active;
  }
  function cancelFrozenGazeExpiry(){
    if(frozenGazeExpiry!==null)clearTimeout(frozenGazeExpiry);
    frozenGazeExpiry=null;const resolve=frozenGazeResolve;frozenGazeResolve=null;resolve?.();
  }
  function clearFrozenGazeDemo(reason='잠정 시선 시험 취소됨',unfreeze=true){
    const wasFrozenDemo=sceneFrozen||frozenGazeRequest||frozenGazeAutomation.status().active||diagnosticPurpose==='frozen-gaze-demo';
    frozenGazeAutomation.stop();frozenGazeGeneration++;cancelFrozenGazeExpiry();frozenGazeRequest=false;cancelProvisionalSpark(`잠정 Spark 결과 폐기 · ${reason}`);
    if(wasFrozenDemo){diagnostic.cancel();diagnosticLayers=null;diagnosticGazePoint=null;diagnosticGazeTiming=null;diagnosticPurpose='scene';$('#sceneSnapshot').hidden=true;$('#sceneStatus').textContent=reason;}
    if(unfreeze){sceneFrozen=false;frozenScene=null;}
    if(reason.includes('철회')&&pilot)delete pilot.frozenSceneDemo;
    $('#gazeSamDemoStatus').textContent=reason;
    updateFrozenGazeControls();
  }
  async function runFrozenGazeSample(){
    if(!sceneFrozen||!frozenScene||!frozenGazeAllowed()||frozenGazeRequest)return;
    const token=++frozenGazeGeneration,sampleAfterMs=Math.max(frozenScene.stableAfterMs,performance.now()+1500),delay=Math.max(0,sampleAfterMs-performance.now());
    $('#gazeSamDemoStatus').textContent='고정 장면에서 1.5초 동안 시선 표본 수집 중 · 캡처 시각은 브라우저 추정이며 물리적 시간 정렬은 미검증입니다.';
    await new Promise(resolve=>{frozenGazeResolve=resolve;frozenGazeExpiry=setTimeout(()=>{frozenGazeExpiry=null;frozenGazeResolve=null;resolve();},delay);});
    if(token!==frozenGazeGeneration||!sceneFrozen||!frozenScene||!frozenGazeAllowed())return;
    const selected=selectFrozenSceneGaze({sample:latest,frame:frozenScene.frame,canvasRect:canvas.getBoundingClientRect(),frozenAtMs:frozenScene.frozenAtMs,stableAfterMs:sampleAfterMs,nowMs:performance.now()});
    if(selected.status!=='ready'){$('#gazeSamDemoStatus').textContent=`시선 표본 보류 · ${selected.reason} · 5초 후 다시 확인합니다. 시간 정렬은 미검증입니다.`;updateFrozenGazeControls();return;}
    if(!frozenGazeAllowed())return;
    frozenGazeRequest=true;diagnosticPurpose='frozen-gaze-demo';diagnosticGazePoint=selected.point;diagnosticGazeTiming={captureAtMs:selected.captureAtMs,processedAtMs:selected.processedAtMs};$('#sceneSnapshot').hidden=true;$('#runScene').disabled=true;$('#gazeSamDemoStatus').textContent=`잠정 점 ${Math.floor(selected.point.x*frozenScene.frame.width)}, ${Math.floor(selected.point.y*frozenScene.frame.height)} px · Meta SAM 유료 요청 중 · 시선 시각/물리적 정렬 미검증`;updateFrozenGazeControls();
    let result;try{result=await diagnostic.run(frozenScene.frame,frozenScene.rgba.slice(),gazeSamPrompt(frozenScene.frame,selected.point));}catch{result={status:'failed'};}
    if(token!==frozenGazeGeneration)return;
    frozenGazeRequest=false;diagnosticPurpose='scene';diagnosticGazePoint=null;diagnosticGazeTiming=null;$('#runScene').disabled=false;
    if(result.status==='ok'){$('#gazeSamDemoStatus').textContent=`SAM 결과 표시됨 · 고정 프레임 ${frozenScene.frame.frameId} · 같은 프레임 마스크와 잠정 시선점 · 물리적 시간 정렬 미검증 · 다음 호출은 5초 이상 후`;if(pilot){pilot.frozenSceneDemo={status:'unverified_used',timingStatus:selected.timingStatus,opticalTimingUncertaintyMs:null,maxAcceptedCaptureProcessingLagMs:selected.maxCaptureProcessingLagMs,maxObservedCaptureProcessingLagMs:selected.captureProcessingLagMs,maxAcceptedProcessingAgeMs:selected.maxAcceptedProcessingAgeMs,maxAcceptedSampleAgeMs:selected.maxAcceptedSampleAgeMs,sampleCount:(pilot.frozenSceneDemo?.sampleCount??0)+1,samCalls:(pilot.frozenSceneDemo?.samCalls??0)+1};}}
    else $('#gazeSamDemoStatus').textContent=result.status==='cancelled'?'SAM 요청 취소됨 · 동의/세션 확인 후 다시 시작합니다.':'SAM 요청 실패 · 원격 서비스 또는 네트워크를 확인하세요. 시간 정렬은 미검증입니다.';
    updateFrozenGazeControls();
  }
  const frozenGazeAutomation=createFrozenGazeAutomation({run:runFrozenGazeSample,now:()=>performance.now(),intervalMs:5000});
  function maybeStartFrozenGazeAutomation(){
    if(!frozenGazeAllowed()||frozenGazeAutomation.status().active)return false;
    const source=world?.getFrame();if(!source){$('#gazeSamDemoStatus').textContent='장면 프레임 대기 · 원격 전송은 아직 시작하지 않았습니다.';return false;}
    const bytes=source.viewport.width*source.viewport.height*4;if(bytes>history.maxBytes){$('#gazeSamDemoStatus').textContent='장면이 메모리 한도를 초과해 자동 탐색을 시작하지 않았습니다.';return false;}
    try{const gl=canvas.getContext('webgl');if(!gl)throw new Error('webgl unavailable');const rgba=new Uint8Array(bytes);gl.readPixels(0,0,source.viewport.width,source.viewport.height,gl.RGBA,gl.UNSIGNED_BYTE,rgba);const frozenAtMs=performance.now();frozenScene={frame:{frameId:source.frameId,observedAt:source.renderTsMs,width:source.viewport.width,height:source.viewport.height},rgba,frozenAtMs,stableAfterMs:frozenAtMs+500};sceneFrozen=true;}
    catch{sceneFrozen=false;frozenScene=null;$('#gazeSamDemoStatus').textContent='가상 장면 프레임 보존 실패 · 자동 전송을 시작하지 않았습니다.';updateFrozenGazeControls();return false;}
    diagnosticPurpose='scene';diagnosticGazePoint=null;diagnosticLayers=null;$('#sceneSnapshot').hidden=true;$('#sceneStatus').textContent='가상 장면 고정 · 잠정 시선 SAM 자동 탐색 · 시간 미검증';
    $('#gazeSamDemoStatus').textContent='고정 장면을 준비했습니다 · 최근 시선 표본 확인 후 SAM 요청을 시작합니다.';frozenGazeAutomation.start();updateFrozenGazeControls();return true;
  }
  $('#resumeWorld').addEventListener('click',()=>clearFrozenGazeDemo('자동 탐색 중단 · 가상 장면 재개'));
  $('#remoteConsent').addEventListener('change',()=>{
    if(!$('#remoteConsent').checked){clearFrozenGazeDemo('자동 탐색 동의 철회 · 대기 프레임/결과 폐기');cancelDiagnostic();stopRemote();}
    else {startRemote();maybeStartFrozenGazeAutomation();}
    updateFrozenGazeControls();updateGazeSamButton();
  });
  $('#provisionalSparkConsent').addEventListener('change',()=>{
    if(!$('#provisionalSparkConsent').checked)cancelProvisionalSpark('잠정 Spark 동의 철회 · 진행 중 요청 취소 및 결과 폐기');
    else $('#provisionalSparkStatus').textContent='별도 동의 완료 · 다음 자동 SAM 성공 후 Spark 전송 · 물리적 시간 정렬 미검증';
  });
  $('#runScene').addEventListener('click',async()=>{
    if(!$('#remoteConsent').checked){$('#sceneStatus').textContent='장면 전송 동의가 필요합니다.';return;}
    const frame=world?.getFrame();if(!frame){$('#sceneStatus').textContent='렌더된 장면이 없습니다.';return;}
    const bytes=frame.viewport.width*frame.viewport.height*4;if(bytes>history.maxBytes){$('#sceneStatus').textContent='장면이 너무 큽니다.';return;}
    const rgba=new Uint8Array(bytes),gl=canvas.getContext('webgl');gl.readPixels(0,0,frame.viewport.width,frame.viewport.height,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
    diagnosticLayers=null;$('#runScene').disabled=true;$('#sceneSnapshot').hidden=true;$('#sceneStatus').textContent='고정 장면 마스크 요청 중';
    const result=await diagnostic.run({frameId:frame.frameId,observedAt:frame.renderTsMs,width:frame.viewport.width,height:frame.viewport.height},rgba);
    if(result.status!=='cancelled'){$('#runScene').disabled=false;if(result.status!=='ok')$('#sceneStatus').textContent='장면 진단 실패 또는 사용 불가';}
  });
  let sessionOffset=0,epoch=crypto.randomUUID()+'-',durableSession=null,sessionStarted=false,sessionSelecting=false,retentionGeneration=0;
  const sessionNow=()=>performance.now()+sessionOffset;
  const researchLedger=new EvaluationLedger();
  const researchTrace=createResearchTrace({isEnabled:()=>$('#traceConsent').checked,ledger:researchLedger,onStatus:result=>{$('#traceStatus').textContent=result.stored?`연구 기록 ${researchLedger.entries.length}건 · 비교 재생 미실행`:`연구 기록 보류: ${result.reason}`;}});
  $('#traceConsent').addEventListener('change',()=>{if(!$('#traceConsent').checked){researchTrace.clear();$('#traceStatus').textContent='연구 기록 삭제됨 · 비교 재생 미실행';}else $('#traceStatus').textContent='연구 기록 대기 · 시간 정렬 검증 필요';});
  $('#deleteTrace').addEventListener('click',()=>{researchTrace.clear();$('#traceStatus').textContent='연구 기록 삭제됨 · 비교 재생 미실행';});
  $('#exportTrace').addEventListener('click',()=>{if(!$('#traceConsent').checked){$('#traceStatus').textContent='연구 기록 동의가 필요합니다.';return;}const url=URL.createObjectURL(new Blob([JSON.stringify(researchLedger.export(),null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='prometheus-research-trace.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  const preparation=createPreparationDisplay({element:$('#preparationStatus'),now:sessionNow,onExpire:()=>{$('#nextGazeStatus').textContent='다음 시선 예측 없음';$('#scenarios').replaceChildren();$('#scenarioStatus').textContent='사전 준비 만료 · 시나리오 철회';}});
  let remotePipeline=null, remoteRuntime=null, remoteGeneration=0,alignedExpiryTimer=null;
  function updateGazeSamButton(){const ready=!!pendingAligned&&!!timingCalibration&&!!remotePipeline&&$('#gazeSamConsent').checked&&$('#remoteConsent').checked&&$('#reasonConsent').checked&&!!coordinator?.status().active&&!coordinator.status().paused;$('#runGazeSam').disabled=!ready;}
  function stopRemote(){researchTrace.cancelPending();remoteGeneration++;const pipeline=remotePipeline;remotePipeline=null;remoteRuntime?.stop();remoteRuntime=null;pipeline?.stop();pendingAligned=null;if(alignedExpiryTimer!==null)clearTimeout(alignedExpiryTimer);alignedExpiryTimer=null;$('#scenarios').replaceChildren();$('#nextGazeStatus').textContent='다음 시선 예측 없음';preparation.clear();$('#scenarioStatus').textContent='시나리오 준비 보류';updateGazeSamButton();}
  function startRemote(){
    if(remotePipeline || !coordinator?.status().active || coordinator.status().paused || !$('#remoteConsent').checked || !calibrationPassed())return;
    const sessionId=crypto.randomUUID(),token=++remoteGeneration;
    const reasoner=createServerReasoner({remoteConsent:true,journal,sessionId:journalSessionId});
    const rt=new RuntimeFacade({sessionId,analyzer:reasoner,now:sessionNow,timeoutMs:90000,minIntervalMs:1000,maxCallsPerMinute:10,maxCostPerMinute:1,estimatedCostPerCall:.05,publish:result=>{
      if(token!==remoteGeneration || !$('#remoteConsent').checked || !$('#reasonConsent').checked)return;
      researchTrace.outcome(result.id,result.scenarios,result.reasoner,result.nextGaze);
      $('#nextGazeStatus').textContent=result.nextGaze?.rankedTargetIds.length ? `다음 시선 가설 (1초): ${result.nextGaze.rankedTargetIds.join(', ')}` : '다음 시선 예측 없음';
      preparation.show(result);
      const list=$('#scenarios');list.replaceChildren();for(const scenario of result.scenarios.slice(0,5)){const li=document.createElement('li');li.textContent=scenario.possible_next_action;list.appendChild(li);}
      $('#scenarioStatus').textContent=result.scenarios.length?'시나리오 가설 · 불확실한 추정':'모델이 시나리오를 보류했습니다';
    }});
    const segment=async(frame,{signal,gaze})=>journalCall('segmentation-'+sessionId,frame.frameId,async()=>{if(signal?.aborted)throw new Error('operation cancelled');const response=await fetch('/api/sam/segment',{method:'POST',headers:{'content-type':'application/json'},signal,body:JSON.stringify({frame:{frameId:frame.frameId,observedAt:frame.observedAt},imageDataUrl:frame.imageData,prompt:gaze ? gazeSamPrompt(frame,gaze) : $('#samConcept').value.trim()})});if(!response.ok)throw new Error('segmentation unavailable');const result=await response.json();if(result.frame?.frameId!==frame.frameId || result.frame?.observedAt!==frame.observedAt)throw new Error('frame mismatch');return result;});
    remoteRuntime=rt;remotePipeline=new PerceptionPipeline({segment,segmentKind:'server_provider',identityNamespace:sessionId,memory,runtime:rt,now:sessionNow,ttlMs:120000,onExplorationResult:({count})=>{if($('#exploreConsent').checked) $('#exploreStatus').textContent=count ? `장면 탐색 결과 · 마스크 ${count}개 검출 · 범위 미검증` : '장면 탐색 결과 · 검출된 마스크 없음 · 물체 부재를 의미하지 않음';},onDecision:(bundle,proof)=>researchTrace.decision(bundle,proof),pinFrame:f=>{const original=resolveWorldFrame(world,f,sessionOffset,epoch);return !!original && world.pinFrame(original).status==='ok';},releaseFrame:f=>{const original=resolveWorldFrame(world,f,sessionOffset,epoch);return !!original && world.releaseFrame(original);},sampleSurface:(f,pixel,processedAt)=>{const original=resolveWorldFrame(world,f,sessionOffset,epoch);if(!original)return null;const value=world.samplePinnedSurface({...f,frameId:original.frameId,observedAt:original.renderTsMs,coordinateFrameId:'synthetic-world-frame'},pixel,Math.max(original.renderTsMs,processedAt-sessionOffset));return value?{...value,frameId:f.frameId,observedAt:f.observedAt,processedAt,coordinateFrameId:f.coordinateFrameId}:null;}});rt.start();remotePipeline.start(sessionId);
    $('#scenarioStatus').textContent='동기화 검증된 시선 대기';updateGazeSamButton();
  }
  const handoff=createAlignedHandoff({
    isAllowed:()=>!!remotePipeline && $('#remoteConsent').checked && $('#reasonConsent').checked && $('#gazeSamConsent').checked && !!coordinator?.status().active && !coordinator.status().paused,
    getPipeline:()=>remotePipeline,now:sessionNow,onFrame:frame=>researchTrace.rememberFrame(frame),mapId:'synthetic-world-'+epoch,coordinateFrameId:'synthetic-world-frame-'+epoch,
    encode:(rgba,width,height)=>{const c=document.createElement('canvas');c.width=width;c.height=height;c.getContext('2d').putImageData(new ImageData(rgba,width,height),0,0);return c.toDataURL('image/png');}
  });
  const exploration=createExploration({allowed:()=>$('#exploreConsent').checked && $('#remoteConsent').checked && validSamConcept($('#samConcept').value) && !!coordinator?.status().active && !coordinator.status().paused, pipeline:()=>remotePipeline, now:sessionNow, snapshot:()=>{
    const original=history.frames.at(-1); if(!original?.evidence)return null;
    const mapped=mapSessionEvidence({},original,sessionOffset,epoch,null).frame, width=mapped.viewport.width,height=mapped.viewport.height;
    const rgba=flipRgba(mapped.evidence.rgba,width,height), c=document.createElement('canvas');c.width=width;c.height=height;c.getContext('2d').putImageData(new ImageData(rgba,width,height),0,0);
    return {frameId:mapped.frameId,observedAt:mapped.renderTsMs,presentTsEstimateMs:null,timingUnavailableReason:'display_presentation_not_measured',processedAt:sessionNow(),causalStatus:'online_causal',provenanceKind:'synthetic',mapId:'synthetic-world-'+epoch,mapVersion:1,coordinateFrameId:'synthetic-world-frame-'+epoch,width,height,rgba,imageData:c.toDataURL('image/png'),depth:null,syncUncertaintyMs:null};
  },onStatus:()=>{$('#exploreStatus').textContent='장면 탐색 요청됨 · 선택한 개념의 검출 범위 미검증';}});
  setInterval(()=>exploration.tick(),1000);
  $('#samConcept').addEventListener('input',()=>{stopRemote();startRemote();$('#exploreStatus').textContent=validSamConcept($('#samConcept').value)?'선택한 개념으로 대기 · 최대 분당 12회':'장면 탐색에 개념을 입력하세요 · 시선 분할에는 필요하지 않습니다';});
  $('#exploreConsent').addEventListener('change',()=>{if(!$('#exploreConsent').checked){stopRemote();startRemote();}$('#exploreStatus').textContent=$('#exploreConsent').checked?'장면 탐색 대기 · 최대 분당 12회':'장면 탐색 꺼짐';});
  function submitAligned(input){pendingAligned=input;if(alignedExpiryTimer!==null)clearTimeout(alignedExpiryTimer);alignedExpiryTimer=setTimeout(()=>{if(pendingAligned===input){pendingAligned=null;updateGazeSamButton();$('#gazeSamStatus').textContent='정렬 프레임 만료 · 다음 프레임을 기다립니다';}},1000);updateGazeSamButton();$('#gazeSamStatus').textContent='정렬된 시선·정확한 프레임 준비됨 · 1초 후 만료 · 전송은 직접 눌러야 합니다';}
  $('#runGazeSam').addEventListener('click',()=>{
    const input=pendingAligned;pendingAligned=null;if(alignedExpiryTimer!==null)clearTimeout(alignedExpiryTimer);alignedExpiryTimer=null;$('#runGazeSam').disabled=true;
    if(!input||sessionNow()-input.gaze.timestampMs>1000||!timingCalibration||!$('#gazeSamConsent').checked||!$('#remoteConsent').checked||!$('#reasonConsent').checked||!remotePipeline){$('#gazeSamStatus').textContent='광학 측정, 최근 정렬 프레임, SAM·Spark 동의 및 활성 세션이 필요합니다.';return;}
    const result=handoff(input);
    $('#gazeSamStatus').textContent=result.accepted?'선택한 시선 프레임을 전송했습니다.':'전송 보류 · 동의, 세션, 정렬 또는 보존 프레임을 확인하세요.';
  });
  $('#gazeSamConsent').addEventListener('change',()=>{if(!$('#gazeSamConsent').checked){pendingAligned=null;stopRemote();startRemote();}updateGazeSamButton();});
  $('#reasonConsent').addEventListener('change',()=>{if(!$('#reasonConsent').checked){stopRemote();startRemote();}else startRemote();updateGazeSamButton();});
  let memory=await MemoryService.open({sessionId:crypto.randomUUID(),clock:sessionNow});
  let unsubscribeTrace=memory.subscribeInvalidations(ids=>{researchTrace.withdrawEvidence(ids);if(remoteRuntime){$('#scenarios').replaceChildren();$('#nextGazeStatus').textContent='다음 시선 예측 없음';preparation.clear();$('#scenarioStatus').textContent='증거 변경으로 시나리오가 철회되었습니다';}});
  function bindTraceMemory(){unsubscribeTrace();unsubscribeTrace=memory.subscribeInvalidations(ids=>{researchTrace.withdrawEvidence(ids);if(remoteRuntime){$('#scenarios').replaceChildren();$('#nextGazeStatus').textContent='다음 시선 예측 없음';preparation.clear();$('#scenarioStatus').textContent='증거 변경으로 시나리오가 철회되었습니다';}});}
  const runtime=new RuntimeFacade({sessionId:crypto.randomUUID(),now:()=>performance.now()});
  function drawEye(id,eye) {
    const container=$('#'+id), c=container.querySelector('canvas'), context=c.getContext('2d');context.clearRect(0,0,c.width,c.height);
    if(eye?.crop && video.readyState>=2) { const q=eye.crop; context.save();context.translate(c.width,0);context.scale(-1,1);context.drawImage(video,q.x,q.y,q.width,q.height,0,0,c.width,c.height);context.restore();container.querySelector('small').textContent=eye.valid?'실제 눈 크롭 · 표시만 반전':`눈 상태: ${eye.reason}`; }
    else container.querySelector('small').textContent='눈 검출 불가';
  }
  function onSample(sample) {
    if(timingCalibration&&!sameTimingSetup(timingCalibration.setup,timingSetup())){invalidateCalibration();return;}
    if(pilot && pilot.stoppedAt===null && pilot.pauseStartedAt==null){
      pilot.samples++;if(sample.valid)pilot.validSamples++;if(sample.faceDetected)pilot.faces++;
      const kind=sample.timestampKind==='browser_capture_estimate'?'browser_capture_estimate':'callback_time_not_capture';pilot.timestampKinds[kind]++;
      if(Number.isFinite(sample.timestampMs) && pilot.lastTimestampKind===kind && Number.isFinite(pilot.lastTimestamp) && sample.timestampMs>pilot.lastTimestamp){const gap=sample.timestampMs-pilot.lastTimestamp;pilot.intervalCount++;pilot.intervalSum+=gap;pilot.intervalMax=Math.max(pilot.intervalMax,gap);}
      pilot.lastTimestamp=sample.timestampMs;pilot.lastTimestampKind=kind;
      if(Number.isFinite(sample.inferenceMs)&&sample.inferenceMs>=0){pilot.inferenceCount++;pilot.inferenceSum+=sample.inferenceMs;pilot.inferenceMax=Math.max(pilot.inferenceMax,sample.inferenceMs);}
    }
    latest=sample;drawEye('leftEye',sample.leftEye);drawEye('rightEye',sample.rightEye);
    gazeStatus.textContent=sample.valid?'시선 추정 · 시간 정렬 보류':`추적 보류 · ${sample.invalidReason}`;
    const r=canvas.getBoundingClientRect(), p=sample.rawScreenXY;
    const viewportXY=sample.valid && p && p.x>=r.left && p.x<r.right && p.y>=r.top && p.y<r.bottom ? {x:(p.x-r.left)/r.width,y:(p.y-r.top)/r.height}:null;
    if(sample.valid) gazeStatus.textContent=viewportXY?(sample.sceneAssociationEligible?'월드 내 시선 추정 · 시간 정렬 확인 중':`월드 내 시선 추정 · 정렬 보류 (${sample.syncStatus})`):'진단 영역 / 월드 밖';
    const displayRegion=viewportXY?(viewportXY.y<1/3?'top':viewportXY.y<2/3?'middle':'bottom'):null;
    const frame=sample.sceneAssociationEligible ? history.at(sample.timestampMs,displayRegion) : null;
    if(sample.sceneAssociationEligible&&viewportXY){
      if(!frame)gazeStatus.textContent='시간 정렬 보류 · 해당 표시 구간의 보존 프레임 없음';
      else {const aligned=alignGaze({valid:true,captureMs:sample.timestampMs,syncUncertaintyMs:sample.syncUncertaintyMs},[{id:frame.frameId,presentMs:frame.presentTsEstimateMs,displayUncertaintyMs:frame.displayUncertaintyMs}]);
        if(aligned.status!=='aligned')gazeStatus.textContent=`시간 정렬 보류 · ${aligned.reason}`;
        else {const hit=world.raycastFrame(frame,viewportXY.x*frame.viewport.width,viewportXY.y*frame.viewport.height);gazeStatus.textContent=hit.status==='hit'?`정렬 프레임 ${frame.frameId} · 공간 접촉점 ${hit.point.map(x=>x.toFixed(2)).join(', ')} m`:`정렬 프레임 ${frame.frameId} · 공간 접촉 ${hit.status}`;}
      }
    }
    if(coordinator && pilot)pilot.peakPending=Math.max(pilot.peakPending,coordinator.status().pending);
    const mapped=mapSessionEvidence(sample,frame,sessionOffset,epoch,viewportXY);
    if(coordinator) coordinator.acceptSample(mapped.sample,mapped.frame).then(async result=>{if(result.recorded){const records=await memory.retrieve({observedUntil:sessionNow()});memoryStatus.textContent=result.pin==='evidence_evicted'?`증거 퇴거: ${result.reason}`:`스침 ${records.glimpses.length}건 · 객체 미연결`;}}).catch(()=>{memoryStatus.textContent='기억 입력 실패 · 기록 보류';});
    updateFrozenGazeControls();
  }
  function setState(s) {state.textContent=({starting:'시작 중',active:'카메라 활성',stopping:'정리 중',stopped:'정지',error:'시작 실패'})[s];start.disabled=s==='starting'||s==='active'||s==='stopping';stop.disabled=!(s==='starting'||s==='active');calibrate.disabled=s!=='active';$('#pause').disabled=s!=='active';if(s!=='active')$('#pause').textContent='일시정지';updateFrozenGazeControls();}
  try {
    controller=createWebcamGazeController({video,mediaDevices:navigator.mediaDevices,loadVision:()=>import('/vendor/vision_bundle.mjs'),wasmRoot:'/vendor',modelAssetPath:'/vendor/face_landmarker.task',onSample,onError:()=>{clearFrozenGazeDemo('카메라 오류 · 잠정 시선 시험 취소',true);stopRemote();cancelDiagnostic();timingCalibration=null;cameraSessionId=null;pendingAligned=null;$('#timingStatus').textContent='카메라 오류 · 시간 측정 다시 적용 필요';$('#runGazeSam').disabled=true;coordinator?.stop();message.textContent='눈 추적 중 오류가 발생해 카메라를 중단했습니다.';}});
    coordinator=createCoordinator({controller,memory,runtime,onState:setState,onAligned:submitAligned,namespace:epoch});
  } catch {start.disabled=true;message.textContent='이 브라우저에서 카메라 API를 사용할 수 없습니다.';}
  async function selectDurable(mode){
    if(sessionSelecting || sessionStarted || durableSession){$('#retentionStatus').textContent='현재 페이지 시작 전 한 번만 선택할 수 있습니다.';return;}
    const hours=Number($('#retentionHours').value);if(!$('#retentionConsent').checked || !Number.isInteger(hours) || hours<1 || hours>720){$('#retentionStatus').textContent='보존 동의와 1–720시간 설정이 필요합니다.';return;}
    sessionSelecting=true;let opened=null;const generation=retentionGeneration;const withdrawn=()=>generation!==retentionGeneration || !$('#retentionConsent').checked;
    try{
      opened=await openDurableSession({sessionId:'local-research',mode,retentionConsent:true,retentionMs:hours*3600000});
      if(withdrawn()){await opened.close({remove:true});opened=null;$('#retentionStatus').textContent='동의 철회로 보존 세션이 삭제되었습니다.';return;}
      await memory.close();
      if(withdrawn()){await opened.close({remove:true});opened=null;memory=await MemoryService.open({sessionId:crypto.randomUUID(),clock:sessionNow});bindTraceMemory();coordinator?.replaceMemory(memory);$('#retentionStatus').textContent='동의 철회로 보존 세션이 삭제되었습니다.';return;}
      cancelDiagnostic();await journal.close();durableSession=opened;opened=null;journal=durableSession.journal;journalSessionId=durableSession.sessionId;sessionOffset=durableSession.offset;memory=durableSession.memory;bindTraceMemory();coordinator?.replaceMemory(memory);$('#retentionStatus').textContent=mode==='reopen'?'보존 세션 열림 · 카메라와 외부 요청은 정지 상태':'보존 세션 생성됨 · 카메라와 외부 요청은 정지 상태';
    }catch{try{if(opened)await opened.close({remove:withdrawn()});else if(withdrawn())await deleteDurableSlot({sessionId:'local-research'});}catch{}$('#retentionStatus').textContent='보존 세션 열기 또는 정리에 실패했습니다. 저장 상태를 확인하세요.';}
    finally{sessionSelecting=false;}
  }
  $('#createDurable').addEventListener('click',()=>selectDurable('create'));
  $('#reopenDurable').addEventListener('click',()=>selectDurable('reopen'));
  $('#deleteDurable').addEventListener('click',async()=>{if(sessionSelecting){$('#retentionStatus').textContent='보존 세션 처리 중입니다.';return;}if(durableSession){$('#clear').click();return;}try{await deleteDurableSlot({sessionId:'local-research'});$('#retentionStatus').textContent='보존 세션 삭제됨';}catch{$('#retentionStatus').textContent='보존 세션 삭제 실패 · 다시 시도 필요';}});
  $('#retentionConsent').addEventListener('change',()=>{if(!$('#retentionConsent').checked){retentionGeneration++;if(durableSession)$('#clear').click();}});
  async function startSession(){
    if(cameraStartPending||coordinator?.status().active)return;
    if(sessionSelecting){message.textContent='보존 세션 처리 완료 후 시작하세요.';return;}
    if(durableSession && !$('#retentionConsent').checked){message.textContent='보존 동의가 철회되어 시작할 수 없습니다. 삭제 상태를 확인하세요.';return;}
    if(!$('#localConsent').checked){message.textContent='시작 전에 기기 내 카메라 처리 동의가 필요합니다.';return;}
    cameraStartPending=true;let result;try{result=await coordinator.start();}finally{cameraStartPending=false;}
    if(result.started) {clearFrozenGazeDemo('새 카메라 세션 · 잠정 시선 시험 초기화',true);cameraSessionId=crypto.randomUUID();pilot={startedAt:performance.now(),startedAtUtc:new Date().toISOString(),stoppedAt:null,pausedMs:0,pauseStartedAt:null,samples:0,validSamples:0,faces:0,timestampKinds:{browser_capture_estimate:0,callback_time_not_capture:0},inferenceCount:0,inferenceSum:0,inferenceMax:0,intervalCount:0,intervalSum:0,intervalMax:0,lastTimestamp:null,lastTimestampKind:null,peakPending:0,cameraSettings:{width:result.settings.width,height:result.settings.height,reportedFrameRate:result.settings.frameRate},calibration:null};sessionStarted=true;updatePilot();updateFrozenGazeControls();pilotTimer=setInterval(updatePilot,1000);timer=setInterval(()=>{maintenance=maintenance.then(()=>memory.advanceTime(sessionNow())).catch(()=>{memoryStatus.textContent='기억 만료 처리 실패';});},5000);message.textContent='카메라 활성 · 교정 안내를 시작했습니다. 27개 교정점과 27개 독립 검증점을 순서대로 보세요.';beginCalibration();}
    else if(result.reason==='start_failed') message.textContent='시작 실패: 로컬 MediaPipe 자산, 카메라 권한 및 브라우저 지원을 확인하세요. README 참조.';
  }
  start.addEventListener('click',startSession);
  function stopSession(){clearFrozenGazeDemo('카메라 정지 · 잠정 시선점 폐기',true);stopRemote();cancelDiagnostic();if(pilot && pilot.stoppedAt===null)pilot.stoppedAt=performance.now();clearInterval(pilotTimer);pilotTimer=null;updatePilot();clearInterval(timer);timer=null;const drained=coordinator?.stop();history.clear();latest=null;candidate=null;pendingAligned=null;cameraSessionId=null;timingCalibration=null;controller?.setTimingCalibration(null);$('#timingStatus').textContent='카메라 세션 종료 · 광학 측정 다시 적용 필요';$('#runGazeSam').disabled=true;$('#gazeSamStatus').textContent='정지됨 · 카메라 시작 후 시선 정렬 필요';calibrationStage=null;$('#calibration').hidden=true;for(const id of ['leftEye','rightEye'])drawEye(id,null);gazeStatus.textContent='교정 필요';return Promise.all([drained,maintenance]);}
  $('#pause').addEventListener('click',()=>{if(!coordinator?.status().active)return;if(coordinator.status().paused){coordinator.resume();if(pilot?.pauseStartedAt!=null){pilot.pausedMs+=performance.now()-pilot.pauseStartedAt;pilot.pauseStartedAt=null;}$('#pause').textContent='일시정지';startRemote();maybeStartFrozenGazeAutomation();}else{clearFrozenGazeDemo('카메라 일시정지 · 잠정 시선점 폐기',true);coordinator.pause();if(pilot)pilot.pauseStartedAt=performance.now();stopRemote();cancelDiagnostic();$('#pause').textContent='재개';}updatePilot();updateFrozenGazeControls();});
  $('#localConsent').addEventListener('change',()=>{if($('#localConsent').checked)startSession();else stopSession();});
  stop.addEventListener('click',stopSession);
  $('#clear').addEventListener('click',async()=>{if(sessionSelecting){$('#retentionStatus').textContent='보존 세션 처리 중입니다.';return;}try{await stopSession();if(durableSession){await durableSession.close({remove:true});durableSession=null;}else {await journal.delete();await memory.deleteSession();}journalSessionId=crypto.randomUUID();journal=await ProviderJournal.open({storage:new EphemeralStorage(),sessionId:journalSessionId});memory=await MemoryService.open({sessionId:crypto.randomUUID(),clock:sessionNow});bindTraceMemory();coordinator?.replaceMemory(memory);researchTrace.clear();$('#traceStatus').textContent='연구 기록 삭제됨 · 비교 재생 미실행';pilot=null;$('#pilotStatus').textContent='관찰 0:00 / 30:00 · 샘플 0';memoryStatus.textContent='임시 세션 삭제됨';message.textContent='임시 세션과 카메라가 정지되었습니다. 원시 영상은 저장하지 않았습니다.';}catch{memoryStatus.textContent='삭제 실패 · 다시 시도 필요';message.textContent='세션 삭제를 완료하지 못했습니다.';}});
  function invalidateCalibration(){clearFrozenGazeDemo('화면/교정 변경 · 잠정 시선점 폐기',true);if(pilot?.calibration)pilot.calibration.invalidatedAtUtc=new Date().toISOString();if(controller){controller.setCalibration(null);controller.setTimingCalibration(null);}timingCalibration=null;pendingAligned=null;stopRemote();startRemote();$('#timingStatus').textContent='화면/설정 변경 · 시간 측정과 시선 교정 다시 필요';$('#runGazeSam').disabled=true;candidate=null;latest=null;calibrationStage=null;training=[];validation=[];$('#calibration').hidden=true;history.clear();gazeStatus.textContent='화면 변경 · 재교정 필요';updateFrozenGazeControls();}
  $('#hide').addEventListener('click',e=>{document.body.classList.toggle('observation');e.target.textContent=document.body.classList.contains('observation')?'진단 표시':'진단 숨기기';sizeCanvas();invalidateCalibration();});
  window.addEventListener('resize',()=>{sizeCanvas();invalidateCalibration();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearFrozenGazeDemo('페이지가 숨겨져 잠정 표본/마스크를 폐기하고 장면을 재개했습니다.',true);});
  window.addEventListener('pagehide',()=>{stopSession().then(()=>durableSession?durableSession.close():Promise.all([journal.close(),memory.close()])).catch(()=>{});});
  const points=(validationPhase)=>{let p=[];for(let repeat=0;repeat<3;repeat++)for(let y=0;y<3;y++)for(let x=0;x<3;x++)p.push({x:innerWidth*(validationPhase ? .20+.28*x : .12+.38*x),y:innerHeight*(validationPhase ? .20+.28*y : .12+.38*y)});return p;};
  function showTarget(){const p=points(calibrationStage==='validation')[sequence], target=$('#target');target.style.left=p.x+'px';target.style.top=p.y+'px';$('#calibrationInfo').textContent=`${calibrationStage==='training'?'교정':'독립 검증'} ${sequence+1}/27 · 표적을 보고 클릭하세요`;}
  function beginCalibration(){
    clearFrozenGazeDemo('교정 시작 · 자동 SAM 대기 중단',true);stopRemote();cancelDiagnostic();controller.setCalibration(null);candidate=null;training=[];validation=[];sequence=0;screenSize={width:innerWidth,height:innerHeight};calibrationStage='training';if(pilot)pilot.calibration={passed:false,status:'in_progress',attempts:[],startedAtUtc:new Date().toISOString()};$('#calibration').hidden=false;showTarget();$('#gazeSamDemoStatus').textContent='교정 진행 중 · 원격 SAM은 독립 검증 통과 전까지 중지됩니다.';updateFrozenGazeControls();
  }
  calibrate.addEventListener('click',beginCalibration);
  $('#target').addEventListener('click',()=>{
    if(!calibrationStage)return;
    if(screenSize.width!==innerWidth||screenSize.height!==innerHeight){calibrationStage=null;$('#calibration').hidden=true;message.textContent='화면 크기가 변경되어 교정을 취소했습니다.';return;}
    const target=points(calibrationStage==='validation')[sequence], fresh=latest?.features && performance.now()-latest.processedMs<500;
    if(pilot?.calibration)pilot.calibration.attempts.push({phase:calibrationStage,index:sequence,target:{...target},sampleAvailable:!!fresh,atUtc:new Date().toISOString()});
    if(calibrationStage==='training') {
      if(!fresh){$('#calibrationInfo').textContent='유효한 양안 샘플이 없습니다. 눈 검출 후 다시 클릭하세요.';return;}
      training.push({id:`train-${sequence}`,features:latest.features,target});
    } else validation.push(fresh?{id:`validate-${sequence}`,features:latest.features,target}:{id:`validate-${sequence}`,valid:false});
    sequence++;
    if(sequence===27&&calibrationStage==='training'){
      try{candidate=fitCalibration(training);calibrationStage='validation';sequence=0;}catch{calibrationStage=null;if(pilot?.calibration)pilot.calibration.status='failed';stopRemote();cancelDiagnostic();$('#calibration').hidden=true;message.textContent='교정 데이터가 충분히 구별되지 않아 실패했습니다. 다시 시도하세요.';$('#gazeSamDemoStatus').textContent='교정 실패 · 자동 SAM 전송을 시작하지 않았습니다.';updateFrozenGazeControls();return;}
    } else if(sequence===27){
      const metrics=calibrationMetrics(candidate,validation,{x:0,y:0,...screenSize},{independent:true});
      const passed=metrics.validRate>=.8&&metrics.p95!==null&&metrics.p95<=.05;
      if(pilot)pilot.calibration={...pilot.calibration,...metrics,passed,status:'completed',trainingAttempts:training.length,validationAttempts:validation.length,screenSize:{...screenSize},completedAtUtc:new Date().toISOString()};
      if(passed)controller.setCalibration(candidate);else {candidate=null;stopRemote();cancelDiagnostic();clearFrozenGazeDemo('교정 실패 · 자동 SAM 전송 중지',true);}
      message.textContent=`독립 검증 ${passed?'통과':'실패'}: 유효 ${(metrics.validRate*100).toFixed(1)}%, p95 ${metrics.p95===null?'없음':(metrics.p95*100).toFixed(2)+'%'} (화면 대각선 기준). 실사용 성능 검증은 별도입니다.`;
      calibrationStage=null;$('#calibration').hidden=true;
      if(passed){$('#gazeSamDemoStatus').textContent=$('#remoteConsent').checked?'교정 통과 · 잠정 고정 장면 자동 탐색을 준비합니다. 시간 정렬은 미검증입니다.':'교정 통과 · 자동 탐색 동의 대기';startRemote();maybeStartFrozenGazeAutomation();}
      else $('#gazeSamDemoStatus').textContent='독립 교정 실패 · 자동 SAM 전송을 중지했습니다. 다시 교정하세요.';
      updateFrozenGazeControls();return;
    }
    showTarget();
  });
  $('#runtimeStatus').textContent='SAM 동의 대기 · Spark 대기';
}
if(typeof document!=='undefined') boot().catch(()=>{const el=document.querySelector('#message');if(el)el.textContent='초기화 실패. 브라우저 콘솔과 로컬 자산을 확인하세요.';});
