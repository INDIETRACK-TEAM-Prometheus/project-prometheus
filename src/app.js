import {createWorld} from './spatial/world.js';
import {createLocalRecorder,listLocalRecordings,deleteLocalRecordings} from './gaze/local-recorder.js';
import {GAZE_CALIBRATION_PROFILE_KEY,restoreLandmarkResidualCalibration,openGazeCalibrationProfileStore,loadGazeCalibrationProfile,createGazeCalibrationProfileAsync,saveGazeCalibrationProfile,fitAffineCalibration,identityAffineCalibration,selectAffineCalibrationCandidate} from './gaze/calibration-profile.js';
import {createCausalDisplayFilter} from './gaze/display-filter.js';
import {createAccuracyPlan} from './gaze/accuracy-protocol.js';
import {createAccuracySession} from './gaze/accuracy-session.js';
import {stableCalibrationWindow,calibrationSampleFreshnessMs,calibrationSampleStatus,calibrationWindowStatus,calibrationTargetTimedOut,CALIBRATION_RUN_TIMEOUT_MS,CALIBRATION_ADAPT_TIMEOUT_MS} from './gaze/calibration-window.js';
import {BackgroundAttentionCoordinator} from './runtime/background-attention.js';
import {createBackgroundBrowserWork} from './runtime/background-browser.js';
import {LiveTracking} from './runtime/live-tracking.js';
import {createProfiledWebcamGazeController,describeOpenEyeWait} from './gaze/remote-webcam.js';
import {gazeViewportPoint,gazeMarkerPosition} from './gaze/overlay.js';
import {withinCalibrationBounds,predictCalibration,calibrationMetrics,fitLandmarkResidualCalibration,landmarkResidualMetrics,landmarkResidualPassesSelection,LANDMARK_RESIDUAL_FIT_ATTEMPTS,predictLandmarkResidual} from './gaze/index.js';
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
import {selectFrozenSceneGaze,createFrozenGazeAutomation,runFrozenGazeCycle} from './gaze/frozen-demo.js';
import {selectProvisionalIrisGaze} from './gaze/uncalibrated.js';
import {gazeCalibrationEnvironmentChanged} from './gaze/persistence.js';
import {ProvisionalTrackingStore,deleteProvisionalTracking} from './memory/provisional-tracking.js';

const startupFailureSteps={
  camera_request_started:'camera_request',camera_stream_acquired:'camera_stream',camera_stop_requested:'camera_stop',camera_stopped:'camera_stop',runtime_config_unavailable:'runtime_config',runtime_config_invalid:'runtime_config',gaze_remote_unavailable:'remote_gaze_health',gaze_adapter_incompatible:'remote_calibration_profile',gaze_protocol_error:'remote_gaze_protocol',gaze_capture_failed:'remote_gaze_capture',gaze_encode_failed:'remote_gaze_encode',gaze_frame_too_large:'remote_gaze_upload',gaze_remote_inference_failed:'remote_gaze_inference',gaze_provider_busy:'remote_gaze_busy',gaze_health_check_started:'remote_gaze_health',gaze_session_created:'remote_gaze_session',remote_gaze_paused:'remote_gaze_pause',remote_gaze_resumed:'remote_gaze_pause',remote_calibration_replay_unsupported:'remote_calibration',
  camera_permission_denied:'camera',camera_device_missing:'camera',camera_device_unavailable:'camera',camera_constraints_unsatisfied:'camera',camera_security_context:'camera',camera_request_aborted:'camera',camera_request_failed:'camera',
  worker_created:'worker_creation',worker_ready:'worker_initialization',worker_load_failed:'worker_load',worker_initialization_failed:'worker_initialization',worker_initialization_timeout:'worker_initialization',worker_inference_failed:'worker_inference',worker_runtime_failed:'worker_runtime',worker_adaptation_failed:'worker_adaptation',
  capture_api_unavailable:'capture_api',capture_started:'capture',capture_frame_failed:'capture',video_attachment_failed:'video_attachment',video_attached:'video_attachment',video_playback_started:'video_playback',video_playback_failed:'video_playback',
  runtime_start_started:'runtime_start',runtime_started:'runtime_start',runtime_start_failed:'runtime_start',runtime_stop_requested:'runtime_stop',runtime_stopped:'runtime_stop',sample_handler_failed:'sample_handler',startup_failed:'startup'
};
export function startupFailureDiagnostic(error){
  const code=Object.hasOwn(startupFailureSteps,error?.code)?error.code:'startup_failed';
  return {code,step:startupFailureSteps[code]};
}
function logStartupDiagnostic(code){
  const diagnostic=startupFailureDiagnostic({code});
  if(diagnostic.code===code)try{console.info('[Prometheus WebEyeTrack diagnostic]',diagnostic);}catch{}
}

