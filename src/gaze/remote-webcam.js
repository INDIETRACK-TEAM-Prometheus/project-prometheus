import {createWebcamGazeController} from './webcam.js';
import {MAX_CALIBRATION_SAMPLE_AGE_MS} from './calibration-window.js';
import {ClockDriftMonitor} from '../runtime/clock.js';

const finite = Number.isFinite;
const allowedCodes = new Set(['GAZE_PROVIDER_BUSY','GAZE_REMOTE_NOT_CONFIGURED','GAZE_REMOTE_UNAVAILABLE','GAZE_REMOTE_TIMEOUT','GAZE_SESSION_UNAVAILABLE','GAZE_PROTOCOL_ERROR','GAZE_INVALID_REQUEST','GAZE_CANCELLED','GAZE_ADAPTER_INCOMPATIBLE']);
const adapterShapes = [[518,16],[16],[16,16],[16],[16,2],[2]];
const adapterModelId = 'webeyetrack-blazegaze-mpiifacegaze';
const adapterSourceCommit = '75fbd2f5f784f2eb3a39675a8dcbf1b01c697f1c';
const startupError = code => Object.assign(new Error(code), {code});
const cameraCodes = {NotAllowedError:'camera_permission_denied',NotFoundError:'camera_device_missing',NotReadableError:'camera_device_unavailable',OverconstrainedError:'camera_constraints_unsatisfied',SecurityError:'camera_security_context',AbortError:'camera_request_aborted'};
const cameraError = error => startupError(cameraCodes[error?.name]??'camera_request_failed');

async function readJson(response) {
  let body;
  try { body = await response.json(); } catch { throw startupError('gaze_protocol_error'); }
  if (!response.ok) {
    const code = allowedCodes.has(body?.code) ? body.code : 'GAZE_REMOTE_UNAVAILABLE';
    throw startupError(code.toLowerCase());
  }
  return body;
}

function validNorm(value) {
  return Array.isArray(value) && value.length === 2 && value.every(x => finite(x) && x >= -.5 && x <= .5);
}

export function validateRemoteGazeAdapter(adapter, model = {}) {
  try {
    if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter) || new TextEncoder().encode(JSON.stringify(adapter)).byteLength > 64*1024 ||
        Object.keys(adapter).sort().join(',')!=='adapterId,modelId,modelSha256,schemaVersion,sourceCommit,weights' ||
        adapter.schemaVersion !== 1 || adapter.adapterId !== 'webeyetrack-gaze-mlp-f32-v1' || adapter.modelId !== adapterModelId || adapter.sourceCommit !== adapterSourceCommit ||
        !/^[a-f0-9]{64}$/i.test(adapter.modelSha256 ?? '') || adapter.modelSha256 !== model.sha256 || !Array.isArray(adapter.weights) || adapter.weights.length !== adapterShapes.length) return false;
    return adapter.weights.every((weight,index)=>{
      const shape=adapterShapes[index];
      if(!weight||typeof weight!=='object'||Array.isArray(weight)||Object.keys(weight).sort().join(',')!=='data,dtype,shape'||weight.dtype!=='float32-le'||JSON.stringify(weight.shape)!==JSON.stringify(shape)||typeof weight.data!=='string'||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(weight.data))return false;
      const binary=atob(weight.data),bytes=shape.reduce((size,part)=>size*part,4);
      if(binary.length!==bytes||btoa(binary)!==weight.data)return false;
      const view=new DataView(Uint8Array.from(binary,char=>char.charCodeAt(0)).buffer);
      for(let offset=0;offset<bytes;offset+=4)if(!finite(view.getFloat32(offset,true)))return false;
      return true;
    });
  } catch { return false; }
}

