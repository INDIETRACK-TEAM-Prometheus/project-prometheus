import {ClockDriftMonitor} from '../runtime/clock.js';

const finite = Number.isFinite;

// The page owns the only webcam stream. WebEyeTrack receives copied frame
// pixels in a worker and never opens its own WebcamClient/getUserMedia stream.
export function createWebcamGazeController({
  video,
  mediaDevices,
  onSample = () => {},
  onError = () => {},
  workerFactory = (url, options) => new Worker(url, options),
  workerReadyTimeoutMs = 10000,
  createCanvas = () => document.createElement('canvas'),
  clockNow = () => performance.now(),
  getViewport = () => ({width:innerWidth,height:innerHeight})
}) {
  if (!video || !mediaDevices?.getUserMedia) throw new Error('video and mediaDevices required');

  let stream = null, running = false, starting = false, generation = 0, callbackId = null;
  let activeWorker = null, candidateWorker = null, timing = null, clockMonitor = null;
  let lastTime = -1, lastTimestamp = -1, requestNumber = 0, captureCanvas = null;

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
    const worker = workerFactory('/src/gaze/webeyetrack-worker.js', {type:'module', name:'prometheus-webeyetrack'});
    const record = {worker, calibrated, ready:false, busy:false, pending:new Map(), latestSample:null, fatal:false};
    const ready = new Promise((resolve, reject) => {
      let timeout;
      record.resolveReady = () => { clearTimeout(timeout); resolve(); };
      record.rejectReady = error => { clearTimeout(timeout); reject(error); };
      timeout = setTimeout(() => record.rejectReady(new Error('WebEyeTrack worker initialization timed out')), workerReadyTimeoutMs);
    });
    worker.onmessage = event => {
      const message = event.data;
      if (message?.type === 'ready') {
        record.ready = true;
        record.resolveReady();
        return;
      }
      if (message?.type === 'result') {
        record.busy = false;
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
        const gazeOpen = message.gazeState === 'open';
        const features = faceDetected && gazeOpen && validNorm ? [norm[0] + .5, norm[1] + .5] : null;
        const viewport = getViewport();
        const rawScreenXY = faceDetected && gazeOpen && validNorm && finite(viewport.width) && finite(viewport.height) && viewport.width>0 && viewport.height>0
          ? {x:Math.min(1-Number.EPSILON,Math.max(0,norm[0]+.5))*viewport.width,y:Math.min(1-Number.EPSILON,Math.max(0,norm[1]+.5))*viewport.height}
          : null;
        const calibrated = record.calibrated && faceDetected && gazeOpen && !!features && !!rawScreenXY;
        const processedMs = receivedAt;
        const sample = {
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
          normPog:validNorm?[...norm]:null,
          rawScreenXY,
          valid:calibrated,
          invalidReason:!faceDetected?'face_not_detected':!gazeOpen?'eyes_closed':!validNorm?'gaze_unavailable':!record.calibrated?'calibration_required':null,
          width:message.width,
          height:message.height,
          modelDurations:message.durations
        };
        record.latestSample = sample;
        try { onSample(sample); } catch (error) { onError(error); }
        return;
      }
      if (message?.type === 'adapted' || message?.type === 'adaptError') {
        const pending = record.pending.get(message.requestId);
        if (!pending) return;
        record.pending.delete(message.requestId);
        if (message.type === 'adapted') pending.resolve({adapted:true,points:message.points});
        else pending.reject(new Error(message.error || 'WebEyeTrack adaptation failed'));
        return;
      }
      if (message?.type === 'error') {
        const error = new Error(message.error || 'WebEyeTrack worker failed');
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
    worker.onerror = event => {
      const error = new Error(event.message || 'WebEyeTrack worker could not start');
      if (!record.ready) record.rejectReady(error);
      if (record.ready && running && selectedWorker() === record) onError(error);
    };
    worker.postMessage({type:'init'});
    return {record, ready};
  }

  const stopCamera = () => {
    if (callbackId !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(callbackId);
    callbackId = null;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.pause?.();
    video.srcObject = null;
  };

  function sendFrame(record, imageData, metadata, now, sentAtMs) {
    if (!record?.ready || record.busy || record.fatal) return;
    record.busy = true;
    const pixels = imageData.data.slice();
    record.worker.postMessage({
      type:'frame',
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
      const records = new Set([activeWorker,candidateWorker].filter(Boolean));
      for (const record of records) sendFrame(record,imageData,metadata,now,sentAtMs);
    } catch (error) {
      running = false;
      generation++;
      stopCamera();
      onError(error);
      return;
    }
    schedule(token);
  }

  return {
    async start({userInitiated = false, cameraConsent = false, videoConstraints = true} = {}) {
      if (!userInitiated || !cameraConsent) throw new Error('explicit start and camera consent required');
      if (running || starting) throw new Error('already started or starting');
      if (typeof video.requestVideoFrameCallback !== 'function') throw new Error('requestVideoFrameCallback unavailable');
      starting = true;
      const token = ++generation;
      try {
        const cameraRequest = mediaDevices.getUserMedia({video:videoConstraints,audio:false});
        const cameraPromise = Promise.resolve(cameraRequest).then(acquired => {
          if (token !== generation) {
            acquired.getTracks().forEach(track=>track.stop());
            throw new Error('start cancelled');
          }
          stream = acquired;
          return acquired;
        });
        cameraPromise.catch(()=>{});
        const created = createRecord(false);
        activeWorker = created.record;
        await Promise.all([cameraPromise,created.ready]);
        if (token !== generation) throw new Error('start cancelled');
        video.srcObject = stream;
        await video.play();
        if (token !== generation) throw new Error('start cancelled');
        lastTime = -1;
        lastTimestamp = -1;
        clockMonitor?.reset();
        running = true;
        schedule(token);
        const settings = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
        return {width:settings.width??null,height:settings.height??null,frameRate:settings.frameRate??null};
      } catch (error) {
        if (token === generation) {
          running = false;
          starting = false;
          generation++;
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
    async calibrate(target) {
      const record = candidateWorker;
      const sample = record?.latestSample;
      if (!record || !running || !sample?.faceDetected || sample.gazeState !== 'open' || !sample.features || clockNow()-sample.processedMs>250) throw new Error('fresh open-eye WebEyeTrack sample required');
      const viewport = getViewport();
      if (!finite(target?.x) || !finite(target?.y) || !finite(viewport?.width) || !finite(viewport?.height) || viewport.width<=0 || viewport.height<=0) throw new Error('invalid calibration target');
      const requestId = `adapt-${++requestNumber}`;
      const promise = new Promise((resolve,reject)=>record.pending.set(requestId,{resolve,reject}));
      record.worker.postMessage({type:'adapt',requestId,target:{x:target.x/viewport.width-.5,y:target.y/viewport.height-.5}});
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
      stopCamera();
      terminateRecord(candidateWorker);
      terminateRecord(activeWorker);
      candidateWorker = null;
      activeWorker = null;
      captureCanvas = null;
    }
  };
}
