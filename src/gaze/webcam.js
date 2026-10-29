import {eyeCrop, predictCalibration, withinCalibrationBounds} from './index.js';
import {ClockDriftMonitor} from '../runtime/clock.js';

// All dependency/model loading is deferred until start. The integrator supplies
// local or explicitly approved URLs and the import function; no default CDN.
export function createWebcamGazeController({video, mediaDevices, loadVision, wasmRoot, modelAssetPath, onSample = () => {}, onError = () => {}, blinkThreshold = .5}) {
  if (!video || !mediaDevices?.getUserMedia || typeof loadVision !== 'function' || !wasmRoot || !modelAssetPath) throw new Error('video, mediaDevices, loader, wasmRoot and modelAssetPath required');
  let stream = null, landmarker = null, running = false, generation = 0, callbackId = null, model = null, timing = null, clockMonitor = null, lastTime = -1, lastTimestamp = -1, starting = false;
  const dispose = () => { if (callbackId !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(callbackId); callbackId = null; stream?.getTracks().forEach(t => t.stop()); stream = null; landmarker?.close(); landmarker = null; video.srcObject = null; };
  const schedule = token => { if (running && token === generation) callbackId = video.requestVideoFrameCallback((now, metadata) => processFrame(token, now, metadata)); };
  function processFrame(token, now, metadata = {}) {
    callbackId = null;
    if (!running || token !== generation) return;
    try {
      if (video.currentTime !== lastTime && video.videoWidth > 0 && video.videoHeight > 0) {
        lastTime = video.currentTime;
        // Browser captureTime, when available, is an estimate in the performance clock domain.
        const hasCaptureTime=Number.isFinite(metadata.captureTime), sourceTimestamp = hasCaptureTime ? metadata.captureTime : now;
        const alignment=hasCaptureTime && clockMonitor ? clockMonitor.observe(sourceTimestamp,now) : null;
        if (sourceTimestamp <= lastTimestamp && alignment?.reason!=='clock_jump_detected') { schedule(token); return; }
        if(sourceTimestamp>lastTimestamp)lastTimestamp = sourceTimestamp;
        const timestamp=alignment?.status==='ok'?alignment.sessionMs:sourceTimestamp;
        const inferenceStart=performance.now();
        const result = landmarker.detectForVideo(video, timestamp);
        const inferenceMs=performance.now()-inferenceStart;
        const landmarks = result.faceLandmarks?.[0];
        const shape = result.faceBlendshapes?.[0]?.categories ?? [];
        const score = name => shape.find(s => s.categoryName === name)?.score ?? null;
        const width = video.videoWidth, height = video.videoHeight;
        const pixel = i => { const p = landmarks?.[i]; return p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 ? {x:p.x*width,y:p.y*height} : null; };
        function eye(corners, iris, blinkName) {
          const a = pixel(corners[0]), b = pixel(corners[1]), points = iris.map(pixel), blinkScore = score(blinkName);
          if (!a || !b || points.some(p => !p) || Math.hypot(b.x-a.x,b.y-a.y) < 1) return {valid:false, reason:'landmarks_unavailable', confidence:null, blinkScore};
          const center = {x:points.reduce((n,p)=>n+p.x,0)/points.length, y:points.reduce((n,p)=>n+p.y,0)/points.length};
          const crop = eyeCrop(a,b,{x:0,y:0,width,height});
          return {valid:!!crop && blinkScore !== null && blinkScore < blinkThreshold, reason:blinkScore === null ? 'blink_unknown' : blinkScore >= blinkThreshold ? 'blink' : crop ? null : 'crop_unavailable', confidence:null, blinkScore, corners:[a,b], iris:center, crop};
        }
        const leftEye = eye([263,362],[474,475,476,477],'eyeBlinkLeft');
        const rightEye = eye([33,133],[469,470,471,472],'eyeBlinkRight');
        const feature = e => { const [a,b]=e.corners; const d=Math.hypot(b.x-a.x,b.y-a.y); return [(e.iris.x-(a.x+b.x)/2)/d,(e.iris.y-(a.y+b.y)/2)/d]; };
        const valid = !!landmarks && leftEye.valid && rightEye.valid;
        const features = valid ? [...feature(leftEye),...feature(rightEye)] : null;
        const inBounds = valid && model && withinCalibrationBounds(model,features);
        const rawScreenXY = inBounds ? predictCalibration(model,features) : null;
        const processedMs=performance.now();
        onSample({timestampMs:timestamp,captureSourceMs:sourceTimestamp,callbackTimestampMs:now,timestampKind:hasCaptureTime ? 'browser_capture_estimate' : 'callback_time_not_capture',sourceClockId:hasCaptureTime ? 'browser_video_capture_estimate' : null,syncOffsetMs:timing?timing.cameraClockModel.sessionAnchorMs-timing.cameraClockModel.sourceAnchorMs:null,syncDriftPpm:timing?.cameraClockModel.driftPpm??null,syncUncertaintyMs:alignment?.status==='ok'?alignment.uncertaintyMs:null,syncStatus:alignment?.status==='ok'?'measured_active':alignment?.reason??'unmeasured',timingUnavailableReason:alignment?.status==='ok'?null:timing?'clock_alignment_withheld':'optical_reference_measurement_required',scenePresentTsEstimateMs:null,displayUncertaintyMs:null,sceneAssociationEligible:alignment?.status==='ok',processedMs,ingestTsMs:performance.now(),inferenceMs,faceDetected:!!landmarks,leftEye,rightEye,features,rawScreenXY,valid:!!rawScreenXY,invalidReason:!landmarks ? 'face_not_detected' : !valid ? 'eye_invalid' : !model ? 'calibration_required' : !inBounds ? 'outside_calibration_bounds' : null,width,height});
      }
      schedule(token);
    } catch (error) { running = false; generation++; dispose(); onError(error); }
  }
  return {
    async start({userInitiated = false, cameraConsent = false, videoConstraints = true} = {}) {
      if (!userInitiated || !cameraConsent) throw new Error('explicit start and camera consent required');
      if (running || starting) throw new Error('already started or starting');
      if (typeof video.requestVideoFrameCallback !== 'function') throw new Error('requestVideoFrameCallback unavailable');
      starting = true; const token = ++generation;
      try {
        const vision = await loadVision();
        if (token !== generation) return;
        const files = await vision.FilesetResolver.forVisionTasks(wasmRoot);
        if (token !== generation) return;
        const detector = await vision.FaceLandmarker.createFromOptions(files, {baseOptions:{modelAssetPath},runningMode:'VIDEO',numFaces:1,outputFaceBlendshapes:true});
        if (token !== generation) { detector.close(); return; }
        landmarker = detector;
        const acquired = await mediaDevices.getUserMedia({video:videoConstraints,audio:false});
        if (token !== generation) { acquired.getTracks().forEach(t=>t.stop()); return; }
        stream = acquired; video.srcObject = stream; await video.play();
        if (token !== generation) return;
        lastTime = -1; lastTimestamp = -1; clockMonitor?.reset(); running = true; schedule(token);
        const settings = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
        return {width:settings.width ?? null,height:settings.height ?? null,frameRate:settings.frameRate ?? null,deviceId:settings.deviceId ?? null};
      } catch (error) { if (token === generation) { running = false; dispose(); } throw error; }
      finally { if (token === generation) starting = false; }
    },
    setCalibration(calibration) { if (calibration && calibration.dimension !== 4) throw new Error('four-feature calibration required'); model = calibration; },
    setTimingCalibration(calibration) { if(calibration && (calibration.status!=='measurement_record_validated' || !calibration.cameraClockModel || !calibration.displayModels)) throw new Error('validated optical timing calibration required');timing=calibration;clockMonitor=calibration?new ClockDriftMonitor(calibration.cameraClockModel,calibration.cameraCallbackLagMs):null; },
    stop() { generation++; starting = false; running = false; model = null; timing=null;clockMonitor=null;dispose(); }
  };
}