export function createRemoteWebcamGazeController({
  video, mediaDevices, onSample = () => {}, onEyePreview = () => {}, onError = () => {}, onDiagnostic = () => {},
  fetchImpl = fetch, createCanvas = () => document.createElement('canvas'), clockNow = () => performance.now(),
  getViewport = () => ({width: innerWidth, height: innerHeight}), maxFrameHz = 8, maxDimension = 640, jpegQuality = .72, getAdapter = async () => null
}) {
  if (!video || !mediaDevices?.getUserMedia) throw new Error('video and mediaDevices required');
  if (!Number.isFinite(maxFrameHz) || maxFrameHz < 1 || maxFrameHz > 15 || !Number.isInteger(maxDimension) || maxDimension < 64 || maxDimension > 1024 || !finite(jpegQuality) || jpegQuality <= 0 || jpegQuality > 1) throw new TypeError('invalid remote gaze bounds');

  let stream = null, running = false, starting = false, paused = false, generation = 0, callbackId = null;
  let sessionId = null, sessionAbort = null, pendingFrame = null, inFlight = null, captureCanvas = null, candidateDiscard = Promise.resolve();
  let lastSentAt = -Infinity, frameNumber = 0, latestSample = null, calibrated = false, candidate = false, calibrationPointIndex = 0;
  let timing = null, clockMonitor = null, lastTimestamp = -1, modelInfo = null;
  // Bounded per-frame transport timings (A12/G4-D): browser clock only, not optical display time.
  const TELEMETRY_SAMPLES = 256, telemetryRows = [];
  const telemetryCounts = {captured:0, superseded:0, sent:0, received:0, published:0, staleDropped:0, busy:0, failed:0, oversized:0};
  function recordTelemetry(row) { telemetryRows.push(row); if (telemetryRows.length > TELEMETRY_SAMPLES) telemetryRows.shift(); }

  function diagnose(code) { try { onDiagnostic(code); } catch {} }
  function validSessionId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }

  async function jsonRequest(path, options = {}) {
    let response;
    try { response = await fetchImpl(path, {cache:'no-store', ...options}); }
    catch (error) { if (options.signal?.aborted) throw startupError('GAZE_CANCELLED'); throw startupError('GAZE_REMOTE_UNAVAILABLE'); }
    return readJson(response);
  }

  async function checkReady() {
    let health;
    try { health = await jsonRequest('/api/gaze/health'); } catch { throw startupError('gaze_remote_unavailable'); }
    if (health.ready !== true || health.backend !== 'remote_gpu' || health.model?.id!==adapterModelId || health.model?.sourceCommit!==adapterSourceCommit || !/^[a-f0-9]{64}$/i.test(health.model?.sha256??'')) throw startupError('gaze_remote_unavailable');
    modelInfo=health.model;
    return health;
  }

  function stopCamera() {
    const current = stream; stream = null;
    try { video.pause(); } catch {}
    try { video.srcObject = null; } catch {}
    for (const track of current?.getTracks?.() ?? []) try { track.stop(); } catch {}
    diagnose('camera_stopped');
  }

  function schedule(token) {
    if (running && !paused && token === generation) callbackId = video.requestVideoFrameCallback((now, metadata = {}) => processFrame(token, now, metadata));
  }

  function processFrame(token, now, metadata) {
    callbackId = null;
    if (!running || paused || token !== generation) return;
    const captureTime = finite(metadata.captureTime) && metadata.captureTime >= 0 ? metadata.captureTime : now;
    telemetryCounts.captured++; if (pendingFrame) telemetryCounts.superseded++;
    pendingFrame = {captureTimestampMs:captureTime, callbackTimestampMs:now, timestampKind:finite(metadata.captureTime)?'browser_capture_estimate':'callback_time_not_capture'};
    if (!inFlight && now - lastSentAt >= 1000 / maxFrameHz) void sendLatest(token);
    schedule(token);
  }

  function encodeLatest(frame) {
    if (!captureCanvas) captureCanvas = createCanvas();
    const width = Math.max(1, video.videoWidth || stream?.getVideoTracks?.()[0]?.getSettings?.().width || 1);
    const height = Math.max(1, video.videoHeight || stream?.getVideoTracks?.()[0]?.getSettings?.().height || 1);
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const canvas = captureCanvas;
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw startupError('gaze_capture_failed');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(startupError('gaze_encode_failed')), 'image/jpeg', jpegQuality));
  }

  function sampleFrom(result, request, receivedAt, sentAt) {
    const norm = result.normPog;
    const gazeOpen = result.gazeState === 'open';
    const faceDetected = result.faceDetected === true;
    const validPoint = validNorm(norm);
    const viewport = getViewport();
    const features = faceDetected && gazeOpen && validPoint ? [norm[0] + .5, norm[1] + .5] : null;
    const rawScreenXY = features && finite(viewport.width) && finite(viewport.height) && viewport.width > 0 && viewport.height > 0
      ? {x:Math.min(1-Number.EPSILON,Math.max(0,features[0]))*viewport.width,y:Math.min(1-Number.EPSILON,Math.max(0,features[1]))*viewport.height}
      : null;
    const hasCaptureTime=request.timestampKind==='browser_capture_estimate';
    const alignment=hasCaptureTime&&clockMonitor?clockMonitor.observe(result.captureTimestampMs,receivedAt):null;
    if(result.captureTimestampMs<=lastTimestamp&&alignment?.reason!=='clock_jump_detected'){telemetryCounts.staleDropped++;return;}
    if(result.captureTimestampMs>lastTimestamp)lastTimestamp=result.captureTimestampMs;
    const calibratedSample=calibrated&&!!features&&!!rawScreenXY;
    const sample = {
      frameId:result.frameId, timestampMs:alignment?.status==='ok'?alignment.sessionMs:result.captureTimestampMs, captureSourceMs:result.captureTimestampMs,
      callbackTimestampMs:request.callbackTimestampMs, timestampKind:request.timestampKind,
      sourceClockId:hasCaptureTime?'browser_video_capture_estimate':null,
      syncOffsetMs:timing?.cameraClockModel?.sessionAnchorMs-timing?.cameraClockModel?.sourceAnchorMs??null,
      syncDriftPpm:timing?.cameraClockModel?.driftPpm??null, syncUncertaintyMs:null, syncStatus:'unmeasured',
      timingUnavailableReason:alignment?.status==='ok'?null:timing?'clock_alignment_withheld':'optical_reference_measurement_required',
      scenePresentTsEstimateMs:null, displayUncertaintyMs:null, sceneAssociationEligible:calibratedSample&&alignment?.status==='ok',
      processedMs:receivedAt, ingestTsMs:receivedAt, inferenceMs:Math.max(0,receivedAt-sentAt),
      faceDetected, gazeState:result.gazeState,
      leftEye:{valid:faceDetected&&gazeOpen,reason:!faceDetected?'face_not_detected':gazeOpen?null:'eyes_closed',confidence:null,crop:null},
      rightEye:{valid:faceDetected&&gazeOpen,reason:!faceDetected?'face_not_detected':gazeOpen?null:'eyes_closed',confidence:null,crop:null},
      features, landmarkFeatures:null, normPog:validPoint?[...norm]:null, rawScreenXY,
      valid:calibratedSample,
      invalidReason:!faceDetected?'face_not_detected':!gazeOpen?'eyes_closed':!validPoint?'gaze_unavailable':!calibrated?'calibration_required':null,
      width:request.width??result.width??null, height:request.height??result.height??null, modelDurations:result.durations
    };
    sample.syncUncertaintyMs=alignment?.status==='ok'?alignment.uncertaintyMs:null;
    sample.syncStatus=alignment?.status==='ok'?'measured_active':alignment?.reason??'unmeasured';
    latestSample = sample;
    try { onEyePreview({frameId:sample.frameId,faceDetected,eyeCrops:{},bitmaps:{}}); } catch {}
    telemetryCounts.published++;
    try { onSample(sample); } catch { const error=startupError('sample_handler_failed'); diagnose(error.code); onError(error); }
  }

  async function sendLatest(token) {
    if (inFlight || !running || paused || token !== generation || !pendingFrame || !sessionId) return;
    const frame = pendingFrame;
    pendingFrame = null;
    const frameId = ++frameNumber;
    const request = {...frame,frameId};
    const now = clockNow();
    if (now - lastSentAt < 1000 / maxFrameHz) { pendingFrame = frame; return; }
    lastSentAt = now;
    const abort = new AbortController();
    sessionAbort = abort;
    const job = (async () => {
      const encodeStartedAt = clockNow();
      const blob = await encodeLatest(frame);
      if (blob.size > 512 * 1024) { telemetryCounts.oversized++; throw startupError('gaze_frame_too_large'); }
      const bytes = await blob.arrayBuffer();
      const sentAt = clockNow();
      telemetryCounts.sent++;
      request.width=captureCanvas.width;request.height=captureCanvas.height;
      const response = await fetchImpl(`/api/gaze/sessions/${encodeURIComponent(sessionId)}/frame`, {
        method:'POST', headers:{'content-type':'image/jpeg','x-frame-id':String(frameId),'x-capture-timestamp-ms':String(frame.captureTimestampMs)}, body:bytes, signal:abort.signal, cache:'no-store'
      });
      const result = await readJson(response);
      if (result.frameId !== frameId || result.captureTimestampMs !== frame.captureTimestampMs || typeof result.faceDetected !== 'boolean' || !['open','closed','unknown'].includes(result.gazeState) || (result.normPog !== null && !validNorm(result.normPog))) throw startupError('gaze_protocol_error');
      const receivedAt = clockNow();
      telemetryCounts.received++;
      const remoteMs = result.durations && typeof result.durations === 'object' ? Object.values(result.durations).filter(finite).reduce((sum, value) => sum + value, 0) : null;
      recordTelemetry({sentAt, encodeMs:sentAt - encodeStartedAt, roundTripMs:receivedAt - sentAt, remoteModelMs:remoteMs, ageAtSampleMs:receivedAt - frame.callbackTimestampMs, bytes:bytes.byteLength});
      if (running && !paused && token === generation) sampleFrom(result, request, receivedAt, sentAt);
    })();
    inFlight = job;
    try { await job; }
    catch (error) {
      if (running && !paused && token === generation && error?.code !== 'GAZE_CANCELLED') {
        if (error?.code === 'gaze_provider_busy') { telemetryCounts.busy++; diagnose('gaze_provider_busy'); }
        else { telemetryCounts.failed++; const safe=startupError(error?.code==='gaze_frame_too_large'?'gaze_frame_too_large':'gaze_remote_inference_failed');diagnose(safe.code);running=false;generation++;stopCamera();onError(safe); }
      }
    } finally {
      if (sessionAbort === abort) sessionAbort = null;
      if (inFlight === job) inFlight = null;
      if (running && !paused && token === generation && pendingFrame && clockNow()-lastSentAt>=1000/maxFrameHz) void sendLatest(token);
    }
  }

  async function discardCandidate() {
    const id=sessionId;
    if (!candidate || !id) return candidateDiscard;
    candidate=false;calibrationPointIndex=0;
    candidateDiscard=jsonRequest(`/api/gaze/sessions/${encodeURIComponent(id)}/candidate/discard`,{method:'POST'});
    await candidateDiscard;
  }

  async function removeSession(id) {
    if (!id) return;
    try { await fetchImpl(`/api/gaze/sessions/${encodeURIComponent(id)}`,{method:'DELETE',cache:'no-store'}); } catch {}
  }

  return {
    get calibrated(){return calibrated;},
    async start({userInitiated=false,cameraConsent=false,videoConstraints=true}={}) {
      if (!userInitiated || !cameraConsent) throw new Error('explicit start and camera consent required');
      if (running || starting) throw new Error('already started or starting');
      if (typeof video.requestVideoFrameCallback !== 'function') { diagnose('capture_api_unavailable'); throw startupError('capture_api_unavailable'); }
      starting=true;const token=++generation;
      try {
        diagnose('gaze_health_check_started');await checkReady();
        const adapter=await optionsAdapter();
        const viewport=getViewport();
        const created=await jsonRequest('/api/gaze/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({screenPxDimensions:[Math.max(1,Math.round(viewport.width)),Math.max(1,Math.round(viewport.height))],...(adapter?{adapter}:{})})});
        if (!validSessionId(created.sessionId)) throw startupError('gaze_protocol_error');
        if(typeof created.calibrated!=='boolean'||created.calibrated!==!!adapter)throw startupError('gaze_protocol_error');
        calibrated=created.calibrated;
        sessionId=created.sessionId;diagnose('gaze_session_created');
        let cameraRequest;
        diagnose('camera_request_started');
        try { cameraRequest=mediaDevices.getUserMedia({video:videoConstraints,audio:false}); } catch (error) { throw cameraError(error); }
        const acquired=await cameraRequest;
        if(token!==generation){for(const track of acquired.getTracks())track.stop();throw startupError('camera_request_aborted');}
        stream=acquired;diagnose('camera_stream_acquired');
        video.srcObject=stream;diagnose('video_attached');await video.play();diagnose('video_playback_started');
        running=true;paused=false;pendingFrame=null;inFlight=null;lastSentAt=-Infinity;latestSample=null;frameNumber=0;
        schedule(token);diagnose('capture_started');
        const settings=stream.getVideoTracks()[0]?.getSettings?.()??{};
        return {width:settings.width??null,height:settings.height??null,frameRate:settings.frameRate??null};
      } catch(error) {
        if(token===generation){running=false;starting=false;generation++;stopCamera();const id=sessionId;sessionId=null;await removeSession(id);}
        throw error;
      } finally {if(token===generation)starting=false;}
    },
    async beginCalibration() {
      if(!running||starting||candidate)throw new Error('calibration unavailable');
      await candidateDiscard;
      const id=sessionId;
      await jsonRequest(`/api/gaze/sessions/${encodeURIComponent(id)}/candidate/start`,{method:'POST'});
      candidate=true;calibrationPointIndex=0;latestSample=null;return {ready:true};
    },
    async calibrate(target,notBeforeTimestampMs=-Infinity,maxSampleAgeMs=250) {
      const sample=latestSample;
      if(notBeforeTimestampMs!==-Infinity&&!finite(notBeforeTimestampMs))throw new Error('invalid calibration timestamp');
      if(!finite(maxSampleAgeMs)||maxSampleAgeMs<0||maxSampleAgeMs>MAX_CALIBRATION_SAMPLE_AGE_MS)throw new Error('invalid calibration sample age');
      const age=sample?.callbackTimestampMs===undefined?Infinity:clockNow()-sample.callbackTimestampMs;
      if(!candidate||!running||!Number.isSafeInteger(sample?.frameId)||!sample.faceDetected||sample.gazeState!=='open'||!sample.features||!finite(sample.callbackTimestampMs)||sample.callbackTimestampMs<notBeforeTimestampMs||age<0||age>maxSampleAgeMs)throw new Error('fresh open-eye WebEyeTrack sample required');
      const viewport=getViewport();
      if(!finite(target?.x)||!finite(target?.y)||!finite(viewport?.width)||!finite(viewport?.height)||viewport.width<=0||viewport.height<=0)throw new Error('invalid calibration target');
      const pointIndex=calibrationPointIndex;
      if(pointIndex>26)throw new Error('calibration sample limit reached');
      const result=await jsonRequest(`/api/gaze/sessions/${encodeURIComponent(sessionId)}/calibration/sample`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({frameId:sample.frameId,pointIndex,target:[target.x/viewport.width-.5,target.y/viewport.height-.5]})});
      if(result.points!==pointIndex+1||result.adapted!==(pointIndex===26))throw startupError('gaze_protocol_error');
      calibrationPointIndex++;
      return {adapted:result.adapted,points:result.points};
    },
    async restoreCalibration() { throw startupError('remote_calibration_replay_unsupported'); },
    async commitCalibration() {
      if(!candidate||!running||calibrationPointIndex!==27)throw new Error('calibration candidate unavailable');
      const accepted=await jsonRequest(`/api/gaze/sessions/${encodeURIComponent(sessionId)}/candidate/accept`,{method:'POST'});
      if(accepted.status!=='accepted'||accepted.calibrated!==true||!validateRemoteGazeAdapter(accepted.adapter,modelInfo))throw startupError('gaze_protocol_error');
      candidate=false;calibrated=true;calibrationPointIndex=0;return {adapter:accepted.adapter};
    },
    cancelCalibration() { return discardCandidate().catch(()=>{}); },
    setTimingCalibration(value) {
      if(value&&(value.status!=='measurement_record_validated'||!value.cameraClockModel||!value.displayModels))throw new Error('validated optical timing calibration required');
      timing=value;clockMonitor=value?new ClockDriftMonitor(value.cameraClockModel,value.cameraCallbackLagMs):null;lastTimestamp=-1;
    },
    pause() {
      if(!running||paused)return;
      paused=true;pendingFrame=null;
      if(callbackId!==null){try{video.cancelVideoFrameCallback(callbackId);}catch{}callbackId=null;}
      sessionAbort?.abort();diagnose('remote_gaze_paused');
    },
    resume() { if(!running||!paused)return;paused=false;pendingFrame=null;schedule(generation);diagnose('remote_gaze_resumed'); },
    telemetry() {
      const pick = key => telemetryRows.map(row => row[key]).filter(finite).sort((a, b) => a - b);
      const stats = key => { const v = pick(key); return v.length ? {n:v.length, p50:v[Math.ceil(.5 * v.length) - 1], p95:v[Math.ceil(.95 * v.length) - 1], max:v[v.length - 1]} : {n:0, p50:null, p95:null, max:null}; };
      const span = telemetryRows.length > 1 ? telemetryRows.at(-1).sentAt - telemetryRows[0].sentAt : 0;
      return {kind:'remote_gaze_transport', clock:'browser_performance_now', windowSamples:telemetryRows.length, maxWindowSamples:TELEMETRY_SAMPLES, counts:{...telemetryCounts},
        effectiveResultHz:span > 0 ? (telemetryRows.length - 1) / (span / 1000) : null,
        encodeMs:stats('encodeMs'), roundTripMs:stats('roundTripMs'), remoteModelMs:stats('remoteModelMs'), ageAtSampleMs:stats('ageAtSampleMs'), bytes:stats('bytes'),
        note:'ageAtSampleMs runs from the video frame callback to the result arriving in the page; display presentation time is not measured'};
    },
    async stop() {
      generation++;starting=false;running=false;paused=false;pendingFrame=null;
      if(callbackId!==null){try{video.cancelVideoFrameCallback(callbackId);}catch{}callbackId=null;}
      diagnose('camera_stop_requested');sessionAbort?.abort();stopCamera();
      const pending=inFlight;if(pending)await pending.catch(()=>{});inFlight=null;sessionAbort=null;
      const id=sessionId;sessionId=null;candidate=false;calibrated=false;latestSample=null;captureCanvas=null;timing=null;clockMonitor=null;lastTimestamp=-1;modelInfo=null;
      await removeSession(id);
    }
  };

  async function optionsAdapter(){
    if(typeof getAdapter!=='function')return null;
    const stored=await getAdapter();
    const adapter=stored?.adapter??stored??null;
    if(adapter&&!validateRemoteGazeAdapter(adapter,modelInfo))throw startupError('gaze_adapter_incompatible');
    return adapter;
  }
}