// Only aggregate pilot measurements are exported; no video, landmarks or device ID.
export function gazeSamPrompt(frame, gaze) {
  if (!gaze || !Number.isInteger(frame?.width) || !Number.isInteger(frame?.height) || frame.width<1 || frame.height<1 || !Number.isFinite(gaze.x) || !Number.isFinite(gaze.y) || gaze.x<0 || gaze.x>=1 || gaze.y<0 || gaze.y>=1) throw new TypeError('invalid gaze point');
  return `<0f>1<|point;x=${Math.floor(gaze.x*frame.width)};y=${Math.floor(gaze.y*frame.height)};w=${frame.width};h=${frame.height}|>`;
}
export function requestStartupSceneAnalysis({consent,frame,rgba,diagnostic}={}) {
  if(consent!==true)return Promise.resolve({status:'withheld'});
  if(!frame?.frameId||!Number.isFinite(frame.renderTsMs)||!Number.isInteger(frame.viewport?.width)||!Number.isInteger(frame.viewport?.height)||frame.viewport.width<1||frame.viewport.height<1||!(rgba instanceof Uint8Array)||rgba.length!==frame.viewport.width*frame.viewport.height*4||typeof diagnostic?.run!=='function')return Promise.resolve({status:'failed'});
  return diagnostic.run({frameId:frame.frameId,observedAt:frame.renderTsMs,width:frame.viewport.width,height:frame.viewport.height},rgba,'objects');
}
export const provisionalSparkMinIntervalMs=30000;
export function provisionalSparkValidityScope(record){
  return `범위: 고정 프레임 ${record.frame.frameId} (${record.frame.observedAt.toFixed(1)} ms)과 당시 시선 추정 (${record.gaze.x.toFixed(3)}, ${record.gaze.y.toFixed(3)} · 표본 ${record.gaze.sampleAtMs.toFixed(1)} ms)에만 적용 · 현재 장면/시선 재사용 불가 · 물리적 시간 정렬 미검증`;
}
export async function publishProvisionalSparkIfCurrent({persist,isCurrent,discard,publish}={}){
  if(typeof persist!=='function'||typeof isCurrent!=='function'||typeof discard!=='function'||typeof publish!=='function')throw new TypeError('invalid provisional Spark publication');
  const result=await persist();
  if(!isCurrent()){await discard();return false;}
  publish(result);return true;
}
const provisionalSparkFailureLabels={network_error:'네트워크 연결 실패',request_failed:'요청 처리 실패',timeout:'응답 시간 초과',rate_limited:'요청 한도 초과',budget_exceeded:'호출 예산 소진',provider_busy:'서비스 혼잡',service_unavailable:'서비스 사용 불가',not_configured:'서버 Spark 설정 없음',access_denied:'서비스 접근 거부',incomplete_response:'Spark 응답 미완료',invalid_response:'Spark 응답 형식 오류',request_rejected:'Spark 요청 거부',provider_failed:'Spark 서비스 실패'};
const provisionalGazeFailureLabels={
  face_not_detected:'얼굴 검출 없음',visible_eye_iris_landmarks_required:'유효한 눈 홍채 랜드마크 없음',uncalibrated_iris_estimate_required:'유효한 미교정 홍채 추정값 없음',
  sample_time_unavailable:'시선 표본 시각 없음',capture_estimate_required:'브라우저 캡처 시각이 있는 표본 필요',frozen_frame_unavailable:'고정 장면 프레임 없음',invalid_provisional_window:'시선 표본 검사 구간 오류',invalid_frozen_window:'고정 장면 검사 구간 오류',
  sample_before_stable_window:'장면 고정 뒤 새 표본 대기',sample_stale_or_lagged:'표본이 오래됐거나 처리 지연',gaze_outside_frozen_scene:'추정점이 장면 밖'
};
export function provisionalGazeFailureReason(estimate,reason){
  const actual=reason==='uncalibrated_iris_estimate_required'?(estimate?.reason??reason):reason;
  return provisionalGazeFailureLabels[actual]??'시선 추정값 확인 필요';
}
function provisionalSparkFailureReason(response,body){
  const code=body?.providerCode;
  if(code==='PROVIDER_NETWORK_ERROR')return 'network_error';
  if(code==='PROVIDER_BUDGET_EXCEEDED')return 'budget_exceeded';
  if(['PROVIDER_BUSY','PROVIDER_MIN_INTERVAL','PROVIDER_CIRCUIT_OPEN'].includes(code))return 'provider_busy';
  if(code==='PROVIDER_RATE_LIMITED'||response.status===429)return 'rate_limited';
  if(response.status===504||body?.error==='timeout'||code==='REASONER_TIMEOUT')return 'timeout';
  if(response.status===503||body?.error==='provider_unavailable')return code==='REASONER_NOT_CONFIGURED'?'not_configured':'service_unavailable';
  if(response.status===401||response.status===403||[401,403].includes(body?.upstreamStatus)||code==='REASONER_ACCESS_DENIED')return 'access_denied';
  if(code==='REASONER_INCOMPLETE')return 'incomplete_response';
  if(['REASONER_WRONG_MODEL','REASONER_LANE_INVALID','REASONER_JSON_INVALID','REASONER_GROUNDING_INVALID','REASONER_INVALID_RESPONSE'].includes(code))return 'invalid_response';
  if(response.status===400||body?.error==='invalid_request')return 'request_rejected';
  return 'provider_failed';
}
export async function sendProvisionalSparkRequest({consent,frame,imageDataUrl,gazePoint,gazeTiming,masks,candidates,depth=null,issuedAtMs,signal,fetchImpl=fetch}={}) {
  if(consent!==true)return {status:'withheld',reason:'consent_required'};
  if(!frame?.frameId||!Number.isFinite(frame.observedAt)||!Number.isInteger(frame.width)||!Number.isInteger(frame.height)||frame.width<1||frame.height<1||frame.width*frame.height>1048576||typeof imageDataUrl!=='string'||!Array.isArray(masks)||!Number.isFinite(gazePoint?.x)||gazePoint.x<0||gazePoint.x>=1||!Number.isFinite(gazePoint?.y)||gazePoint.y<0||gazePoint.y>=1||!Number.isFinite(gazeTiming?.sampleAtMs)||gazeTiming.sampleAtMs<0||!Number.isFinite(gazeTiming?.processedAtMs)||gazeTiming.processedAtMs<gazeTiming.sampleAtMs||!['browser_capture_estimate','callback_time_not_capture'].includes(gazeTiming.timestampKind)||!['uncalibrated_estimate','validated_calibration_estimate'].includes(gazeTiming.estimateStatus)||(gazeTiming.timestampKind==='callback_time_not_capture'&&gazeTiming.estimateStatus!=='uncalibrated_estimate')||!Number.isFinite(issuedAtMs)||issuedAtMs<Math.max(frame.observedAt,gazeTiming.processedAtMs)||typeof fetchImpl!=='function')return {status:'failed'};
  if(signal?.aborted)return {status:'cancelled'};
  const body={consentScope:'provisional_spark',timingStatus:'provisional',frame:{frameId:frame.frameId,observedAt:frame.observedAt,width:frame.width,height:frame.height},imageDataUrl,gazePoint:{x:gazePoint.x,y:gazePoint.y,sampleAtMs:gazeTiming.sampleAtMs,processedAtMs:gazeTiming.processedAtMs,timestampKind:gazeTiming.timestampKind,estimateStatus:gazeTiming.estimateStatus},issuedAtMs,masks:masks.slice(0,10).map(mask=>mask?.bounds)};
  if(candidates?.length)body.candidates=candidates;
  if(depth)body.depth=depth;
  try {
    const response=await fetchImpl('/api/reason-provisional',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});
    if(signal?.aborted)return {status:'cancelled'};
    let result;try{result=await response.json();}catch{result=null;}
    if(signal?.aborted)return {status:'cancelled'};
    if(!response.ok)return {status:'failed',reason:provisionalSparkFailureReason(response,result)};
    if(result?.timingStatus!=='provisional'||result.frame?.frameId!==frame.frameId||result.frame?.observedAt!==frame.observedAt||!Array.isArray(result.scenarios))return {status:'failed',reason:'invalid_response'};
    return {status:'ok',result};
  } catch {return signal?.aborted?{status:'cancelled'}:{status:'failed',reason:'network_error'};}
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
export function createCoordinator({controller, memory, runtime, onState=()=>{}, onAligned=()=>{}, onDiagnostic=()=>{}, maxPending=64, namespace=''}) {
  const diagnose=code=>{try{onDiagnostic(code);}catch{}};
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
        const settings=await controller.start({userInitiated:true,cameraConsent:true,videoConstraints:{width:{ideal:1280},height:{ideal:720}}});
        if (token!==generation) return {started:false,reason:'cancelled'};
        if (!settings) return {started:false,reason:'cancelled'};
        diagnose('runtime_start_started');
        try { runtime.start(); }
        catch {
          diagnose('runtime_start_failed');diagnose('runtime_stop_requested');
          try { runtime.stop(); } catch {}
          diagnose('runtime_stopped');
          throw Object.assign(new Error('Runtime startup failed'),{code:'runtime_start_failed'});
        }
        diagnose('runtime_started');
        active=true; paused=false; onState('active'); return {started:true,settings};
      } catch(error) { if(token===generation) { controller.stop(); onState('error'); } return {started:false,reason:'start_failed',error}; }
    },
    stop() { const token=++generation; active=false; paused=false; draining=true;const old=attention;attention=null;if(old)chain=chain.then(()=>memory.releaseEventPin(old.eventId));controller.stop();diagnose('runtime_stop_requested');runtime.stop();diagnose('runtime_stopped');onState('stopping');return chain.then(()=>{if(token===generation){draining=false;onState('stopped');}}); },
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
  const gazeMarker=$('#gazeMarker');
  const clearGazeMarker=()=>{gazeMarker.hidden=true;};
  const showGazeMarker=(point,state)=>{const position=gazeMarkerPosition(point,state);if(!position){clearGazeMarker();return;}gazeMarker.style.left=position.left;gazeMarker.style.top=position.top;gazeMarker.hidden=false;};
  let world=null, latest=null, latestProvisionalGaze=null, candidate=null, coordinator=null, controller=null, calibrationStage=null, calibrationRunToken=0, sequence=0, training=[], validation=[], screenSize=null, calibrationTargetShownAt=-Infinity, lastCopy=0, lastHistoryFrameId=null, maintenance=Promise.resolve(), timer=null,timingCalibration=null,pendingAligned=null,cameraSessionId=null,sceneFrozen=false,frozenScene=null,frozenGazeExpiry=null,frozenGazeResolve=null,frozenGazeGeneration=0,frozenGazeRequest=false,initialScenePending=false,initialSceneGeneration=0,diagnosticPurpose='scene',diagnosticGazePoint=null,diagnosticGazeTiming=null,diagnosticRequestNumber=0,provisionalSparkController=null,provisionalSparkGeneration=0,provisionalSparkRequestNumber=0,lastProvisionalSparkAt=-Infinity,cameraStartPending=false;
  const clockSessionId=crypto.randomUUID();
  // WebEyeTrack exposes adaptation in memory but no official model persistence API.
  // Keep the legacy hand-built calibration key untouched; it is incompatible.
  let activeCalibration=null,activeAffine=null,capturedAdaptation=null,calibrationRunStart=null,calibrationAdaptStartedAt=null,calibrationAdaptStarted=false,calibrationAdaptFinished=false,calibrationSerializeStartedAt=null,calibrationSerializeFinished=false;const calibrationWindow=[];
  const profileRuntime={webeyetrack:'0.0.2',protocol:'replay-v1'},profileStorage=openGazeCalibrationProfileStore().catch(()=>null),displayFilter=createCausalDisplayFilter();
  const remoteGazeAdapterKey='prometheus.gaze-calibration.remote-adapter.v1';let remoteCalibrationProfile=null;
  let activeLandmarkResidual=null;
  const calibrationStatus=$('#calibrationStatus');
  calibrationStatus.id='gazeCalibrationStatus';calibrationStatus.className='row';calibrationStatus.setAttribute('aria-live','polite');gazeStatus.parentElement.after(calibrationStatus);
  const showCalibrationStatus=text=>{calibrationStatus.textContent=text;};
  function logCalibrationStage(event,{startedAt,count=27}={}){
    if(!cameraSessionId)return;
    const body={event,sessionId:cameraSessionId,...(Number.isFinite(startedAt)?{durationMs:Math.min(600000,Math.max(0,Math.round(performance.now()-startedAt)))}:{}),count};
    try{void fetch('/api/diagnostics/calibration-stage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),keepalive:true}).catch(()=>{});}catch{}
  }
  function onCalibrationProgress({stage,count}={}){
    const now=performance.now(),info=$('#calibrationInfo');
    if(stage==='adaptation_started'){
      calibrationAdaptStartedAt??=now;
      if(!calibrationAdaptStarted){logCalibrationStage('calibration_adapt_start');calibrationAdaptStarted=true;}
      if(calibrationStage==='training')info.textContent='27개 WebEyeTrack 표본 수집 완료 · 로컬 모델 적응 중';
    }else if(stage==='adaptation_complete'){
      if(!calibrationAdaptStarted){calibrationAdaptStartedAt??=now;logCalibrationStage('calibration_adapt_start');calibrationAdaptStarted=true;}
      if(!calibrationAdaptFinished)logCalibrationStage('calibration_adapt_complete',{startedAt:calibrationAdaptStartedAt});
      calibrationAdaptFinished=true;
      if(calibrationStage==='training')info.textContent='모델 적응 완료 · 로컬 교정 재생 자료 준비 중';
    }else if(stage==='adaptation_error'){
      if(!calibrationAdaptStarted){calibrationAdaptStartedAt??=now;logCalibrationStage('calibration_adapt_start');calibrationAdaptStarted=true;}
      if(!calibrationAdaptFinished)logCalibrationStage('calibration_adapt_error',{startedAt:calibrationAdaptStartedAt});
      calibrationAdaptFinished=true;
    }else if(stage==='serialization_started'){
      calibrationSerializeStartedAt=now;calibrationSerializeFinished=false;
      logCalibrationStage('adaptation_serialize_start');
      if(calibrationStage==='training')info.textContent=`모델 적응 완료 · 로컬 교정 재생 자료 인코딩 0/${count??27}`;
    }else if(stage==='serialization_progress'){
      if(calibrationStage==='training')info.textContent=`모델 적응 완료 · 로컬 교정 재생 자료 인코딩 ${count??0}/27`;
    }else if(stage==='serialization_complete'){
      if(!calibrationSerializeFinished)logCalibrationStage('adaptation_serialize_complete',{startedAt:calibrationSerializeStartedAt});
      calibrationSerializeFinished=true;
    }else if(stage==='serialization_error'){
      if(!calibrationSerializeFinished)logCalibrationStage('adaptation_serialize_error',{startedAt:calibrationSerializeStartedAt});
      calibrationSerializeFinished=true;
    }
  }
  showCalibrationStatus('WebEyeTrack 교정 없음 · 시작 시 이 기기에 저장된 교정 복원을 시도');
  let provisionalTrackingStore=null, provisionalTrackingOpening=null, provisionalSparkRecordId=null;
  const provisionalTrackingStatus=$('#provisionalTrackingStatus'), provisionalTrackingList=$('#provisionalTrackingList');
  function renderProvisionalTracking(records){
    provisionalTrackingList.replaceChildren();
    for(const record of [...records].reverse()){
      const item=document.createElement('li'), heading=document.createElement('div');
      const date=new Date(record.recordedAt).toLocaleString();
      const sparkStatus={pending:'분석 중',complete:'분석 완료',failed:'실패',cancelled:'취소',withheld:'동의 없음',skipped:'요청 보류'}[record.spark.status]??'상태 확인 필요';
      const sparkFailure=record.spark.reason?` · ${provisionalSparkFailureLabels[record.spark.reason]??'실패 사유 확인 필요'}`:'';
      heading.textContent=`${date} · ${record.classification==='uncalibrated_provisional'?'미교정/잠정':'교정 추정/잠정'} · 프레임 ${record.frame.frameId} · 시선 ${record.gaze.x.toFixed(3)}, ${record.gaze.y.toFixed(3)} · SAM ${record.sam.maskCount}개 · Spark ${sparkStatus}${sparkFailure}`;
      item.append(heading);
      const scope=document.createElement('div');scope.textContent=provisionalSparkValidityScope(record);item.append(scope);
      for(const scenario of record.spark.scenarios){const detail=document.createElement('div');detail.textContent=`Spark 가설: ${scenario.possible_next_action}`;item.append(detail);}
      if(!record.spark.scenarios.length){const detail=document.createElement('div');detail.textContent='저장된 Spark 가설 없음';item.append(detail);}
      provisionalTrackingList.append(item);
    }
    if(!records.length){const empty=document.createElement('li');empty.textContent='저장된 미교정 시연 기록이 없습니다.';provisionalTrackingList.append(empty);}
    provisionalTrackingStatus.textContent=`잠정 시연 기록 ${records.length}건 · 이 기기에 저장 · 사용자가 삭제할 때까지 보존`;
  }
  async function ensureProvisionalTracking(){
    if(provisionalTrackingStore)return provisionalTrackingStore;
    if(provisionalTrackingOpening)return provisionalTrackingOpening;
    provisionalTrackingStatus.textContent='미교정/잠정 시연 기록 복원 중';
    provisionalTrackingOpening=ProvisionalTrackingStore.open({sessionId:'local-research',retentionConsent:true}).then(async store=>{
      provisionalTrackingStore=store;renderProvisionalTracking(await store.list());return store;
    }).catch(error=>{
      provisionalTrackingStatus.textContent='잠정 시연 기록 저장소를 열지 못했습니다. 브라우저 저장소 또는 다른 탭의 잠금을 확인하세요.';
      throw error;
    }).finally(()=>{provisionalTrackingOpening=null;});
    return provisionalTrackingOpening;
  }
  async function persistSamResult({frame,gazePoint,gazeTiming,masks}){
    try{
      const store=await ensureProvisionalTracking();
      const record=await store.appendDemoResult({frame,gazePoint,gazeTiming,masks,scenarios:[],sparkStatus:$('#provisionalSparkConsent').checked?'pending':'withheld'});
      renderProvisionalTracking(await store.list());return record.id;
    }catch(error){provisionalTrackingStatus.textContent=`SAM 결과는 표시했지만 잠정 로컬 저장에 실패했습니다 · ${provisionalTrackingFailureReason(error)}`;return null;}
  }
  function provisionalTrackingFailureReason(error){
    const detail=`${error?.name??''} ${error?.message??''}`;
    if(/open elsewhere/i.test(detail))return '다른 탭에서 저장소 사용 중';
    if(/quota/i.test(detail))return '브라우저 저장 공간 부족';
    if(/IndexedDB unavailable/i.test(detail))return '브라우저 저장소 사용 불가';
    return '저장소 확인 필요';
  }
  async function persistSparkResult(recordId,status,scenarios=[],reason,{render=true}={}){
    if(!recordId)return;
    try{const store=await ensureProvisionalTracking();await store.updateSparkResult(recordId,{status,scenarios,reason});const records=await store.list();if(render)renderProvisionalTracking(records);return records;}
    catch{provisionalTrackingStatus.textContent='SAM 결과는 보존했지만 Spark 상태 갱신에 실패했습니다.';}
  }
  async function deleteProvisionalHistory(){
    try{
      const store=await ensureProvisionalTracking();await store.deleteAll();renderProvisionalTracking([]);provisionalTrackingStatus.textContent='잠정 시연 기록 삭제됨';
    }catch{
      try{await deleteProvisionalTracking({sessionId:'local-research'});renderProvisionalTracking([]);provisionalTrackingStatus.textContent='잠정 시연 기록 삭제됨';}
      catch{provisionalTrackingStatus.textContent='잠정 시연 기록 삭제 실패 · 다시 시도하세요.';throw Error('provisional tracking deletion failed');}
    }
  }
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
    // Stage timings for request/latency QA (browser clock; not display presentation time).
    data.gazeTransport=typeof controller?.telemetry==='function'?controller.telemetry():null;data.backgroundAttention=typeof backgroundAttention?.telemetry==='function'?backgroundAttention.telemetry():lastBackgroundTelemetry;
    if(timingCalibration){data.opticalTimingUncertaintyMs=Math.max(timingCalibration.cameraClockModel.uncertaintyMs,...Object.values(timingCalibration.displayModels).map(m=>m.uncertaintyMs));data.opticalTimingUnavailableReason=null;data.cameraClockSync={status:'operator_supplied_measurement_record_loaded',sourceClockId:timingCalibration.sourceClockId,offsetMs:timingCalibration.cameraClockModel.sessionAnchorMs-timingCalibration.cameraClockModel.sourceAnchorMs,driftPpm:timingCalibration.cameraClockModel.driftPpm,uncertaintyMs:timingCalibration.cameraClockModel.uncertaintyMs,profileId:timingCalibration.profileId,evidenceSha256:timingCalibration.reference.evidenceSha256};data.scenePresentation={status:'operator_supplied_optical_measurements_loaded',regions:Object.fromEntries(Object.entries(timingCalibration.displayModels).map(([id,m])=>[id,{offsetMs:m.sessionAnchorMs-m.sourceAnchorMs,driftPpm:m.driftPpm,uncertaintyMs:m.uncertaintyMs}]))};data.sceneAssociation='runtime_alignment_active_t15_unverified';data.syncGate={status:'not_passed',t15:'not_run'};}
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='prometheus-pilot-summary.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    message.textContent='요약을 내보냈습니다. 영상, 랜드마크, 카메라 ID는 포함하지 않습니다.';
  });
  function timingSetup(){return {userAgent:navigator.userAgent,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio:window.devicePixelRatio||1,screenX:window.screenX,screenY:window.screenY,screenWidth:screen.width,screenHeight:screen.height},camera:{modelLabel:$('#timingCameraLabel').value.trim(),width:video.videoWidth,height:video.videoHeight,frameRate:pilot?.cameraSettings.reportedFrameRate??null}};}
  function sameTimingSetup(a,b){return a?.userAgent===b.userAgent&&['width','height','devicePixelRatio','screenX','screenY','screenWidth','screenHeight'].every(key=>a.viewport?.[key]===b.viewport[key])&&['modelLabel','width','height','frameRate'].every(key=>a.camera?.[key]===b.camera[key]);}
  function gazeEnvironment(camera){return {viewport:{width:innerWidth,height:innerHeight,devicePixelRatio:window.devicePixelRatio||1},screen:{width:screen.width,height:screen.height},camera:{width:camera?.width??null,height:camera?.height??null,frameRate:camera?.reportedFrameRate??camera?.frameRate??null}};}
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
    $('#worldGazeState').textContent='교정 필요'; }
  catch { message.textContent='WebGL을 사용할 수 없어 3D 장면을 표시할 수 없습니다.'; }
  for(const id of ['leftEye','rightEye']) {const container=$('#'+id);container.innerHTML='<canvas width="320" height="260"></canvas><small>카메라 시작 및 눈 검출 필요</small>';}
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
    display:async({frame,pixels,overlay,depth,count,provider,model,masks,imageDataUrl})=>{
      const gazeDemo=['frozen-gaze-demo','uncalibrated-gaze-demo'].includes(diagnosticPurpose);
      if(gazeDemo){$('#provisionalSparkScenarios').replaceChildren();$('#provisionalSparkStatus').textContent=`새 SAM 프레임 ${frame.frameId} · Spark 응답 대기 · 잠정 · 시간 정렬 미검증`;}
      diagnosticLayers={frame,pixels,overlay,depth,gazePoint:gazeDemo?diagnosticGazePoint:null};drawDiagnostic();
      $('#runtimeStatus').textContent=gazeDemo?'시선 SAM 완료 · 잠정 Spark 동의 확인 중':'SAM 응답 확인 · Spark 대기';
      if(diagnosticPurpose==='scene-only'){
        $('#worldSceneState').textContent=count?`장면 마스크 ${count}개`:'응답 · 마스크 0개';
        $('#sceneStatus').textContent=`시작 장면 전용 SAM · 시선점 미사용 · ${provider==='Meta'?'Meta':'provider unknown'} ${model==='sam-3.1'?'SAM 3.1':'model unknown'} · 마스크 ${count}개 (0개는 물체 부재를 뜻하지 않음)`;
      }else if(diagnosticPurpose==='frozen-gaze-demo'||diagnosticPurpose==='uncalibrated-gaze-demo'){
        $('#worldSceneState').textContent=count?`시선 SAM 마스크 ${count}개`:'시선 SAM · 마스크 0개';
        const label=diagnosticPurpose==='uncalibrated-gaze-demo'?'WebEyeTrack 기본 모델(미교정)':'보정된 WebEyeTrack 추정';
        $('#sceneStatus').textContent=`잠정 고정 장면 시험 · ${frame.frameId} · ${label} ${diagnosticGazePoint.x.toFixed(3)}, ${diagnosticGazePoint.y.toFixed(3)} · 해당 프레임 기록 전용 · 현재 장면/시선 재사용 불가 · 물리적 시간 정렬 미검증 · ${provider==='Meta'?'Meta':'provider unknown'} ${model==='sam-3.1'?'SAM 3.1':'model unknown'} · 같은 프레임 마스크 ${count}개`;
      }else $('#sceneStatus').textContent=
        `고정 프레임 ${frame.frameId} · 관측 ${frame.observedAt.toFixed(1)} ms · 처리 ${performance.now().toFixed(1)} ms · ${provider==='Meta'?'Meta':'provider unknown'} ${model==='sam-3.1'?'SAM 3.1':'model unknown'} · 마스크 ${count}개`;
      if(gazeDemo){const gazePoint=diagnosticGazePoint,gazeTiming=diagnosticGazeTiming,recordId=await persistSamResult({frame,gazePoint,gazeTiming,masks});await requestProvisionalSpark({frame,imageDataUrl,masks,gazePoint,gazeTiming,recordId});}
    }
  });
  function cancelDiagnostic(){diagnostic.cancel();cancelProvisionalSpark();diagnosticLayers=null;diagnosticGazePoint=null;diagnosticGazeTiming=null;diagnosticPurpose='scene';$('#runScene').disabled=false;$('#sceneSnapshot').hidden=true;$('#sceneStatus').textContent='장면 진단 취소됨';if($('#worldSceneState').textContent.includes('SAM 요청 중'))$('#worldSceneState').textContent='중단됨';}
  function calibrationPassed(){return pilot?.calibration?.passed===true&&!pilot.calibration.invalidatedAtUtc;}
  function samSessionAllowed(){const session=coordinator?.status();return !!session?.active&&!session.paused&&$('#localConsent').checked;}
  function frozenGazeAllowed(){return samSessionAllowed()&&calibrationPassed();}
  function provisionalGazeAllowed(){return samSessionAllowed()&&!calibrationStage;}
  function provisionalSparkAllowed(frame){return provisionalGazeAllowed()&&$('#provisionalSparkConsent').checked&&sceneFrozen&&frozenScene?.frame.frameId===frame?.frameId&&frozenScene.frame.observedAt===frame?.observedAt;}
  function cancelProvisionalSpark(status='잠정 Spark 결과 폐기 · 물리적 시간 정렬 미검증'){
    provisionalSparkGeneration++;const pending=provisionalSparkController,recordId=provisionalSparkRecordId;provisionalSparkController=null;provisionalSparkRecordId=null;pending?.abort();if(recordId)void persistSparkResult(recordId,'cancelled');$('#provisionalSparkScenarios').replaceChildren();$('#provisionalSparkStatus').textContent=status;
  }
  function beginGazeObservation(){
    $('#provisionalSparkScenarios').replaceChildren();
    if(diagnosticLayers?.frame){const previous=diagnosticLayers.frame;$('#sceneSnapshot').hidden=true;$('#sceneStatus').textContent=`이전 SAM 결과 범위 · 고정 프레임 ${previous.frameId} 기록에만 적용 · 현재 장면/시선 재사용 불가 · 물리적 시간 정렬 미검증`;diagnosticLayers=null;}
    $('#provisionalSparkStatus').textContent='새 시선 표본 수집 중 · 이전 Spark 가설은 저장된 프레임 기록에만 적용';
  }
  function resumeWorldAfterGazeCycle(){sceneFrozen=false;frozenScene=null;$('#worldSceneState').textContent='장면 재생 · 이전 마스크는 고정 프레임 기록';updateFrozenGazeControls();}
  async function requestProvisionalSpark({frame,imageDataUrl,masks,gazePoint,gazeTiming,recordId=null}){
    $('#provisionalSparkScenarios').replaceChildren();
    if(!provisionalSparkAllowed(frame)){
      if(recordId)void persistSparkResult(recordId,$('#provisionalSparkConsent').checked?'cancelled':'withheld');
      if(!$('#provisionalSparkConsent').checked)$('#provisionalSparkStatus').textContent='SAM 결과만 표시 · 잠정 Spark 별도 동의 필요 · 물리적 시간 정렬 미검증';
      return;
    }
    if(provisionalSparkController){if(recordId)void persistSparkResult(recordId,'skipped');$('#provisionalSparkStatus').textContent='Spark 분석 중 · 잠정 · 시간 정렬 미검증';return;}
    const now=performance.now(),remaining=provisionalSparkMinIntervalMs-(now-lastProvisionalSparkAt);
    if(remaining>0){if(recordId)void persistSparkResult(recordId,'skipped');$('#provisionalSparkStatus').textContent=`Spark 요청 대기 · ${Math.ceil(remaining/1000)}초 후 재시도 · 잠정`;return;}
    const token=++provisionalSparkGeneration,requestController=new AbortController();provisionalSparkController=requestController;lastProvisionalSparkAt=now;
    provisionalSparkRecordId=recordId;
    $('#provisionalSparkStatus').textContent='Spark 분석 중 · 잠정 · 시간 정렬 미검증';
    const id=`${epoch}${frame.frameId}:${++provisionalSparkRequestNumber}`;
    let outcome;
    try{outcome=await journalCall('provisional-spark',id,()=>sendProvisionalSparkRequest({consent:true,frame,imageDataUrl,gazePoint,gazeTiming,masks,issuedAtMs:performance.now(),signal:requestController.signal}));}catch{outcome=requestController.signal.aborted?{status:'cancelled'}:{status:'failed',reason:'request_failed'};}
    if(token!==provisionalSparkGeneration||requestController.signal.aborted||!provisionalSparkAllowed(frame)){if(recordId)await persistSparkResult(recordId,'cancelled');if(provisionalSparkController===requestController)provisionalSparkController=null;if(provisionalSparkRecordId===recordId)provisionalSparkRecordId=null;return;}
    if(outcome.status==='ok'){
      const scenarios=outcome.result.scenarios.filter(s=>typeof s?.possible_next_action==='string').slice(0,5),list=$('#provisionalSparkScenarios');
      const published=await publishProvisionalSparkIfCurrent({
        persist:()=>persistSparkResult(recordId,'complete',outcome.result.scenarios,undefined,{render:false}),
        isCurrent:()=>token===provisionalSparkGeneration&&!requestController.signal.aborted&&provisionalSparkAllowed(frame),
        discard:()=>persistSparkResult(recordId,'cancelled'),
        publish:records=>{
          if(records)renderProvisionalTracking(records);
          for(const scenario of scenarios){const li=document.createElement('li');li.textContent=scenario.possible_next_action;list.appendChild(li);}
          $('#runtimeStatus').textContent='SAM + Spark 분석 완료 · 잠정 · 시간 정렬 미검증';
          $('#provisionalSparkStatus').textContent=scenarios.length?`Spark 분석 완료 · 가설 ${scenarios.length}개 · 잠정 · 시간 정렬 미검증`:`Spark 분석 완료 · 가설 보류 · 잠정 · 시간 정렬 미검증`;
        }
      });
      if(!published){if(provisionalSparkController===requestController)provisionalSparkController=null;if(provisionalSparkRecordId===recordId)provisionalSparkRecordId=null;return;}
    }else if(outcome.status==='failed'){
      const published=await publishProvisionalSparkIfCurrent({
        persist:()=>persistSparkResult(recordId,'failed',[],outcome.reason),
        isCurrent:()=>token===provisionalSparkGeneration&&!requestController.signal.aborted&&provisionalSparkAllowed(frame),
        discard:()=>persistSparkResult(recordId,'cancelled'),
        publish:()=>{$('#provisionalSparkStatus').textContent=`Spark 분석 실패 · ${provisionalSparkFailureLabels[outcome.reason]??'실패 사유 확인 필요'} · SAM 결과 보존 · 잠정`;}
      });
      if(!published){if(provisionalSparkController===requestController)provisionalSparkController=null;if(provisionalSparkRecordId===recordId)provisionalSparkRecordId=null;return;}
    }else await persistSparkResult(recordId,outcome.status==='cancelled'?'cancelled':'failed');
    if(provisionalSparkController===requestController)provisionalSparkController=null;
    if(provisionalSparkRecordId===recordId)provisionalSparkRecordId=null;
  }
  function updateFrozenGazeControls(){
    $('#resumeWorld').disabled=!sceneFrozen&&!frozenGazeAutomation.status().active;
  }
  function cancelFrozenGazeExpiry(){
    if(frozenGazeExpiry!==null)clearTimeout(frozenGazeExpiry);
    frozenGazeExpiry=null;const resolve=frozenGazeResolve;frozenGazeResolve=null;resolve?.();
  }
  function clearFrozenGazeDemo(reason='잠정 시선 시험 취소됨',unfreeze=true){
    const wasFrozenDemo=sceneFrozen||frozenGazeRequest||frozenGazeAutomation.status().active||diagnosticPurpose==='frozen-gaze-demo'||diagnosticPurpose==='uncalibrated-gaze-demo'||diagnosticPurpose==='scene-only';
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
    if(initialScenePending){$('#gazeSamDemoStatus').textContent='시작 장면 SAM 처리 완료 후 시선 SAM을 시작합니다.';return;}
    const selected=selectFrozenSceneGaze({sample:latest,frame:frozenScene.frame,canvasRect:canvas.getBoundingClientRect(),frozenAtMs:frozenScene.frozenAtMs,stableAfterMs:sampleAfterMs,nowMs:performance.now()});
    if(selected.status!=='ready'){$('#gazeSamDemoStatus').textContent=`시선 표본 보류 · ${provisionalGazeFailureReason(null,selected.reason)} · 5초 후 다시 확인합니다. 시간 정렬은 미검증입니다.`;updateFrozenGazeControls();return;}
    if(!frozenGazeAllowed())return;
    frozenGazeRequest=true;diagnosticPurpose='frozen-gaze-demo';diagnosticGazePoint=selected.point;diagnosticGazeTiming={sampleAtMs:selected.captureAtMs,processedAtMs:selected.processedAtMs,timestampKind:'browser_capture_estimate',estimateStatus:'validated_calibration_estimate'};$('#sceneSnapshot').hidden=true;$('#runScene').disabled=true;$('#worldGazeState').textContent='잠정 시선 SAM 요청 중';$('#worldSceneState').textContent='시선 SAM 요청 중';$('#gazeSamDemoStatus').textContent=`보정된 브라우저 추정점 ${Math.floor(selected.point.x*frozenScene.frame.width)}, ${Math.floor(selected.point.y*frozenScene.frame.height)} px · Meta SAM 유료 요청 중 · 물리적 시간 정렬 미검증`;updateFrozenGazeControls();
    let result;try{result=await diagnostic.run(frozenScene.frame,frozenScene.rgba.slice(),gazeSamPrompt(frozenScene.frame,selected.point));}catch{result={status:'failed'};}
    if(token!==frozenGazeGeneration)return;
    frozenGazeRequest=false;diagnosticPurpose='scene';diagnosticGazePoint=null;diagnosticGazeTiming=null;$('#runScene').disabled=false;
    if(result.status==='ok'){$('#worldGazeState').textContent='SAM 응답 · 시간 미검증';$('#gazeSamDemoStatus').textContent=`SAM 결과 표시됨 · 고정 프레임 ${frozenScene.frame.frameId} · 같은 프레임 마스크와 보정된 브라우저 추정점 · 물리적 시간 정렬 미검증 · 다음 호출은 5초 이상 후`;if(pilot){pilot.frozenSceneDemo={status:'unverified_used',timingStatus:selected.timingStatus,opticalTimingUncertaintyMs:null,maxAcceptedCaptureProcessingLagMs:selected.maxCaptureProcessingLagMs,maxObservedCaptureProcessingLagMs:selected.captureProcessingLagMs,maxAcceptedProcessingAgeMs:selected.maxAcceptedProcessingAgeMs,maxAcceptedSampleAgeMs:selected.maxAcceptedSampleAgeMs,sampleCount:(pilot.frozenSceneDemo?.sampleCount??0)+1,samCalls:(pilot.frozenSceneDemo?.samCalls??0)+1};}}
    else {$('#worldGazeState').textContent=result.status==='cancelled'?'중단됨':'보정 시선 SAM 실패';$('#worldSceneState').textContent=result.status==='cancelled'?'중단됨':'시선 SAM 실패';$('#gazeSamDemoStatus').textContent=result.status==='cancelled'?'SAM 요청 취소됨 · 동의/세션 확인 후 다시 시작합니다.':'SAM 요청 실패 · 원격 서비스 또는 네트워크를 확인하세요. 시간 정렬은 미검증입니다.';}
    updateFrozenGazeControls();
  }
  async function runUncalibratedGazeSample(){
    if(!sceneFrozen||!frozenScene||!provisionalGazeAllowed()||frozenGazeRequest)return;
    const token=++frozenGazeGeneration,sampleAfterMs=Math.max(frozenScene.stableAfterMs,performance.now()+1500),delay=Math.max(0,sampleAfterMs-performance.now());
    $('#gazeSamDemoStatus').textContent='WebEyeTrack 기본 모델 · 미교정 · 고정 장면에서 신선한 표본을 기다립니다. 정확도와 물리적 시간 정렬은 미검증입니다.';
    await new Promise(resolve=>{frozenGazeResolve=resolve;frozenGazeExpiry=setTimeout(()=>{frozenGazeExpiry=null;frozenGazeResolve=null;resolve();},delay);});
    if(token!==frozenGazeGeneration||!sceneFrozen||!frozenScene||!provisionalGazeAllowed())return;
    if(initialScenePending){$('#gazeSamDemoStatus').textContent='시작 장면 SAM 처리 완료 후 미교정 시선 SAM을 시작합니다.';return;}
    const selected=selectProvisionalIrisGaze({estimate:latestProvisionalGaze?.estimate,sample:latestProvisionalGaze?.sample,frame:frozenScene.frame,canvasRect:canvas.getBoundingClientRect(),viewport:{width:innerWidth,height:innerHeight},stableAfterMs:sampleAfterMs,nowMs:performance.now()});
    if(selected.status!=='ready'){$('#gazeSamDemoStatus').textContent=`미교정 시선 표본 보류 · ${provisionalGazeFailureReason(latestProvisionalGaze?.estimate,selected.reason)} · 5초 후 다시 확인합니다. 물리적 시간 정렬은 미검증입니다.`;updateFrozenGazeControls();return;}
    if(!provisionalGazeAllowed())return;
    frozenGazeRequest=true;diagnosticPurpose='uncalibrated-gaze-demo';diagnosticGazePoint=selected.point;diagnosticGazeTiming={sampleAtMs:selected.sampleAtMs,processedAtMs:selected.processedAtMs,timestampKind:selected.timestampKind,estimateStatus:'uncalibrated_estimate'};$('#sceneSnapshot').hidden=true;$('#runScene').disabled=true;$('#worldGazeState').textContent='미교정 추정 시선 SAM 요청 중';$('#worldSceneState').textContent='미교정 시선 SAM 요청 중';
    const timingLabel=selected.timestampKind==='browser_capture_estimate'?'브라우저 캡처 추정 시각':'콜백 시각(캡처 시각 아님)';
    const eyeBasis=selected.eyesUsed?.length===1?'한쪽 눈 기반':'양안 기반';
    $('#gazeSamDemoStatus').textContent=`WebEyeTrack 기본 모델 미교정 (${eyeBasis}) ${Math.floor(selected.point.x*frozenScene.frame.width)}, ${Math.floor(selected.point.y*frozenScene.frame.height)} px · ${timingLabel} · Meta SAM 유료 요청 · 정확도와 물리적 시간 정렬 미검증`;updateFrozenGazeControls();
    let result;try{result=await diagnostic.run(frozenScene.frame,frozenScene.rgba.slice(),gazeSamPrompt(frozenScene.frame,selected.point));}catch{result={status:'failed'};}
    if(token!==frozenGazeGeneration)return;
    frozenGazeRequest=false;diagnosticPurpose='scene';diagnosticGazePoint=null;diagnosticGazeTiming=null;$('#runScene').disabled=false;
    if(result.status==='ok'){$('#worldGazeState').textContent=`WebEyeTrack 미교정 추정 (${eyeBasis}) · SAM 응답 · 시간 미검증`;$('#gazeSamDemoStatus').textContent=`SAM 결과 표시됨 · WebEyeTrack 기본 모델 미교정 (${eyeBasis}) · ${timingLabel} · 고정 프레임 ${frozenScene.frame.frameId} · 정확도와 물리적 시간 정렬 미검증 · 다음 호출은 5초 이상 후`;}
    else {$('#worldGazeState').textContent=result.status==='cancelled'?'중단됨':'미교정 추정 SAM 실패';$('#worldSceneState').textContent=result.status==='cancelled'?'중단됨':'미교정 시선 SAM 실패';$('#gazeSamDemoStatus').textContent=result.status==='cancelled'?'SAM 요청 취소됨 · 동의/세션 확인 후 다시 시작합니다.':'미교정 추정 SAM 요청 실패 · 원격 서비스 또는 네트워크를 확인하세요. 물리적 시간 정렬은 미검증입니다.';}
    updateFrozenGazeControls();
  }
  function prepareFrozenSceneForGaze(provisional=false){
    if(sceneFrozen&&frozenScene)return true;
    if(provisional?!provisionalGazeAllowed():!frozenGazeAllowed())return false;
    const source=world?.getFrame();if(!source){$('#gazeSamDemoStatus').textContent='장면 프레임 대기 · 시선 SAM 보류';return false;}
    const bytes=source.viewport.width*source.viewport.height*4;if(bytes>history.maxBytes){$('#gazeSamDemoStatus').textContent='장면이 메모리 한도를 초과해 시선 SAM을 보류했습니다.';return false;}
    try{const gl=canvas.getContext('webgl');if(!gl)throw new Error('webgl unavailable');const rgba=new Uint8Array(bytes);gl.readPixels(0,0,source.viewport.width,source.viewport.height,gl.RGBA,gl.UNSIGNED_BYTE,rgba);const frozenAtMs=performance.now();frozenScene={frame:{frameId:source.frameId,observedAt:source.renderTsMs,width:source.viewport.width,height:source.viewport.height},rgba,frozenAtMs,stableAfterMs:frozenAtMs+500};sceneFrozen=true;}
    catch{sceneFrozen=false;frozenScene=null;$('#gazeSamDemoStatus').textContent='가상 장면 프레임 보존 실패 · 시선 SAM을 보류했습니다.';updateFrozenGazeControls();return false;}
    diagnosticPurpose='scene';diagnosticGazePoint=null;diagnosticLayers=null;$('#sceneSnapshot').hidden=true;$('#sceneStatus').textContent=provisional?'WebEyeTrack 기본 모델(미교정) 전용 · 시선점 정확도를 검증하지 않았습니다.':'교정 완료 · 다음 요청부터 보정된 WebEyeTrack 추정 시선점을 사용합니다. 시간 정렬은 미검증입니다.';$('#worldGazeState').textContent=provisional?'미교정 추정 표본 대기':'시선점 표본 대기';
    $('#gazeSamDemoStatus').textContent=provisional?'미교정 휴리스틱 세션 · 고정 장면에서 신선한 눈 랜드마크 표본을 기다립니다.':'교정된 세션 · 고정 장면에서 최근 시선 표본을 기다립니다.';updateFrozenGazeControls();return true;
  }
  async function runSceneOnlyAnalysis(){
    if(!samSessionAllowed()||initialScenePending)return {status:'withheld'};
    const source=world?.getFrame();
    if(!source){$('#worldSceneState').textContent='프레임 대기 실패';return {status:'failed'};}
    const bytes=source.viewport.width*source.viewport.height*4;
    if(bytes>history.maxBytes){$('#worldSceneState').textContent='프레임 한도 초과';return {status:'failed'};}
    let rgba;try{const gl=canvas.getContext('webgl');if(!gl)throw new Error('webgl unavailable');rgba=new Uint8Array(bytes);gl.readPixels(0,0,source.viewport.width,source.viewport.height,gl.RGBA,gl.UNSIGNED_BYTE,rgba);}catch{$('#worldSceneState').textContent='장면 캡처 실패';return {status:'failed'};}
    const token=++initialSceneGeneration;initialScenePending=true;diagnosticPurpose='scene-only';diagnosticGazePoint=null;diagnosticGazeTiming=null;$('#runScene').disabled=true;$('#worldSceneState').textContent='장면 전용 SAM 요청 중';$('#sceneStatus').textContent='교정 전 장면 전용 SAM · 시선점 미사용';$('#gazeSamDemoStatus').textContent='교정 전 · 장면만 분할 중 · 시선 SAM 보류';
    let result;try{result=await requestStartupSceneAnalysis({consent:$('#localConsent').checked,frame:source,rgba,diagnostic});}catch{result={status:'failed'};}
    if(token===initialSceneGeneration){$('#runScene').disabled=false;if(result.status!=='ok'&&result.status!=='cancelled'&&result.status!=='withheld'){$('#worldSceneState').textContent='장면 요청 실패';$('#sceneStatus').textContent='장면 SAM 요청 실패 · 네트워크 또는 Meta SAM 설정을 확인하세요.';}initialScenePending=false;diagnosticPurpose='scene';}
    return result;
  }
  async function runSamAnalysis(){
    if(!samSessionAllowed())return;
    beginGazeObservation();
    const calibrated=calibrationPassed();
    return runFrozenGazeCycle({
      prepare:()=>calibrated?prepareFrozenSceneForGaze():provisionalGazeAllowed()&&prepareFrozenSceneForGaze(true),
      run:()=>{if(initialScenePending){$('#gazeSamDemoStatus').textContent='시작 장면 SAM 처리 완료 후 시선 표본을 수집합니다.';return {status:'withheld'};}return calibrated?runFrozenGazeSample():runUncalibratedGazeSample();},
      resume:resumeWorldAfterGazeCycle
    });
  }
  const frozenGazeAutomation=createFrozenGazeAutomation({run:runSamAnalysis,now:()=>performance.now(),intervalMs:5000});
  function maybeStartFrozenGazeAutomation(){if(!samSessionAllowed()||frozenGazeAutomation.status().active)return false;frozenGazeAutomation.start();updateFrozenGazeControls();return true;}
  $('#resumeWorld').addEventListener('click',()=>clearFrozenGazeDemo('자동 탐색 중단 · 가상 장면 재개'));
  $('#provisionalSparkConsent').addEventListener('change',()=>{
    if(!$('#provisionalSparkConsent').checked)cancelProvisionalSpark('잠정 Spark 동의 철회 · 진행 중 요청 취소 및 결과 폐기');
    else $('#provisionalSparkStatus').textContent='별도 동의 완료 · 다음 SAM 응답 후 Spark 분석 · 잠정';
  });
  $('#runScene').addEventListener('click',async()=>{
    if(!$('#localConsent').checked){$('#sceneStatus').textContent='시작 전 카메라·SAM 동의가 필요합니다.';return;}
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
  function updateGazeSamButton(){const ready=!!pendingAligned&&!!timingCalibration&&!!remotePipeline&&$('#gazeSamConsent').checked&&$('#localConsent').checked&&$('#reasonConsent').checked&&!!coordinator?.status().active&&!coordinator.status().paused;$('#runGazeSam').disabled=!ready;}
  function stopRemote(){researchTrace.cancelPending();remoteGeneration++;const pipeline=remotePipeline;remotePipeline=null;remoteRuntime?.stop();remoteRuntime=null;pipeline?.stop();pendingAligned=null;if(alignedExpiryTimer!==null)clearTimeout(alignedExpiryTimer);alignedExpiryTimer=null;$('#scenarios').replaceChildren();$('#nextGazeStatus').textContent='다음 시선 예측 없음';preparation.clear();$('#scenarioStatus').textContent='시나리오 준비 보류';updateGazeSamButton();}
  function startRemote(){
    if(remotePipeline || !coordinator?.status().active || coordinator.status().paused || !$('#localConsent').checked || !calibrationPassed())return;
    const sessionId=crypto.randomUUID(),token=++remoteGeneration;
    const reasoner=createServerReasoner({remoteConsent:true,journal,sessionId:journalSessionId});
    const rt=new RuntimeFacade({sessionId,analyzer:reasoner,now:sessionNow,timeoutMs:90000,minIntervalMs:1000,maxCallsPerMinute:10,maxCostPerMinute:1,estimatedCostPerCall:.05,publish:result=>{
      if(token!==remoteGeneration || !$('#localConsent').checked || !$('#reasonConsent').checked)return;
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
    isAllowed:()=>!!remotePipeline && $('#localConsent').checked && $('#reasonConsent').checked && $('#gazeSamConsent').checked && !!coordinator?.status().active && !coordinator.status().paused,
    getPipeline:()=>remotePipeline,now:sessionNow,onFrame:frame=>researchTrace.rememberFrame(frame),mapId:'synthetic-world-'+epoch,coordinateFrameId:'synthetic-world-frame-'+epoch,
    encode:(rgba,width,height)=>{const c=document.createElement('canvas');c.width=width;c.height=height;c.getContext('2d').putImageData(new ImageData(rgba,width,height),0,0);return c.toDataURL('image/png');}
  });
  const exploration=createExploration({allowed:()=>$('#exploreConsent').checked && $('#localConsent').checked && validSamConcept($('#samConcept').value) && !!coordinator?.status().active && !coordinator.status().paused, pipeline:()=>remotePipeline, now:sessionNow, snapshot:()=>{
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
    if(!input||sessionNow()-input.gaze.timestampMs>1000||!timingCalibration||!$('#gazeSamConsent').checked||!$('#localConsent').checked||!$('#reasonConsent').checked||!remotePipeline){$('#gazeSamStatus').textContent='광학 측정, 최근 정렬 프레임, SAM·Spark 동의 및 활성 세션이 필요합니다.';return;}
    const result=handoff(input);
    $('#gazeSamStatus').textContent=result.accepted?'선택한 시선 프레임을 전송했습니다.':'전송 보류 · 동의, 세션, 정렬 또는 보존 프레임을 확인하세요.';
  });
  $('#gazeSamConsent').addEventListener('change',()=>{if(!$('#gazeSamConsent').checked){pendingAligned=null;stopRemote();startRemote();}updateGazeSamButton();});
  $('#reasonConsent').addEventListener('change',()=>{if(!$('#reasonConsent').checked){stopRemote();startRemote();}else startRemote();updateGazeSamButton();});
  let memory=await MemoryService.open({sessionId:crypto.randomUUID(),clock:sessionNow});
  let unsubscribeTrace=memory.subscribeInvalidations(ids=>{researchTrace.withdrawEvidence(ids);if(remoteRuntime){$('#scenarios').replaceChildren();$('#nextGazeStatus').textContent='다음 시선 예측 없음';preparation.clear();$('#scenarioStatus').textContent='증거 변경으로 시나리오가 철회되었습니다';}});
  function bindTraceMemory(){unsubscribeTrace();unsubscribeTrace=memory.subscribeInvalidations(ids=>{researchTrace.withdrawEvidence(ids);if(remoteRuntime){$('#scenarios').replaceChildren();$('#nextGazeStatus').textContent='다음 시선 예측 없음';preparation.clear();$('#scenarioStatus').textContent='증거 변경으로 시나리오가 철회되었습니다';}});}
  const runtime=new RuntimeFacade({sessionId:crypto.randomUUID(),now:()=>performance.now()});
  const recordingStatus=document.createElement('span');recordingStatus.id='recordingState';recordingStatus.setAttribute('role','status');canvas.parentElement.append(recordingStatus);
  const recordingSummary=$('#localRecordingSummary'),mib=bytes=>`${(bytes/1048576).toFixed(1)} MiB`;
  async function refreshRecordingSummary(){try{const {recordings,totalBytes}=await listLocalRecordings();const active=recordings.filter(r=>r.active).length;recordingSummary.textContent=recordings.length?`로컬 영상 기록 ${recordings.length}개 · ${mib(totalBytes)}${active?` · 녹화 중 ${active}개`:''}`:'로컬 영상 기록 없음';}catch{recordingSummary.textContent='로컬 영상 기록 확인 실패';}}
  async function refreshComputeProfile(){const status=$('#gazeBackendStatus');try{const response=await fetch('/api/runtime/config');if(!response.ok)throw Error();const config=await response.json();if(config.computeProfile==='cloud'){const probe=await fetch('/api/gaze/health'),health=await probe.json();status.textContent=health.ready?'Cloud profile · Remote GPU WebEyeTrack 준비됨 · unavailable이면 로컬 fallback 없이 시작 차단':'Cloud profile · Remote GPU를 사용할 수 없음 · 로컬 fallback 없이 시작 차단';}else if(config.computeProfile==='local')status.textContent='Local profile · WebEyeTrack은 이 기기 브라우저에서 실행됩니다.';else status.textContent='Compute profile 확인 실패';}catch{status.textContent='Compute profile/Remote GPU 상태를 확인할 수 없음';}}
  async function refreshDepthBackend(){const status=$('#depthBackendStatus');try{const response=await fetch('/api/depth/status');if(!response.ok)throw Error();const value=await response.json();status.textContent=value.backend==='colab_gpu'?'Colab GPU 선택됨 · 가상 장면 프레임을 Google Colab으로 전송':value.backend==='local_cpu'?'이 기기 로컬 CPU 선택됨':'깊이 서버 선택을 확인할 수 없음';}catch{status.textContent='깊이 서버 선택을 확인할 수 없음';}}
  const localRecorder=createLocalRecorder({onStatus:result=>{recordingStatus.textContent=({recording:'로컬 기록 중',saved:'로컬 기록 저장됨',failed:'로컬 기록 저장 실패',unavailable:'로컬 영상 기록 지원 안 됨'})[result.status]??'';if(['recording','saved'].includes(result.status))void refreshRecordingSummary();}});
  $('#refreshRecordings').addEventListener('click',()=>void refreshRecordingSummary());
  function setDataPanel(open){$('#sessionPanel').classList.toggle('open',open);$('#dataPanel').setAttribute('aria-expanded',String(open));if(open){$('#dataSettings').open=true;void refreshRecordingSummary();void refreshComputeProfile();void refreshDepthBackend();}}
  $('#dataPanel').addEventListener('click',()=>setDataPanel(!$('#sessionPanel').classList.contains('open')));
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&accuracySession){accuracySession.cancel('user_cancelled');return;}if(event.key==='Escape'&&$('#sessionPanel').classList.contains('open')){setDataPanel(false);$('#dataPanel').focus();}});
  // Deletion is permanent and the server never removes an open recording, so stopping comes first.
  $('#deleteRecordings').addEventListener('click',async event=>{const button=event.currentTarget;if(coordinator?.status().active){recordingSummary.textContent='녹화 중에는 삭제할 수 없습니다 · 정지(■) 후 다시 시도';return;}if(!confirm('이 기기의 로컬 영상 기록을 모두 영구 삭제합니다. 계속할까요?'))return;button.disabled=true;
    try{const result=await deleteLocalRecordings();recordingSummary.textContent=`로컬 영상 기록 ${result.deleted.length}개 삭제 · ${mib(result.freedBytes)}`+(result.failed.length?` · 삭제 실패 ${result.failed.length}개`:'')+(result.skippedActive.length?` · 녹화 중이라 보류 ${result.skippedActive.length}개`:'');}
    catch{recordingSummary.textContent='로컬 영상 기록 삭제 실패 · 일부만 삭제됐을 수 있음, 확인 버튼으로 다시 확인';}finally{button.disabled=false;}});
  // Accuracy test (G1-F): frozen plan, fixed timing, no click-through and no adaptation while targets are shown.
  let accuracySession=null,accuracyResult=null;const accuracyStatus=$('#accuracyStatus');
  function accuracyConditions(){const glasses=$('#accuracyGlasses').value,lighting=$('#accuracyLighting').value.trim(),distance=Number($('#accuracyDistance').value);
    return {glasses:glasses===''?{value:null,reason:'not_reported'}:glasses==='true',lighting:lighting?lighting:{value:null,reason:'not_reported'},distanceCm:$('#accuracyDistance').value!==''&&Number.isFinite(distance)&&distance>0&&distance<500?distance:{value:null,reason:'not_measured'}};}
  function downloadJson(data,name){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  $('#startAccuracy').addEventListener('click',()=>{
    if(accuracySession){accuracyStatus.textContent='시험 진행 중';return;}
    if(!coordinator?.status().active||coordinator.status().paused){accuracyStatus.textContent='카메라 시작(▶) 후 시험할 수 있습니다';return;}
    if(calibrationStage||!calibrationPassed()){accuracyStatus.textContent='교정 통과 후 시험할 수 있습니다';return;}
    let session;try{const seed=crypto.getRandomValues(new Uint32Array(1))[0];const plan=createAccuracyPlan({seed,screen:{width:innerWidth,height:innerHeight}});
      session=createAccuracySession({plan,conditions:accuracyConditions(),
        onTrial:({trial,index,total})=>{const target=$('#target');$('#calibration').hidden=false;target.style.pointerEvents='none';target.style.left=trial.x+'px';target.style.top=trial.y+'px';$('#calibrationInfo').textContent=`정확도 시험 ${index+1}/${total} · 표적 응시 · 클릭 불필요 · Esc 취소`;},
        onFinish:result=>{accuracySession=null;$('#calibration').hidden=true;$('#target').style.pointerEvents='';$('#calibrationInfo').textContent='';
          if(result.status==='completed'){accuracyResult=result;const v=result.report.verdict,e=result.report.stages[result.report.verdictStage]?.error;accuracyStatus.textContent=`시험 완료 · ${v.status} · p95 ${Number.isFinite(e?.p95)?(e.p95*100).toFixed(1)+'%':'산출 불가'} (대각선) · plan ${result.planHash.slice(0,8)} · Gate 판정 아님`;$('#exportAccuracyReport').disabled=false;$('#exportAccuracySamples').disabled=false;}
          else accuracyStatus.textContent=result.status==='report_failed'?`보고서 생성 실패 · ${result.reason}`:`시험 취소 · ${result.reason}`;
          startBackgroundAttention();}});}
    catch(error){accuracyStatus.textContent=`시험 준비 실패 · ${error.message}`;return;}
    accuracySession=session;stopBackgroundAttention();setDataPanel(false);accuracyStatus.textContent=`시험 중 · plan ${session.planHash.slice(0,8)}`;session.start();
  });
  $('#exportAccuracyReport').addEventListener('click',()=>{if(accuracyResult)downloadJson(accuracyResult.report,`prometheus-gaze-accuracy-${accuracyResult.planHash.slice(0,8)}.json`);});
  $('#exportAccuracySamples').addEventListener('click',()=>{if(accuracyResult)downloadJson({kind:'gaze_accuracy_samples',planHash:accuracyResult.planHash,reportHash:accuracyResult.report.hash,droppedSamples:accuracyResult.droppedSamples,samples:accuracyResult.samples},`prometheus-gaze-accuracy-samples-${accuracyResult.planHash.slice(0,8)}.json`);});
  $('#deleteCalibrationProfile').addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;try{const store=await profileStorage;if(!store)throw new Error('storage_unavailable');await store.removeItem(GAZE_CALIBRATION_PROFILE_KEY);await store.removeItem(remoteGazeAdapterKey);remoteCalibrationProfile=null;showCalibrationStatus('저장 교정 및 GPU model-only adapter 삭제됨 · 현재 세션의 적응은 정지 전까지 유지');}catch{showCalibrationStatus('저장 교정 삭제 실패');}finally{button.disabled=false;}});
  let backgroundAttention=null,depthRequest=null,lastBackgroundTelemetry=null;
  const modelDepthStatus=document.createElement('span');modelDepthStatus.id='modelDepthState';modelDepthStatus.setAttribute('role','status');canvas.parentElement.append(modelDepthStatus);

  const backgroundStatus=document.createElement('span');backgroundStatus.id='backgroundAttentionState';backgroundStatus.setAttribute('role','status');canvas.parentElement.append(backgroundStatus);
  function backgroundSnapshot(){
    // Paid SAM/Spark calls run only with the start consent in place and a visible tab.
    if(!$('#localConsent').checked||document.hidden||accuracySession||!coordinator?.status().active||coordinator.status().paused||calibrationStage||!latest?.faceDetected||!latest.rawScreenXY||performance.now()-latest.processedMs>500||!world)return null;
    const source=world.getFrame(),r=canvas.getBoundingClientRect();if(!source||r.width<=0||r.height<=0)return null;
    const x=(latest.rawScreenXY.x-r.left)/r.width,y=(latest.rawScreenXY.y-r.top)/r.height;if(x<0||y<0||x>=1||y>=1)return null;
    const copy=document.createElement('canvas'),scale=Math.min(1,640/canvas.width,480/canvas.height);copy.width=Math.max(1,Math.round(canvas.width*scale));copy.height=Math.max(1,Math.round(canvas.height*scale));copy.getContext('2d').drawImage(canvas,0,0,copy.width,copy.height);
    const at=performance.now();
    return {frame:{frameId:source.frameId,observedAt:source.renderTsMs,processedAt:at,width:copy.width,height:copy.height,imageData:copy.toDataURL('image/png')},gaze:{frameId:source.frameId,x,y,observedAt:latest.timestampMs,processedAt:latest.processedMs,timestampKind:latest.timestampKind,estimateStatus:latest.valid&&latest.timestampKind==='browser_capture_estimate'?'validated_calibration_estimate':'uncalibrated_estimate'},dependencies:{mapId:'synthetic-world',mapVersion:1,objectIds:[],evidenceIds:[source.frameId],expiresAt:at+120000},timingStatus:'provisional_browser_association',stateKey:source.frameId};
  }
  let liveTracker=null;
  function startBackgroundAttention(){
    if(backgroundAttention||!coordinator?.status().active)return;
    // One tracker per camera session keeps persistent object IDs across pause/resume.
    const trackingSession=cameraSessionId??'no-camera-session';if(!liveTracker||liveTracker.sessionId!==trackingSession)liveTracker={sessionId:trackingSession,tracker:new LiveTracking()};
    const work=createBackgroundBrowserWork({tracker:liveTracker.tracker,capture:async snapshot=>({frame:snapshot.frame}),
      // Depth runs on the same frame in parallel with SAM; mask-level statistics reach Spark only if it arrives in time.
      depth:async(frame,{signal})=>{modelDepthStatus.textContent='Depth Anything 분석 중';const response=await fetch('/api/depth/estimate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({frame:{frameId:frame.frameId,observedAt:frame.observedAt,width:frame.width,height:frame.height},imageDataUrl:frame.imageData}),signal});const result=await response.json();if(!response.ok){modelDepthStatus.textContent='Depth Anything 요청 실패';throw Object.assign(new Error('depth_unavailable'),{code:result?.code??'depth_unavailable'});}modelDepthStatus.textContent=`Depth Anything · ${result.model?.device??'?'} · ${Math.round(result.timing?.requestRoundTripMs??result.timing?.totalMs??0)}ms · 원본 프레임 기준`;return result;},
      sam:async(frame,{signal,gaze})=>{const response=await fetch('/api/sam/segment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({frame:{frameId:frame.frameId,observedAt:frame.observedAt},imageDataUrl:frame.imageData,prompt:gazeSamPrompt(frame,gaze)}),signal});if(!response.ok)throw new Error('background_sam_failed');const result=await response.json();$('#worldSceneState').textContent=`백그라운드 SAM · ${result.masks?.length??0} 마스크`;return result;},
      reason:async(input,{signal})=>sendProvisionalSparkRequest({consent:$('#provisionalSparkConsent').checked,frame:input.frame,imageDataUrl:input.frame.imageData,gazePoint:input.gaze,gazeTiming:{sampleAtMs:input.gaze.observedAt,processedAtMs:input.gaze.processedAt,timestampKind:input.gaze.timestampKind,estimateStatus:input.gaze.estimateStatus},masks:input.masks,candidates:input.candidates,depth:input.depth,issuedAtMs:performance.now(),signal})});
    backgroundAttention=new BackgroundAttentionCoordinator({work,snapshot:backgroundSnapshot,intervalMs:1000,minIntervalMs:1000,timeoutMs:110000,retryIntervalMs:5000,
      publish:result=>{const list=$('#provisionalSparkScenarios');list.replaceChildren();for(const scenario of result.scenarios){const item=document.createElement('li');item.textContent=scenario.possible_next_action;list.append(item);}if(result.nextGaze) {const item=document.createElement('li');item.textContent='다음 응시 후보: '+result.nextGaze.rankedTargetIds.join(', ');list.append(item);}backgroundStatus.textContent=`백그라운드 가설 · 근거 ${Math.round(result.sourceAgeMs)}ms 전 · 시간 정렬 미검증`;},
      onStatus:status=>{if(['work_failed','invalid_result','timeout','processing_failed','snapshot_failed'].includes(status.event))backgroundStatus.textContent='백그라운드 추론 요청 실패 · 재시도 대기';}});
    backgroundAttention.start(cameraSessionId??crypto.randomUUID());backgroundStatus.textContent='백그라운드 attention 분석 중';
  }
  function stopBackgroundAttention(){if(typeof backgroundAttention?.telemetry==='function')lastBackgroundTelemetry=backgroundAttention.telemetry();backgroundAttention?.stop();backgroundAttention=null;depthRequest?.abort();depthRequest=null;}
  function drawEye(id,bitmap,faceDetected,crop) {
    const container=$('#'+id), c=container.querySelector('canvas'), context=c.getContext('2d');context.clearRect(0,0,c.width,c.height);
    if(bitmap) { try{context.drawImage(bitmap,0,0,c.width,c.height);container.querySelector('small').textContent='MediaPipe 실제 점 · 눈 민트/눈꺼풀 노랑/홍채 보라/눈썹 주황 · 동공 검출 아님 · 로컬';return;}catch{} }
    if(crop&&video.readyState>=2){context.save();context.translate(c.width,0);context.scale(-1,1);context.drawImage(video,crop.x,crop.y,crop.width,crop.height,0,0,c.width,c.height);context.restore();container.querySelector('small').textContent='랜드마크 비트맵 없음 · 실시간 크롭만 표시(프레임 비동기)';}
    else container.querySelector('small').textContent=!faceDetected?'얼굴/눈 검출 대기':crop?'랜드마크 미리보기 사용 불가 · 추적 계속':'눈 크롭 검출 대기';
  }
  function onEyePreview({faceDetected,eyeCrops,bitmaps}={}) {
    if(controller?.remote){for(const id of ['leftEye','rightEye'])$('#'+id).querySelector('small').textContent='Remote GPU gaze · eye crops and landmarks stay on this device';return;}
    drawEye('leftEye',bitmaps?.left,faceDetected,eyeCrops?.left);
    drawEye('rightEye',bitmaps?.right,faceDetected,eyeCrops?.right);
  }
  function onSample(sample) {
    if(timingCalibration&&!sameTimingSetup(timingCalibration.setup,timingSetup())){handleCalibrationEnvironmentChange('화면/카메라 설정 변경');return;}
    if(sample.features&&Number.isFinite(sample.callbackTimestampMs)){calibrationWindow.push({at:sample.callbackTimestampMs,features:[...sample.features]});while(calibrationWindow.length>30)calibrationWindow.shift();}
    const baseRawScreenXY=sample.rawScreenXY;
    if(sample.valid&&activeAffine&&withinCalibrationBounds(activeAffine,sample.features)){const p=predictCalibration(activeAffine,sample.features);if(Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<innerWidth&&p.y>=0&&p.y<innerHeight)sample={...sample,rawScreenXY:p};}
    const correctedFeatures=sample.valid&&activeLandmarkResidual?predictLandmarkResidual(activeLandmarkResidual,sample.features,sample.landmarkFeatures):null;
    if(correctedFeatures&&baseRawScreenXY&&Number.isFinite(innerWidth)&&Number.isFinite(innerHeight)&&innerWidth>0&&innerHeight>0)sample={...sample,rawScreenXY:{x:Math.min(1-Number.EPSILON,correctedFeatures[0])*innerWidth,y:Math.min(1-Number.EPSILON,correctedFeatures[1])*innerHeight}};
    if(pilot && pilot.stoppedAt===null && pilot.pauseStartedAt==null){
      pilot.samples++;if(sample.valid)pilot.validSamples++;if(sample.faceDetected)pilot.faces++;
      const kind=sample.timestampKind==='browser_capture_estimate'?'browser_capture_estimate':'callback_time_not_capture';pilot.timestampKinds[kind]++;
      if(Number.isFinite(sample.timestampMs) && pilot.lastTimestampKind===kind && Number.isFinite(pilot.lastTimestamp) && sample.timestampMs>pilot.lastTimestamp){const gap=sample.timestampMs-pilot.lastTimestamp;pilot.intervalCount++;pilot.intervalSum+=gap;pilot.intervalMax=Math.max(pilot.intervalMax,gap);}
      pilot.lastTimestamp=sample.timestampMs;pilot.lastTimestampKind=kind;
      if(Number.isFinite(sample.inferenceMs)&&sample.inferenceMs>=0){pilot.inferenceCount++;pilot.inferenceSum+=sample.inferenceMs;pilot.inferenceMax=Math.max(pilot.inferenceMax,sample.inferenceMs);}
    }
    accuracySession?.record({valid:sample.valid===true,invalidReason:sample.invalidReason,timestampMs:sample.timestampMs,baseScreenXY:baseRawScreenXY,calibratedScreenXY:sample.rawScreenXY,screen:{width:innerWidth,height:innerHeight}});
    latest=sample;
    const uncalibratedEstimate={status:baseRawScreenXY?'uncalibrated_estimate':'unavailable',calibrationStatus:'uncalibrated',method:'WebEyeTrack base model without user adaptation',eyesUsed:sample.faceDetected?['left','right']:[],point:baseRawScreenXY?{x:baseRawScreenXY.x/innerWidth,y:baseRawScreenXY.y/innerHeight}:null};
    latestProvisionalGaze={estimate:uncalibratedEstimate,sample:{faceDetected:sample.faceDetected===true,timestampMs:sample.timestampMs,processedMs:sample.processedMs,timestampKind:sample.timestampKind}};
    const r=canvas.getBoundingClientRect(),session=coordinator?.status(),viewportXY=gazeViewportPoint(sample,r);
    let markerXY=viewportXY;
    if(!calibrationPassed()&&!calibrationStage){
      markerXY=null;
      if(sample.faceDetected===true&&uncalibratedEstimate.status==='uncalibrated_estimate'){
        const screenPoint={x:uncalibratedEstimate.point.x*innerWidth,y:uncalibratedEstimate.point.y*innerHeight};
        if(screenPoint.x>=r.left&&screenPoint.x<r.left+r.width&&screenPoint.y>=r.top&&screenPoint.y<r.top+r.height)markerXY={x:(screenPoint.x-r.left)/r.width,y:(screenPoint.y-r.top)/r.height};
      }
      const timingLabel=sample.timestampKind==='callback_time_not_capture'?'콜백 시각(캡처 시각 아님)':'브라우저 캡처 추정 시각';
      gazeStatus.textContent=markerXY?`WebEyeTrack 기본 모델 · 미교정 ${timingLabel} · 정확도와 시간 정렬 미검증`:sample.faceDetected===true?'미교정 추정점이 장면 밖입니다.':'얼굴/유효 시선 미검출 · 미교정 추정 보류';
      $('#worldGazeState').textContent=markerXY?'WebEyeTrack 미교정 추정 · 데모 전용':sample.faceDetected===true?'장면 밖 · 미교정 추정':'얼굴/유효 시선 미검출';
    }else{
      gazeStatus.textContent=sample.valid?'시선 추정 · 시간 정렬 보류':`추적 보류 · ${sample.invalidReason}`;
      $('#worldGazeState').textContent=sample.valid?'시선 추정 · 정렬 미검증':sample.invalidReason==='calibration_required'?'교정 필요':`추적 보류 · ${sample.invalidReason}`;
      if(sample.valid)gazeStatus.textContent=viewportXY?(sample.sceneAssociationEligible?'월드 내 시선 추정 · 시간 정렬 확인 중':`월드 내 시선 추정 · 정렬 보류 (${sample.syncStatus})`):'진단 영역 / 월드 밖';
    }
    const filteredMarker=displayFilter.update(markerXY,sample.processedMs,{valid:!!markerXY&&!calibrationStage});
    showGazeMarker(filteredMarker.point,{active:!!session?.active,paused:!!session?.paused,calibrating:!!calibrationStage});
    const displayRegion=viewportXY?(viewportXY.y<1/3?'top':viewportXY.y<2/3?'middle':'bottom'):null;
    const frame=sample.sceneAssociationEligible ? history.at(sample.timestampMs,displayRegion) : null;
    if(sample.sceneAssociationEligible&&viewportXY){
      if(!frame)gazeStatus.textContent='시간 정렬 보류 · 해당 표시 구간의 보존 프레임 없음';
      else {const aligned=alignGaze({valid:true,captureMs:sample.timestampMs,syncUncertaintyMs:sample.syncUncertaintyMs},[{id:frame.frameId,presentMs:frame.presentTsEstimateMs,displayUncertaintyMs:frame.displayUncertaintyMs}]);
        if(aligned.status!=='aligned')gazeStatus.textContent=`시간 정렬 보류 · ${aligned.reason}`;
        else {const hit=world.raycastFrame(frame,viewportXY.x*frame.viewport.width,viewportXY.y*frame.viewport.height);gazeStatus.textContent=hit.status==='hit'?`정렬 프레임 ${frame.frameId} · 공간 접촉점 ${hit.point.map(x=>x.toFixed(2)).join(', ')} m`:`정렬 프레임 ${frame.frameId} · 공간 접촉 ${hit.status}`;}
      }
    }
    if(pilot?.calibration?.environmentChanged){gazeStatus.textContent+=' · 환경 변경 · 정확도 보장 안 됨';$('#worldGazeState').textContent+=' · 정확도 미보장';}
    if(coordinator && pilot)pilot.peakPending=Math.max(pilot.peakPending,coordinator.status().pending);
    const sampleForMemory={...sample};delete sampleForMemory.landmarkFeatures;
    const mapped=mapSessionEvidence(sampleForMemory,frame,sessionOffset,epoch,viewportXY);
    if(coordinator) coordinator.acceptSample(mapped.sample,mapped.frame).then(async result=>{if(result.recorded){const records=await memory.retrieve({observedUntil:sessionNow()});memoryStatus.textContent=result.pin==='evidence_evicted'?`증거 퇴거: ${result.reason}`:`스침 ${records.glimpses.length}건 · 객체 미연결`;}}).catch(()=>{memoryStatus.textContent='기억 입력 실패 · 기록 보류';});
    updateFrozenGazeControls();
  }
  function setState(s) {state.textContent=({starting:'시작 중',active:'카메라 활성',stopping:'정리 중',stopped:'정지',error:'시작 실패'})[s];start.disabled=s==='starting'||s==='active'||s==='stopping';stop.disabled=!(s==='starting'||s==='active');calibrate.disabled=s!=='active';calibrate.style.display=s==='active'?'inline-flex':'none';$('#pause').disabled=s!=='active';if(s!=='active'){clearGazeMarker();$('#pause').textContent='⏸';$('#pause').setAttribute('aria-label','일시정지');$('#pause').title='일시정지';}if(s==='stopped'&&!$('#localConsent').checked)$('#worldSceneState').textContent='동의 대기';updateFrozenGazeControls();}
  try {
    controller=createProfiledWebcamGazeController({video,mediaDevices:navigator.mediaDevices,onSample,onEyePreview,onDiagnostic:logStartupDiagnostic,onCalibrationProgress,getAdapter:async()=>{const store=await profileStorage;remoteCalibrationProfile=store?await store.getItem(remoteGazeAdapterKey):null;if(remoteCalibrationProfile&&(!remoteCalibrationProfile.adapter||remoteCalibrationProfile.version!==1||remoteCalibrationProfile.calibration?.passed!==true||!remoteCalibrationProfile.environment))throw Object.assign(new Error('remote calibration profile invalid'),{code:'gaze_adapter_incompatible'});return remoteCalibrationProfile?.adapter??null;},onError:error=>{stopBackgroundAttention();void localRecorder.stop();const diagnostic=startupFailureDiagnostic(error),detail=typeof error?.detail==='string'&&/^[a-z_]{3,48}$/.test(error.detail)?error.detail:null,text=`WebEyeTrack 추적 중단 · 코드 ${diagnostic.code} · 단계 ${diagnostic.step}${detail?` · 원인 ${detail}`:''}`;if(detail)try{console.info('[Prometheus WebEyeTrack diagnostic] 원인',detail);}catch{}logStartupDiagnostic(diagnostic.code);clearFrozenGazeDemo('카메라 오류 · 잠정 시선 시험 취소',true);stopRemote();cancelDiagnostic();activeCalibration=null;activeAffine=null;displayFilter.reset();activeLandmarkResidual=null;training=[];validation=[];if(pilot?.calibration?.passed)pilot.calibration={...pilot.calibration,passed:false,status:'camera_error',invalidatedAtUtc:new Date().toISOString()};timingCalibration=null;cameraSessionId=null;pendingAligned=null;$('#timingStatus').textContent='카메라 오류 · 시간 측정 다시 적용 필요';$('#runGazeSam').disabled=true;coordinator?.stop();message.textContent=text;gazeStatus.textContent=text;}});
    coordinator=createCoordinator({controller,memory,runtime,onState:setState,onAligned:submitAligned,onDiagnostic:logStartupDiagnostic,namespace:epoch});
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
  $('#deleteDurable').addEventListener('click',async()=>{if(sessionSelecting){$('#retentionStatus').textContent='보존 세션 처리 중입니다.';return;}if(durableSession){$('#clear').click();return;}try{await deleteProvisionalHistory();await deleteDurableSlot({sessionId:'local-research'});$('#retentionStatus').textContent='보존 세션 삭제됨';}catch{$('#retentionStatus').textContent='보존 세션 삭제 실패 · 다시 시도 필요';}});
  $('#deleteProvisionalHistory').addEventListener('click',async event=>{event.currentTarget.disabled=true;try{await deleteProvisionalHistory();}catch{}finally{event.currentTarget.disabled=false;}});
  $('#retentionConsent').addEventListener('change',()=>{if(!$('#retentionConsent').checked){retentionGeneration++;if(durableSession)$('#clear').click();}});
  async function startSession(){
    if(cameraStartPending||coordinator?.status().active)return;
    if(sessionSelecting){message.textContent='보존 세션 처리 완료 후 시작하세요.';return;}
    if(durableSession && !$('#retentionConsent').checked){message.textContent='보존 동의가 철회되어 시작할 수 없습니다. 삭제 상태를 확인하세요.';return;}
    if(!$('#localConsent').checked){message.textContent='시작 전에 카메라·유료 SAM 통합 동의가 필요합니다.';return;}
    cameraStartPending=true;let result;try{result=await coordinator.start();}finally{cameraStartPending=false;}
    if(result.started) {
      void localRecorder.start(video.srcObject).catch(()=>{recordingStatus.textContent='로컬 기록 시작 실패';});
      clearFrozenGazeDemo('새 카메라 세션 · 잠정 시선 시험 초기화',true);cameraSessionId=crypto.randomUUID();
      pilot={startedAt:performance.now(),startedAtUtc:new Date().toISOString(),stoppedAt:null,pausedMs:0,pauseStartedAt:null,samples:0,validSamples:0,faces:0,timestampKinds:{browser_capture_estimate:0,callback_time_not_capture:0},inferenceCount:0,inferenceSum:0,inferenceMax:0,intervalCount:0,intervalSum:0,intervalMax:0,lastTimestamp:null,lastTimestampKind:null,peakPending:0,cameraSettings:{width:result.settings.width,height:result.settings.height,reportedFrameRate:result.settings.frameRate},calibration:null};
      if(controller.remote&&controller.calibrated&&remoteCalibrationProfile)activeCalibration={calibration:remoteCalibrationProfile.calibration,environment:remoteCalibrationProfile.environment,environmentChanged:gazeCalibrationEnvironmentChanged(remoteCalibrationProfile.environment,gazeEnvironment(pilot.cameraSettings))};
      if(!activeCalibration&&!controller.remote){try{const store=await profileStorage;if(store){const loaded=await loadGazeCalibrationProfile(store,{environment:gazeEnvironment(pilot.cameraSettings),runtime:profileRuntime});if(loaded.compatible){await controller.restoreCalibration(loaded.profile);activeCalibration={calibration:loaded.profile.calibration,environment:loaded.profile.environment,environmentChanged:false};activeAffine=loaded.profile.affine?.selection?.selected?loaded.profile.affine.model:null;activeLandmarkResidual=restoreLandmarkResidualCalibration(loaded.profile);showCalibrationStatus('저장 교정 복원 완료');}else if(loaded.status!=='missing')showCalibrationStatus(`저장 교정 사용 보류 · ${loaded.status}`);}}catch{showCalibrationStatus('저장 교정 복원 실패 · 교정 버튼으로 다시 시도');}}
      const environmentChanged=!!activeCalibration&&(activeCalibration.environmentChanged===true||gazeCalibrationEnvironmentChanged(activeCalibration.environment,gazeEnvironment(pilot.cameraSettings)));
      if(activeCalibration)pilot.calibration={...activeCalibration.calibration,passed:true,status:'completed',reused:true,environmentChanged};
      sessionStarted=true;calibrationStage=null;$('#calibration').hidden=true;latestProvisionalGaze=null;updatePilot();updateFrozenGazeControls();pilotTimer=setInterval(updatePilot,1000);timer=setInterval(()=>{maintenance=maintenance.then(()=>memory.advanceTime(sessionNow())).catch(()=>{memoryStatus.textContent='기억 만료 처리 실패';});},5000);
      if(activeCalibration){
        showCalibrationStatus(controller.remote?(environmentChanged?'환경 변경 · 이 기기의 model-only GPU 교정 재사용 · 정확도 보장 안 됨':'이 기기의 model-only GPU 교정 재사용 · 정확도 보장 안 됨'):environmentChanged?'환경 변경 감지 · 현재 페이지의 WebEyeTrack 적응 재사용 · 정확도 보장 안 됨 · 버튼으로 재교정':'현재 페이지 WebEyeTrack 적응 재사용 · 정확도 보장 안 됨');
        message.textContent=controller.remote?'이 기기에 저장된 model-only GPU adapter를 적용했습니다. 원시 프레임·눈 패치·랜드마크는 저장하지 않습니다.':environmentChanged?'현재 페이지의 WebEyeTrack 적응을 재사용합니다. 화면/카메라 환경이 달라 정확도를 보장할 수 없습니다.':'현재 페이지의 WebEyeTrack 적응을 재사용합니다. 실사용 시선 정확도와 시간 정렬은 보장되지 않습니다.';
        gazeStatus.textContent=controller.remote?'저장된 GPU 교정 추정 · 정확도 보장 안 됨':environmentChanged?'환경 변경 · 현재 페이지 적응 추정 · 정확도 보장 안 됨':'현재 페이지 WebEyeTrack 적응 추정 · 정확도 보장 안 됨';
        $('#worldGazeState').textContent=environmentChanged?'환경 변경 · 정확도 미보장':'WebEyeTrack 교정 · 정확도 미보장';
      }else {showCalibrationStatus(controller.remote?'Remote GPU WebEyeTrack 교정 없음 · 교정 버튼으로 시작':'WebEyeTrack 교정 없음 · 자동 교정 안 함 · 교정 버튼으로 시작');message.textContent=controller.remote?'카메라 활성 · 클라우드 GPU의 미교정 시선만 표시합니다. 카메라 프레임은 추론용으로 전송됩니다.':'카메라 활성 · WebEyeTrack 기본 모델의 미교정 추정만 표시합니다. 교정 성능과 시간 정렬은 검증되지 않았습니다.';gazeStatus.textContent='미교정 추정 대기';$('#worldGazeState').textContent=controller.remote?'Remote GPU · 미교정 추정 대기':'미교정 추정 대기';}
      $('#gazeSamDemoStatus').textContent=controller.remote?'Remote GPU WebEyeTrack · 시선 프레임 전송 · 얼굴 랜드마크/눈 크롭은 전송하지 않음':activeCalibration?'WebEyeTrack 교정 사용 · 화면/환경 변경 시 정확도는 보장되지 않습니다.':'WebEyeTrack 기본 모델 · 미교정 · 정확도와 물리적 시간 정렬은 검증되지 않았습니다.';
      startBackgroundAttention();
    }
    else if(result.reason==='start_failed') {const diagnostic=startupFailureDiagnostic(result.error),text=`시작 실패 · 코드 ${diagnostic.code} · 단계 ${diagnostic.step}`;logStartupDiagnostic(diagnostic.code);message.textContent=text;gazeStatus.textContent=text;$('#provisionalSparkStatus').textContent=text;}
  }
  start.addEventListener('click',()=>{for(const id of ['localConsent','provisionalSparkConsent','exploreConsent','reasonConsent','gazeSamConsent','traceConsent','retentionConsent'])$('#'+id).checked=true;void startSession();});
  function stopSession(){calibrationRunToken++;accuracySession?.cancel('session_stopped');capturedAdaptation=null;calibrationWindow.length=0;stopBackgroundAttention();clearGazeMarker();initialSceneGeneration++;initialScenePending=false;clearFrozenGazeDemo('카메라 정지 · 잠정 시선점 폐기',true);stopRemote();cancelDiagnostic();if(pilot && pilot.stoppedAt===null)pilot.stoppedAt=performance.now();clearInterval(pilotTimer);pilotTimer=null;updatePilot();clearInterval(timer);timer=null;const drained=coordinator?.stop();controller?.cancelCalibration();activeCalibration=null;activeAffine=null;displayFilter.reset();activeLandmarkResidual=null;training=[];validation=[];history.clear();latest=null;latestProvisionalGaze=null;candidate=null;pendingAligned=null;cameraSessionId=null;timingCalibration=null;controller?.setTimingCalibration(null);$('#timingStatus').textContent='카메라 세션 종료 · 광학 측정 다시 적용 필요';$('#runGazeSam').disabled=true;$('#gazeSamStatus').textContent='정지됨 · 카메라 시작 후 시선 정렬 필요';$('#worldSceneState').textContent=$('#localConsent').checked?'정지':'동의 대기';$('#worldGazeState').textContent='미교정 추정 대기';calibrationStage=null;$('#calibration').hidden=true;for(const id of ['leftEye','rightEye'])drawEye(id,null,false,null);gazeStatus.textContent='미교정 추정 대기';showCalibrationStatus('카메라 세션 종료 · 저장된 교정은 다음 시작 때 복원');return Promise.all([drained,maintenance,localRecorder.stop()]);}
  $('#pause').addEventListener('click',()=>{if(!coordinator?.status().active)return;if(coordinator.status().paused){coordinator.resume();controller?.resume?.();backgroundAttention?.resume();localRecorder.resume();if(pilot?.pauseStartedAt!=null){pilot.pausedMs+=performance.now()-pilot.pauseStartedAt;pilot.pauseStartedAt=null;}$('#pause').textContent='⏸';$('#pause').setAttribute('aria-label','일시정지');$('#pause').title='일시정지';startRemote();startBackgroundAttention();}else{clearGazeMarker();clearFrozenGazeDemo('카메라 일시정지 · 잠정 시선점 폐기',true);coordinator.pause();controller?.pause?.();depthRequest?.abort();depthRequest=null;backgroundAttention?.pause();localRecorder.pause();if(pilot)pilot.pauseStartedAt=performance.now();stopRemote();cancelDiagnostic();$('#pause').textContent='▶';$('#pause').setAttribute('aria-label','재개');$('#pause').title='재개';}updatePilot();updateFrozenGazeControls();});
  $('#localConsent').addEventListener('change',()=>{if($('#localConsent').checked)startSession();else {void stopSession();message.textContent='통합 동의 철회 · 카메라와 진행 중인 SAM 요청을 중단했습니다.';}});
  stop.addEventListener('click',stopSession);
  $('#clear').addEventListener('click',async()=>{if(sessionSelecting){$('#retentionStatus').textContent='보존 세션 처리 중입니다.';return;}try{await stopSession();await deleteProvisionalHistory();if(durableSession){await durableSession.close({remove:true});durableSession=null;}else {await journal.delete();await memory.deleteSession();}journalSessionId=crypto.randomUUID();journal=await ProviderJournal.open({storage:new EphemeralStorage(),sessionId:journalSessionId});memory=await MemoryService.open({sessionId:crypto.randomUUID(),clock:sessionNow});bindTraceMemory();coordinator?.replaceMemory(memory);researchTrace.clear();$('#traceStatus').textContent='연구 기록 삭제됨 · 비교 재생 미실행';pilot=null;$('#pilotStatus').textContent='관찰 0:00 / 30:00 · 샘플 0';memoryStatus.textContent='임시 세션 삭제됨';message.textContent='세션과 저장된 미교정 기록을 삭제했습니다. 원시 영상은 저장하지 않았습니다.';}catch{memoryStatus.textContent='삭제 실패 · 다시 시도 필요';message.textContent='세션 삭제를 완료하지 못했습니다.';}});
  function restorePreviousCalibration(){
    controller?.cancelCalibration();
    if(activeCalibration){if(pilot)pilot.calibration={...activeCalibration.calibration,passed:true,status:'completed',reused:true,environmentChanged:activeCalibration.environmentChanged===true};}
    else if(pilot)pilot.calibration={passed:false,status:'not_calibrated'};
  }
  function handleCalibrationEnvironmentChange(reason){accuracySession?.cancel('environment_changed');capturedAdaptation=null;calibrationWindow.length=0;
    clearGazeMarker();clearFrozenGazeDemo('화면/환경 변경 · 잠정 시선점 폐기',true);
    if(activeCalibration){activeCalibration.environmentChanged=true;if(pilot?.calibration?.passed)pilot.calibration.environmentChanged=true;}
    if(controller)controller.setTimingCalibration(null);
    timingCalibration=null;pendingAligned=null;stopRemote();startRemote();$('#timingStatus').textContent='환경 변경 · 광학 시간 측정 다시 적용 필요';$('#runGazeSam').disabled=true;
    if(calibrationStage){calibrationRunToken++;calibrationStage=null;candidate=null;training=[];validation=[];restorePreviousCalibration();message.textContent='환경 변경으로 진행 중 WebEyeTrack 적응을 취소했습니다. 현재 세션의 이전 적응은 유지합니다.';}
    else message.textContent=`${reason} 감지 · 현재 세션의 WebEyeTrack 교정을 유지합니다. 정확도는 보장되지 않으며 재교정은 버튼으로 시작하세요.`;
    latest=null;latestProvisionalGaze=null;$('#calibration').hidden=true;history.clear();
    if(activeCalibration){showCalibrationStatus('환경 변경 감지 · 현재 세션 WebEyeTrack 적응 사용 중 · 정확도 보장 안 됨 · 버튼을 눌러 명시 재교정');gazeStatus.textContent='환경 변경 · 현재 세션 적응 유지 · 정확도 보장 안 됨';$('#worldGazeState').textContent='환경 변경 · 정확도 미보장';}
    else {showCalibrationStatus('환경 변경 · WebEyeTrack 교정 없음 · 자동 교정 안 함 · 버튼으로 교정');gazeStatus.textContent='미교정 추정 대기 · 환경 변경';$('#worldGazeState').textContent='교정 필요';}
    updateFrozenGazeControls();startBackgroundAttention();
  }
  $('#hide').addEventListener('click',e=>{document.body.classList.toggle('observation');e.target.textContent=document.body.classList.contains('observation')?'진단 표시':'진단 숨기기';sizeCanvas();handleCalibrationEnvironmentChange('화면 레이아웃');});
  window.addEventListener('resize',()=>{sizeCanvas();handleCalibrationEnvironmentChange('화면 크기');});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearFrozenGazeDemo('페이지가 숨겨져 잠정 표본/마스크를 폐기하고 장면을 재개했습니다.',true);});
  window.addEventListener('pagehide',()=>{stopSession().then(async()=>{await (durableSession?durableSession.close():Promise.all([journal.close(),memory.close()]));await provisionalTrackingOpening?.catch(()=>{});await provisionalTrackingStore?.close();}).catch(()=>{});});
  const points=(validationPhase)=>{let p=[];for(let repeat=0;repeat<3;repeat++)for(let y=0;y<3;y++)for(let x=0;x<3;x++)p.push({x:innerWidth*(validationPhase ? .20+.28*x : .12+.38*x),y:innerHeight*(validationPhase ? .20+.28*y : .12+.38*y)});return p;};
  function showTarget(){const phase=calibrationStage==='training'?'WebEyeTrack 적응':'별도 표본', p=points(calibrationStage==='validation')[sequence], target=$('#target'), info=$('#calibrationInfo');target.style.left=p.x+'px';target.style.top=p.y+'px';calibrationTargetShownAt=performance.now();target.setAttribute('aria-label',`${phase} 표적 ${sequence+1}/27 · 0.5초 이상 응시한 뒤 클릭, Enter 또는 Space로 기록`);info.setAttribute('role','status');info.setAttribute('aria-live','polite');info.textContent=`${phase} ${sequence+1}/27 · 표적을 0.5초 이상 응시한 뒤 클릭 또는 Enter/Space`;}
  const metricModel=()=>({dimension:2,x:[0,innerWidth,0],y:[0,0,innerHeight],trainingIds:[]});
  async function beginCalibration(){
    if(!coordinator?.status().active||calibrationStage)return;
    const runToken=++calibrationRunToken;
    capturedAdaptation=null;calibrationWindow.length=0;calibrationRunStart=null;calibrationAdaptStartedAt=null;calibrationAdaptStarted=false;calibrationAdaptFinished=false;calibrationSerializeStartedAt=null;calibrationSerializeFinished=false;stopBackgroundAttention();clearGazeMarker();clearFrozenGazeDemo('교정 시작 · 시선 SAM 대기 중단',true);stopRemote();cancelDiagnostic();controller.cancelCalibration();candidate=null;training=[];validation=[];sequence=0;screenSize={width:innerWidth,height:innerHeight};calibrationStage='loading';if(pilot)pilot.calibration={passed:false,status:'in_progress',attempts:[],startedAtUtc:new Date().toISOString(),method:'WebEyeTrack.adapt',persistence:controller.remote?'remote_session':'local_adaptation_replay'};showCalibrationStatus(controller.remote?'Remote GPU WebEyeTrack 후보 준비 중 · 현재 카메라 스트림 재사용':'WebEyeTrack worker/model 준비 중 · 현재 카메라 스트림 재사용');gazeStatus.textContent='교정 준비 중 · 시선 분석 보류';$('#worldGazeState').textContent=controller.remote?'Remote GPU 후보 준비 중':'WebEyeTrack 준비 중';$('#calibration').hidden=false;$('#calibrationInfo').textContent=controller.remote?'Remote GPU 후보 모델을 준비하고 있습니다. 압축된 카메라 프레임만 추론 서버로 전송합니다.':'로컬 WebEyeTrack 모델을 준비하고 있습니다.';$('#gazeSamDemoStatus').textContent=controller.remote?'교정 중 · 압축 프레임은 Remote GPU로 전송 · 랜드마크/눈 크롭은 로컬 유지':'WebEyeTrack 교정 준비 중 · 영상은 로컬 worker에서만 처리됩니다.';updateFrozenGazeControls();
    try{await controller.beginCalibration();}catch(error){if(runToken!==calibrationRunToken||calibrationStage!=='loading')return;calibrationStage=null;restorePreviousCalibration();$('#calibration').hidden=true;message.textContent=`WebEyeTrack 준비 실패: ${error.message}`;showCalibrationStatus(controller.remote?'Remote GPU 교정 준비 실패 · 연결 상태 확인':'교정 준비 실패 · 로컬 자산과 worker 오류 확인');return;}
    if(runToken!==calibrationRunToken||calibrationStage!=='loading'||screenSize.width!==innerWidth||screenSize.height!==innerHeight){controller.cancelCalibration();return;}
    calibrationStage='training';calibrationRunStart=performance.now();showCalibrationStatus('WebEyeTrack 공식 adapt() 적응 중 · 이후 별도 27점 표본 수집');gazeStatus.textContent='WebEyeTrack 적응 중 · 시선 분석 보류';$('#worldGazeState').textContent='교정 필요';showTarget();$('#target').focus({preventScroll:true});updateFrozenGazeControls();startBackgroundAttention();
  }
  calibrate.addEventListener('click',()=>{void beginCalibration();});
  setInterval(()=>{
    const now=performance.now();
    const adaptationTimedOut=calibrationAdaptStartedAt!==null&&!calibrationAdaptFinished&&now-calibrationAdaptStartedAt>CALIBRATION_ADAPT_TIMEOUT_MS;
    const replayTimedOut=calibrationSerializeStartedAt!==null&&!calibrationSerializeFinished&&now-calibrationSerializeStartedAt>CALIBRATION_ADAPT_TIMEOUT_MS;
    if((adaptationTimedOut||replayTimedOut)&&['training','validation'].includes(calibrationStage)){calibrationRunToken++;
      const hadCalibration=!!activeCalibration,phase=replayTimedOut?'교정 재생 자료 인코딩':'WebEyeTrack 적응',reason=replayTimedOut?'calibration_replay_timeout':'calibration_adapt_timeout';
      if(adaptationTimedOut){if(!calibrationAdaptStarted){logCalibrationStage('calibration_adapt_start');calibrationAdaptStarted=true;}logCalibrationStage('calibration_adapt_error',{startedAt:calibrationAdaptStartedAt});calibrationAdaptFinished=true;}
      if(replayTimedOut){logCalibrationStage('adaptation_serialize_error',{startedAt:calibrationSerializeStartedAt});calibrationSerializeFinished=true;}
      calibrationStage=null;calibrationRunStart=null;capturedAdaptation=null;calibrationWindow.length=0;candidate=null;training=[];validation=[];restorePreviousCalibration();delete $('#target').dataset.pending;
      if(hadCalibration&&pilot?.calibration)pilot.calibration.lastRecalibrationFailureReason=reason;else if(pilot)pilot.calibration={...pilot.calibration,passed:false,status:'failed',failureReason:reason};
      $('#calibration').hidden=false;$('#calibrationInfo').textContent=`${phase} 시간 초과 · 후보 worker를 취소했습니다. 카메라와 이전 교정은 계속 유지됩니다.`;
      showCalibrationStatus(hadCalibration?`${phase} 시간 초과 · 이전 현재 세션 교정 유지`:`${phase} 시간 초과 · 현재 카메라는 계속 실행 중입니다. 다시 시도하세요.`);
      message.textContent=hadCalibration?`${phase} 시간 초과 · 이전 현재 세션 교정을 유지하고 카메라를 계속 실행합니다.`:`${phase} 시간 초과 · 카메라를 계속 실행합니다. 다시 교정하세요.`;
      calibrate.focus();updateFrozenGazeControls();startBackgroundAttention();return;
    }
    if(calibrationRunStart!==null&&now-calibrationRunStart>CALIBRATION_RUN_TIMEOUT_MS&&['training','validation'].includes(calibrationStage)){calibrationRunToken++;
      const hadCalibration=!!activeCalibration;
      if(calibrationAdaptStartedAt!==null&&!calibrationAdaptFinished){if(!calibrationAdaptStarted){logCalibrationStage('calibration_adapt_start');calibrationAdaptStarted=true;}logCalibrationStage('calibration_adapt_error',{startedAt:calibrationAdaptStartedAt});calibrationAdaptFinished=true;}
      if(calibrationSerializeStartedAt!==null&&!calibrationSerializeFinished){logCalibrationStage('adaptation_serialize_error',{startedAt:calibrationSerializeStartedAt});calibrationSerializeFinished=true;}
      calibrationStage=null;calibrationRunStart=null;capturedAdaptation=null;calibrationWindow.length=0;candidate=null;training=[];validation=[];restorePreviousCalibration();delete $('#target').dataset.pending;
      if(hadCalibration&&pilot?.calibration)pilot.calibration.lastRecalibrationFailureReason='calibration_run_timeout';else if(pilot)pilot.calibration={...pilot.calibration,passed:false,status:'failed',failureReason:'calibration_run_timeout'};
      $('#calibration').hidden=false;$('#calibrationInfo').textContent='전체 교정 시간 초과 · 교정을 취소했습니다. 다시 시도하세요.';
      showCalibrationStatus(hadCalibration?'전체 재교정 시간 초과 · 이전 현재 세션 교정 유지':'전체 교정 시간 초과 · 버튼으로 다시 시도');
      message.textContent=hadCalibration?'재교정 전체 시간 초과 · 이전 현재 세션 교정은 유지됩니다.':'교정 전체 시간 초과 · 현재 세션 교정은 적용되지 않았습니다.';
      calibrate.focus();updateFrozenGazeControls();startBackgroundAttention();return;
    }
    if(!['training','validation'].includes(calibrationStage))return;
    if(calibrationTargetTimedOut(calibrationTargetShownAt,now,calibrationWindow)&&$('#target').dataset.pending!=='true'){
      calibrationRunToken++;const phase=calibrationStage==='training'?'WebEyeTrack 적응':'별도 표본',targetNumber=sequence+1,hadCalibration=!!activeCalibration;
      const maxSampleAgeMs=calibrationSampleFreshnessMs(calibrationWindow),sampleStatus=calibrationSampleStatus(latest,{targetShownAt:calibrationTargetShownAt,now,maxAgeMs:maxSampleAgeMs}),windowStatus=calibrationWindowStatus(calibrationWindow,{targetShownAt:calibrationTargetShownAt,now});
      const reason=calibrationStage==='validation'&&windowStatus!=='ready'?windowStatus:sampleStatus==='ready'?'sample_processing_delayed':sampleStatus;
      calibrationStage=null;calibrationRunStart=null;capturedAdaptation=null;calibrationWindow.length=0;candidate=null;training=[];validation=[];restorePreviousCalibration();
      if(hadCalibration&&pilot?.calibration)pilot.calibration.lastRecalibrationFailureReason=reason;else if(pilot)pilot.calibration={...pilot.calibration,passed:false,status:'failed',failureReason:reason};
      const reasonText={no_open_eye_sample:'열린 눈 표본 없음',missing_sample_timestamp:'표본 시각 없음',no_post_dwell_sample:'응시 대기 후 표본 없음',future_sample:'미래 표본 시각',stale_sample:'최근 표본 없음',no_post_dwell_samples:'응시 대기 후 표본 없음',insufficient_recent_samples:'최근 표본 부족',gaze_unstable:'표본 흔들림이 커 안정된 검증 표본 부족',sample_processing_delayed:'WebEyeTrack 처리 응답 지연'}[reason]??reason;
      $('#calibration').hidden=false;$('#calibrationInfo').textContent=`${phase} 표적 ${targetNumber}/27 시간 초과 · 원인: ${reasonText} · 교정을 취소했습니다. 다시 시도하세요.`;
      showCalibrationStatus(hadCalibration?`재교정 표본 시간 초과 (${reason}) · 이전 현재 세션 교정 유지`:`교정 표본 시간 초과 (${reason}) · 버튼으로 다시 시도`);
      message.textContent=hadCalibration?`재교정 표본 수집 시간 초과 (${reason}) · 이전 현재 세션 교정은 유지됩니다.`:`교정 표본 수집 시간 초과 (${reason}) · 현재 세션 교정은 적용되지 않았습니다.`;
      calibrate.focus();updateFrozenGazeControls();startBackgroundAttention();return;
    }
    if(now-calibrationTargetShownAt>=650&&!$('#target').dataset.pending)$('#target').click();
  },150);
  $('#target').addEventListener('click',async()=>{
    const runToken=calibrationRunToken;
    if(!calibrationStage||calibrationStage==='loading'||$('#target').dataset.pending==='true')return;
    $('#target').dataset.pending='true';
    try{
      if(screenSize.width!==innerWidth||screenSize.height!==innerHeight){handleCalibrationEnvironmentChange('화면 크기');return;}
      const target=points(calibrationStage==='validation')[sequence], now=performance.now();
      if(now-calibrationTargetShownAt<500){$('#calibrationInfo').textContent='표적이 바뀐 뒤 0.5초 이상 응시한 다음 다시 클릭 또는 Enter/Space를 누르세요.';return;}
      const sampleAgeLimitMs=calibrationSampleFreshnessMs(calibrationWindow),sampleStatus=calibrationSampleStatus(latest,{targetShownAt:calibrationTargetShownAt,now,maxAgeMs:sampleAgeLimitMs}),fresh=sampleStatus==='ready';
      const stabilityStatus=calibrationWindowStatus(calibrationWindow,{targetShownAt:calibrationTargetShownAt,now});
      if(calibrationStage==='validation'&&!stableCalibrationWindow(calibrationWindow,{targetShownAt:calibrationTargetShownAt,now})){const waitText={settling:'표적 표시 후 0.5초 이상 응시하세요',no_post_dwell_samples:'응시 대기 후 검증 표본을 기다리는 중',insufficient_recent_samples:'최근 검증 표본을 모으는 중',gaze_unstable:'시선 표본 흔들림이 큽니다. 표적을 계속 바라보세요'}[stabilityStatus]??'검증 표본을 기다리는 중';$('#calibrationInfo').textContent=waitText;return;}
      if(calibrationStage==='training'){
        if(!fresh){const waitText={no_open_eye_sample:`열린 눈 표본이 없습니다 · ${describeOpenEyeWait(latest)}`,missing_sample_timestamp:'WebEyeTrack 표본 시각을 기다리는 중',no_post_dwell_sample:'표적을 0.5초 이상 바라본 뒤의 표본을 기다리는 중',stale_sample:'최근 열린 눈 표본을 기다리는 중',future_sample:'WebEyeTrack 표본 시각 확인 중'}[sampleStatus]??'열린 눈 표본을 기다리는 중';$('#calibrationInfo').textContent=waitText;return;}
        const finalTrainingTarget=sequence===26;
        if(finalTrainingTarget){calibrationAdaptStartedAt=performance.now();calibrationAdaptStarted=false;calibrationAdaptFinished=false;calibrationSerializeStartedAt=null;calibrationSerializeFinished=false;$('#calibrationInfo').textContent='27/27 표본 수집 완료 · WebEyeTrack 적응을 기다리는 중';}
        try{const response=await controller.calibrate(target,calibrationTargetShownAt+500,sampleAgeLimitMs);if(runToken!==calibrationRunToken||calibrationStage!=='training')return;if(response.adaptationSamples)capturedAdaptation=response.adaptationSamples;}catch(error){
          if(runToken!==calibrationRunToken||calibrationStage!=='training')return;
          if(finalTrainingTarget){if(!calibrationAdaptStarted){logCalibrationStage('calibration_adapt_start');calibrationAdaptStarted=true;}if(!calibrationAdaptFinished)logCalibrationStage('calibration_adapt_error',{startedAt:calibrationAdaptStartedAt});calibrationAdaptFinished=true;}
          calibrationStage=null;candidate=null;training=[];validation=[];controller.cancelCalibration();restorePreviousCalibration();if(pilot?.calibration?.passed)pilot.calibration.lastRecalibrationStatus='failed';else if(pilot)pilot.calibration={...pilot.calibration,passed:false,status:'failed'};$('#calibration').hidden=true;message.textContent=`WebEyeTrack 적응 실패: ${error.message}`;showCalibrationStatus(activeCalibration?'재교정 실패 · 이전 현재 세션 적응 유지':'교정 실패 · 버튼으로 다시 시도');calibrate.focus();updateFrozenGazeControls();return;
        }
        training.push({id:`train-${sequence}`,target});
      } else {
        if(!fresh){const waitText={no_open_eye_sample:`열린 눈 표본이 없습니다 · ${describeOpenEyeWait(latest)}`,missing_sample_timestamp:'WebEyeTrack 표본 시각을 기다리는 중',no_post_dwell_sample:'응시 대기 후 검증 표본을 기다리는 중',stale_sample:'최근 열린 눈 검증 표본을 기다리는 중',future_sample:'WebEyeTrack 표본 시각 확인 중'}[sampleStatus]??'열린 눈 검증 표본을 기다리는 중';$('#calibrationInfo').textContent=waitText;return;}
        validation.push({id:`validate-${sequence}`,features:latest.features,landmarkFeatures:latest.landmarkFeatures,target});
      }
      if(pilot?.calibration)pilot.calibration.attempts.push({phase:calibrationStage,index:sequence,target:{...target},sampleAvailable:true,atUtc:new Date().toISOString()});
      sequence++;
      if(sequence===27&&calibrationStage==='training'){
        candidate=metricModel();calibrationStage='validation';sequence=0;showCalibrationStatus('27회 WebEyeTrack adapt() 완료 · 별도 27점 표본 수집 · 잔차 후보는 18/9 분할');
      } else if(sequence===27){
        const validationScreen={x:0,y:0,...screenSize};
        let affineSelection=null,affineModel=null;try{affineModel=fitAffineCalibration(validation.slice(0,18).filter(v=>v.valid!==false));affineSelection=selectAffineCalibrationCandidate({candidateModel:affineModel,baselineModel:identityAffineCalibration(validationScreen),selectionSamples:validation.slice(18),screen:validationScreen});}catch{}
        const metrics=affineSelection?.selected?affineSelection.candidate:calibrationMetrics(candidate,validation,validationScreen,{independent:true});
        let passed=metrics.validRate>=.8&&metrics.p95!==null&&metrics.p95<=.05;
        const residualModel=passed?fitLandmarkResidualCalibration(validation.slice(0,LANDMARK_RESIDUAL_FIT_ATTEMPTS),screenSize):null;
        const holdout=validation.slice(LANDMARK_RESIDUAL_FIT_ATTEMPTS);
        const baselineHoldout=calibrationMetrics(candidate,holdout,validationScreen,{independent:true});
        const residualHoldout=residualModel?landmarkResidualMetrics(residualModel,holdout,screenSize):null;
        const residualSelected=!affineSelection?.selected&&landmarkResidualPassesSelection(passed,residualModel,baselineHoldout,residualHoldout);
        const residualSummary={status:residualSelected?'selected_on_third_repeat_selection_set':residualModel?'not_selected':'unavailable',fitAttempts:LANDMARK_RESIDUAL_FIT_ATTEMPTS,holdoutAttempts:holdout.length,correctedCount:residualHoldout?.correctedCount??0,baselineHoldoutP95:baselineHoldout.p95,candidateHoldoutP95:residualHoldout?.p95??null};
        let commitFailed=false,committedAdapter=null;if(passed){try{const committed=await controller.commitCalibration();committedAdapter=committed?.adapter??null;if(controller.remote&&!committedAdapter)throw Error('remote adapter missing');}catch{passed=false;commitFailed=true;}}
        if(pilot)pilot.calibration={...pilot.calibration,...metrics,landmarkResidual:residualSummary,passed,status:commitFailed?'failed':'completed',...(commitFailed?{failureReason:'calibration_commit_failed'}:{}),trainingAttempts:training.length,validationAttempts:validation.length,screenSize:{...screenSize},completedAtUtc:new Date().toISOString(),environmentChanged:false,method:residualSelected?'WebEyeTrack.adapt+landmark-residual-candidate':'WebEyeTrack.adapt',persistence:controller.remote?'local_model_adapter':'local_adaptation_replay'};
        if(passed){activeAffine=affineSelection?.selected?affineModel:null;activeLandmarkResidual=!activeAffine&&residualSelected?residualModel:null;activeCalibration={calibration:pilot.calibration,environment:gazeEnvironment(pilot.cameraSettings),environmentChanged:false};}
        else {
          const previousCalibration=activeCalibration?.calibration;
          candidate=null;restorePreviousCalibration();
          if(previousCalibration&&pilot)pilot.calibration.lastRecalibration={passed:false,...metrics,completedAtUtc:new Date().toISOString()};
          else if(pilot)pilot.calibration={...pilot.calibration,...metrics,landmarkResidual:residualSummary,passed:false,status:commitFailed?'failed':'completed',...(commitFailed?{failureReason:'calibration_commit_failed'}:{}),method:'WebEyeTrack.adapt',persistence:controller.remote?'local_model_adapter':'local_adaptation_replay'};
          stopRemote();$('#worldGazeState').textContent=activeCalibration?'이전 현재 세션 적응 유지 · 정확도 미보장':'교정 실패 · 시선 분석 보류';
        }
        calibrationRunStart=null;
        let remoteAdapterSaved=false;if(passed&&controller.remote&&committedAdapter){const profileSaveStartedAt=performance.now();logCalibrationStage('profile_save_start');try{const store=await profileStorage;if(!store)throw Error('storage_unavailable');remoteCalibrationProfile={version:1,createdAtUtc:new Date().toISOString(),adapter:committedAdapter,calibration:pilot.calibration,environment:gazeEnvironment(pilot.cameraSettings)};await store.setItem(remoteGazeAdapterKey,remoteCalibrationProfile);remoteAdapterSaved=true;logCalibrationStage('profile_save_complete',{startedAt:profileSaveStartedAt});recordingStatus.textContent='Remote GPU 교정 adapter를 이 기기에 저장했습니다.';}catch{remoteCalibrationProfile=null;logCalibrationStage('profile_save_error',{startedAt:profileSaveStartedAt});recordingStatus.textContent='GPU 교정은 현재 세션에서 통과했지만 이 기기 저장에 실패했습니다.';}}else if(passed&&capturedAdaptation){const profileSaveStartedAt=performance.now();logCalibrationStage('profile_save_start');try{const store=await profileStorage;if(!store)throw Error('storage_unavailable');const profile=await createGazeCalibrationProfileAsync({adaptationSamples:capturedAdaptation,calibration:pilot.calibration,environment:gazeEnvironment(pilot.cameraSettings),runtime:profileRuntime,landmarkResidual:activeLandmarkResidual,affine:affineSelection?{model:affineModel,selection:affineSelection}:null},{batchSize:3,onProgress:count=>{$('#calibrationInfo').textContent=`교정 통과 · 로컬 재생 프로필 준비 ${count}/27`;}});if(!await saveGazeCalibrationProfile(store,profile))throw Error('profile_write_failed');logCalibrationStage('profile_save_complete',{startedAt:profileSaveStartedAt});recordingStatus.textContent='교정 저장 완료';}catch{logCalibrationStage('profile_save_error',{startedAt:profileSaveStartedAt});recordingStatus.textContent='교정 저장 실패 · 현재 세션에서만 사용';}}capturedAdaptation=null;
        const metricsSummary=`기준 WebEyeTrack 별도 평가 ${passed?'통과':'실패'}: 유효 ${(metrics.validRate*100).toFixed(1)}%, p95 ${metrics.p95===null?'없음':(metrics.p95*100).toFixed(2)+'%'} (화면 대각선 기준). 실사용 성능은 보장되지 않습니다.`;
        const residualMessage=residualSelected?`랜드마크 잔차 후보: 18회 적합, 같은 3×3 위치의 9회 반복 선택 표본 p95 ${(baselineHoldout.p95*100).toFixed(2)}% → ${(residualHoldout.p95*100).toFixed(2)}%. 일반화 검증은 아닙니다.`:residualModel?'랜드마크 잔차 후보는 같은 3×3 위치의 9회 반복 선택 표본에서 조건을 충족하지 않아 적용하지 않았습니다.':'랜드마크 잔차 후보는 특징 표본 누락 또는 퇴화로 적용하지 않았습니다.';
        message.textContent=passed?controller.remote?`${metricsSummary} GPU 교정 adapter를 ${remoteAdapterSaved?'이 기기에 저장했습니다.':'현재 세션에만 적용했습니다.'} 원본 프레임과 calibration sample은 저장하지 않습니다.`:`${metricsSummary} ${residualMessage} 저장된 교정은 동일 환경의 다음 시작에서 재적용합니다. 저장 성공 여부는 기록 상태를 확인하세요.`:activeCalibration?`${metricsSummary} 이전 현재 세션 적응을 유지합니다.`:metricsSummary;
        showCalibrationStatus(passed?(residualSelected?'WebEyeTrack 교정 통과 · MediaPipe 잔차 후보는 같은 3×3 위치의 9회 반복 선택 표본에만 근거 · 일반화 검증 아님 · 현재 세션 메모리만 사용':'WebEyeTrack 교정 통과 · 랜드마크 잔차 후보 미적용 · 현재 세션 메모리만 사용 · 카메라 정지/새로고침 뒤 재교정 필요'):(activeCalibration?'새 교정 실패 · 이전 현재 세션 적응 유지 · 정확도 보장 안 됨':'교정 실패 · 자동 재교정 안 함 · 버튼으로 다시 시도'));
        training=[];validation=[];candidate=null;calibrationStage=null;$('#calibration').hidden=true;calibrate.focus();
        if(passed){gazeStatus.textContent='WebEyeTrack 교정 통과 · 시선 분석 준비 · 실사용 정확도 미보장';$('#worldGazeState').textContent='시선점 대기 · 정확도 미보장';$('#gazeSamDemoStatus').textContent=$('#localConsent').checked?'WebEyeTrack 적응 통과 · 로컬 프로필 재사용 · 정확도와 시간 정렬 미검증':'교정 통과 · 자동 탐색 동의 대기';startRemote();startBackgroundAttention();}
        else $('#gazeSamDemoStatus').textContent='WebEyeTrack 독립 검증 실패 · 장면 전용 SAM은 계속되고 시선 SAM은 보류됩니다. 다시 교정하세요.';
        updateFrozenGazeControls();return;
      }
      showTarget();
    }finally{if(runToken===calibrationRunToken)delete $('#target').dataset.pending;}
  });
  void ensureProvisionalTracking().catch(()=>{});
  $('#runtimeStatus').textContent='카메라 시작 동의 대기 · Spark 별도 동의 필요';
}
if(typeof document!=='undefined') boot().catch(()=>{const text='앱 초기화 실패 · 페이지를 새로고침해 주세요';for(const selector of ['#message','#gazeStatus','#provisionalSparkStatus']){const el=document.querySelector(selector);if(el)el.textContent=text;}});
