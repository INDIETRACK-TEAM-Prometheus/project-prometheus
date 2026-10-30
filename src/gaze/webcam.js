import {eyeCrop, predictCalibration, withinCalibrationBounds} from './index.js';
import {ClockDriftMonitor} from '../runtime/clock.js';

// Unvalidated fallback cutoffs; each eye learns its open baseline from landmarks.
const BLINK_SCORE_MARGIN = .15;
const MIN_EYE_APERTURE_RATIO = .025;
const EYE_CLOSURE_RATIO = .5;

function apertureRatio(landmarks, upperIndices, lowerIndices, a, b) {
  const mean = indices => {
    const points=indices.map(i=>landmarks?.[i]).filter(p=>Number.isFinite(p?.x)&&Number.isFinite(p?.y)&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1);
    return points.length ? {x:points.reduce((sum,p)=>sum+p.x,0)/points.length,y:points.reduce((sum,p)=>sum+p.y,0)/points.length} : null;
  };
  const upper=mean(upperIndices),lower=mean(lowerIndices),dx=b.x-a.x,dy=b.y-a.y,span=Math.hypot(dx,dy);
  if(!upper||!lower||span===0)return null;
  return Math.abs((upper.x-lower.x)*(-dy/span)+(upper.y-lower.y)*(dx/span))/span;
}

function createBlinkState() { return {openAperture:null,openScore:null,upperLidBaseline:null}; }

function assessBlink(state, score, aperture, fallbackThreshold) {
  if(Number.isFinite(aperture)&&aperture>=MIN_EYE_APERTURE_RATIO) {
    if(state.openAperture===null||aperture>state.openAperture) {
      state.openAperture=aperture;
      state.openScore=score;
    } else if(aperture>=state.openAperture*.75&&score!==null) {
      state.openScore=state.openScore===null?score:Math.min(state.openScore,score);
    }
  }
  const threshold=state.openScore===null?fallbackThreshold:Math.min(1,Math.max(fallbackThreshold,state.openScore+BLINK_SCORE_MARGIN));
  const geometryClosed=Number.isFinite(aperture)&&(aperture<MIN_EYE_APERTURE_RATIO||(state.openAperture!==null&&aperture<state.openAperture*EYE_CLOSURE_RATIO));
  return {threshold,apertureBaseline:state.openAperture,closed:geometryClosed||(score!==null&&score>=threshold)};
}