export function createProfiledWebcamGazeController(options) {
  let controller=null, remote=false, timing=null, selecting=null, generation=0;
  async function selectController() {
    if(controller)return controller;
    if(selecting)return selecting;
    selecting=(async()=>{
      let response,config;
      try{response=await (options.fetchImpl??fetch)('/api/runtime/config',{cache:'no-store'});if(!response.ok)throw new Error();config=await response.json();}catch{throw startupError('runtime_config_unavailable');}
      if(config?.computeProfile==='cloud'&&config?.gazeBackend==='remote_gpu'){remote=true;controller=createRemoteWebcamGazeController(options);}
      else if(config?.computeProfile==='local'&&config?.gazeBackend==='browser_local'){remote=false;controller=createWebcamGazeController(options);}
      else throw startupError('runtime_config_invalid');
      if(timing)controller.setTimingCalibration(timing);
      return controller;
    })().finally(()=>{selecting=null;});
    return selecting;
  }
  return {
    get remote(){return remote;},
    get calibrated(){return Boolean(controller?.calibrated);},
    async start(options){const token=++generation;const selected=await selectController();if(token!==generation)throw startupError('camera_request_aborted');return selected.start(options);},
    stop(){generation++;return controller?.stop();},
    telemetry(){return typeof controller?.telemetry==='function'?controller.telemetry():null;},
    pause(){return controller?.pause?.();},
    resume(){return controller?.resume?.();},
    beginCalibration(...args){return selectController().then(c=>c.beginCalibration(...args));},
    calibrate(...args){return selectController().then(c=>c.calibrate(...args));},
    restoreCalibration(...args){return selectController().then(c=>c.restoreCalibration(...args));},
    commitCalibration(...args){return selectController().then(c=>c.commitCalibration(...args));},
    cancelCalibration(...args){return controller?.cancelCalibration?.(...args);},
    setTimingCalibration(value){timing=value;return controller?.setTimingCalibration(value);}
  };
}
