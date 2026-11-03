import {createWorld} from './spatial/world.js';
import {createVideoScene} from './spatial/video-scene.js';
import {parseGazeTrack} from './gaze/gaze-replay.js';
import {createLocalRecorder,listLocalRecordings,deleteLocalRecordings} from './gaze/local-recorder.js';
import {GAZE_CALIBRATION_PROFILE_KEY,restoreLandmarkResidualCalibration,openGazeCalibrationProfileStore,loadGazeCalibrationProfile,createGazeCalibrationProfileAsync,saveGazeCalibrationProfile,fitAffineCalibration,identityAffineCalibration,selectAffineCalibrationCandidate} from './gaze/calibration-profile.js';
import {createCausalDisplayFilter,REMOTE_GAZE_DISPLAY_FILTER} from './gaze/display-filter.js';
import {createAccuracyPlan} from './gaze/accuracy-protocol.js';
import {createAccuracySession} from './gaze/accuracy-session.js';
import {stableCalibrationWindow,calibrationSampleFreshnessMs,calibrationSampleStatus,calibrationWindowStatus,calibrationTargetTimedOut,CALIBRATION_RUN_TIMEOUT_MS,CALIBRATION_ADAPT_TIMEOUT_MS} from './gaze/calibration-window.js';
import {BackgroundAttentionCoordinator} from './runtime/background-attention.js';
import {createBackgroundBrowserWork} from './runtime/background-browser.js';
import {LiveTracking} from './runtime/live-tracking.js';
import {createProfiledWebcamGazeController,describeCalibrationTarget,describeOpenEyeWait} from './gaze/remote-webcam.js';
import {NON_GAZE_CLICK_TARGETS} from './gaze/official-webeyetrack.js';
import {createFixationBuffer} from './gaze/fixation.js';
import {gazeViewportPoint,gazeMarkerPosition} from './gaze/overlay.js';
import {withinCalibrationBounds,predictCalibration,calibrationMetrics,calibrationReach,fitLandmarkResidualCalibration,landmarkResidualMetrics,landmarkResidualPassesSelection,LANDMARK_RESIDUAL_FIT_ATTEMPTS,predictLandmarkResidual} from './gaze/index.js';
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
  return `Scope: frozen frame ${record.frame.frameId} (${record.frame.observedAt.toFixed(1)} ms) and the gaze estimate at that time (${record.gaze.x.toFixed(3)}, ${record.gaze.y.toFixed(3)} · sample ${record.gaze.sampleAtMs.toFixed(1)} ms) only · not reusable for the current scene or gaze · physical time alignment not verified`;
}
export async function publishProvisionalSparkIfCurrent({persist,isCurrent,discard,publish}={}){
  if(typeof persist!=='function'||typeof isCurrent!=='function'||typeof discard!=='function'||typeof publish!=='function')throw new TypeError('invalid provisional Spark publication');
  const result=await persist();
  if(!isCurrent()){await discard();return false;}
  publish(result);return true;
}
const provisionalSparkFailureLabels={network_error:'Network connection failed',request_failed:'Request failed',timeout:'Response timed out',rate_limited:'Rate limit reached',budget_exceeded:'Call budget used up',provider_busy:'Service busy',service_unavailable:'Service unavailable',not_configured:'Spark is not configured on the server',access_denied:'Service access denied',incomplete_response:'Spark response incomplete',invalid_response:'Spark response malformed',request_rejected:'Spark request rejected',provider_failed:'Spark service failed'};
const provisionalGazeFailureLabels={
  face_not_detected:'No face detected',visible_eye_iris_landmarks_required:'No valid iris landmarks',uncalibrated_iris_estimate_required:'No valid uncalibrated iris estimate',
  sample_time_unavailable:'Gaze sample has no timestamp',capture_estimate_required:'A sample with a browser capture time is required',frozen_frame_unavailable:'No frozen scene frame',invalid_provisional_window:'Gaze sample check window error',invalid_frozen_window:'Frozen scene check window error',
  sample_before_stable_window:'Waiting for a new sample after the scene froze',sample_stale_or_lagged:'Sample too old or processing delayed',gaze_outside_frozen_scene:'Estimate is outside the scene'
};
export function provisionalGazeFailureReason(estimate,reason){
  const actual=reason==='uncalibrated_iris_estimate_required'?(estimate?.reason??reason):reason;
  return provisionalGazeFailureLabels[actual]??'Check the gaze estimate';
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
export const SCENE_OBJECTS_PROMPT='objects';
export async function sendProvisionalSparkRequest({consent,frame,imageDataUrl,gazePoint,gazeTiming,masks,candidates,gazeTarget=null,depth=null,issuedAtMs,signal,fetchImpl=fetch}={}) {
  if(consent!==true)return {status:'withheld',reason:'consent_required'};
  if(!frame?.frameId||!Number.isFinite(frame.observedAt)||!Number.isInteger(frame.width)||!Number.isInteger(frame.height)||frame.width<1||frame.height<1||frame.width*frame.height>1048576||typeof imageDataUrl!=='string'||!Array.isArray(masks)||!Number.isFinite(gazePoint?.x)||gazePoint.x<0||gazePoint.x>=1||!Number.isFinite(gazePoint?.y)||gazePoint.y<0||gazePoint.y>=1||!Number.isFinite(gazeTiming?.sampleAtMs)||gazeTiming.sampleAtMs<0||!Number.isFinite(gazeTiming?.processedAtMs)||gazeTiming.processedAtMs<gazeTiming.sampleAtMs||!['browser_capture_estimate','callback_time_not_capture'].includes(gazeTiming.timestampKind)||!['uncalibrated_estimate','validated_calibration_estimate'].includes(gazeTiming.estimateStatus)||(gazeTiming.timestampKind==='callback_time_not_capture'&&gazeTiming.estimateStatus!=='uncalibrated_estimate')||!Number.isFinite(issuedAtMs)||issuedAtMs<Math.max(frame.observedAt,gazeTiming.processedAtMs)||typeof fetchImpl!=='function')return {status:'failed'};
  if(signal?.aborted)return {status:'cancelled'};
  const body={consentScope:'provisional_spark',timingStatus:'provisional',frame:{frameId:frame.frameId,observedAt:frame.observedAt,width:frame.width,height:frame.height},imageDataUrl,gazePoint:{x:gazePoint.x,y:gazePoint.y,sampleAtMs:gazeTiming.sampleAtMs,processedAtMs:gazeTiming.processedAtMs,timestampKind:gazeTiming.timestampKind,estimateStatus:gazeTiming.estimateStatus},issuedAtMs,masks:masks.slice(0,10).map(mask=>mask?.bounds)};
  if(candidates?.length)body.candidates=candidates;
  if(gazeTarget&&candidates?.some(candidate=>candidate.objectId===gazeTarget.objectId))body.gazeTarget=gazeTarget;
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
  function clear() { generation++;if(timer!==null)clearTimer(timer);timer=null;element.textContent='No preparation'; }
  function show(record) {
    clear();
    const remaining=record.expiresAt-now();
    if(record.deliveryState!=='silent_ready' || !Number.isFinite(record.observedUntil) || !Number.isFinite(remaining) || remaining<=0 || !Array.isArray(record.objectIds) || !Array.isArray(record.evidenceIds))return;
    element.textContent=`Preparation: silent_ready · observed up to ${record.observedUntil.toFixed(0)} ms · expires ${record.expiresAt.toFixed(0)} ms (session clock) · ${record.objectIds.length} objects · ${record.evidenceIds.length} evidence items`;
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
  const profileRuntime={webeyetrack:'0.0.2',protocol:'replay-v1'},profileStorage=openGazeCalibrationProfileStore().catch(()=>null),displayFilter=createCausalDisplayFilter(),remoteDisplayFilter=createCausalDisplayFilter(REMOTE_GAZE_DISPLAY_FILTER);
  const remoteGazeAdapterKey='prometheus.gaze-calibration.remote-adapter.v1';let remoteCalibrationProfile=null;
  const screenDiagonalKey='prometheus.screen-diagonal-inches.v1';
  function screenDiagonalInches(){try{const value=Number(localStorage.getItem(screenDiagonalKey));return Number.isFinite(value)&&value>=7&&value<=100?value:null;}catch{return null;}}
  // WebEyeTrack scales its calibration loss by the screen size in cm; the viewport share of the physical screen is what the targets span.
  function viewportScreenCm(){const inches=screenDiagonalInches(),diagonalPx=Math.hypot(screen.width,screen.height);if(!inches||!(diagonalPx>0))return null;const cmPerPx=inches*2.54/diagonalPx;return [Math.round(innerWidth*cmPerPx*10)/10,Math.round(innerHeight*cmPerPx*10)/10];}
  function showScreenDiagonal(){const inches=screenDiagonalInches(),cm=viewportScreenCm();$('#screenDiagonal').value=inches??'';$('#screenDiagonalStatus').textContent=cm?`${inches} in · this window ${cm[0]}×${cm[1]} cm · applies from the next camera start`:'Not set · model default (24-inch 16:9)';}
  let clickCorrections=0,clickCorrectionBusy=false,lastClickCorrectionAt=-Infinity,syntheticWorld=null,videoScene=null,videoObjectUrl=null,gazeTrack=null,eyeObjectUrl=null,eyeLoop=null;
  const fixation=createFixationBuffer();
  let activeLandmarkResidual=null;
  const calibrationStatus=$('#calibrationStatus');
  calibrationStatus.id='gazeCalibrationStatus';calibrationStatus.className='row';calibrationStatus.setAttribute('aria-live','polite');gazeStatus.parentElement.after(calibrationStatus);
  const showCalibrationStatus=text=>{calibrationStatus.textContent=text;};
  function logCalibrationStage(event,{startedAt,count=27,verdict=null}={}){
    if(!cameraSessionId)return;
    const body={event,sessionId:cameraSessionId,...(verdict??{}),...(Number.isFinite(startedAt)?{durationMs:Math.min(600000,Math.max(0,Math.round(performance.now()-startedAt)))}:{}),count};
    try{void fetch('/api/diagnostics/calibration-stage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),keepalive:true}).catch(()=>{});}catch{}
  }
  function onCalibrationProgress({stage,count}={}){
    const now=performance.now(),info=$('#calibrationInfo');
    if(stage==='adaptation_started'){
      calibrationAdaptStartedAt??=now;
      if(!calibrationAdaptStarted){logCalibrationStage('calibration_adapt_start');calibrationAdaptStarted=true;}
      if(calibrationStage==='training')info.textContent='27 WebEyeTrack samples collected · adapting the local model';
    }else if(stage==='adaptation_complete'){
      if(!calibrationAdaptStarted){calibrationAdaptStartedAt??=now;logCalibrationStage('calibration_adapt_start');calibrationAdaptStarted=true;}
      if(!calibrationAdaptFinished)logCalibrationStage('calibration_adapt_complete',{startedAt:calibrationAdaptStartedAt});
      calibrationAdaptFinished=true;
      if(calibrationStage==='training')info.textContent='Model adapted · preparing local calibration replay data';
    }else if(stage==='adaptation_error'){
      if(!calibrationAdaptStarted){calibrationAdaptStartedAt??=now;logCalibrationStage('calibration_adapt_start');calibrationAdaptStarted=true;}
      if(!calibrationAdaptFinished)logCalibrationStage('calibration_adapt_error',{startedAt:calibrationAdaptStartedAt});
      calibrationAdaptFinished=true;
    }else if(stage==='serialization_started'){
      calibrationSerializeStartedAt=now;calibrationSerializeFinished=false;
      logCalibrationStage('adaptation_serialize_start');
      if(calibrationStage==='training')info.textContent=`Model adapted · encoding local calibration replay data 0/${count??27}`;
    }else if(stage==='serialization_progress'){
      if(calibrationStage==='training')info.textContent=`Model adapted · encoding local calibration replay data ${count??0}/27`;
    }else if(stage==='serialization_complete'){
      if(!calibrationSerializeFinished)logCalibrationStage('adaptation_serialize_complete',{startedAt:calibrationSerializeStartedAt});
      calibrationSerializeFinished=true;
    }else if(stage==='serialization_error'){
      if(!calibrationSerializeFinished)logCalibrationStage('adaptation_serialize_error',{startedAt:calibrationSerializeStartedAt});
      calibrationSerializeFinished=true;
    }
  }
  showCalibrationStatus('No WebEyeTrack calibration · will try to restore one saved on this device at start');
  let provisionalTrackingStore=null, provisionalTrackingOpening=null, provisionalSparkRecordId=null;
  const provisionalTrackingStatus=$('#provisionalTrackingStatus'), provisionalTrackingList=$('#provisionalTrackingList');
  function renderProvisionalTracking(records){
    provisionalTrackingList.replaceChildren();
    for(const record of [...records].reverse()){
      const item=document.createElement('li'), heading=document.createElement('div');
      const date=new Date(record.recordedAt).toLocaleString();
      const sparkStatus={pending:'Analyzing',complete:'Analysis complete',failed:'Failed',cancelled:'Cancelled',withheld:'No consent',skipped:'Request on hold'}[record.spark.status]??'Check status';
      const sparkFailure=record.spark.reason?` · ${provisionalSparkFailureLabels[record.spark.reason]??'Check the failure reason'}`:'';
      heading.textContent=`${date} · ${record.classification==='uncalibrated_provisional'?'uncalibrated / provisional':'calibrated estimate / provisional'} · frame ${record.frame.frameId} · gaze ${record.gaze.x.toFixed(3)}, ${record.gaze.y.toFixed(3)} · SAM ${record.sam.maskCount} masks · Spark ${sparkStatus}${sparkFailure}`;
      item.append(heading);
      const scope=document.createElement('div');scope.textContent=provisionalSparkValidityScope(record);item.append(scope);
      for(const scenario of record.spark.scenarios){const detail=document.createElement('div');detail.textContent=`Spark hypothesis: ${scenario.possible_next_action}`;item.append(detail);}
      if(!record.spark.scenarios.length){const detail=document.createElement('div');detail.textContent='No saved Spark hypotheses';item.append(detail);}
      provisionalTrackingList.append(item);
    }
    if(!records.length){const empty=document.createElement('li');empty.textContent='No saved uncalibrated demo records.';provisionalTrackingList.append(empty);}
    provisionalTrackingStatus.textContent=`${records.length} provisional demo records · saved on this device · kept until you delete them`;
  }
  async function ensureProvisionalTracking(){
    if(provisionalTrackingStore)return provisionalTrackingStore;
    if(provisionalTrackingOpening)return provisionalTrackingOpening;
    provisionalTrackingStatus.textContent='Restoring uncalibrated / provisional demo records';
    provisionalTrackingOpening=ProvisionalTrackingStore.open({sessionId:'local-research',retentionConsent:true}).then(async store=>{
      provisionalTrackingStore=store;renderProvisionalTracking(await store.list());return store;
    }).catch(error=>{
      provisionalTrackingStatus.textContent='Could not open the provisional demo record store. Check browser storage or a lock held by another tab.';
      throw error;
    }).finally(()=>{provisionalTrackingOpening=null;});
    return provisionalTrackingOpening;
  }
  async function persistSamResult({frame,gazePoint,gazeTiming,masks}){
    try{
      const store=await ensureProvisionalTracking();
      const record=await store.appendDemoResult({frame,gazePoint,gazeTiming,masks,scenarios:[],sparkStatus:$('#provisionalSparkConsent').checked?'pending':'withheld'});
      renderProvisionalTracking(await store.list());return record.id;
    }catch(error){provisionalTrackingStatus.textContent=`SAM result shown, but saving it locally failed · ${provisionalTrackingFailureReason(error)}`;return null;}
  }
  function provisionalTrackingFailureReason(error){
    const detail=`${error?.name??''} ${error?.message??''}`;
    if(/open elsewhere/i.test(detail))return 'Store in use by another tab';
    if(/quota/i.test(detail))return 'Browser storage is full';
    if(/IndexedDB unavailable/i.test(detail))return 'Browser storage unavailable';
    return 'Check storage';
  }
  async function persistSparkResult(recordId,status,scenarios=[],reason,{render=true}={}){
    if(!recordId)return;
    try{const store=await ensureProvisionalTracking();await store.updateSparkResult(recordId,{status,scenarios,reason});const records=await store.list();if(render)renderProvisionalTracking(records);return records;}
    catch{provisionalTrackingStatus.textContent='SAM result kept, but the Spark status update failed.';}
  }
  async function deleteProvisionalHistory(){
    try{
      const store=await ensureProvisionalTracking();await store.deleteAll();renderProvisionalTracking([]);provisionalTrackingStatus.textContent='Provisional demo records deleted';
    }catch{
      try{await deleteProvisionalTracking({sessionId:'local-research'});renderProvisionalTracking([]);provisionalTrackingStatus.textContent='Provisional demo records deleted';}
      catch{provisionalTrackingStatus.textContent='Could not delete provisional demo records · try again.';throw Error('provisional tracking deletion failed');}
    }
  }
  const history=new FrameHistory();
  let pilot=null, pilotTimer=null;
  function updatePilot() {
    if(!pilot)return;
    const end=pilot.stoppedAt ?? performance.now();const seconds=Math.floor(Math.max(0,end-pilot.startedAt-(pilot.pausedMs??0)-(pilot.pauseStartedAt==null?0:end-pilot.pauseStartedAt))/1000);
    $('#pilotStatus').textContent=`Observed ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} / 30:00 · ${pilot.samples} samples`;
  }
  $('#exportPilot').addEventListener('click',()=>{
    if(!pilot){message.textContent='No session to export.';return;}
    const data=pilotReport(pilot,performance.now(),coordinator?.status());
    // Stage timings for request/latency QA (browser clock; not display presentation time).
    data.gazeTransport=typeof controller?.telemetry==='function'?controller.telemetry():null;data.backgroundAttention=typeof backgroundAttention?.telemetry==='function'?backgroundAttention.telemetry():lastBackgroundTelemetry;
    if(timingCalibration){data.opticalTimingUncertaintyMs=Math.max(timingCalibration.cameraClockModel.uncertaintyMs,...Object.values(timingCalibration.displayModels).map(m=>m.uncertaintyMs));data.opticalTimingUnavailableReason=null;data.cameraClockSync={status:'operator_supplied_measurement_record_loaded',sourceClockId:timingCalibration.sourceClockId,offsetMs:timingCalibration.cameraClockModel.sessionAnchorMs-timingCalibration.cameraClockModel.sourceAnchorMs,driftPpm:timingCalibration.cameraClockModel.driftPpm,uncertaintyMs:timingCalibration.cameraClockModel.uncertaintyMs,profileId:timingCalibration.profileId,evidenceSha256:timingCalibration.reference.evidenceSha256};data.scenePresentation={status:'operator_supplied_optical_measurements_loaded',regions:Object.fromEntries(Object.entries(timingCalibration.displayModels).map(([id,m])=>[id,{offsetMs:m.sessionAnchorMs-m.sourceAnchorMs,driftPpm:m.driftPpm,uncertaintyMs:m.uncertaintyMs}]))};data.sceneAssociation='runtime_alignment_active_t15_unverified';data.syncGate={status:'not_passed',t15:'not_run'};}
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='prometheus-pilot-summary.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    message.textContent='Summary exported. Video, landmarks and camera IDs are not included.';
  });
  function timingSetup(){return {userAgent:navigator.userAgent,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio:window.devicePixelRatio||1,screenX:window.screenX,screenY:window.screenY,screenWidth:screen.width,screenHeight:screen.height},camera:{modelLabel:$('#timingCameraLabel').value.trim(),width:video.videoWidth,height:video.videoHeight,frameRate:pilot?.cameraSettings.reportedFrameRate??null}};}
  function sameTimingSetup(a,b){return a?.userAgent===b.userAgent&&['width','height','devicePixelRatio','screenX','screenY','screenWidth','screenHeight'].every(key=>a.viewport?.[key]===b.viewport[key])&&['modelLabel','width','height','frameRate'].every(key=>a.camera?.[key]===b.camera[key]);}
  function gazeEnvironment(camera){return {viewport:{width:innerWidth,height:innerHeight,devicePixelRatio:window.devicePixelRatio||1},screen:{width:screen.width,height:screen.height},camera:{width:camera?.width??null,height:camera?.height??null,frameRate:camera?.reportedFrameRate??camera?.frameRate??null}};}
  $('#exportTimingTemplate').addEventListener('click',()=>{
    const setup=timingSetup();if(!coordinator?.status().active||!cameraSessionId||!setup.camera.modelLabel||!setup.camera.frameRate){$('#timingStatus').textContent='Start the camera and check the model label and the real frame rate.';return;}
    const data=createTimingTemplate({browserSessionId:clockSessionId,cameraSessionId,setup});
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='prometheus-optical-timing-template.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    $('#timingStatus').textContent='Template exported for this browser session only · real measurement pairs and raw logs are required.';
  });
  $('#loadTiming').addEventListener('click',async()=>{
    try{
      if(!coordinator?.status().active||!pilot||latest?.timestampKind!=='browser_capture_estimate'||!Number.isFinite(latest?.captureSourceMs))throw new Error('Start a camera session with captureTime and enter the measurement camera label.');
      const manifest=$('#timingProfile').files[0],evidence=$('#timingEvidence').files[0];if(!manifest||!evidence)throw new Error('Select both the measurement manifest and the raw optical log file.');
      const profile=JSON.parse(await manifest.text()),record=validateTimingCalibration(profile,{browserSessionId:clockSessionId,cameraSessionId,setup:timingSetup(),performanceNowMs:performance.now(),captureSourceMs:latest.captureSourceMs});
      const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await evidence.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');
      if(record.reference.evidenceFile!==evidence.name||record.reference.evidenceSha256.toLowerCase()!==digest)throw new Error('The raw log file name or SHA-256 does not match the manifest.');
      controller.setTimingCalibration(record);timingCalibration=record;pendingAligned=null;pilot.timingCalibration={profileId:record.profileId,referenceFile:evidence.name,evidenceSha256:digest,intendedDurationMs:record.intendedDurationMs,t15Status:'not_run'};
      $('#timingStatus').textContent=`External optical measurement applied · clock drift ${record.cameraClockModel.driftPpm.toFixed(1)} ppm · camera uncertainty ${record.cameraClockModel.uncertaintyMs.toFixed(2)} ms · T15 not run`;
      $('#runGazeSam').disabled=true;$('#gazeSamStatus').textContent='Waiting for the next aligned frame · sending needs a button press';
    }catch(error){timingCalibration=null;pendingAligned=null;controller?.setTimingCalibration(null);$('#timingStatus').textContent=`Alignment on hold · ${error?.message||'Measurement record check failed'}`;$('#runGazeSam').disabled=true;}
  });
  const sizeCanvas=()=>{const r=canvas.getBoundingClientRect(), d=window.devicePixelRatio||1;canvas.width=Math.max(1,Math.round(r.width*d));canvas.height=Math.max(1,Math.round(r.height*d));};
  sizeCanvas();
  try { world=createWorld(canvas);syntheticWorld=world;
    const draw=ts=>{
      if(!sceneFrozen)world.render(ts);history.trim(ts);
      const current=world.getFrame();
      if(coordinator?.status().active && current && current.frameId!==lastHistoryFrameId && ts-lastCopy>=200){try{const f=timingPresentations(current,timingCalibration),bytes=canvas.width*canvas.height*4;if(bytes>history.maxBytes)throw Error('frame exceeds budget');const gl=canvas.getContext('webgl'),rgba=new Uint8Array(bytes);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,rgba);history.add(f,rgba,ts);lastCopy=ts;lastHistoryFrameId=current.frameId;}catch{memoryStatus.textContent='Could not copy scene evidence';}}
      requestAnimationFrame(draw);
    };requestAnimationFrame(draw);
    $('#worldGazeState').textContent='Calibration needed'; }
  catch { message.textContent='WebGL is unavailable, so the 3D scene cannot be shown.'; }
  for(const id of ['leftEye','rightEye']) {const container=$('#'+id);container.innerHTML='<canvas width="320" height="260"></canvas><small>Needs camera start and eye detection</small>';}
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
      if(gazeDemo){$('#provisionalSparkScenarios').replaceChildren();$('#provisionalSparkStatus').textContent=`New SAM frame ${frame.frameId} · waiting for Spark · provisional · time alignment not verified`;}
      diagnosticLayers={frame,pixels,overlay,depth,gazePoint:gazeDemo?diagnosticGazePoint:null};drawDiagnostic();
      $('#runtimeStatus').textContent=gazeDemo?'Gaze SAM done · checking provisional Spark consent':'SAM response received · Spark waiting';
      if(diagnosticPurpose==='scene-only'){
        $('#worldSceneState').textContent=count?`${count} scene masks`:'Response · 0 masks';
        $('#sceneStatus').textContent=`Startup scene-only SAM · gaze point not used · ${provider==='Meta'?'Meta':'provider unknown'} ${model==='sam-3.1'?'SAM 3.1':'model unknown'} · ${count} masks (0 does not mean nothing is there)`;
      }else if(diagnosticPurpose==='frozen-gaze-demo'||diagnosticPurpose==='uncalibrated-gaze-demo'){
        $('#worldSceneState').textContent=count?`Gaze SAM · ${count} masks`:'Gaze SAM · 0 masks';
        const label=diagnosticPurpose==='uncalibrated-gaze-demo'?'WebEyeTrack base model (uncalibrated)':'Calibrated WebEyeTrack estimate';
        $('#sceneStatus').textContent=`Provisional frozen-scene test · ${frame.frameId} · ${label} ${diagnosticGazePoint.x.toFixed(3)}, ${diagnosticGazePoint.y.toFixed(3)} · this frame record only · not reusable for the current scene or gaze · physical time alignment not verified · ${provider==='Meta'?'Meta':'provider unknown'} ${model==='sam-3.1'?'SAM 3.1':'model unknown'} · ${count} masks on the same frame`;
      }else $('#sceneStatus').textContent=
        `Frozen frame ${frame.frameId} · observed ${frame.observedAt.toFixed(1)} ms · processed ${performance.now().toFixed(1)} ms · ${provider==='Meta'?'Meta':'provider unknown'} ${model==='sam-3.1'?'SAM 3.1':'model unknown'} · ${count} masks`;
      if(gazeDemo){const gazePoint=diagnosticGazePoint,gazeTiming=diagnosticGazeTiming,recordId=await persistSamResult({frame,gazePoint,gazeTiming,masks});await requestProvisionalSpark({frame,imageDataUrl,masks,gazePoint,gazeTiming,recordId});}
    }
  });
  function cancelDiagnostic(){diagnostic.cancel();cancelProvisionalSpark();diagnosticLayers=null;diagnosticGazePoint=null;diagnosticGazeTiming=null;diagnosticPurpose='scene';$('#runScene').disabled=false;$('#sceneSnapshot').hidden=true;$('#sceneStatus').textContent='Scene diagnostic cancelled';if($('#worldSceneState').textContent.includes('SAM request in progress'))$('#worldSceneState').textContent='Stopped';}
  function calibrationPassed(){return pilot?.calibration?.passed===true&&!pilot.calibration.invalidatedAtUtc;}
  function samSessionAllowed(){const session=coordinator?.status();return !!session?.active&&!session.paused&&$('#localConsent').checked;}
  function frozenGazeAllowed(){return samSessionAllowed()&&calibrationPassed();}
  function provisionalGazeAllowed(){return samSessionAllowed()&&!calibrationStage;}
  function provisionalSparkAllowed(frame){return provisionalGazeAllowed()&&$('#provisionalSparkConsent').checked&&sceneFrozen&&frozenScene?.frame.frameId===frame?.frameId&&frozenScene.frame.observedAt===frame?.observedAt;}
  function cancelProvisionalSpark(status='Provisional Spark result discarded · physical time alignment not verified'){
    provisionalSparkGeneration++;const pending=provisionalSparkController,recordId=provisionalSparkRecordId;provisionalSparkController=null;provisionalSparkRecordId=null;pending?.abort();if(recordId)void persistSparkResult(recordId,'cancelled');$('#provisionalSparkScenarios').replaceChildren();$('#provisionalSparkStatus').textContent=status;
  }
  function beginGazeObservation(){
    $('#provisionalSparkScenarios').replaceChildren();
    if(diagnosticLayers?.frame){const previous=diagnosticLayers.frame;$('#sceneSnapshot').hidden=true;$('#sceneStatus').textContent=`Earlier SAM result scope · applies only to frozen frame ${previous.frameId} · not reusable for the current scene or gaze · physical time alignment not verified`;diagnosticLayers=null;}
    $('#provisionalSparkStatus').textContent='Collecting new gaze samples · earlier Spark hypotheses apply only to their stored frames';
  }
  function resumeWorldAfterGazeCycle(){sceneFrozen=false;frozenScene=null;$('#worldSceneState').textContent='Scene resumed · earlier masks belong to the frozen frame';updateFrozenGazeControls();}
  async function requestProvisionalSpark({frame,imageDataUrl,masks,gazePoint,gazeTiming,recordId=null}){
    $('#provisionalSparkScenarios').replaceChildren();
    if(!provisionalSparkAllowed(frame)){
      if(recordId)void persistSparkResult(recordId,$('#provisionalSparkConsent').checked?'cancelled':'withheld');
      if(!$('#provisionalSparkConsent').checked)$('#provisionalSparkStatus').textContent='SAM result only · provisional Spark needs its own consent · physical time alignment not verified';
      return;
    }
    if(provisionalSparkController){if(recordId)void persistSparkResult(recordId,'skipped');$('#provisionalSparkStatus').textContent='Spark analyzing · provisional · time alignment not verified';return;}
    const now=performance.now(),remaining=provisionalSparkMinIntervalMs-(now-lastProvisionalSparkAt);
    if(remaining>0){if(recordId)void persistSparkResult(recordId,'skipped');$('#provisionalSparkStatus').textContent=`Spark request waiting · retry in ${Math.ceil(remaining/1000)} s · provisional`;return;}
    const token=++provisionalSparkGeneration,requestController=new AbortController();provisionalSparkController=requestController;lastProvisionalSparkAt=now;
    provisionalSparkRecordId=recordId;
    $('#provisionalSparkStatus').textContent='Spark analyzing · provisional · time alignment not verified';
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
          $('#runtimeStatus').textContent='SAM + Spark analysis complete · provisional · time alignment not verified';
          $('#provisionalSparkStatus').textContent=scenarios.length?`Spark analysis complete · ${scenarios.length} hypotheses · provisional · time alignment not verified`:`Spark analysis complete · hypotheses withheld · provisional · time alignment not verified`;
        }
      });
      if(!published){if(provisionalSparkController===requestController)provisionalSparkController=null;if(provisionalSparkRecordId===recordId)provisionalSparkRecordId=null;return;}
    }else if(outcome.status==='failed'){
      const published=await publishProvisionalSparkIfCurrent({
        persist:()=>persistSparkResult(recordId,'failed',[],outcome.reason),
        isCurrent:()=>token===provisionalSparkGeneration&&!requestController.signal.aborted&&provisionalSparkAllowed(frame),
        discard:()=>persistSparkResult(recordId,'cancelled'),
        publish:()=>{$('#provisionalSparkStatus').textContent=`Spark analysis failed · ${provisionalSparkFailureLabels[outcome.reason]??'Check the failure reason'} · SAM result kept · provisional`;}
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
  function clearFrozenGazeDemo(reason='Provisional gaze test cancelled',unfreeze=true){
    const wasFrozenDemo=sceneFrozen||frozenGazeRequest||frozenGazeAutomation.status().active||diagnosticPurpose==='frozen-gaze-demo'||diagnosticPurpose==='uncalibrated-gaze-demo'||diagnosticPurpose==='scene-only';
    frozenGazeAutomation.stop();frozenGazeGeneration++;cancelFrozenGazeExpiry();frozenGazeRequest=false;cancelProvisionalSpark(`Provisional Spark result discarded · ${reason}`);
    if(wasFrozenDemo){diagnostic.cancel();diagnosticLayers=null;diagnosticGazePoint=null;diagnosticGazeTiming=null;diagnosticPurpose='scene';$('#sceneSnapshot').hidden=true;$('#sceneStatus').textContent=reason;}
    if(unfreeze){sceneFrozen=false;frozenScene=null;}
    if(reason.includes('Withdrawn')&&pilot)delete pilot.frozenSceneDemo;
    $('#gazeSamDemoStatus').textContent=reason;
    updateFrozenGazeControls();
  }
  async function runFrozenGazeSample(){
    if(!sceneFrozen||!frozenScene||!frozenGazeAllowed()||frozenGazeRequest)return;
    const token=++frozenGazeGeneration,sampleAfterMs=Math.max(frozenScene.stableAfterMs,performance.now()+1500),delay=Math.max(0,sampleAfterMs-performance.now());
    $('#gazeSamDemoStatus').textContent='Collecting gaze samples for 1.5 s on the frozen scene · capture time is a browser estimate; physical time alignment is not verified.';
    await new Promise(resolve=>{frozenGazeResolve=resolve;frozenGazeExpiry=setTimeout(()=>{frozenGazeExpiry=null;frozenGazeResolve=null;resolve();},delay);});
    if(token!==frozenGazeGeneration||!sceneFrozen||!frozenScene||!frozenGazeAllowed())return;
    if(initialScenePending){$('#gazeSamDemoStatus').textContent='Gaze SAM starts after the startup scene SAM finishes.';return;}
    const selected=selectFrozenSceneGaze({sample:latest,frame:frozenScene.frame,canvasRect:canvas.getBoundingClientRect(),frozenAtMs:frozenScene.frozenAtMs,stableAfterMs:sampleAfterMs,nowMs:performance.now()});
    if(selected.status!=='ready'){$('#gazeSamDemoStatus').textContent=`Gaze sample on hold · ${provisionalGazeFailureReason(null,selected.reason)} · checking again in 5 s. Time alignment is not verified.`;updateFrozenGazeControls();return;}
    if(!frozenGazeAllowed())return;
    frozenGazeRequest=true;diagnosticPurpose='frozen-gaze-demo';diagnosticGazePoint=selected.point;diagnosticGazeTiming={sampleAtMs:selected.captureAtMs,processedAtMs:selected.processedAtMs,timestampKind:'browser_capture_estimate',estimateStatus:'validated_calibration_estimate'};$('#sceneSnapshot').hidden=true;$('#runScene').disabled=true;$('#worldGazeState').textContent='Provisional gaze SAM request in progress';$('#worldSceneState').textContent='Gaze SAM request in progress';$('#gazeSamDemoStatus').textContent=`Calibrated browser estimate ${Math.floor(selected.point.x*frozenScene.frame.width)}, ${Math.floor(selected.point.y*frozenScene.frame.height)} px · paid Meta SAM request in progress · physical time alignment not verified`;updateFrozenGazeControls();
    let result;try{result=await diagnostic.run(frozenScene.frame,frozenScene.rgba.slice(),gazeSamPrompt(frozenScene.frame,selected.point));}catch{result={status:'failed'};}
    if(token!==frozenGazeGeneration)return;
    frozenGazeRequest=false;diagnosticPurpose='scene';diagnosticGazePoint=null;diagnosticGazeTiming=null;$('#runScene').disabled=false;
    if(result.status==='ok'){$('#worldGazeState').textContent='SAM response · timing not verified';$('#gazeSamDemoStatus').textContent=`SAM result shown · frozen frame ${frozenScene.frame.frameId} · masks and the calibrated browser estimate from the same frame · physical time alignment not verified · next call in 5 s or more`;if(pilot){pilot.frozenSceneDemo={status:'unverified_used',timingStatus:selected.timingStatus,opticalTimingUncertaintyMs:null,maxAcceptedCaptureProcessingLagMs:selected.maxCaptureProcessingLagMs,maxObservedCaptureProcessingLagMs:selected.captureProcessingLagMs,maxAcceptedProcessingAgeMs:selected.maxAcceptedProcessingAgeMs,maxAcceptedSampleAgeMs:selected.maxAcceptedSampleAgeMs,sampleCount:(pilot.frozenSceneDemo?.sampleCount??0)+1,samCalls:(pilot.frozenSceneDemo?.samCalls??0)+1};}}
    else {$('#worldGazeState').textContent=result.status==='cancelled'?'Stopped':'Calibrated gaze SAM failed';$('#worldSceneState').textContent=result.status==='cancelled'?'Stopped':'Gaze SAM failed';$('#gazeSamDemoStatus').textContent=result.status==='cancelled'?'SAM request cancelled · restarts after consent and session are checked.':'SAM request failed · check the remote service or network. Time alignment is not verified.';}
    updateFrozenGazeControls();
  }
  async function runUncalibratedGazeSample(){
    if(!sceneFrozen||!frozenScene||!provisionalGazeAllowed()||frozenGazeRequest)return;
    const token=++frozenGazeGeneration,sampleAfterMs=Math.max(frozenScene.stableAfterMs,performance.now()+1500),delay=Math.max(0,sampleAfterMs-performance.now());
    $('#gazeSamDemoStatus').textContent='WebEyeTrack base model · uncalibrated · waiting for a fresh sample on the frozen scene. Accuracy and physical time alignment are not verified.';
    await new Promise(resolve=>{frozenGazeResolve=resolve;frozenGazeExpiry=setTimeout(()=>{frozenGazeExpiry=null;frozenGazeResolve=null;resolve();},delay);});
    if(token!==frozenGazeGeneration||!sceneFrozen||!frozenScene||!provisionalGazeAllowed())return;
    if(initialScenePending){$('#gazeSamDemoStatus').textContent='Uncalibrated gaze SAM starts after the startup scene SAM finishes.';return;}
    const selected=selectProvisionalIrisGaze({estimate:latestProvisionalGaze?.estimate,sample:latestProvisionalGaze?.sample,frame:frozenScene.frame,canvasRect:canvas.getBoundingClientRect(),viewport:{width:innerWidth,height:innerHeight},stableAfterMs:sampleAfterMs,nowMs:performance.now()});
    if(selected.status!=='ready'){$('#gazeSamDemoStatus').textContent=`Uncalibrated gaze sample on hold · ${provisionalGazeFailureReason(latestProvisionalGaze?.estimate,selected.reason)} · checking again in 5 s. Physical time alignment is not verified.`;updateFrozenGazeControls();return;}
    if(!provisionalGazeAllowed())return;
    frozenGazeRequest=true;diagnosticPurpose='uncalibrated-gaze-demo';diagnosticGazePoint=selected.point;diagnosticGazeTiming={sampleAtMs:selected.sampleAtMs,processedAtMs:selected.processedAtMs,timestampKind:selected.timestampKind,estimateStatus:'uncalibrated_estimate'};$('#sceneSnapshot').hidden=true;$('#runScene').disabled=true;$('#worldGazeState').textContent='Uncalibrated gaze estimate SAM request in progress';$('#worldSceneState').textContent='Uncalibrated gaze SAM request in progress';
    const timingLabel=selected.timestampKind==='browser_capture_estimate'?'Browser capture time estimate':'Callback time (not capture time)';
    const eyeBasis=selected.eyesUsed?.length===1?'One eye':'Both eyes';
    $('#gazeSamDemoStatus').textContent=`WebEyeTrack base model, uncalibrated (${eyeBasis}) ${Math.floor(selected.point.x*frozenScene.frame.width)}, ${Math.floor(selected.point.y*frozenScene.frame.height)} px · ${timingLabel} · paid Meta SAM request · accuracy and physical time alignment not verified`;updateFrozenGazeControls();
    let result;try{result=await diagnostic.run(frozenScene.frame,frozenScene.rgba.slice(),gazeSamPrompt(frozenScene.frame,selected.point));}catch{result={status:'failed'};}
    if(token!==frozenGazeGeneration)return;
    frozenGazeRequest=false;diagnosticPurpose='scene';diagnosticGazePoint=null;diagnosticGazeTiming=null;$('#runScene').disabled=false;
    if(result.status==='ok'){$('#worldGazeState').textContent=`WebEyeTrack uncalibrated estimate (${eyeBasis}) · SAM response · timing not verified`;$('#gazeSamDemoStatus').textContent=`SAM result shown · WebEyeTrack base model, uncalibrated (${eyeBasis}) · ${timingLabel} · frozen frame ${frozenScene.frame.frameId} · accuracy and physical time alignment not verified · next call in 5 s or more`;}
    else {$('#worldGazeState').textContent=result.status==='cancelled'?'Stopped':'Uncalibrated estimate SAM failed';$('#worldSceneState').textContent=result.status==='cancelled'?'Stopped':'Uncalibrated gaze SAM failed';$('#gazeSamDemoStatus').textContent=result.status==='cancelled'?'SAM request cancelled · restarts after consent and session are checked.':'Uncalibrated estimate SAM request failed · check the remote service or network. Physical time alignment is not verified.';}
    updateFrozenGazeControls();
  }
  function prepareFrozenSceneForGaze(provisional=false){
    if(sceneFrozen&&frozenScene)return true;
    if(provisional?!provisionalGazeAllowed():!frozenGazeAllowed())return false;
    const source=world?.getFrame();if(!source){$('#gazeSamDemoStatus').textContent='Waiting for a scene frame · gaze SAM on hold';return false;}
    const bytes=source.viewport.width*source.viewport.height*4;if(bytes>history.maxBytes){$('#gazeSamDemoStatus').textContent='The scene exceeds the memory limit, so gaze SAM is on hold.';return false;}
    try{const gl=canvas.getContext('webgl');if(!gl)throw new Error('webgl unavailable');const rgba=new Uint8Array(bytes);gl.readPixels(0,0,source.viewport.width,source.viewport.height,gl.RGBA,gl.UNSIGNED_BYTE,rgba);const frozenAtMs=performance.now();frozenScene={frame:{frameId:source.frameId,observedAt:source.renderTsMs,width:source.viewport.width,height:source.viewport.height},rgba,frozenAtMs,stableAfterMs:frozenAtMs+500};sceneFrozen=true;}
    catch{sceneFrozen=false;frozenScene=null;$('#gazeSamDemoStatus').textContent='Could not keep the scene frame · gaze SAM is on hold.';updateFrozenGazeControls();return false;}
    diagnosticPurpose='scene';diagnosticGazePoint=null;diagnosticLayers=null;$('#sceneSnapshot').hidden=true;$('#sceneStatus').textContent=provisional?'WebEyeTrack base model (uncalibrated) only · gaze point accuracy not verified.':'Calibration done · the next requests use the calibrated WebEyeTrack gaze point. Time alignment is not verified.';$('#worldGazeState').textContent=provisional?'Waiting for an uncalibrated sample':'Waiting for a gaze sample';
    $('#gazeSamDemoStatus').textContent=provisional?'Uncalibrated heuristic session · waiting for a fresh eye landmark sample on the frozen scene.':'Calibrated session · waiting for a recent gaze sample on the frozen scene.';updateFrozenGazeControls();return true;
  }
  async function runSceneOnlyAnalysis(){
    if(!samSessionAllowed()||initialScenePending)return {status:'withheld'};
    const source=world?.getFrame();
    if(!source){$('#worldSceneState').textContent='Frame wait failed';return {status:'failed'};}
    const bytes=source.viewport.width*source.viewport.height*4;
    if(bytes>history.maxBytes){$('#worldSceneState').textContent='Frame limit exceeded';return {status:'failed'};}
    let rgba;try{const gl=canvas.getContext('webgl');if(!gl)throw new Error('webgl unavailable');rgba=new Uint8Array(bytes);gl.readPixels(0,0,source.viewport.width,source.viewport.height,gl.RGBA,gl.UNSIGNED_BYTE,rgba);}catch{$('#worldSceneState').textContent='Scene capture failed';return {status:'failed'};}
    const token=++initialSceneGeneration;initialScenePending=true;diagnosticPurpose='scene-only';diagnosticGazePoint=null;diagnosticGazeTiming=null;$('#runScene').disabled=true;$('#worldSceneState').textContent='Scene-only SAM request in progress';$('#sceneStatus').textContent='Scene-only SAM before calibration · gaze point not used';$('#gazeSamDemoStatus').textContent='Before calibration · segmenting the scene only · gaze SAM on hold';
    let result;try{result=await requestStartupSceneAnalysis({consent:$('#localConsent').checked,frame:source,rgba,diagnostic});}catch{result={status:'failed'};}
    if(token===initialSceneGeneration){$('#runScene').disabled=false;if(result.status!=='ok'&&result.status!=='cancelled'&&result.status!=='withheld'){$('#worldSceneState').textContent='Scene request failed';$('#sceneStatus').textContent='Scene SAM request failed · check the network or the Meta SAM setup.';}initialScenePending=false;diagnosticPurpose='scene';}
    return result;
  }
  async function runSamAnalysis(){
    if(!samSessionAllowed())return;
    beginGazeObservation();
    const calibrated=calibrationPassed();
    return runFrozenGazeCycle({
      prepare:()=>calibrated?prepareFrozenSceneForGaze():provisionalGazeAllowed()&&prepareFrozenSceneForGaze(true),
      run:()=>{if(initialScenePending){$('#gazeSamDemoStatus').textContent='Gaze samples are collected after the startup scene SAM finishes.';return {status:'withheld'};}return calibrated?runFrozenGazeSample():runUncalibratedGazeSample();},
      resume:resumeWorldAfterGazeCycle
    });
  }
  const frozenGazeAutomation=createFrozenGazeAutomation({run:runSamAnalysis,now:()=>performance.now(),intervalMs:5000});
  function maybeStartFrozenGazeAutomation(){if(!samSessionAllowed()||frozenGazeAutomation.status().active)return false;frozenGazeAutomation.start();updateFrozenGazeControls();return true;}
  $('#resumeWorld').addEventListener('click',()=>clearFrozenGazeDemo('Auto exploration stopped · scene resumed'));
  $('#provisionalSparkConsent').addEventListener('change',()=>{
    if(!$('#provisionalSparkConsent').checked)cancelProvisionalSpark('Provisional Spark consent withdrawn · in-flight request cancelled and result discarded');
    else $('#provisionalSparkStatus').textContent='Consent given · Spark analysis after the next SAM response · provisional';
  });
  $('#runScene').addEventListener('click',async()=>{
    if(!$('#localConsent').checked){$('#sceneStatus').textContent='Camera and SAM consent is required before starting.';return;}
    const frame=world?.getFrame();if(!frame){$('#sceneStatus').textContent='No rendered scene.';return;}
    const bytes=frame.viewport.width*frame.viewport.height*4;if(bytes>history.maxBytes){$('#sceneStatus').textContent='The scene is too large.';return;}
    const rgba=new Uint8Array(bytes),gl=canvas.getContext('webgl');gl.readPixels(0,0,frame.viewport.width,frame.viewport.height,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
    diagnosticLayers=null;$('#runScene').disabled=true;$('#sceneSnapshot').hidden=true;$('#sceneStatus').textContent='Frozen scene mask request in progress';
    const result=await diagnostic.run({frameId:frame.frameId,observedAt:frame.renderTsMs,width:frame.viewport.width,height:frame.viewport.height},rgba);
    if(result.status!=='cancelled'){$('#runScene').disabled=false;if(result.status!=='ok')$('#sceneStatus').textContent='Scene diagnostic failed or unavailable';}
  });
  let sessionOffset=0,epoch=crypto.randomUUID()+'-',durableSession=null,sessionStarted=false,sessionSelecting=false,retentionGeneration=0;
  const sessionNow=()=>performance.now()+sessionOffset;
  const researchLedger=new EvaluationLedger();
  const researchTrace=createResearchTrace({isEnabled:()=>$('#traceConsent').checked,ledger:researchLedger,onStatus:result=>{$('#traceStatus').textContent=result.stored?`${researchLedger.entries.length} research records · comparison replay not run`:`Research record on hold: ${result.reason}`;}});
  $('#traceConsent').addEventListener('change',()=>{if(!$('#traceConsent').checked){researchTrace.clear();$('#traceStatus').textContent='Research record deleted · comparison replay not run';}else $('#traceStatus').textContent='Research record waiting · time alignment needs verification';});
  $('#deleteTrace').addEventListener('click',()=>{researchTrace.clear();$('#traceStatus').textContent='Research record deleted · comparison replay not run';});
  $('#exportTrace').addEventListener('click',()=>{if(!$('#traceConsent').checked){$('#traceStatus').textContent='Research record consent is required.';return;}const url=URL.createObjectURL(new Blob([JSON.stringify(researchLedger.export(),null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='prometheus-research-trace.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  const preparation=createPreparationDisplay({element:$('#preparationStatus'),now:sessionNow,onExpire:()=>{$('#nextGazeStatus').textContent='No next-gaze prediction';$('#scenarios').replaceChildren();$('#scenarioStatus').textContent='Preparation expired · scenarios withdrawn';}});
  let remotePipeline=null, remoteRuntime=null, remoteGeneration=0,alignedExpiryTimer=null;
  function updateGazeSamButton(){const ready=!!pendingAligned&&!!timingCalibration&&!!remotePipeline&&$('#gazeSamConsent').checked&&$('#localConsent').checked&&$('#reasonConsent').checked&&!!coordinator?.status().active&&!coordinator.status().paused;$('#runGazeSam').disabled=!ready;}
  function stopRemote(){researchTrace.cancelPending();remoteGeneration++;const pipeline=remotePipeline;remotePipeline=null;remoteRuntime?.stop();remoteRuntime=null;pipeline?.stop();pendingAligned=null;if(alignedExpiryTimer!==null)clearTimeout(alignedExpiryTimer);alignedExpiryTimer=null;$('#scenarios').replaceChildren();$('#nextGazeStatus').textContent='No next-gaze prediction';preparation.clear();$('#scenarioStatus').textContent='Scenario preparation on hold';updateGazeSamButton();}
  function startRemote(){
    if(remotePipeline || !coordinator?.status().active || coordinator.status().paused || !$('#localConsent').checked || !calibrationPassed())return;
    const sessionId=crypto.randomUUID(),token=++remoteGeneration;
    const reasoner=createServerReasoner({remoteConsent:true,journal,sessionId:journalSessionId});
    const rt=new RuntimeFacade({sessionId,analyzer:reasoner,now:sessionNow,timeoutMs:90000,minIntervalMs:1000,maxCallsPerMinute:10,maxCostPerMinute:1,estimatedCostPerCall:.05,publish:result=>{
      if(token!==remoteGeneration || !$('#localConsent').checked || !$('#reasonConsent').checked)return;
      researchTrace.outcome(result.id,result.scenarios,result.reasoner,result.nextGaze);
      $('#nextGazeStatus').textContent=result.nextGaze?.rankedTargetIds.length ? `Next gaze hypothesis (1 s): ${result.nextGaze.rankedTargetIds.join(', ')}` : 'No next-gaze prediction';
      preparation.show(result);
      const list=$('#scenarios');list.replaceChildren();for(const scenario of result.scenarios.slice(0,5)){const li=document.createElement('li');li.textContent=scenario.possible_next_action;list.appendChild(li);}
      $('#scenarioStatus').textContent=result.scenarios.length?'Scenario hypothesis · uncertain estimate':'The model withheld scenarios';
    }});
    const segment=async(frame,{signal,gaze})=>journalCall('segmentation-'+sessionId,frame.frameId,async()=>{if(signal?.aborted)throw new Error('operation cancelled');const response=await fetch('/api/sam/segment',{method:'POST',headers:{'content-type':'application/json'},signal,body:JSON.stringify({frame:{frameId:frame.frameId,observedAt:frame.observedAt},imageDataUrl:frame.imageData,prompt:gaze ? gazeSamPrompt(frame,gaze) : $('#samConcept').value.trim()})});if(!response.ok)throw new Error('segmentation unavailable');const result=await response.json();if(result.frame?.frameId!==frame.frameId || result.frame?.observedAt!==frame.observedAt)throw new Error('frame mismatch');return result;});
    remoteRuntime=rt;remotePipeline=new PerceptionPipeline({segment,segmentKind:'server_provider',identityNamespace:sessionId,memory,runtime:rt,now:sessionNow,ttlMs:120000,onExplorationResult:({count})=>{if($('#exploreConsent').checked) $('#exploreStatus').textContent=count ? `Scene exploration result · ${count} masks detected · coverage not verified` : 'Scene exploration result · no mask detected · that does not mean the object is absent';},onDecision:(bundle,proof)=>researchTrace.decision(bundle,proof),pinFrame:f=>{const original=resolveWorldFrame(world,f,sessionOffset,epoch);return !!original && world.pinFrame(original).status==='ok';},releaseFrame:f=>{const original=resolveWorldFrame(world,f,sessionOffset,epoch);return !!original && world.releaseFrame(original);},sampleSurface:(f,pixel,processedAt)=>{const original=resolveWorldFrame(world,f,sessionOffset,epoch);if(!original)return null;const value=world.samplePinnedSurface({...f,frameId:original.frameId,observedAt:original.renderTsMs,coordinateFrameId:'synthetic-world-frame'},pixel,Math.max(original.renderTsMs,processedAt-sessionOffset));return value?{...value,frameId:f.frameId,observedAt:f.observedAt,processedAt,coordinateFrameId:f.coordinateFrameId}:null;}});rt.start();remotePipeline.start(sessionId);
    $('#scenarioStatus').textContent='Waiting for sync-verified gaze';updateGazeSamButton();
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
  },onStatus:()=>{$('#exploreStatus').textContent='Scene exploration requested · detection coverage of the chosen concept not verified';}});
  setInterval(()=>exploration.tick(),1000);
  $('#samConcept').addEventListener('input',()=>{stopRemote();startRemote();$('#exploreStatus').textContent=validSamConcept($('#samConcept').value)?'Waiting with the chosen concept · at most 12 per minute':'Enter a concept for scene exploration · not needed for gaze segmentation';});
  $('#exploreConsent').addEventListener('change',()=>{if(!$('#exploreConsent').checked){stopRemote();startRemote();}$('#exploreStatus').textContent=$('#exploreConsent').checked?'Scene exploration waiting · at most 12 per minute':'Scene exploration off';});
  function submitAligned(input){pendingAligned=input;if(alignedExpiryTimer!==null)clearTimeout(alignedExpiryTimer);alignedExpiryTimer=setTimeout(()=>{if(pendingAligned===input){pendingAligned=null;updateGazeSamButton();$('#gazeSamStatus').textContent='Aligned frame expired · waiting for the next frame';}},1000);updateGazeSamButton();$('#gazeSamStatus').textContent='Aligned gaze and exact frame ready · expires in 1 s · sending needs a manual press';}
  $('#runGazeSam').addEventListener('click',()=>{
    const input=pendingAligned;pendingAligned=null;if(alignedExpiryTimer!==null)clearTimeout(alignedExpiryTimer);alignedExpiryTimer=null;$('#runGazeSam').disabled=true;
    if(!input||sessionNow()-input.gaze.timestampMs>1000||!timingCalibration||!$('#gazeSamConsent').checked||!$('#localConsent').checked||!$('#reasonConsent').checked||!remotePipeline){$('#gazeSamStatus').textContent='Optical timing measurement, a recent aligned frame, SAM and Spark consent and an active session are required.';return;}
    const result=handoff(input);
    $('#gazeSamStatus').textContent=result.accepted?'Selected gaze frame sent.':'Send on hold · check consent, session, alignment or the kept frame.';
  });
  $('#gazeSamConsent').addEventListener('change',()=>{if(!$('#gazeSamConsent').checked){pendingAligned=null;stopRemote();startRemote();}updateGazeSamButton();});
  $('#reasonConsent').addEventListener('change',()=>{if(!$('#reasonConsent').checked){stopRemote();startRemote();}else startRemote();updateGazeSamButton();});
  let memory=await MemoryService.open({sessionId:crypto.randomUUID(),clock:sessionNow});
  let unsubscribeTrace=memory.subscribeInvalidations(ids=>{researchTrace.withdrawEvidence(ids);if(remoteRuntime){$('#scenarios').replaceChildren();$('#nextGazeStatus').textContent='No next-gaze prediction';preparation.clear();$('#scenarioStatus').textContent='Scenarios withdrawn because the evidence changed';}});
  function bindTraceMemory(){unsubscribeTrace();unsubscribeTrace=memory.subscribeInvalidations(ids=>{researchTrace.withdrawEvidence(ids);if(remoteRuntime){$('#scenarios').replaceChildren();$('#nextGazeStatus').textContent='No next-gaze prediction';preparation.clear();$('#scenarioStatus').textContent='Scenarios withdrawn because the evidence changed';}});}
  const runtime=new RuntimeFacade({sessionId:crypto.randomUUID(),now:()=>performance.now()});
  const recordingStatus=document.createElement('span');recordingStatus.id='recordingState';recordingStatus.setAttribute('role','status');canvas.parentElement.append(recordingStatus);
  const recordingSummary=$('#localRecordingSummary'),mib=bytes=>`${(bytes/1048576).toFixed(1)} MiB`;
  async function refreshRecordingSummary(){try{const {recordings,totalBytes}=await listLocalRecordings();const active=recordings.filter(r=>r.active).length;recordingSummary.textContent=recordings.length?`${recordings.length} local video recordings · ${mib(totalBytes)}${active?` · ${active} recording now`:''}`:'No local video recordings';}catch{recordingSummary.textContent='Could not check local video recordings';}}
  async function refreshComputeProfile(){const status=$('#gazeBackendStatus');try{const response=await fetch('/api/runtime/config');if(!response.ok)throw Error();const config=await response.json();if(config.computeProfile==='cloud'){const probe=await fetch('/api/gaze/health'),health=await probe.json();status.textContent=health.ready?'Cloud profile · remote GPU WebEyeTrack ready · if unavailable, start is blocked with no local fallback':'Cloud profile · remote GPU unavailable · start is blocked with no local fallback';}else if(config.computeProfile==='local')status.textContent='Local profile · WebEyeTrack runs in this browser.';else status.textContent='Compute profile check failed';}catch{status.textContent='Cannot check the compute profile / remote GPU status';}}
  async function refreshDepthBackend(){const status=$('#depthBackendStatus');try{const response=await fetch('/api/depth/status');if(!response.ok)throw Error();const value=await response.json();status.textContent=value.backend==='colab_gpu'?'Colab GPU selected · scene frames are sent to Google Colab':value.backend==='local_cpu'?'Local CPU on this device selected':'Cannot check the depth server selection';}catch{status.textContent='Cannot check the depth server selection';}}
  const localRecorder=createLocalRecorder({onStatus:result=>{recordingStatus.textContent=({recording:'Recording locally',saved:'Local recording saved',failed:'Local recording failed to save',unavailable:'Local video recording not supported'})[result.status]??'';if(['recording','saved'].includes(result.status))void refreshRecordingSummary();}});
  $('#refreshRecordings').addEventListener('click',()=>void refreshRecordingSummary());
  function setDataPanel(open){$('#sessionPanel').classList.toggle('open',open);$('#dataPanel').setAttribute('aria-expanded',String(open));if(open){$('#dataSettings').open=true;void refreshRecordingSummary();void refreshComputeProfile();void refreshDepthBackend();}}
  $('#dataPanel').addEventListener('click',()=>setDataPanel(!$('#sessionPanel').classList.contains('open')));
  document.addEventListener('keydown',event=>{if(controller?.remote&&['training','validation'].includes(calibrationStage)){if(event.key==='Escape'){cancelRemoteCalibration();return;}if((event.key==='Enter'||event.key===' ')&&!event.repeat&&document.activeElement!==$('#target')){event.preventDefault();$('#target').click();return;}}if(event.key==='Escape'&&accuracySession){accuracySession.cancel('user_cancelled');return;}if(event.key==='Escape'&&$('#sessionPanel').classList.contains('open')){setDataPanel(false);$('#dataPanel').focus();}});
  // Deletion is permanent and the server never removes an open recording, so stopping comes first.
  $('#deleteRecordings').addEventListener('click',async event=>{const button=event.currentTarget;if(coordinator?.status().active){recordingSummary.textContent='Cannot delete while recording · stop (■) and try again';return;}if(!confirm('This permanently deletes every local video recording on this device. Continue?'))return;button.disabled=true;
    try{const result=await deleteLocalRecordings();recordingSummary.textContent=`${result.deleted.length} local video recordings deleted · ${mib(result.freedBytes)}`+(result.failed.length?` · ${result.failed.length} failed to delete`:'')+(result.skippedActive.length?` · ${result.skippedActive.length} skipped while recording`:'');}
    catch{recordingSummary.textContent='Could not delete local recordings · some may be deleted; press Check again';}finally{button.disabled=false;}});
  // Accuracy test (G1-F): frozen plan, fixed timing, no click-through and no adaptation while targets are shown.
  let accuracySession=null,accuracyResult=null;const accuracyStatus=$('#accuracyStatus');
  function accuracyConditions(){const glasses=$('#accuracyGlasses').value,lighting=$('#accuracyLighting').value.trim(),distance=Number($('#accuracyDistance').value);
    return {glasses:glasses===''?{value:null,reason:'not_reported'}:glasses==='true',lighting:lighting?lighting:{value:null,reason:'not_reported'},distanceCm:$('#accuracyDistance').value!==''&&Number.isFinite(distance)&&distance>0&&distance<500?distance:{value:null,reason:'not_measured'}};}
  function downloadJson(data,name){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  $('#startAccuracy').addEventListener('click',()=>{
    if(accuracySession){accuracyStatus.textContent='Test in progress';return;}
    if(!coordinator?.status().active||coordinator.status().paused){accuracyStatus.textContent='Start the camera (▶) to run the test';return;}
    if(calibrationStage||!calibrationPassed()){accuracyStatus.textContent='Pass calibration to run the test';return;}
    let session;try{const seed=crypto.getRandomValues(new Uint32Array(1))[0];const plan=createAccuracyPlan({seed,screen:{width:innerWidth,height:innerHeight}});
      session=createAccuracySession({plan,conditions:accuracyConditions(),
        onTrial:({trial,index,total})=>{const target=$('#target');$('#calibration').hidden=false;target.style.pointerEvents='none';target.style.left=trial.x+'px';target.style.top=trial.y+'px';$('#calibrationInfo').textContent=`Accuracy test ${index+1}/${total} · look at the target · no clicking · Esc cancels`;},
        onFinish:result=>{accuracySession=null;$('#calibration').hidden=true;$('#target').style.pointerEvents='';$('#calibrationInfo').textContent='';
          if(result.status==='completed'){accuracyResult=result;const v=result.report.verdict,e=result.report.stages[result.report.verdictStage]?.error;accuracyStatus.textContent=`Test complete · ${v.status} · p95 ${Number.isFinite(e?.p95)?(e.p95*100).toFixed(1)+'%':'Not available'} (diagonal) · plan ${result.planHash.slice(0,8)} · not a gate verdict`;$('#exportAccuracyReport').disabled=false;$('#exportAccuracySamples').disabled=false;}
          else accuracyStatus.textContent=result.status==='report_failed'?`Report failed · ${result.reason}`:`Test cancelled · ${result.reason}`;
          startBackgroundAttention();}});}
    catch(error){accuracyStatus.textContent=`Test setup failed · ${error.message}`;return;}
    accuracySession=session;stopBackgroundAttention();setDataPanel(false);accuracyStatus.textContent=`Testing · plan ${session.planHash.slice(0,8)}`;session.start();
  });
  $('#exportAccuracyReport').addEventListener('click',()=>{if(accuracyResult)downloadJson(accuracyResult.report,`prometheus-gaze-accuracy-${accuracyResult.planHash.slice(0,8)}.json`);});
  $('#exportAccuracySamples').addEventListener('click',()=>{if(accuracyResult)downloadJson({kind:'gaze_accuracy_samples',planHash:accuracyResult.planHash,reportHash:accuracyResult.report.hash,droppedSamples:accuracyResult.droppedSamples,samples:accuracyResult.samples},`prometheus-gaze-accuracy-samples-${accuracyResult.planHash.slice(0,8)}.json`);});
  showScreenDiagonal();
  $('#screenDiagonal').addEventListener('change',event=>{const value=Number(event.currentTarget.value);try{if(event.currentTarget.value===''){localStorage.removeItem(screenDiagonalKey);}else if(Number.isFinite(value)&&value>=7&&value<=100){localStorage.setItem(screenDiagonalKey,String(value));}}catch{}showScreenDiagonal();});
  addEventListener('resize',showScreenDiagonal);
  // WebEyeTrack click calibration: clicking the live view means the user is looking at that point. Session only, never saved.
  // Guided click calibration for the official WebEyeTrack pipeline. Its proxy builds the tracker without maxPoints, so every
  // click point is kept; the package ignores a click within 1 s or within 5% of the previous one and uses the gaze result at
  // click time. The guide therefore shows a 5x4 grid (20 points) one dot at a time and accepts a click on the dot only after
  // the user has looked for 1.2 s with an open-eye face in view. The dot is a plain element, so its click reaches the package.
  let clickGuide=null;
  function stopClickGuide(){clickGuide?.remove();clickGuide=null;}
  function startClickGuide(){
    if(!controller?.official||!controller.calibrated||controller.replay)return;
    stopClickGuide();
    // Rows alternate direction so the eyes move to a neighbouring dot each time.
    const spots=[.08,.36,.64,.92].flatMap((y,row)=>{const xs=[.05,.275,.5,.725,.95].map(x=>[x,y]);return row%2?xs.reverse():xs;});
    const overlay=document.createElement('div'),dot=document.createElement('div'),info=document.createElement('div');
    overlay.className='click-guide';dot.className='click-guide-dot waiting';info.className='click-guide-info';overlay.append(dot,info);document.body.append(overlay);clickGuide=overlay;
    let index=0,readyAt=Infinity,timer=null;
    const show=()=>{
      const [x,y]=spots[index];dot.style.left=`${x*innerWidth}px`;dot.style.top=`${y*innerHeight}px`;dot.className='click-guide-dot waiting';
      info.textContent=`${index+1}/${spots.length} · Look at the dot. When it turns green, keep looking and click it. (Esc: skip)`;
      readyAt=performance.now()+1200;clearTimeout(timer);timer=setTimeout(()=>{if(clickGuide===overlay)dot.className='click-guide-dot';},1200);
    };
    overlay.addEventListener('click',event=>{
      // Only a click on the ready dot may reach the package; anything else is not a gaze point.
      if(event.target!==dot||performance.now()<readyAt){event.stopPropagation();return;}
      if(!latest?.valid){event.stopPropagation();info.textContent='No face or open eyes in view. Look at the camera with your eyes open and click again.';return;}
      index++;
      if(index<spots.length){setTimeout(()=>{if(clickGuide===overlay)show();},0);return;}
      setTimeout(()=>{stopClickGuide();$('#clickCorrectionState').textContent=`${spots.length}-point click calibration done · click where you look to refine`;message.textContent=`Click calibration with ${spots.length} points done. If accuracy drops, recalibrate with the button or click where you look.`;},0);
    });
    overlay.addEventListener('keydown',event=>{if(event.key==='Escape')stopClickGuide();});
    addEventListener('keydown',function escape(event){if(event.key==='Escape'&&clickGuide===overlay){stopClickGuide();removeEventListener('keydown',escape);}});
    show();
  }
  // Local profile: every page click goes to WebEyeTrack's own click calibration, exactly like its WebEyeTrackProxy.
  addEventListener('click',event=>{
    if(!controller?.calibrated||calibrationStage||accuracySession)return;
    // GPU host: the click point and the frames at that moment go to the worker's click calibration (the package's handleClick).
    if(controller.remote){
      if(!controller.official||event.target?.closest?.(NON_GAZE_CLICK_TARGETS))return;
      controller.clickCorrection({x:event.clientX,y:event.clientY}).then(result=>{if(result.adapted){clickCorrections++;$('#clickCorrectionState').textContent=`${clickCorrections} corrections · GPU host`;}}).catch(()=>{});
      return;
    }
    if(controller.click({x:event.clientX,y:event.clientY},event.target)){clickCorrections++;$('#clickCorrectionState').textContent=`${clickCorrections} sent · WebEyeTrack click calibration · this session only`;}
  });
  canvas.addEventListener('click',async event=>{
    if(controller?.official)return;
    if(!controller?.remote||!controller.calibrated||calibrationStage||accuracySession||clickCorrectionBusy)return;
    const now=performance.now();if(now-lastClickCorrectionAt<1000)return;
    clickCorrectionBusy=true;lastClickCorrectionAt=now;const state=$('#clickCorrectionState');state.textContent='Correcting';
    try{
      const result=await controller.clickCorrection({x:event.clientX,y:event.clientY});
      if(result.adapted){
        // The browser-side corrections were fitted to the model before this click, so they no longer apply.
        clickCorrections++;activeAffine=null;activeLandmarkResidual=null;if(pilot)pilot.clickCorrections=clickCorrections;
        state.textContent=`${clickCorrections} applied · this session only · not checked`;
      }else state.textContent='Eyes closed or no face detected · click again';
    }catch(error){state.textContent=error?.code==='gaze_provider_busy'?'GPU busy · click again':'Correction failed · click again';}
    finally{clickCorrectionBusy=false;}
  });
  $('#deleteCalibrationProfile').addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;try{const store=await profileStorage;if(!store)throw new Error('storage_unavailable');await store.removeItem(GAZE_CALIBRATION_PROFILE_KEY);await store.removeItem(remoteGazeAdapterKey);remoteCalibrationProfile=null;showCalibrationStatus('Saved calibration and GPU model-only adapter deleted · this session adaptation stays until stop');}catch{showCalibrationStatus('Could not delete the saved calibration');}finally{button.disabled=false;}});
  let backgroundAttention=null,depthRequest=null,lastBackgroundTelemetry=null;
  const modelDepthStatus=document.createElement('span');modelDepthStatus.id='modelDepthState';modelDepthStatus.setAttribute('role','status');canvas.parentElement.append(modelDepthStatus);

  const backgroundStatus=document.createElement('span');backgroundStatus.id='backgroundAttentionState';backgroundStatus.setAttribute('role','status');canvas.parentElement.append(backgroundStatus);
  // ---- Scene source: the synthetic world or a recorded video in the same canvas (same frame interface downstream).
  const sceneVideo=$('#sceneVideo'),sceneSource=$('#sceneSource'),sceneVideoFile=$('#sceneVideoFile');
  function useScene(kind){
    // Object identities do not carry over between scenes.
    liveTracker=null;clearGazeTarget();
    if(kind==='video'&&videoScene){world=videoScene;void sceneVideo.play().catch(()=>{});$('#sceneLabel').textContent='Video scene';$('#sceneNote').textContent='Recorded video · gaze → SAM 3.1 → depth → Muse Spark';}
    else{sceneVideo.pause();gazeTrack=null;setEyeVideo(null);world=syntheticWorld;sceneSource.value='synthetic';$('#sceneLabel').textContent='Live world';$('#sceneNote').textContent='The virtual scene is not controlled by gaze';}
  }
  sceneSource.addEventListener('change',()=>{if(sceneSource.value==='video')sceneVideoFile.click();else useScene('synthetic');});
  sceneVideoFile.addEventListener('cancel',()=>{if(world!==videoScene)sceneSource.value='synthetic';});
  sceneVideoFile.addEventListener('change',()=>{
    const files=[...(sceneVideoFile.files??[])];sceneVideoFile.value='';
    const isEyes=item=>/\.eyes\.(mp4|webm)$/i.test(item.name);
    const file=files.find(item=>!isEyes(item)&&(item.type.startsWith('video/')||/\.(mp4|webm|mov|m4v)$/i.test(item.name))),trackFile=files.find(item=>/\.json$/i.test(item.name)),eyesFile=files.find(isEyes);
    if(!file){if(world!==videoScene)sceneSource.value='synthetic';return;}
    // Optional recorded gaze for this video (scripts/aria/export_gaze_video.py); it replaces live gaze while loaded.
    setEyeVideo(eyesFile??null);
    gazeTrack=null;if(trackFile){void trackFile.text().then(text=>{gazeTrack=parseGazeTrack(text);message.textContent=`Video scene: ${file.name} · ${gazeTrack.samples.length} recorded gaze samples (${gazeTrack.source}) · press ▶ to play`;}).catch(()=>{message.textContent='Could not read the gaze track (JSON) · using webcam gaze';});}
    if(videoObjectUrl)URL.revokeObjectURL(videoObjectUrl);
    videoObjectUrl=URL.createObjectURL(file);sceneVideo.src=videoObjectUrl;
    try{videoScene??=createVideoScene(canvas,sceneVideo);}catch{message.textContent='This browser cannot show the video scene.';useScene('synthetic');return;}
    sceneSource.value='video';useScene('video');message.textContent=`Video scene: ${file.name} (plays on this device only; analysis frames go to SAM, depth and Spark)`;
  });
  // ---- Glasses eye camera (exported with the gaze track): the left and right halves drawn into the eye panels, kept in
  // step with the scene video, so the eyes that produce the gaze are on screen next to what they look at.
  const eyeVideo=$('#eyeVideo');
  function setEyeVideo(file){
    cancelAnimationFrame(eyeLoop);eyeLoop=null;eyeVideo.pause();
    if(eyeObjectUrl){URL.revokeObjectURL(eyeObjectUrl);eyeObjectUrl=null;}
    document.body.classList.toggle('glasses-eyes',!!file);
    for(const id of ['leftEye','rightEye']){const small=$('#'+id).querySelector('small');if(small)small.textContent=file?'Project Aria eye camera (infrared)':'Needs camera start and eye detection';}
    if(!file){eyeVideo.removeAttribute('src');return;}
    eyeObjectUrl=URL.createObjectURL(file);eyeVideo.src=eyeObjectUrl;
    const canvases=['leftEye','rightEye'].map(id=>$('#'+id).querySelector('canvas'));
    const draw=()=>{
      eyeLoop=requestAnimationFrame(draw);
      if(eyeVideo.readyState<2)return;
      // Follow the scene video: same frame times by construction, so only correct drift and play state.
      if(Math.abs(eyeVideo.currentTime-sceneVideo.currentTime)>.12)eyeVideo.currentTime=sceneVideo.currentTime;
      if(sceneVideo.paused!==eyeVideo.paused){if(sceneVideo.paused)eyeVideo.pause();else void eyeVideo.play().catch(()=>{});}
      const half=eyeVideo.videoWidth/2,h=eyeVideo.videoHeight;
      canvases.forEach((canvas,index)=>{if(!canvas)return;if(canvas.width!==half||canvas.height!==h){canvas.width=half;canvas.height=h;}canvas.getContext('2d').drawImage(eyeVideo,index*half,0,half,h,0,0,half,h);});
    };
    draw();
  }
  // ---- Gaze target overlay: the box of the object nearest the fixation, and the fixation itself.
  const gazeTargetOverlay=$('#gazeTargetOverlay');let gazeTargetTimer=null;
  function clearGazeTarget(){clearTimeout(gazeTargetTimer);const ctx=gazeTargetOverlay.getContext('2d');ctx.clearRect(0,0,gazeTargetOverlay.width,gazeTargetOverlay.height);}
  function drawGazeTarget(view,target){
    const r=gazeTargetOverlay.getBoundingClientRect(),d=window.devicePixelRatio||1;
    gazeTargetOverlay.width=Math.max(1,Math.round(r.width*d));gazeTargetOverlay.height=Math.max(1,Math.round(r.height*d));
    clearGazeTarget();if(!view?.frameWidth||!view?.frameHeight)return;
    const ctx=gazeTargetOverlay.getContext('2d'),sx=gazeTargetOverlay.width/view.frameWidth,sy=gazeTargetOverlay.height/view.frameHeight;
    if(view.targetBounds){const b=view.targetBounds,x=b.left*sx,y=b.top*sy,w=(b.right-b.left)*sx,h=(b.bottom-b.top)*sy;
      ctx.lineWidth=2*d;ctx.strokeStyle='#41d7a2';ctx.fillStyle='#41d7a21f';ctx.fillRect(x,y,w,h);ctx.strokeRect(x,y,w,h);
      ctx.font=`500 ${13*d}px "IBM Plex Sans",system-ui,sans-serif`;const label=`Looking at ${target?.objectId??''}`;ctx.fillStyle='#111111';ctx.fillRect(x,Math.max(0,y-22*d),ctx.measureText(label).width+14*d,22*d);ctx.fillStyle='#ffffff';ctx.fillText(label,x+7*d,Math.max(15*d,y-7*d));}
    if(view.gaze){const x=view.gaze.x*gazeTargetOverlay.width,y=view.gaze.y*gazeTargetOverlay.height;ctx.lineWidth=2*d;ctx.strokeStyle='#fff';ctx.beginPath();ctx.arc(x,y,9*d,0,Math.PI*2);ctx.moveTo(x-14*d,y);ctx.lineTo(x+14*d,y);ctx.moveTo(x,y-14*d);ctx.lineTo(x,y+14*d);ctx.stroke();}
    // The box belongs to an analysed frame; on moving footage it goes stale, so it fades out.
    gazeTargetTimer=setTimeout(clearGazeTarget,4000);
  }
  // ---- Muse Spark background reasoning timeline: the evidence each analysis used and what Spark returned.
  function addSparkTimeline(result){
    const list=$('#sparkTimeline'),item=document.createElement('li');
    const head=document.createElement('div');head.className='when';head.textContent=`${new Date().toLocaleTimeString('en-US')} · ${world===videoScene?'Video':'Virtual scene'} · evidence ${(Math.round(result.sourceAgeMs??0)/1000).toFixed(1)} s old`;item.append(head);
    const steps=document.createElement('dl');
    const add=(label,value,lead=false)=>{const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;if(lead)dd.className='lead';steps.append(dt,dd);};
    add('Gaze',result.gazeTarget?`${result.gazeTarget.objectId} · ${(result.gazeTarget.distance*100).toFixed(1)}% from the fixation`:'No object within the radius');
    add('SAM 3.1',`${result.view?.maskCount??0} masks · ${result.candidateSpace?.candidates?.length??0} tracked objects`);
    add('Depth',result.depth?.status==='ok'?`${result.depth.objectCount} objects measured`:result.depth?`Withheld (${result.depth.reason})`:'Not requested');
    add('Muse Spark',result.scenarios.length?result.scenarios.map(scenario=>scenario.possible_next_action).join(' · '):'No scenarios',true);
    if(result.nextGaze?.rankedTargetIds?.length)add('Next gaze',result.nextGaze.rankedTargetIds.join(', '));
    item.append(steps);list.prepend(item);while(list.children.length>8)list.lastElementChild.remove();
  }
  function backgroundSnapshot(){
    // Paid SAM/Spark calls run only with the start consent in place and a visible tab.
    // Not during the click-calibration guide either: the gaze is on calibration dots, not on the scene.
    if(!$('#localConsent').checked||document.hidden||accuracySession||clickGuide||!coordinator?.status().active||coordinator.status().paused||calibrationStage||!latest?.faceDetected||!latest.rawScreenXY||performance.now()-latest.processedMs>500||!world)return null;
    const source=world.getFrame(),r=canvas.getBoundingClientRect();if(!source||r.width<=0||r.height<=0)return null;
    // The median of the last 0.8 s of gaze, not the single latest sample (falls back to it with fewer than 3 samples).
    const fix=fixation.estimate(performance.now(),{minSamples:3})??latest.rawScreenXY;
    const x=(fix.x-r.left)/r.width,y=(fix.y-r.top)/r.height;if(x<0||y<0||x>=1||y>=1)return null;
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
      depth:async(frame,{signal})=>{modelDepthStatus.textContent='Depth Anything analyzing';const response=await fetch('/api/depth/estimate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({frame:{frameId:frame.frameId,observedAt:frame.observedAt,width:frame.width,height:frame.height},imageDataUrl:frame.imageData}),signal});const result=await response.json();if(!response.ok){modelDepthStatus.textContent='Depth Anything request failed';throw Object.assign(new Error('depth_unavailable'),{code:result?.code??'depth_unavailable'});}modelDepthStatus.textContent=`Depth Anything · ${result.model?.device??'?'} · ${Math.round(result.timing?.requestRoundTripMs??result.timing?.totalMs??0)} ms · on the source frame`;return result;},
      // Segment every object, then pick the gaze target by distance (gaze-target.js); the gaze point alone is only a fallback.
      sam:async(frame,{signal,gaze})=>{const segment=async prompt=>{const response=await fetch('/api/sam/segment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({frame:{frameId:frame.frameId,observedAt:frame.observedAt},imageDataUrl:frame.imageData,prompt}),signal});if(!response.ok)throw new Error('background_sam_failed');return response.json();};// Recorded glasses gaze is accurate enough to prompt SAM at the fixation itself; webcam gaze asks for all objects first.
        const pointFirst=controller?.replay===true&&!!gaze;let result=await segment(pointFirst?gazeSamPrompt(frame,gaze):SCENE_OBJECTS_PROMPT),mode=pointFirst?'gaze point':'objects';
        if(!result.masks?.length){if(!pointFirst&&gaze){result=await segment(gazeSamPrompt(frame,gaze));mode='gaze point';}else if(pointFirst){result=await segment(SCENE_OBJECTS_PROMPT);mode='objects';}}$('#worldSceneState').textContent=`Background SAM · ${mode} · ${result.masks?.length??0} masks`;return result;},
      reason:async(input,{signal})=>sendProvisionalSparkRequest({consent:$('#provisionalSparkConsent').checked,frame:input.frame,imageDataUrl:input.frame.imageData,gazePoint:input.gaze,gazeTiming:{sampleAtMs:input.gaze.observedAt,processedAtMs:input.gaze.processedAt,timestampKind:input.gaze.timestampKind,estimateStatus:input.gaze.estimateStatus},masks:input.masks,candidates:input.candidates,gazeTarget:input.gazeTarget,depth:input.depth,issuedAtMs:performance.now(),signal})});
    backgroundAttention=new BackgroundAttentionCoordinator({work,snapshot:backgroundSnapshot,intervalMs:1000,minIntervalMs:1000,timeoutMs:110000,retryIntervalMs:5000,
      publish:result=>{drawGazeTarget(result.view,result.gazeTarget);addSparkTimeline(result);const list=$('#provisionalSparkScenarios');list.replaceChildren();for(const scenario of result.scenarios){const item=document.createElement('li');item.textContent=scenario.possible_next_action;list.append(item);}if(result.nextGaze) {const item=document.createElement('li');item.textContent='Next gaze candidates: '+result.nextGaze.rankedTargetIds.join(', ');list.append(item);}backgroundStatus.textContent=`Background hypothesis · evidence ${Math.round(result.sourceAgeMs)} ms old · time alignment not verified`;$('#worldGazeState').textContent=result.gazeTarget?`Gaze target ${result.gazeTarget.objectId} · distance ${(result.gazeTarget.distance*100).toFixed(1)}%`:'No gaze target (outside the radius)';},
      onStatus:status=>{if(['work_failed','invalid_result','timeout','processing_failed','snapshot_failed'].includes(status.event)){backgroundStatus.textContent='Background reasoning request failed · waiting to retry';console.warn('[Prometheus background]',status.event,status.error?.message??status.reason??status);}}});
    backgroundAttention.start(cameraSessionId??crypto.randomUUID());backgroundStatus.textContent='Background attention analyzing';
  }
  function stopBackgroundAttention(){if(typeof backgroundAttention?.telemetry==='function')lastBackgroundTelemetry=backgroundAttention.telemetry();backgroundAttention?.stop();backgroundAttention=null;depthRequest?.abort();depthRequest=null;}
  function drawEye(id,bitmap,faceDetected,crop) {
    const container=$('#'+id), c=container.querySelector('canvas'), context=c.getContext('2d');context.clearRect(0,0,c.width,c.height);
    if(bitmap) { try{context.drawImage(bitmap,0,0,c.width,c.height);container.querySelector('small').textContent='MediaPipe points · eye mint / lid yellow / iris violet / brow orange · not pupil detection · local';return;}catch{} }
    if(crop&&video.readyState>=2){context.save();context.translate(c.width,0);context.scale(-1,1);context.drawImage(video,crop.x,crop.y,crop.width,crop.height,0,0,c.width,c.height);context.restore();container.querySelector('small').textContent='No landmark bitmap · live crop only (frames async)';}
    else container.querySelector('small').textContent=!faceDetected?'Waiting for face / eye detection':crop?'Landmark preview unavailable · tracking continues':'Waiting for eye crop detection';
  }
  function onEyePreview({faceDetected,eyeCrops,bitmaps}={}) {
    if(controller?.remote){for(const id of ['leftEye','rightEye'])$('#'+id).querySelector('small').textContent='Remote GPU gaze · eye crops and landmarks stay on this device';return;}
    drawEye('leftEye',bitmaps?.left,faceDetected,eyeCrops?.left);
    drawEye('rightEye',bitmaps?.right,faceDetected,eyeCrops?.right);
  }
  function onSample(sample) {
    if(timingCalibration&&!sameTimingSetup(timingCalibration.setup,timingSetup())){handleCalibrationEnvironmentChange('Screen / camera settings changed');return;}
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
    if(sample.valid&&sample.rawScreenXY)fixation.add(sample.rawScreenXY,sample.processedMs);else if(!sample.faceDetected)fixation.clear();
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
      const timingLabel=sample.timestampKind==='callback_time_not_capture'?'Callback time (not capture time)':'Browser capture time estimate';
      gazeStatus.textContent=markerXY?`WebEyeTrack base model · uncalibrated ${timingLabel} · accuracy and time alignment not verified`:sample.faceDetected===true?'The uncalibrated estimate is outside the scene.':`No face / valid gaze · uncalibrated estimate on hold · ${describeOpenEyeWait(sample)}`;
      $('#worldGazeState').textContent=markerXY?'WebEyeTrack uncalibrated estimate · demo only':sample.faceDetected===true?'Outside the scene · uncalibrated estimate':'No face / valid gaze detected';
    }else{
      gazeStatus.textContent=sample.valid?'Gaze estimate · time alignment on hold':`Tracking on hold · ${sample.invalidReason}`;
      $('#worldGazeState').textContent=sample.valid?'Gaze estimate · alignment not verified':sample.invalidReason==='calibration_required'?'Calibration needed':`Tracking on hold · ${sample.invalidReason}`;
      if(sample.valid)gazeStatus.textContent=viewportXY?(sample.sceneAssociationEligible?'Gaze in the scene · checking time alignment':`Gaze in the scene · alignment on hold (${sample.syncStatus})`):'Diagnostic area / outside the scene';
    }
    const filteredMarker=(controller?.remote?remoteDisplayFilter:displayFilter).update(markerXY,sample.processedMs,{valid:!!markerXY&&!calibrationStage});
    showGazeMarker(filteredMarker.point,{active:!!session?.active,paused:!!session?.paused,calibrating:!!calibrationStage});
    const displayRegion=viewportXY?(viewportXY.y<1/3?'top':viewportXY.y<2/3?'middle':'bottom'):null;
    const frame=sample.sceneAssociationEligible ? history.at(sample.timestampMs,displayRegion) : null;
    if(sample.sceneAssociationEligible&&viewportXY){
      if(!frame)gazeStatus.textContent='Time alignment on hold · no kept frame for that display interval';
      else {const aligned=alignGaze({valid:true,captureMs:sample.timestampMs,syncUncertaintyMs:sample.syncUncertaintyMs},[{id:frame.frameId,presentMs:frame.presentTsEstimateMs,displayUncertaintyMs:frame.displayUncertaintyMs}]);
        if(aligned.status!=='aligned')gazeStatus.textContent=`Time alignment on hold · ${aligned.reason}`;
        else {const hit=world.raycastFrame(frame,viewportXY.x*frame.viewport.width,viewportXY.y*frame.viewport.height);gazeStatus.textContent=hit.status==='hit'?`Aligned frame ${frame.frameId} · surface contact point ${hit.point.map(x=>x.toFixed(2)).join(', ')} m`:`Aligned frame ${frame.frameId} · surface contact ${hit.status}`;}
      }
    }
    if(pilot?.calibration?.environmentChanged){gazeStatus.textContent+=' · environment changed · accuracy not guaranteed';$('#worldGazeState').textContent+=' · accuracy not guaranteed';}
    if(coordinator && pilot)pilot.peakPending=Math.max(pilot.peakPending,coordinator.status().pending);
    if(controller?.replay){gazeStatus.textContent=sample.valid?'Project Aria glasses gaze · tracking':'Project Aria glasses gaze · no gaze in this frame (blink or tracking loss)';$('#worldGazeState').textContent='Project Aria gaze';}
    const sampleForMemory={...sample};delete sampleForMemory.landmarkFeatures;
    const mapped=mapSessionEvidence(sampleForMemory,frame,sessionOffset,epoch,viewportXY);
    if(coordinator) coordinator.acceptSample(mapped.sample,mapped.frame).then(async result=>{if(result.recorded){const records=await memory.retrieve({observedUntil:sessionNow()});memoryStatus.textContent=result.pin==='evidence_evicted'?`Evidence evicted: ${result.reason}`:`${records.glimpses.length} glimpses · not linked to objects`;}}).catch(()=>{memoryStatus.textContent='Memory input failed · record on hold';});
    updateFrozenGazeControls();
  }
  function setState(s) {state.textContent=({starting:'Starting',active:'Camera active',stopping:'Cleaning up',stopped:'Stopped',error:'Start failed'})[s];start.disabled=s==='starting'||s==='active'||s==='stopping';stop.disabled=!(s==='starting'||s==='active');calibrate.disabled=s!=='active';calibrate.style.display=s==='active'?'inline-flex':'none';$('#pause').disabled=s!=='active';if(s!=='active'){clearGazeMarker();$('#pause').textContent='⏸';$('#pause').setAttribute('aria-label','Paused');$('#pause').title='Paused';}if(s==='stopped'&&!$('#localConsent').checked)$('#worldSceneState').textContent='Waiting for consent';updateFrozenGazeControls();}
  try {
    controller=createProfiledWebcamGazeController({video,mediaDevices:navigator.mediaDevices,onSample,onEyePreview,onDiagnostic:logStartupDiagnostic,onCalibrationProgress,getScreenCm:viewportScreenCm,
      getReplay:()=>world===videoScene&&gazeTrack?{track:gazeTrack,video:sceneVideo,getSceneRect:()=>canvas.getBoundingClientRect()}:null,getAdapter:async()=>{const store=await profileStorage;remoteCalibrationProfile=store?await store.getItem(remoteGazeAdapterKey):null;if(remoteCalibrationProfile&&(!remoteCalibrationProfile.adapter||remoteCalibrationProfile.version!==1||remoteCalibrationProfile.calibration?.passed!==true||!remoteCalibrationProfile.environment))throw Object.assign(new Error('remote calibration profile invalid'),{code:'gaze_adapter_incompatible'});return remoteCalibrationProfile?.adapter??null;},onError:error=>{stopBackgroundAttention();void localRecorder.stop();const diagnostic=startupFailureDiagnostic(error),detail=typeof error?.detail==='string'&&/^[a-z_]{3,48}$/.test(error.detail)?error.detail:null,text=`WebEyeTrack tracking stopped · code ${diagnostic.code} · step ${diagnostic.step}${detail?` · cause ${detail}`:''}`;if(detail)try{console.info('[Prometheus WebEyeTrack diagnostic] cause',detail);}catch{}logStartupDiagnostic(diagnostic.code);clearFrozenGazeDemo('Camera error · provisional gaze test cancelled',true);stopRemote();cancelDiagnostic();activeCalibration=null;activeAffine=null;displayFilter.reset();activeLandmarkResidual=null;training=[];validation=[];if(pilot?.calibration?.passed)pilot.calibration={...pilot.calibration,passed:false,status:'camera_error',invalidatedAtUtc:new Date().toISOString()};timingCalibration=null;cameraSessionId=null;pendingAligned=null;$('#timingStatus').textContent='Camera error · reapply the timing measurement';$('#runGazeSam').disabled=true;coordinator?.stop();message.textContent=text;gazeStatus.textContent=text;}});
    coordinator=createCoordinator({controller,memory,runtime,onState:setState,onAligned:submitAligned,onDiagnostic:logStartupDiagnostic,namespace:epoch});
  } catch {start.disabled=true;message.textContent='The camera API is unavailable in this browser.';}
  async function selectDurable(mode){
    if(sessionSelecting || sessionStarted || durableSession){$('#retentionStatus').textContent='This can be chosen only once, before the page starts.';return;}
    const hours=Number($('#retentionHours').value);if(!$('#retentionConsent').checked || !Number.isInteger(hours) || hours<1 || hours>720){$('#retentionStatus').textContent='Retention consent and a 1–720 hour setting are required.';return;}
    sessionSelecting=true;let opened=null;const generation=retentionGeneration;const withdrawn=()=>generation!==retentionGeneration || !$('#retentionConsent').checked;
    try{
      opened=await openDurableSession({sessionId:'local-research',mode,retentionConsent:true,retentionMs:hours*3600000});
      if(withdrawn()){await opened.close({remove:true});opened=null;$('#retentionStatus').textContent='Consent withdrawn, so the retained session was deleted.';return;}
      await memory.close();
      if(withdrawn()){await opened.close({remove:true});opened=null;memory=await MemoryService.open({sessionId:crypto.randomUUID(),clock:sessionNow});bindTraceMemory();coordinator?.replaceMemory(memory);$('#retentionStatus').textContent='Consent withdrawn, so the retained session was deleted.';return;}
      cancelDiagnostic();await journal.close();durableSession=opened;opened=null;journal=durableSession.journal;journalSessionId=durableSession.sessionId;sessionOffset=durableSession.offset;memory=durableSession.memory;bindTraceMemory();coordinator?.replaceMemory(memory);$('#retentionStatus').textContent=mode==='reopen'?'Retained session open · camera and external requests stopped':'Retained session created · camera and external requests stopped';
    }catch{try{if(opened)await opened.close({remove:withdrawn()});else if(withdrawn())await deleteDurableSlot({sessionId:'local-research'});}catch{}$('#retentionStatus').textContent='Could not open or clean up the retained session. Check the storage state.';}
    finally{sessionSelecting=false;}
  }
  $('#createDurable').addEventListener('click',()=>selectDurable('create'));
  $('#reopenDurable').addEventListener('click',()=>selectDurable('reopen'));
  $('#deleteDurable').addEventListener('click',async()=>{if(sessionSelecting){$('#retentionStatus').textContent='Retained session is being processed.';return;}if(durableSession){$('#clear').click();return;}try{await deleteProvisionalHistory();await deleteDurableSlot({sessionId:'local-research'});$('#retentionStatus').textContent='Retained session deleted';}catch{$('#retentionStatus').textContent='Could not delete the retained session · try again';}});
  $('#deleteProvisionalHistory').addEventListener('click',async event=>{event.currentTarget.disabled=true;try{await deleteProvisionalHistory();}catch{}finally{event.currentTarget.disabled=false;}});
  $('#retentionConsent').addEventListener('change',()=>{if(!$('#retentionConsent').checked){retentionGeneration++;if(durableSession)$('#clear').click();}});
  async function startSession(){
    if(cameraStartPending||coordinator?.status().active)return;
    if(sessionSelecting){message.textContent='Start after the retained session finishes processing.';return;}
    if(durableSession && !$('#retentionConsent').checked){message.textContent='Retention consent was withdrawn, so the session cannot start. Check the deletion state.';return;}
    if(!$('#localConsent').checked){message.textContent='Camera and paid SAM consent is required before starting.';return;}
    cameraStartPending=true;let result;try{result=await coordinator.start();}finally{cameraStartPending=false;}
    if(result.started) {
      void localRecorder.start(video.srcObject).catch(()=>{recordingStatus.textContent='Local recording failed to start';});
      clearFrozenGazeDemo('New camera session · provisional gaze test reset',true);cameraSessionId=crypto.randomUUID();
      pilot={startedAt:performance.now(),startedAtUtc:new Date().toISOString(),stoppedAt:null,pausedMs:0,pauseStartedAt:null,samples:0,validSamples:0,faces:0,timestampKinds:{browser_capture_estimate:0,callback_time_not_capture:0},inferenceCount:0,inferenceSum:0,inferenceMax:0,intervalCount:0,intervalSum:0,intervalMax:0,lastTimestamp:null,lastTimestampKind:null,peakPending:0,cameraSettings:{width:result.settings.width,height:result.settings.height,reportedFrameRate:result.settings.frameRate},calibration:null};
      if(controller.official){pilot.calibration={passed:true,status:'completed',method:'webeyetrack_official_click_calibration',reused:false};activeCalibration={calibration:pilot.calibration,environment:gazeEnvironment(pilot.cameraSettings),environmentChanged:false};}
      if(controller.remote&&controller.calibrated&&remoteCalibrationProfile)activeCalibration={calibration:remoteCalibrationProfile.calibration,environment:remoteCalibrationProfile.environment,environmentChanged:gazeCalibrationEnvironmentChanged(remoteCalibrationProfile.environment,gazeEnvironment(pilot.cameraSettings))};
      if(!activeCalibration&&!controller.remote&&!controller.official){try{const store=await profileStorage;if(store){const loaded=await loadGazeCalibrationProfile(store,{environment:gazeEnvironment(pilot.cameraSettings),runtime:profileRuntime});if(loaded.compatible){await controller.restoreCalibration(loaded.profile);activeCalibration={calibration:loaded.profile.calibration,environment:loaded.profile.environment,environmentChanged:false};activeAffine=loaded.profile.affine?.selection?.selected?loaded.profile.affine.model:null;activeLandmarkResidual=restoreLandmarkResidualCalibration(loaded.profile);showCalibrationStatus('Saved calibration restored');}else if(loaded.status!=='missing')showCalibrationStatus(`Saved calibration on hold · ${loaded.status}`);}}catch{showCalibrationStatus('Could not restore the saved calibration · use the calibration button to retry');}}
      const environmentChanged=!!activeCalibration&&(activeCalibration.environmentChanged===true||gazeCalibrationEnvironmentChanged(activeCalibration.environment,gazeEnvironment(pilot.cameraSettings)));
      if(activeCalibration)pilot.calibration={...activeCalibration.calibration,passed:true,status:'completed',reused:true,environmentChanged};
      sessionStarted=true;calibrationStage=null;$('#calibration').hidden=true;latestProvisionalGaze=null;updatePilot();updateFrozenGazeControls();pilotTimer=setInterval(updatePilot,1000);timer=setInterval(()=>{maintenance=maintenance.then(()=>memory.advanceTime(sessionNow())).catch(()=>{memoryStatus.textContent='Memory expiry failed';});},5000);
      if(activeCalibration){
        showCalibrationStatus(controller.remote?(environmentChanged?'Environment changed · reusing this device model-only GPU calibration · accuracy not guaranteed':'Reusing this device model-only GPU calibration · accuracy not guaranteed'):environmentChanged?'Environment change detected · reusing this page WebEyeTrack adaptation · accuracy not guaranteed · recalibrate with the button':'Reusing this page WebEyeTrack adaptation · accuracy not guaranteed');
        message.textContent=controller.remote?'Applied the model-only GPU adapter saved on this device. Raw frames, eye patches and landmarks are not saved.':environmentChanged?'Reusing this page WebEyeTrack adaptation. The screen / camera changed, so accuracy is not guaranteed.':'Reusing this page WebEyeTrack adaptation. Real-world gaze accuracy and time alignment are not guaranteed.';
        gazeStatus.textContent=controller.remote?'Saved GPU calibration estimate · accuracy not guaranteed':environmentChanged?'Environment changed · this page adaptation estimate · accuracy not guaranteed':'This page WebEyeTrack adaptation estimate · accuracy not guaranteed';
        $('#worldGazeState').textContent=environmentChanged?'Environment changed · accuracy not guaranteed':'WebEyeTrack calibration · accuracy not guaranteed';
      }else {showCalibrationStatus(controller.remote?'No remote GPU WebEyeTrack calibration · start with the calibration button':'No WebEyeTrack calibration · no automatic calibration · start with the calibration button');message.textContent=controller.remote?'Camera active · showing only uncalibrated gaze from the cloud GPU. Camera frames are sent for inference.':'Camera active · showing only uncalibrated WebEyeTrack base-model estimates. Calibration performance and time alignment are not verified.';gazeStatus.textContent='Waiting for an uncalibrated estimate';$('#worldGazeState').textContent=controller.remote?'Remote GPU · waiting for an uncalibrated estimate':'Waiting for an uncalibrated estimate';}
      if(controller.official)setTimeout(startClickGuide,1500);
      if(controller.replay){showCalibrationStatus('Recorded gaze replay · Project Aria glasses gaze → SAM 3.1 → depth → Muse Spark');message.textContent='Replaying the recorded glasses gaze in sync with the video. The webcam is not used.';gazeStatus.textContent='Aria recorded gaze replay';$('#worldGazeState').textContent='Aria recorded gaze';$('#clickCorrectionState').textContent='Recorded gaze (no calibration needed)';}
      else if(controller.official){showCalibrationStatus('Official WebEyeTrack (same as the demo) · no calibration step · look at a spot and click it to calibrate');message.textContent='Tracking with the official WebEyeTrack model. Look at several places and click them to improve accuracy.';gazeStatus.textContent='Official WebEyeTrack gaze · click calibration · accuracy not guaranteed';$('#worldGazeState').textContent='Official WebEyeTrack · click calibration';$('#clickCorrectionState').textContent='Look and click to calibrate';}
      $('#gazeSamDemoStatus').textContent=controller.remote?'Remote GPU WebEyeTrack · gaze frames sent · face landmarks and eye crops are not sent':activeCalibration?'Using WebEyeTrack calibration · accuracy is not guaranteed if the screen or environment changes.':'WebEyeTrack base model · uncalibrated · accuracy and physical time alignment are not verified.';
      startBackgroundAttention();
    }
    else if(result.reason==='start_failed') {const diagnostic=startupFailureDiagnostic(result.error),text=`Start failed · code ${diagnostic.code} · step ${diagnostic.step}`;logStartupDiagnostic(diagnostic.code);message.textContent=text;gazeStatus.textContent=text;$('#provisionalSparkStatus').textContent=text;}
  }
  start.addEventListener('click',()=>{for(const id of ['localConsent','provisionalSparkConsent','exploreConsent','reasonConsent','gazeSamConsent','traceConsent','retentionConsent'])$('#'+id).checked=true;void startSession();});
  function stopSession(){stopClickGuide();clickCorrections=0;clickCorrectionBusy=false;$('#clickCorrectionState').textContent='Available after calibration';calibrationRunToken++;accuracySession?.cancel('session_stopped');capturedAdaptation=null;calibrationWindow.length=0;stopBackgroundAttention();clearGazeMarker();initialSceneGeneration++;initialScenePending=false;clearFrozenGazeDemo('Camera stopped · provisional gaze point discarded',true);stopRemote();cancelDiagnostic();if(pilot && pilot.stoppedAt===null)pilot.stoppedAt=performance.now();clearInterval(pilotTimer);pilotTimer=null;updatePilot();clearInterval(timer);timer=null;const drained=coordinator?.stop();controller?.cancelCalibration();activeCalibration=null;activeAffine=null;displayFilter.reset();activeLandmarkResidual=null;training=[];validation=[];history.clear();latest=null;latestProvisionalGaze=null;candidate=null;pendingAligned=null;cameraSessionId=null;timingCalibration=null;controller?.setTimingCalibration(null);$('#timingStatus').textContent='Camera session ended · reapply the optical measurement';$('#runGazeSam').disabled=true;$('#gazeSamStatus').textContent='Stopped · gaze alignment needed after the camera starts';$('#worldSceneState').textContent=$('#localConsent').checked?'Stopped':'Waiting for consent';$('#worldGazeState').textContent='Waiting for an uncalibrated estimate';calibrationStage=null;$('#calibration').hidden=true;for(const id of ['leftEye','rightEye'])drawEye(id,null,false,null);gazeStatus.textContent='Waiting for an uncalibrated estimate';showCalibrationStatus('Camera session ended · the saved calibration is restored at the next start');return Promise.all([drained,maintenance,localRecorder.stop()]);}
  $('#pause').addEventListener('click',()=>{if(!coordinator?.status().active)return;if(coordinator.status().paused){coordinator.resume();controller?.resume?.();backgroundAttention?.resume();localRecorder.resume();if(pilot?.pauseStartedAt!=null){pilot.pausedMs+=performance.now()-pilot.pauseStartedAt;pilot.pauseStartedAt=null;}$('#pause').textContent='⏸';$('#pause').setAttribute('aria-label','Paused');$('#pause').title='Paused';startRemote();startBackgroundAttention();}else{clearGazeMarker();clearFrozenGazeDemo('Camera paused · provisional gaze point discarded',true);coordinator.pause();controller?.pause?.();depthRequest?.abort();depthRequest=null;backgroundAttention?.pause();localRecorder.pause();if(pilot)pilot.pauseStartedAt=performance.now();stopRemote();cancelDiagnostic();$('#pause').textContent='▶';$('#pause').setAttribute('aria-label','Resume');$('#pause').title='Resume';}updatePilot();updateFrozenGazeControls();});
  $('#localConsent').addEventListener('change',()=>{if($('#localConsent').checked)startSession();else {void stopSession();message.textContent='Consent withdrawn · the camera and in-flight SAM requests were stopped.';}});
  stop.addEventListener('click',stopSession);
  $('#clear').addEventListener('click',async()=>{if(sessionSelecting){$('#retentionStatus').textContent='Retained session is being processed.';return;}try{await stopSession();await deleteProvisionalHistory();if(durableSession){await durableSession.close({remove:true});durableSession=null;}else {await journal.delete();await memory.deleteSession();}journalSessionId=crypto.randomUUID();journal=await ProviderJournal.open({storage:new EphemeralStorage(),sessionId:journalSessionId});memory=await MemoryService.open({sessionId:crypto.randomUUID(),clock:sessionNow});bindTraceMemory();coordinator?.replaceMemory(memory);researchTrace.clear();$('#traceStatus').textContent='Research record deleted · comparison replay not run';pilot=null;$('#pilotStatus').textContent='Observed 0:00 / 30:00 · 0 samples';memoryStatus.textContent='Temporary session deleted';message.textContent='Session and saved uncalibrated records deleted. Raw video was not stored.';}catch{memoryStatus.textContent='Delete failed · try again';message.textContent='Could not finish deleting the session.';}});
  function restorePreviousCalibration(){
    controller?.cancelCalibration();
    if(activeCalibration){if(pilot)pilot.calibration={...activeCalibration.calibration,passed:true,status:'completed',reused:true,environmentChanged:activeCalibration.environmentChanged===true};}
    else if(pilot)pilot.calibration={passed:false,status:'not_calibrated'};
  }
  function handleCalibrationEnvironmentChange(reason){
    // Recorded glasses gaze does not depend on this screen or camera, so a resize changes nothing it relies on.
    if(controller?.replay)return;
    accuracySession?.cancel('environment_changed');capturedAdaptation=null;calibrationWindow.length=0;
    clearGazeMarker();clearFrozenGazeDemo('Screen / environment changed · provisional gaze point discarded',true);
    if(activeCalibration){activeCalibration.environmentChanged=true;if(pilot?.calibration?.passed)pilot.calibration.environmentChanged=true;}
    if(controller)controller.setTimingCalibration(null);
    timingCalibration=null;pendingAligned=null;stopRemote();startRemote();$('#timingStatus').textContent='Environment changed · reapply the optical timing measurement';$('#runGazeSam').disabled=true;
    if(calibrationStage){calibrationRunToken++;calibrationStage=null;candidate=null;training=[];validation=[];restorePreviousCalibration();message.textContent='The environment changed, so the WebEyeTrack adaptation in progress was cancelled. The earlier adaptation for this session is kept.';}
    else message.textContent=`${reason} detected · keeping this session WebEyeTrack calibration. Accuracy is not guaranteed; start a recalibration with the button.`;
    latest=null;latestProvisionalGaze=null;$('#calibration').hidden=true;history.clear();
    if(activeCalibration){showCalibrationStatus('Environment change detected · using this session WebEyeTrack adaptation · accuracy not guaranteed · press the button to recalibrate');gazeStatus.textContent='Environment changed · keeping this session adaptation · accuracy not guaranteed';$('#worldGazeState').textContent='Environment changed · accuracy not guaranteed';}
    else {showCalibrationStatus('Environment changed · no WebEyeTrack calibration · no automatic calibration · calibrate with the button');gazeStatus.textContent='Waiting for an uncalibrated estimate · environment changed';$('#worldGazeState').textContent='Calibration needed';}
    updateFrozenGazeControls();startBackgroundAttention();
  }
  $('#hide').addEventListener('click',e=>{document.body.classList.toggle('observation');e.target.textContent=document.body.classList.contains('observation')?'Show diagnostics':'Hide diagnostics';sizeCanvas();handleCalibrationEnvironmentChange('Screen layout');});
  window.addEventListener('resize',()=>{sizeCanvas();handleCalibrationEnvironmentChange('Screen size');});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearFrozenGazeDemo('The page was hidden, so provisional samples and masks were discarded and the scene resumed.',true);});
  window.addEventListener('pagehide',()=>{stopSession().then(async()=>{await (durableSession?durableSession.close():Promise.all([journal.close(),memory.close()]));await provisionalTrackingOpening?.catch(()=>{});await provisionalTrackingStore?.close();}).catch(()=>{});});
  // Adaptation targets: a 5x5 grid over 5-95% of the screen plus two extra centre samples (27 in all, as the worker requires).
  // Validation targets stay on a separate inner 3x3 grid, three times, so they are never the same points the model was fitted on.
  const points=(validationPhase)=>{let p=[];
    if(validationPhase){for(let repeat=0;repeat<3;repeat++)for(let y=0;y<3;y++)for(let x=0;x<3;x++)p.push({x:innerWidth*(.20+.28*x),y:innerHeight*(.20+.28*y)});return p;}
    for(let y=0;y<5;y++)for(let x=0;x<5;x++)p.push({x:innerWidth*(.05+.225*x),y:innerHeight*(.05+.225*y)});
    p.push({x:innerWidth*.5,y:innerHeight*.5},{x:innerWidth*.5,y:innerHeight*.5});return p;};
  function showTarget(index=sequence){const phase=calibrationStage==='training'?'WebEyeTrack adaptation':'Separate sample', p=points(calibrationStage==='validation')[index], target=$('#target'), info=$('#calibrationInfo');target.style.left=p.x+'px';target.style.top=p.y+'px';calibrationTargetShownAt=performance.now();const keyed=controller?.remote===true,instruction=keyed?'Eyes open, look at the target and press Enter or Space · keep looking about 0.5 s after pressing · Esc cancels':'Look at the target for at least 0.5 s, then click or press Enter / Space';target.setAttribute('aria-label',`${phase} target ${index+1}/27 · ${instruction}`);info.setAttribute('role','status');info.setAttribute('aria-live','polite');info.textContent=`${phase} ${index+1}/27 · ${instruction}`;if(keyed)target.focus({preventScroll:true});}
  const metricModel=()=>({dimension:2,x:[0,innerWidth,0],y:[0,0,innerHeight],trainingIds:[]});
  let remoteBatch=null;
  async function beginCalibration(){
    if(!coordinator?.status().active||calibrationStage)return;
    const runToken=++calibrationRunToken;
    capturedAdaptation=null;calibrationWindow.length=0;calibrationRunStart=null;calibrationAdaptStartedAt=null;calibrationAdaptStarted=false;calibrationAdaptFinished=false;calibrationSerializeStartedAt=null;calibrationSerializeFinished=false;stopBackgroundAttention();clearGazeMarker();clearFrozenGazeDemo('Calibration started · gaze SAM wait stopped',true);stopRemote();cancelDiagnostic();controller.cancelCalibration();candidate=null;training=[];validation=[];sequence=0;screenSize={width:innerWidth,height:innerHeight};calibrationStage='loading';if(pilot)pilot.calibration={passed:false,status:'in_progress',attempts:[],startedAtUtc:new Date().toISOString(),method:'WebEyeTrack.adapt',persistence:controller.remote?'remote_session':'local_adaptation_replay'};showCalibrationStatus(controller.remote?'Preparing the remote GPU WebEyeTrack candidate · reusing the current camera stream':'Preparing the WebEyeTrack worker / model · reusing the current camera stream');gazeStatus.textContent='Preparing calibration · gaze analysis on hold';$('#worldGazeState').textContent=controller.remote?'Preparing the remote GPU candidate':'Preparing WebEyeTrack';$('#calibration').hidden=false;$('#calibrationInfo').textContent=controller.remote?'Preparing the remote GPU candidate model. Only compressed camera frames are sent to the inference server.':'Preparing the local WebEyeTrack model.';$('#gazeSamDemoStatus').textContent=controller.remote?'Calibrating · compressed frames go to the remote GPU · landmarks and eye crops stay local':'Preparing WebEyeTrack calibration · video is processed only in the local worker.';updateFrozenGazeControls();
    try{await controller.beginCalibration();}catch(error){if(runToken!==calibrationRunToken||calibrationStage!=='loading')return;calibrationStage=null;restorePreviousCalibration();$('#calibration').hidden=true;message.textContent=`WebEyeTrack setup failed: ${error.message}`;showCalibrationStatus(controller.remote?'Remote GPU calibration setup failed · check the connection':'Calibration setup failed · check local assets and worker errors');return;}
    if(runToken!==calibrationRunToken||calibrationStage!=='loading'||screenSize.width!==innerWidth||screenSize.height!==innerHeight){controller.cancelCalibration();return;}
    calibrationStage='training';calibrationRunStart=controller.remote?null:performance.now();remoteBatch=controller.remote?newRemoteBatch():null;showCalibrationStatus(controller.remote?'For accuracy: face the screen, keep hair off your eyes, adjust the light or screen brightness if your glasses reflect, sit 50–70 cm away · a separate 27-point check follows':'Adapting with the official WebEyeTrack adapt() · a separate 27-point sample follows');gazeStatus.textContent='Adapting WebEyeTrack · gaze analysis on hold';$('#worldGazeState').textContent='Calibration needed';showTarget();$('#target').focus({preventScroll:true});updateFrozenGazeControls();startBackgroundAttention();
  }
  calibrate.addEventListener('click',()=>{if(controller?.official){startClickGuide();return;}void beginCalibration();});
  setInterval(()=>{
    const now=performance.now();
    const adaptationTimedOut=calibrationAdaptStartedAt!==null&&!calibrationAdaptFinished&&now-calibrationAdaptStartedAt>CALIBRATION_ADAPT_TIMEOUT_MS;
    const replayTimedOut=calibrationSerializeStartedAt!==null&&!calibrationSerializeFinished&&now-calibrationSerializeStartedAt>CALIBRATION_ADAPT_TIMEOUT_MS;
    if((adaptationTimedOut||replayTimedOut)&&['training','validation'].includes(calibrationStage)){calibrationRunToken++;
      const hadCalibration=!!activeCalibration,phase=replayTimedOut?'Encoding calibration replay data':'WebEyeTrack adaptation',reason=replayTimedOut?'calibration_replay_timeout':'calibration_adapt_timeout';
      if(adaptationTimedOut){if(!calibrationAdaptStarted){logCalibrationStage('calibration_adapt_start');calibrationAdaptStarted=true;}logCalibrationStage('calibration_adapt_error',{startedAt:calibrationAdaptStartedAt});calibrationAdaptFinished=true;}
      if(replayTimedOut){logCalibrationStage('adaptation_serialize_error',{startedAt:calibrationSerializeStartedAt});calibrationSerializeFinished=true;}
      calibrationStage=null;calibrationRunStart=null;capturedAdaptation=null;calibrationWindow.length=0;candidate=null;training=[];validation=[];restorePreviousCalibration();delete $('#target').dataset.pending;
      if(hadCalibration&&pilot?.calibration)pilot.calibration.lastRecalibrationFailureReason=reason;else if(pilot)pilot.calibration={...pilot.calibration,passed:false,status:'failed',failureReason:reason};
      $('#calibration').hidden=false;$('#calibrationInfo').textContent=`${phase} timed out · the candidate worker was cancelled. The camera and the earlier calibration stay as they are.`;
      showCalibrationStatus(hadCalibration?`${phase} timed out · keeping the earlier calibration for this session`:`${phase} timed out · the camera keeps running. Try again.`);
      message.textContent=hadCalibration?`${phase} timed out · keeping the earlier calibration for this session and the camera running.`:`${phase} timed out · the camera keeps running. Calibrate again.`;
      calibrate.focus();updateFrozenGazeControls();startBackgroundAttention();return;
    }
    if(calibrationRunStart!==null&&now-calibrationRunStart>CALIBRATION_RUN_TIMEOUT_MS&&['training','validation'].includes(calibrationStage)){calibrationRunToken++;
      const hadCalibration=!!activeCalibration;
      if(calibrationAdaptStartedAt!==null&&!calibrationAdaptFinished){if(!calibrationAdaptStarted){logCalibrationStage('calibration_adapt_start');calibrationAdaptStarted=true;}logCalibrationStage('calibration_adapt_error',{startedAt:calibrationAdaptStartedAt});calibrationAdaptFinished=true;}
      if(calibrationSerializeStartedAt!==null&&!calibrationSerializeFinished){logCalibrationStage('adaptation_serialize_error',{startedAt:calibrationSerializeStartedAt});calibrationSerializeFinished=true;}
      calibrationStage=null;calibrationRunStart=null;capturedAdaptation=null;calibrationWindow.length=0;candidate=null;training=[];validation=[];restorePreviousCalibration();delete $('#target').dataset.pending;
      if(hadCalibration&&pilot?.calibration)pilot.calibration.lastRecalibrationFailureReason='calibration_run_timeout';else if(pilot)pilot.calibration={...pilot.calibration,passed:false,status:'failed',failureReason:'calibration_run_timeout'};
      $('#calibration').hidden=false;$('#calibrationInfo').textContent='Calibration timed out · cancelled. Try again.';
      showCalibrationStatus(hadCalibration?'Recalibration timed out · keeping the earlier calibration for this session':'Calibration timed out · retry with the button');
      message.textContent=hadCalibration?'Recalibration timed out · the earlier calibration for this session is kept.':'Calibration timed out · no calibration was applied to this session.';
      calibrate.focus();updateFrozenGazeControls();startBackgroundAttention();return;
    }
    if(!['training','validation'].includes(calibrationStage))return;
    if(controller?.remote)return;
    if(calibrationTargetTimedOut(calibrationTargetShownAt,now,calibrationWindow)&&$('#target').dataset.pending!=='true'){
      calibrationRunToken++;const phase=calibrationStage==='training'?'WebEyeTrack adaptation':'Separate sample',targetNumber=sequence+1,hadCalibration=!!activeCalibration;
      const maxSampleAgeMs=calibrationSampleFreshnessMs(calibrationWindow),sampleStatus=calibrationSampleStatus(latest,{targetShownAt:calibrationTargetShownAt,now,maxAgeMs:maxSampleAgeMs}),windowStatus=calibrationWindowStatus(calibrationWindow,{targetShownAt:calibrationTargetShownAt,now});
      const reason=calibrationStage==='validation'&&windowStatus!=='ready'?windowStatus:sampleStatus==='ready'?'sample_processing_delayed':sampleStatus;
      calibrationStage=null;calibrationRunStart=null;capturedAdaptation=null;calibrationWindow.length=0;candidate=null;training=[];validation=[];restorePreviousCalibration();
      if(hadCalibration&&pilot?.calibration)pilot.calibration.lastRecalibrationFailureReason=reason;else if(pilot)pilot.calibration={...pilot.calibration,passed:false,status:'failed',failureReason:reason};
      const reasonText={no_open_eye_sample:'No open-eye sample',missing_sample_timestamp:'Sample has no timestamp',no_post_dwell_sample:'No sample after the fixation wait',future_sample:'Sample timestamp in the future',stale_sample:'No recent sample',no_post_dwell_samples:'No sample after the fixation wait',insufficient_recent_samples:'Not enough recent samples',gaze_unstable:'Samples too unsteady for a stable check',sample_processing_delayed:'WebEyeTrack response delayed'}[reason]??reason;
      $('#calibration').hidden=false;$('#calibrationInfo').textContent=`${phase} target ${targetNumber}/27 timed out · cause: ${reasonText} · calibration cancelled. Try again.`;
      showCalibrationStatus(hadCalibration?`Recalibration samples timed out (${reason}) · keeping the earlier calibration for this session`:`Calibration samples timed out (${reason}) · retry with the button`);
      message.textContent=hadCalibration?`Recalibration sample collection timed out (${reason}) · the earlier calibration for this session is kept.`:`Calibration sample collection timed out (${reason}) · no calibration was applied to this session.`;
      calibrate.focus();updateFrozenGazeControls();startBackgroundAttention();return;
    }
    if(now-calibrationTargetShownAt>=650&&!$('#target').dataset.pending)$('#target').click();
  },150);

  // ---- Cloud calibration: the user presses Enter/Space on each target, a short burst is kept in memory, and the
  // bursts are analysed in batches (no live stream runs meanwhile, so no request overlaps). Only the first target is
  // analysed at once, to show right away whether the face and open eyes are detected.
  const REMOTE_TARGET_ATTEMPTS={training:3,validation:2};
  function newRemoteBatch(){return {captures:new Map(),results:new Map(),attempts:new Map(),retry:[]};}
  const remoteStale=(runToken,stage)=>runToken!==calibrationRunToken||calibrationStage!==stage;
  function remoteReason(error){const detail=error?.detail??error?.code??error?.message;return typeof detail==='string'?detail:'unknown';}
  function endRemoteCalibration(messageText,statusText){
    calibrationRunToken++;calibrationAdaptFinished=true;calibrationStage=null;candidate=null;training=[];validation=[];remoteBatch=null;calibrationRunStart=null;
    restorePreviousCalibration();
    if(pilot?.calibration?.passed)pilot.calibration.lastRecalibrationStatus='failed';else if(pilot)pilot.calibration={...pilot.calibration,passed:false,status:'failed'};
    $('#calibration').hidden=true;delete $('#target').dataset.pending;message.textContent=messageText;showCalibrationStatus(statusText);
    calibrate.focus();updateFrozenGazeControls();startBackgroundAttention();
  }
  function failRemoteCalibration(error,phaseText){const reason=remoteReason(error);endRemoteCalibration(`GPU calibration failed (${phaseText}): ${reason}`,activeCalibration?'Recalibration failed · keeping the earlier adaptation for this session':'Calibration failed · retry with the button');}
  function cancelRemoteCalibration(){endRemoteCalibration('Calibration cancelled. The earlier calibration is kept.',activeCalibration?'Calibration cancelled · keeping the earlier adaptation for this session':'Calibration cancelled · retry with the button');}
  async function uploadRemoteTarget(index,phaseName,runToken,stage){
    const entry=remoteBatch.captures.get(index);let lastError=null;
    for(let attempt=0;attempt<3;attempt++){
      try{return await controller.uploadCalibrationTarget({phase:phaseName,pointIndex:index,target:entry.target,frames:entry.frames});}
      catch(error){
        if(remoteStale(runToken,stage))return null;
        lastError=error;if(['gaze_session_unavailable','gaze_protocol_error','gaze_invalid_request'].includes(error?.code))break;
        await new Promise(resolve=>setTimeout(resolve,400*(attempt+1)));   // the same frame IDs are re-sent, which the service answers idempotently
      }
    }
    throw lastError??new Error('upload_failed');
  }
  async function completeRemotePhase(runToken,stage){
    const info=$('#calibrationInfo'),batch=remoteBatch;
    if(stage==='training'){
      training=[];for(let index=0;index<27;index++)training.push({id:`train-${index}`,target:batch.captures.get(index).target});
      calibrationAdaptStartedAt=performance.now();calibrationAdaptStarted=true;calibrationAdaptFinished=false;logCalibrationStage('calibration_adapt_start');
      info.textContent='27/27 samples analyzed · adapting on the GPU. Please wait';
      try{await controller.finalizeCalibration();}catch(error){if(remoteStale(runToken,stage))return;logCalibrationStage('calibration_adapt_error',{startedAt:calibrationAdaptStartedAt});failRemoteCalibration(error,'Adaptation');return;}
      if(remoteStale(runToken,stage))return;
      calibrationAdaptFinished=true;logCalibrationStage('calibration_adapt_complete',{startedAt:calibrationAdaptStartedAt});
      if(pilot?.calibration)for(let index=0;index<27;index++)pilot.calibration.attempts.push({phase:'training',index,target:{...batch.captures.get(index).target},sampleAvailable:true,atUtc:new Date().toISOString()});
      candidate=metricModel();calibrationStage='validation';sequence=0;remoteBatch=newRemoteBatch();
      showCalibrationStatus('27-point GPU adaptation done · collecting a separate 27-point check (Enter or Space)');showTarget(0);return;
    }
    validation=[];let invalid=0;
    for(let index=0;index<27;index++){
      const target=batch.captures.get(index).target,result=batch.results.get(index);
      if(result?.status==='measured')validation.push({id:`validate-${index}`,features:[result.normPog[0]+.5,result.normPog[1]+.5],landmarkFeatures:null,target});
      else{invalid++;validation.push({id:`validate-${index}`,features:null,landmarkFeatures:null,target,valid:false});}   // stays in the denominator
      if(pilot?.calibration)pilot.calibration.attempts.push({phase:'validation',index,target:{...target},sampleAvailable:result?.status==='measured',atUtc:new Date().toISOString()});
    }
    sequence=27;if(invalid)info.textContent=`${invalid} check targets had no detected eyes and count as invalid (included in the valid rate).`;
    await finishCalibrationValidation();
  }
  async function uploadRemoteBatch(runToken,stage){
    const info=$('#calibrationInfo'),batch=remoteBatch,phaseName=stage==='training'?'train':'validate',failed=[];
    for(let index=0;index<27;index++){
      if(batch.results.has(index))continue;
      info.textContent=`Analyzing on the GPU ${index+1}/27 · do not close the window`;
      let result;try{result=await uploadRemoteTarget(index,phaseName,runToken,stage);}catch(error){if(remoteStale(runToken,stage))return;failRemoteCalibration(error,'Sample analysis');return;}
      if(remoteStale(runToken,stage)||!result)return;
      if(result.status==='insufficient'){failed.push({index,result});batch.results.delete(index);}else batch.results.set(index,result);
    }
    if(failed.length){
      const limit=REMOTE_TARGET_ATTEMPTS[stage],exhausted=failed.filter(({index})=>(batch.attempts.get(index)??0)>=limit);
      if(exhausted.length&&stage==='training'){failRemoteCalibration({detail:describeCalibrationTarget(exhausted[0].result)},`Target ${exhausted[0].index+1}`);return;}
      batch.retry=failed.filter(({index})=>(batch.attempts.get(index)??0)<limit).map(({index})=>index);
      for(const {index,result} of exhausted)batch.results.set(index,{...result,status:'invalid'});
      if(batch.retry.length){
        info.textContent=`Not enough usable frames at target ${batch.retry.map(index=>index+1).join(', ')} (${describeCalibrationTarget(failed[0].result)}). Collecting only these targets again.`;
        showTarget(batch.retry[0]);setTimeout(()=>{if(!remoteStale(runToken,stage))info.textContent=`Collecting target ${batch.retry.map(index=>index+1).join(', ')} again · eyes open, look at the target and press Enter or Space`;},2500);
        return;
      }
    }
    await completeRemotePhase(runToken,stage);
  }
  async function remoteCalibrationStep(runToken){
    const stage=calibrationStage,isTrain=stage==='training',phaseName=isTrain?'train':'validate',info=$('#calibrationInfo'),batch=remoteBatch;
    if(!batch)return;
    if(performance.now()-calibrationTargetShownAt<500){info.textContent='After the target appears, look at it for at least 0.5 s, then press Enter or Space.';return;}
    const retrying=batch.retry.length>0,index=retrying?batch.retry[0]:sequence,target=points(!isTrain)[index];
    info.textContent=`Target ${index+1}/27 · keep looking (collecting frames)`;
    let frames;
    try{frames=await controller.captureCalibrationFrames();}
    catch(error){if(remoteStale(runToken,stage))return;info.textContent=`Frame collection failed (${remoteReason(error)}) · press Enter or Space again.`;return;}
    if(remoteStale(runToken,stage))return;
    batch.captures.set(index,{target,frames});batch.attempts.set(index,(batch.attempts.get(index)??0)+1);
    const preflight=isTrain&&index===0&&!retrying&&!batch.results.has(0);
    if(retrying||preflight){
      info.textContent=preflight?'Checking the first target · confirming face and eye detection on the GPU':`Analyzing target ${index+1}/27`;
      let result;try{result=await uploadRemoteTarget(index,phaseName,runToken,stage);}catch(error){if(remoteStale(runToken,stage))return;failRemoteCalibration(error,'Sample analysis');return;}
      if(remoteStale(runToken,stage)||!result)return;
      if(result.status==='insufficient'){
        const limit=REMOTE_TARGET_ATTEMPTS[stage],attempts=batch.attempts.get(index)??0;
        if(attempts>=limit){
          if(isTrain){failRemoteCalibration({detail:describeCalibrationTarget(result)},`Target ${index+1}`);return;}
          batch.results.set(index,{...result,status:'invalid'});batch.retry.shift();
        }else{info.textContent=`Target ${index+1}/27 unusable: ${describeCalibrationTarget(result)} · eyes open, look at the target and press Enter or Space again (${attempts}/${limit}).`;return;}
      }else{batch.results.set(index,result);if(retrying)batch.retry.shift();}
      if(preflight){info.textContent=`First target checked · ${describeCalibrationTarget(result)}. The other targets are analyzed together after all are collected.`;sequence=1;setTimeout(()=>{if(!remoteStale(runToken,stage)&&sequence===1&&!batch.retry.length)showTarget(1);},1200);return;}
      if(batch.retry.length){showTarget(batch.retry[0]);return;}
      await completeRemotePhase(runToken,stage);return;
    }
    sequence++;
    if(sequence<27){showTarget(sequence);return;}
    await uploadRemoteBatch(runToken,stage);
  }
  async function finishCalibrationValidation(){
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
        let reach=null;try{reach=calibrationReach(candidate,validation,validationScreen);}catch{}
        const bp=value=>Number.isFinite(value)?Math.max(-100000,Math.min(100000,Math.round(value*10000))):null;
        logCalibrationStage('calibration_verdict',{count:validation.length,verdict:{passed,validCount:metrics.validCount,attempts:metrics.attempts,...(Number.isFinite(metrics.p95)?{p95Bp:Math.min(100000,Math.round(metrics.p95*10000))}:{}),...(Number.isFinite(metrics.p50)?{p50Bp:Math.min(100000,Math.round(metrics.p50*10000))}:{}),...Object.fromEntries(Object.entries({gainXBp:bp(reach?.gainX),gainYBp:bp(reach?.gainY),biasXBp:bp(reach?.biasX),biasYBp:bp(reach?.biasY)}).filter(([,value])=>value!==null))}});
        if(pilot)pilot.calibration={...pilot.calibration,...metrics,landmarkResidual:residualSummary,passed,status:commitFailed?'failed':'completed',...(commitFailed?{failureReason:'calibration_commit_failed'}:{}),trainingAttempts:training.length,validationAttempts:validation.length,screenSize:{...screenSize},completedAtUtc:new Date().toISOString(),environmentChanged:false,method:residualSelected?'WebEyeTrack.adapt+landmark-residual-candidate':'WebEyeTrack.adapt',persistence:controller.remote?'local_model_adapter':'local_adaptation_replay'};
        if(passed){activeAffine=affineSelection?.selected?affineModel:null;activeLandmarkResidual=!activeAffine&&residualSelected?residualModel:null;activeCalibration={calibration:pilot.calibration,environment:gazeEnvironment(pilot.cameraSettings),environmentChanged:false};}
        else {
          const previousCalibration=activeCalibration?.calibration;
          candidate=null;restorePreviousCalibration();
          if(previousCalibration&&pilot)pilot.calibration.lastRecalibration={passed:false,...metrics,completedAtUtc:new Date().toISOString()};
          else if(pilot)pilot.calibration={...pilot.calibration,...metrics,landmarkResidual:residualSummary,passed:false,status:commitFailed?'failed':'completed',...(commitFailed?{failureReason:'calibration_commit_failed'}:{}),method:'WebEyeTrack.adapt',persistence:controller.remote?'local_model_adapter':'local_adaptation_replay'};
          stopRemote();$('#worldGazeState').textContent=activeCalibration?'Keeping the earlier adaptation for this session · accuracy not guaranteed':'Calibration failed · gaze analysis on hold';
          // The verdict text lives in a hidden element, so state the outcome and the numbers where the user can see them.
          const pct=value=>`${(value*100).toFixed(1)}%`,measured=`Valid ${pct(metrics.validRate)} (80% or more) · p95 ${metrics.p95===null?'Not available':pct(metrics.p95)} (5% or less of the screen diagonal)${reach&&Number.isFinite(reach.gainX)&&Number.isFinite(reach.gainY)?` · gaze reach horizontal ${Math.round(reach.gainX*100)}% vertical ${Math.round(reach.gainY*100)}% (100% = reaches the targets) · bias horizontal ${(reach.biasX*100).toFixed(1)}% vertical ${(reach.biasY*100).toFixed(1)}% (+ is right / down)`:''}`;
          gazeStatus.textContent=commitFailed?'Calibration could not be committed · no server adapter received · gaze analysis on hold':`${activeCalibration?'New calibration did not pass · earlier calibration kept':'Calibration check did not pass · gaze analysis on hold'} · ${measured}`;
        }
        calibrationRunStart=null;
        let remoteAdapterSaved=false;if(passed&&controller.remote&&committedAdapter){const profileSaveStartedAt=performance.now();logCalibrationStage('profile_save_start');try{const store=await profileStorage;if(!store)throw Error('storage_unavailable');remoteCalibrationProfile={version:1,createdAtUtc:new Date().toISOString(),adapter:committedAdapter,calibration:pilot.calibration,environment:gazeEnvironment(pilot.cameraSettings)};await store.setItem(remoteGazeAdapterKey,remoteCalibrationProfile);remoteAdapterSaved=true;logCalibrationStage('profile_save_complete',{startedAt:profileSaveStartedAt});recordingStatus.textContent='The remote GPU calibration adapter was saved on this device.';}catch{remoteCalibrationProfile=null;logCalibrationStage('profile_save_error',{startedAt:profileSaveStartedAt});recordingStatus.textContent='The GPU calibration passed for this session but could not be saved on this device.';}}else if(passed&&capturedAdaptation){const profileSaveStartedAt=performance.now();logCalibrationStage('profile_save_start');try{const store=await profileStorage;if(!store)throw Error('storage_unavailable');const profile=await createGazeCalibrationProfileAsync({adaptationSamples:capturedAdaptation,calibration:pilot.calibration,environment:gazeEnvironment(pilot.cameraSettings),runtime:profileRuntime,landmarkResidual:activeLandmarkResidual,affine:affineSelection?{model:affineModel,selection:affineSelection}:null},{batchSize:3,onProgress:count=>{$('#calibrationInfo').textContent=`Calibration passed · preparing the local replay profile ${count}/27`;}});if(!await saveGazeCalibrationProfile(store,profile))throw Error('profile_write_failed');logCalibrationStage('profile_save_complete',{startedAt:profileSaveStartedAt});recordingStatus.textContent='Calibration saved';}catch{logCalibrationStage('profile_save_error',{startedAt:profileSaveStartedAt});recordingStatus.textContent='Calibration save failed · used for this session only';}}capturedAdaptation=null;
        const metricsSummary=`Baseline WebEyeTrack separate check ${passed?'Passed':'Failed'}: valid ${(metrics.validRate*100).toFixed(1)}%, p95 ${metrics.p95===null?'None':(metrics.p95*100).toFixed(2)+'%'} (of the screen diagonal). Real-world performance is not guaranteed.`;
        const residualMessage=residualSelected?`Landmark residual candidate: fitted on 18, p95 on the 9 repeated selection samples at the same 3×3 positions ${(baselineHoldout.p95*100).toFixed(2)}% → ${(residualHoldout.p95*100).toFixed(2)}%. Not a generalization check.`:residualModel?'The landmark residual candidate was not applied: it failed the criteria on the 9 repeated selection samples at the same 3×3 positions.':'The landmark residual candidate was not applied: feature samples were missing or degenerate.';
        message.textContent=passed?controller.remote?`${metricsSummary} GPU calibration adapter: ${remoteAdapterSaved?'Saved on this device.':'Applied to this session only.'} Raw frames and calibration samples are not saved.`:`${metricsSummary} ${residualMessage} The saved calibration is reapplied at the next start in the same environment. Check the record status to see whether saving succeeded.`:activeCalibration?`${metricsSummary} Keeping the earlier adaptation for this session.`:metricsSummary;
        showCalibrationStatus(passed?(residualSelected?'WebEyeTrack calibration passed · MediaPipe residual candidate based only on 9 repeated selection samples at the same 3×3 positions · not a generalization check · session memory only':'WebEyeTrack calibration passed · landmark residual candidate not applied · session memory only · recalibrate after stopping the camera or reloading'):(activeCalibration?'New calibration failed · keeping the earlier adaptation for this session · accuracy not guaranteed':'Calibration failed · no automatic recalibration · retry with the button'));
        training=[];validation=[];candidate=null;calibrationStage=null;$('#calibration').hidden=true;calibrate.focus();
        if(passed){gazeStatus.textContent='WebEyeTrack calibration passed · gaze analysis ready · real-world accuracy not guaranteed';$('#worldGazeState').textContent='Waiting for a gaze point · accuracy not guaranteed';$('#gazeSamDemoStatus').textContent=$('#localConsent').checked?'WebEyeTrack adaptation passed · reusing the local profile · accuracy and time alignment not verified':'Calibration passed · waiting for auto exploration consent';startRemote();startBackgroundAttention();}
        else $('#gazeSamDemoStatus').textContent='WebEyeTrack independent check failed · scene-only SAM continues and gaze SAM is on hold. Calibrate again.';
        updateFrozenGazeControls();return;
  }
  $('#target').addEventListener('keydown',event=>{if(controller?.remote&&event.repeat&&(event.key==='Enter'||event.key===' '))event.preventDefault();});
  $('#target').addEventListener('click',async()=>{
    const runToken=calibrationRunToken;
    if(!calibrationStage||calibrationStage==='loading'||$('#target').dataset.pending==='true')return;
    $('#target').dataset.pending='true';
    try{
      if(screenSize.width!==innerWidth||screenSize.height!==innerHeight){handleCalibrationEnvironmentChange('Screen size');return;}
      if(controller.remote){await remoteCalibrationStep(runToken);return;}
      const target=points(calibrationStage==='validation')[sequence], now=performance.now();
      if(now-calibrationTargetShownAt<500){$('#calibrationInfo').textContent='After the target changes, look at it for at least 0.5 s, then click or press Enter / Space again.';return;}
      const sampleAgeLimitMs=calibrationSampleFreshnessMs(calibrationWindow),sampleStatus=calibrationSampleStatus(latest,{targetShownAt:calibrationTargetShownAt,now,maxAgeMs:sampleAgeLimitMs}),fresh=sampleStatus==='ready';
      const stabilityStatus=calibrationWindowStatus(calibrationWindow,{targetShownAt:calibrationTargetShownAt,now});
      if(calibrationStage==='validation'&&!stableCalibrationWindow(calibrationWindow,{targetShownAt:calibrationTargetShownAt,now})){const waitText={settling:'Look at the target for at least 0.5 s after it appears',no_post_dwell_samples:'Waiting for check samples after the fixation wait',insufficient_recent_samples:'Collecting recent check samples',gaze_unstable:'Gaze samples are unsteady. Keep looking at the target'}[stabilityStatus]??'Waiting for check samples';$('#calibrationInfo').textContent=waitText;return;}
      if(calibrationStage==='training'){
        if(!fresh){const waitText={no_open_eye_sample:`No open-eye sample · ${describeOpenEyeWait(latest)}`,missing_sample_timestamp:'Waiting for a WebEyeTrack sample timestamp',no_post_dwell_sample:'Waiting for samples taken after 0.5 s on the target',stale_sample:'Waiting for a recent open-eye sample',future_sample:'Checking the WebEyeTrack sample timestamp'}[sampleStatus]??'Waiting for an open-eye sample';$('#calibrationInfo').textContent=waitText;return;}
        const finalTrainingTarget=sequence===26;
        if(finalTrainingTarget){calibrationAdaptStartedAt=performance.now();calibrationAdaptStarted=false;calibrationAdaptFinished=false;calibrationSerializeStartedAt=null;calibrationSerializeFinished=false;$('#calibrationInfo').textContent='27/27 samples collected · waiting for WebEyeTrack adaptation';}
        try{const response=await controller.calibrate(target,calibrationTargetShownAt+500,sampleAgeLimitMs);if(runToken!==calibrationRunToken||calibrationStage!=='training')return;if(response.adaptationSamples)capturedAdaptation=response.adaptationSamples;}catch(error){
          if(runToken!==calibrationRunToken||calibrationStage!=='training')return;
          if(finalTrainingTarget){if(!calibrationAdaptStarted){logCalibrationStage('calibration_adapt_start');calibrationAdaptStarted=true;}if(!calibrationAdaptFinished)logCalibrationStage('calibration_adapt_error',{startedAt:calibrationAdaptStartedAt});calibrationAdaptFinished=true;}
          calibrationStage=null;candidate=null;training=[];validation=[];controller.cancelCalibration();restorePreviousCalibration();if(pilot?.calibration?.passed)pilot.calibration.lastRecalibrationStatus='failed';else if(pilot)pilot.calibration={...pilot.calibration,passed:false,status:'failed'};$('#calibration').hidden=true;message.textContent=`WebEyeTrack adaptation failed: ${error.message}`;showCalibrationStatus(activeCalibration?'Recalibration failed · keeping the earlier adaptation for this session':'Calibration failed · retry with the button');calibrate.focus();updateFrozenGazeControls();return;
        }
        training.push({id:`train-${sequence}`,target});
      } else {
        if(!fresh){const waitText={no_open_eye_sample:`No open-eye sample · ${describeOpenEyeWait(latest)}`,missing_sample_timestamp:'Waiting for a WebEyeTrack sample timestamp',no_post_dwell_sample:'Waiting for check samples after the fixation wait',stale_sample:'Waiting for a recent open-eye check sample',future_sample:'Checking the WebEyeTrack sample timestamp'}[sampleStatus]??'Waiting for an open-eye check sample';$('#calibrationInfo').textContent=waitText;return;}
        validation.push({id:`validate-${sequence}`,features:latest.features,landmarkFeatures:latest.landmarkFeatures,target});
      }
      if(pilot?.calibration)pilot.calibration.attempts.push({phase:calibrationStage,index:sequence,target:{...target},sampleAvailable:true,atUtc:new Date().toISOString()});
      sequence++;
      if(sequence===27&&calibrationStage==='training'){
        candidate=metricModel();calibrationStage='validation';sequence=0;showCalibrationStatus('27 WebEyeTrack adapt() calls done · separate 27-point sample · residual candidate split 18/9');
      } else if(sequence===27){
        await finishCalibrationValidation();return;
      }
      showTarget();
    }finally{if(runToken===calibrationRunToken)delete $('#target').dataset.pending;}
  });
  void ensureProvisionalTracking().catch(()=>{});
  $('#runtimeStatus').textContent='Waiting for camera consent · Spark needs its own consent';
}
if(typeof document!=='undefined') boot().catch(()=>{const text='App failed to start · please reload the page';for(const selector of ['#message','#gazeStatus','#provisionalSparkStatus']){const el=document.querySelector(selector);if(el)el.textContent=text;}});