// All dependency/model loading is deferred until start. The integrator supplies
// local or explicitly approved URLs and the import function; no default CDN.
export function createWebcamGazeController({video, mediaDevices, loadVision, wasmRoot, modelAssetPath, onSample = () => {}, onError = () => {}, blinkThreshold = .5}) {
  if (!video || !mediaDevices?.getUserMedia || typeof loadVision !== 'function' || !wasmRoot || !modelAssetPath) throw new Error('video, mediaDevices, loader, wasmRoot and modelAssetPath required');
  if (!Number.isFinite(blinkThreshold) || blinkThreshold < 0 || blinkThreshold > 1) throw new Error('blink threshold must be between 0 and 1');
  let stream = null, landmarker = null, running = false, generation = 0, callbackId = null, model = null, timing = null, clockMonitor = null, lastTime = -1, lastTimestamp = -1, starting = false;
  let blinkStates={left:createBlinkState(),right:createBlinkState()};
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
        const score = name => { const value=shape.find(s => s.categoryName === name)?.score; return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null; };
        const width = video.videoWidth, height = video.videoHeight;
        const pixel = i => { const p = landmarks?.[i]; return p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 ? {x:p.x*width,y:p.y*height} : null; };
        function eye(corners, iris, upperLid, lowerLid, blinkName, state) {
          const blinkScore=score(blinkName),a=pixel(corners[0]),b=pixel(corners[1]);
          if(!a||!b)return {valid:false,reason:'landmarks_unavailable',confidence:null,blinkScore};
          const metadata=[...corners,...iris].map(i=>landmarks?.[i]);
          if(metadata.some(p=>['visibility','presence'].some(k=>p?.[k]!=null&&(!Number.isFinite(p[k])||p[k]<0||p[k]>1))))return {valid:false,reason:'landmark_quality_invalid',confidence:null,blinkScore};
          const quality=p=>{
            // Optional quality fields may arrive as zero when the provider omits them.
            const values=['visibility','presence'].map(k=>p?.[k]).filter(v=>Number.isFinite(v)&&v>0);
            return values.length?Math.min(...values):null;
          };
          const cornerQuality=corners.map(i=>quality(landmarks?.[i]));
          if(cornerQuality.some(q=>q!==null&&q<.5))return {valid:false,reason:'landmark_visibility_low',confidence:null,blinkScore};
          const irisPoints=iris.map(i=>({point:pixel(i),quality:quality(landmarks?.[i])}));
          const usable=irisPoints.filter(item=>item.point&&(item.quality===null||item.quality>=.5)).map(item=>item.point);
          if(usable.length<3)return {valid:false,reason:irisPoints.some(item=>item.quality!==null&&item.quality<.5)?'landmark_visibility_low':'landmarks_unavailable',confidence:null,blinkScore};
          const eyeSpan=Math.hypot(b.x-a.x,b.y-a.y),irisSpan=Math.max(...usable.flatMap((p,i)=>usable.slice(i+1).map(q=>Math.hypot(p.x-q.x,p.y-q.y))));
          if(eyeSpan<4||irisSpan<1)return {valid:false,reason:'landmarks_degenerate',confidence:null,blinkScore};
          const aperture=apertureRatio(landmarks,upperLid,lowerLid,{x:a.x/width,y:a.y/height},{x:b.x/width,y:b.y/height});
          if(aperture===null)return {valid:false,reason:'blink_geometry_unavailable',confidence:null,blinkScore};
          const blink=assessBlink(state,blinkScore,aperture,blinkThreshold);
          if(blinkScore===null||blink.closed)return {valid:false,reason:blinkScore===null?'blink_unknown':'blink',confidence:null,blinkScore,blinkScoreThreshold:blink.threshold,apertureRatio:aperture,apertureBaseline:blink.apertureBaseline,irisLandmarkCount:usable.length};
          const center = {x:usable.reduce((n,p)=>n+p.x,0)/usable.length, y:usable.reduce((n,p)=>n+p.y,0)/usable.length};
          const crop = eyeCrop(a,b,{x:0,y:0,width,height});
          const upperPoints=upperLid.map(pixel).filter(Boolean);
          const upperCenter=upperPoints.length?{x:upperPoints.reduce((n,p)=>n+p.x,0)/upperPoints.length,y:upperPoints.reduce((n,p)=>n+p.y,0)/upperPoints.length}:null;
          // Use image y so the cue has the same sign for both eye-corner orders.
          const upperLidY=upperCenter?(upperCenter.y-(a.y+b.y)/2)/eyeSpan:null;
          let upperLidDeltaY=null;
          if(upperLidY!==null&&crop){
            if(state.upperLidBaseline===null)state.upperLidBaseline=upperLidY;
            upperLidDeltaY=upperLidY-state.upperLidBaseline;
          }
          return {valid:!!crop,reason:crop?null:'crop_unavailable',confidence:null,blinkScore,blinkScoreThreshold:blink.threshold,apertureRatio:aperture,apertureBaseline:blink.apertureBaseline,irisLandmarkCount:usable.length,corners:[a,b],iris:center,upperLidDeltaY,crop};
        }
        const leftEye = eye([263,362],[474,475,476,477],[385,386],[373,374],'eyeBlinkLeft',blinkStates.left);
        const rightEye = eye([33,133],[469,470,471,472],[158,159],[144,145],'eyeBlinkRight',blinkStates.right);
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
        lastTime = -1; lastTimestamp = -1; blinkStates={left:createBlinkState(),right:createBlinkState()};clockMonitor?.reset(); running = true; schedule(token);
        const settings = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
        return {width:settings.width ?? null,height:settings.height ?? null,frameRate:settings.frameRate ?? null,deviceId:settings.deviceId ?? null};
      } catch (error) { if (token === generation) { running = false; dispose(); } throw error; }
      finally { if (token === generation) starting = false; }
    },
    setCalibration(calibration) { if (calibration && calibration.dimension !== 4) throw new Error('four-feature calibration required'); model = calibration; },
    setTimingCalibration(calibration) { if(calibration && (calibration.status!=='measurement_record_validated' || !calibration.cameraClockModel || !calibration.displayModels)) throw new Error('validated optical timing calibration required');timing=calibration;clockMonitor=calibration?new ClockDriftMonitor(calibration.cameraClockModel,calibration.cameraCallbackLagMs):null; },
    stop() { generation++; starting = false; running = false; model = null; timing=null;clockMonitor=null;blinkStates={left:createBlinkState(),right:createBlinkState()};dispose(); }
  };
}
