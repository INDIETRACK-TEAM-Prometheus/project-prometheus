import {ClockDriftMonitor} from '../runtime/clock.js';

const finite = Number.isFinite;
const cameraStartupCodes = {
  NotAllowedError:'camera_permission_denied',
  NotFoundError:'camera_device_missing',
  NotReadableError:'camera_device_unavailable',
  OverconstrainedError:'camera_constraints_unsatisfied',
  SecurityError:'camera_security_context',
  AbortError:'camera_request_aborted'
};
const startupError = code => Object.assign(new Error('WebEyeTrack startup failed'),{code});
const cameraError = error => startupError(cameraStartupCodes[error?.name]??'camera_request_failed');

// The page owns the only webcam stream. WebEyeTrack receives copied frame
// pixels in a worker and never opens its own WebcamClient/getUserMedia stream.
export function createWebcamGazeController({
  video,
  mediaDevices,
  onSample = () => {},
  onEyePreview = () => {},
  onError = () => {},
  onDiagnostic = () => {},
  workerFactory = (url, options) => new Worker(url, options),
  workerReadyTimeoutMs = 10000,
  createCanvas = () => document.createElement('canvas'),
  clockNow = () => performance.now(),
  getViewport = () => ({width:innerWidth,height:innerHeight})
}) {
  if (!video || !mediaDevices?.getUserMedia) throw new Error('video and mediaDevices required');

  let stream = null, running = false, starting = false, generation = 0, callbackId = null;
  let activeWorker = null, candidateWorker = null, timing = null, clockMonitor = null;
  let lastTime = -1, lastTimestamp = -1, requestNumber = 0, frameNumber = 0, captureCanvas = null;

  function diagnose(code) { try { onDiagnostic(code); } catch {} }

  function selectedWorker() { return candidateWorker ?? activeWorker; }

  function terminateRecord(record, reason = 'WebEyeTrack worker stopped') {
    if (!record) return;
    if (!record.ready) record.rejectReady(new Error(reason));
    record.worker.terminate();
    for (const pending of record.pending.values()) pending.reject(new Error(reason));
    record.pending.clear();
    record.busy = false;
  }

  function createRecord(calibrated = false) {
    let worker;
    try { worker = workerFactory('/src/gaze/webeyetrack-worker.js', {name:'prometheus-webeyetrack'}); }
    catch { diagnose('worker_load_failed'); throw startupError('worker_load_failed'); }
    const record = {worker, calibrated, ready:false, busy:false, pending:new Map(), latestSample:null, fatal:false};
    diagnose('worker_created');
    let readyTimeout;
    const ready = new Promise((resolve, reject) => {
      record.resolveReady = () => { clearTimeout(readyTimeout); resolve(); };
      record.rejectReady = error => { clearTimeout(readyTimeout); reject(error); };
      readyTimeout = setTimeout(() => {
        diagnose('worker_initialization_timeout');
        record.rejectReady(startupError('worker_initialization_timeout'));
      }, workerReadyTimeoutMs);
    });
    worker.onmessage = event => {
      const message = event.data;
      if (message?.type === 'ready') {
        record.ready = true;
        diagnose('worker_ready');
        record.resolveReady();
        return;
      }
      if (message?.type === 'result') {
        record.busy = false;
        const previewBitmaps=message.previewBitmaps??{};
        try {
        if (!running || selectedWorker() !== record) return;
        const receivedAt = clockNow();
        const sourceTimestamp = message.captureTimestampMs;
        const hasCaptureTime = message.timestampKind === 'browser_capture_estimate';
        const alignment = hasCaptureTime && clockMonitor ? clockMonitor.observe(sourceTimestamp, receivedAt) : null;
        if (sourceTimestamp <= lastTimestamp && alignment?.reason !== 'clock_jump_detected') return;
        if (sourceTimestamp > lastTimestamp) lastTimestamp = sourceTimestamp;
        const timestamp = alignment?.status === 'ok' ? alignment.sessionMs : sourceTimestamp;
        const faceDetected = message.faceDetected === true;
        const norm = message.normPog;
        const validNorm = Array.isArray(norm) && norm.length === 2 && norm.every(finite) && norm.every(value => value >= -.5 && value <= .5);
        const landmarkFeatures = Array.isArray(message.landmarkFeatures) && message.landmarkFeatures.length === 3 && message.landmarkFeatures.every(value => finite(value) && Math.abs(value) <= 1) ? [...message.landmarkFeatures] : null;
        const gazeOpen = message.gazeState === 'open';
        const features = faceDetected && gazeOpen && validNorm ? [norm[0] + .5, norm[1] + .5] : null;
        const viewport = getViewport();
        const rawScreenXY = faceDetected && gazeOpen && validNorm && finite(viewport.width) && finite(viewport.height) && viewport.width>0 && viewport.height>0
          ? {x:Math.min(1-Number.EPSILON,Math.max(0,norm[0]+.5))*viewport.width,y:Math.min(1-Number.EPSILON,Math.max(0,norm[1]+.5))*viewport.height}
          : null;
        const calibrated = record.calibrated && faceDetected && gazeOpen && !!features && !!rawScreenXY;
        const processedMs = receivedAt;
        const sample = {
          frameId:message.frameId,
          timestampMs:timestamp,
          captureSourceMs:sourceTimestamp,
          callbackTimestampMs:message.callbackTimestampMs,
          timestampKind:message.timestampKind,
          sourceClockId:hasCaptureTime?'browser_video_capture_estimate':null,
          syncOffsetMs:timing?timing.cameraClockModel.sessionAnchorMs-timing.cameraClockModel.sourceAnchorMs:null,
          syncDriftPpm:timing?.cameraClockModel.driftPpm??null,
          syncUncertaintyMs:alignment?.status==='ok'?alignment.uncertaintyMs:null,
          syncStatus:alignment?.status==='ok'?'measured_active':alignment?.reason??'unmeasured',
          timingUnavailableReason:alignment?.status==='ok'?null:timing?'clock_alignment_withheld':'optical_reference_measurement_required',
          scenePresentTsEstimateMs:null,
          displayUncertaintyMs:null,
          sceneAssociationEligible:calibrated && alignment?.status==='ok',
          processedMs,
          ingestTsMs:processedMs,
          inferenceMs:Math.max(0,receivedAt-message.sentAtMs),
          faceDetected,
          gazeState:message.gazeState,
          leftEye:{valid:faceDetected&&gazeOpen,reason:!faceDetected?'face_not_detected':gazeOpen?null:'eyes_closed',confidence:null,crop:message.eyeCrops?.left??null},
          rightEye:{valid:faceDetected&&gazeOpen,reason:!faceDetected?'face_not_detected':gazeOpen?null:'eyes_closed',confidence:null,crop:message.eyeCrops?.right??null},
          features,
          landmarkFeatures,
          normPog:validNorm?[...norm]:null,
          rawScreenXY,
          valid:calibrated,
          invalidReason:!faceDetected?'face_not_detected':!gazeOpen?'eyes_closed':!validNorm?'gaze_unavailable':!record.calibrated?'calibration_required':null,
          width:message.width,
          height:message.height,
          modelDurations:message.durations
        };
        record.latestSample = sample;
        try { onEyePreview({frameId:message.frameId,faceDetected,eyeCrops:message.eyeCrops??{},bitmaps:previewBitmaps}); } catch {}
        try { onSample(sample); } catch {
          const error=startupError('sample_handler_failed');
          diagnose(error.code);
          onError(error);
        }
        } finally {
          for(const bitmap of Object.values(previewBitmaps))try{bitmap?.close?.();}catch{}
        }
        return;
      }
      if (message?.type === 'adapted' || message?.type === 'adaptError') {
        const pending = record.pending.get(message.requestId);
        if (!pending) return;
        record.pending.delete(message.requestId);
        if (message.type === 'adapted') pending.resolve({adapted:true,points:message.points});
        else {
          diagnose('worker_adaptation_failed');
          pending.reject(startupError('worker_adaptation_failed'));
        }
        return;
      }
      if (message?.type === 'error') {
        const error = startupError(record.ready?'worker_inference_failed':'worker_initialization_failed');
        diagnose(error.code);
        if (!record.ready) record.rejectReady(error);
        if (message.requestId && record.pending.has(message.requestId)) {
          const pending = record.pending.get(message.requestId);
          record.pending.delete(message.requestId);
          pending.reject(error);
        }
        if (message.fatal) {
          record.fatal = true;
          record.busy = false;
          if (record.ready && running && selectedWorker() === record) onError(error);
        }
      }
    };
    worker.onerror = () => {
      const error = startupError(record.ready?'worker_runtime_failed':'worker_load_failed');
      diagnose(error.code);
      if (!record.ready) record.rejectReady(error);
      if (record.ready && running && selectedWorker() === record) onError(error);
    };
    try { worker.postMessage({type:'init'}); }
    catch { clearTimeout(readyTimeout);worker.terminate();diagnose('worker_load_failed');throw startupError('worker_load_failed'); }
    return {record, ready};
  }

  const stopCamera = () => {
    const hadCameraWork = !!stream || video.srcObject != null || callbackId !== null || running || starting || !!activeWorker || !!candidateWorker;
    if (callbackId !== null && video.cancelVideoFrameCallback) {
      try { video.cancelVideoFrameCallback(callbackId); } catch {}
    }
    callbackId = null;
    const oldStream = stream;
    stream = null;
    try { oldStream?.getTracks().forEach(track => { try { track.stop(); } catch {} }); } catch {}
    try { video.pause?.(); } catch {}
    try { video.srcObject = null; } catch {}
    if (hadCameraWork) diagnose('camera_stopped');
  };

  function sendFrame(record, imageData, metadata, now, sentAtMs) {
    if (!record?.ready || record.busy || record.fatal) return;
    record.busy = true;
    const pixels = imageData.data.slice();
    record.worker.postMessage({
      type:'frame',
      frameId:++frameNumber,
      width:imageData.width,
      height:imageData.height,
      pixels:pixels.buffer,
      captureTimestampMs:finite(metadata.captureTime)?metadata.captureTime:now,
      callbackTimestampMs:now,
      sentAtMs,
      timestampKind:finite(metadata.captureTime)?'browser_capture_estimate':'callback_time_not_capture'
    },[pixels.buffer]);
  }

  function schedule(token) {
    if (running && token === generation) callbackId = video.requestVideoFrameCallback((now, metadata) => processFrame(token, now, metadata));
  }

  function processFrame(token, now, metadata = {}) {
    callbackId = null;
    if (!running || token !== generation) return;
    try {
      if (video.currentTime === lastTime || video.videoWidth < 1 || video.videoHeight < 1) { schedule(token); return; }
      lastTime = video.currentTime;
      const sourceTimestamp = finite(metadata.captureTime)?metadata.captureTime:now;
      if (sourceTimestamp <= lastTimestamp) { schedule(token); return; }
      captureCanvas ??= createCanvas();
      captureCanvas.width = video.videoWidth;
      captureCanvas.height = video.videoHeight;
      const context = captureCanvas.getContext('2d',{willReadFrequently:true});
      if (!context) throw new Error('camera frame canvas unavailable');
      context.drawImage(video,0,0,captureCanvas.width,captureCanvas.height);
      const imageData = context.getImageData(0,0,captureCanvas.width,captureCanvas.height);
      const sentAtMs = clockNow();
      const record = selectedWorker();
      if (record) sendFrame(record,imageData,metadata,now,sentAtMs);
    } catch {
      running = false;
      generation++;
      const safeError = startupError('capture_frame_failed');
      diagnose(safeError.code);
      diagnose('camera_stop_requested');
      stopCamera();
      onError(safeError);
      return;
    }
    schedule(token);
  }

  return {
    async start({userInitiated = false, cameraConsent = false, videoConstraints = true} = {}) {
      if (!userInitiated || !cameraConsent) throw new Error('explicit start and camera consent required');
      if (running || starting) throw new Error('already started or starting');
      if (typeof video.requestVideoFrameCallback !== 'function') {
        diagnose('capture_api_unavailable');
        throw startupError('capture_api_unavailable');
      }
      starting = true;
      const token = ++generation;
      try {
        let cameraRequest;
        diagnose('camera_request_started');
        try { cameraRequest = mediaDevices.getUserMedia({video:videoConstraints,audio:false}); }
        catch (error) { const safeError=cameraError(error);diagnose(safeError.code);throw safeError; }
        const cameraPromise = Promise.resolve(cameraRequest).then(acquired => {
          if (token !== generation) {
            acquired.getTracks().forEach(track=>track.stop());
            throw new Error('start cancelled');
          }
          stream = acquired;
          diagnose('camera_stream_acquired');
          return acquired;
        },error=>{const safeError=cameraError(error);diagnose(safeError.code);throw safeError;});
        cameraPromise.catch(()=>{});
        const created = createRecord(false);
        activeWorker = created.record;
        await Promise.all([cameraPromise,created.ready]);
        if (token !== generation) throw new Error('start cancelled');
        try { video.srcObject = stream; }
        catch { diagnose('video_attachment_failed');throw startupError('video_attachment_failed'); }
        diagnose('video_attached');
        try { await video.play(); }
        catch { diagnose('video_playback_failed');throw startupError('video_playback_failed'); }
        diagnose('video_playback_started');
        if (token !== generation) throw new Error('start cancelled');
        lastTime = -1;
        lastTimestamp = -1;
        clockMonitor?.reset();
        running = true;
        schedule(token);
        diagnose('capture_started');
        const settings = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
        return {width:settings.width??null,height:settings.height??null,frameRate:settings.frameRate??null};
      } catch (error) {
        if (token === generation) {
          running = false;
          starting = false;
          generation++;
          diagnose('camera_stop_requested');
          stopCamera();
          terminateRecord(candidateWorker,error.message);
          terminateRecord(activeWorker,error.message);
          candidateWorker = null;
          activeWorker = null;
        }
        throw error;
      } finally {
        if (token === generation) starting = false;
      }
    },
    async beginCalibration() {
      if (!running || starting || candidateWorker) throw new Error('calibration unavailable');
      const created = createRecord(false);
      candidateWorker = created.record;
      try {
        await created.ready;
        if (!running || candidateWorker !== created.record) throw new Error('calibration cancelled');
      } catch (error) {
        if (candidateWorker === created.record) candidateWorker = null;
        terminateRecord(created.record,error.message);
        throw error;
      }
    },
    async calibrate(target, notBeforeTimestampMs = -Infinity) {
      const record = candidateWorker;
      const sample = record?.latestSample;
      if (notBeforeTimestampMs !== -Infinity && !finite(notBeforeTimestampMs)) throw new Error('invalid calibration timestamp');
      const sampleAgeMs = sample?.callbackTimestampMs===undefined ? Infinity : clockNow()-sample.callbackTimestampMs;
      if (!record || !running || !Number.isSafeInteger(sample?.frameId) || !sample?.faceDetected || sample.gazeState !== 'open' || !sample.features || !finite(sample.callbackTimestampMs) || sample.callbackTimestampMs<notBeforeTimestampMs || sampleAgeMs<0 || sampleAgeMs>250) throw new Error('fresh open-eye WebEyeTrack sample required');
      const viewport = getViewport();
      if (!finite(target?.x) || !finite(target?.y) || !finite(viewport?.width) || !finite(viewport?.height) || viewport.width<=0 || viewport.height<=0) throw new Error('invalid calibration target');
      const requestId = `adapt-${++requestNumber}`;
      const promise = new Promise((resolve,reject)=>record.pending.set(requestId,{resolve,reject}));
      record.worker.postMessage({type:'adapt',requestId,frameId:sample.frameId,target:{x:target.x/viewport.width-.5,y:target.y/viewport.height-.5}});
      return promise;
    },
    commitCalibration() {
      if (!candidateWorker || !running) throw new Error('calibration candidate unavailable');
      const previous = activeWorker;
      candidateWorker.calibrated = true;
      activeWorker = candidateWorker;
      candidateWorker = null;
      if (previous && previous !== activeWorker) terminateRecord(previous);
    },
    cancelCalibration() {
      const candidate = candidateWorker;
      candidateWorker = null;
      terminateRecord(candidate,'calibration cancelled');
    },
    setTimingCalibration(calibration) {
      if (calibration && (calibration.status !== 'measurement_record_validated' || !calibration.cameraClockModel || !calibration.displayModels)) throw new Error('validated optical timing calibration required');
      timing = calibration;
      clockMonitor = calibration ? new ClockDriftMonitor(calibration.cameraClockModel,calibration.cameraCallbackLagMs) : null;
      lastTimestamp = -1;
    },
    stop() {
      generation++;
      starting = false;
      running = false;
      timing = null;
      clockMonitor = null;
      diagnose('camera_stop_requested');
      stopCamera();
      terminateRecord(candidateWorker);
      terminateRecord(activeWorker);
      candidateWorker = null;
      activeWorker = null;
      captureCanvas = null;
    }
  };
}
