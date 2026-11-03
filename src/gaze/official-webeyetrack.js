// The official WebEyeTrack pipeline as its demo app uses it (js/examples/demo-app/src/App.tsx): the package's own
// WebcamClient, WebEyeTrack tracker, model and click calibration, gaze at (normPog + 0.5) x window size. WebEyeTrackProxy and
// its worker are mirrored message for message only so the tracker can keep more than its default 5 calibration points.

const finite = Number.isFinite;
// Clicks on controls are not gaze points. The package fits an unconstrained affine to its kept click points once it has
// more than 3, so a cluster of button/checkbox clicks throws the gaze to the screen corners.
export const NON_GAZE_CLICK_TARGETS = 'button,input,select,textarea,label,a,summary,details,[role="button"],[contenteditable]';
const startupError = code => Object.assign(new Error(code), {code});

let packageLoad = null;
function loadPackage(src) {
  if (globalThis.WebEyeTrackProxy && globalThis.WebcamClient) return Promise.resolve();
  packageLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => globalThis.WebEyeTrackProxy && globalThis.WebcamClient ? resolve() : reject(startupError('webeyetrack_package_missing'));
    script.onerror = () => { packageLoad = null; reject(startupError('webeyetrack_package_unavailable')); };
    document.head.append(script);
  });
  return packageLoad;
}

export function officialSample(result, {frameId, receivedAt, viewport}) {
  const norm = Array.isArray(result?.normPog) && result.normPog.length === 2 && result.normPog.every(finite) ? [result.normPog[0], result.normPog[1]] : null;
  const gazeOpen = result?.gazeState === 'open';
  const faceDetected = !!result && !!norm;
  const usable = faceDetected && gazeOpen && viewport?.width > 0 && viewport?.height > 0;
  const features = usable ? [Math.min(1, Math.max(0, norm[0] + .5)), Math.min(1, Math.max(0, norm[1] + .5))] : null;
  const rawScreenXY = features ? {x:Math.min(1 - Number.EPSILON, features[0]) * viewport.width, y:Math.min(1 - Number.EPSILON, features[1]) * viewport.height} : null;
  return {
    frameId, timestampMs:receivedAt, captureSourceMs:receivedAt, callbackTimestampMs:receivedAt, timestampKind:'callback_time_not_capture',
    sourceClockId:null, syncOffsetMs:null, syncDriftPpm:null, syncUncertaintyMs:null, syncStatus:'unmeasured',
    timingUnavailableReason:'optical_reference_measurement_required', scenePresentTsEstimateMs:null, displayUncertaintyMs:null,
    sceneAssociationEligible:false, processedMs:receivedAt, ingestTsMs:receivedAt, inferenceMs:null,
    faceDetected, gazeState:result?.gazeState ?? 'unknown',
    leftEye:{valid:usable, reason:!faceDetected ? 'face_not_detected' : gazeOpen ? null : 'eyes_closed', confidence:null, crop:null},
    rightEye:{valid:usable, reason:!faceDetected ? 'face_not_detected' : gazeOpen ? null : 'eyes_closed', confidence:null, crop:null},
    features, landmarkFeatures:null, normPog:norm, rawScreenXY,
    valid:!!rawScreenXY,
    invalidReason:!faceDetected ? 'face_not_detected' : !gazeOpen ? 'eyes_closed' : !rawScreenXY ? 'gaze_unavailable' : null,
    width:null, height:null, modelDurations:result?.durations ?? null
  };
}

// Calibration points the tracker keeps (the package default is 5).
export const OFFICIAL_MAX_POINTS = 25;

export function createOfficialWebEyeTrackController({video, onSample = () => {}, onDiagnostic = () => {}, getViewport = () => ({width:innerWidth, height:innerHeight}),
  packageSrc = '/vendor/webeyetrack.js', workerUrl = '/src/gaze/official-webeyetrack-worker.js', maxPoints = OFFICIAL_MAX_POINTS, clockNow = () => performance.now()} = {}) {
  if (!video?.id) throw new Error('video element with an id required');
  let worker = null, client = null, workerStatus = 'idle', running = false, paused = false, frameId = 0, clicks = 0, generation = 0;
  const diagnose = code => { try { onDiagnostic(code); } catch {} };
  // WebEyeTrackProxy's page-click listener, minus clicks on controls (they are not gaze points).
  const onPageClick = event => {
    if (!running || paused || !worker || event.target?.closest?.(NON_GAZE_CLICK_TARGETS)) return;
    worker.postMessage({type:'click', payload:{x:event.clientX / innerWidth - .5, y:event.clientY / innerHeight - .5}});
  };

  return {
    official:true,
    // The official demo has no calibration gate: the base model runs at once and clicks refine it.
    get calibrated() { return running; },
    get clickCount() { return clicks; },
    async start({userInitiated = false, cameraConsent = false} = {}) {
      if (!userInitiated || !cameraConsent) throw new Error('explicit start and camera consent required');
      if (running) throw new Error('already started');
      const token = ++generation;
      await loadPackage(packageSrc);
      client = new globalThis.WebcamClient(video.id);
      worker = new Worker(workerUrl);
      workerStatus = 'idle';
      // Same message flow as WebEyeTrackProxy: start the webcam once the worker is ready, send a frame whenever it is idle.
      worker.onmessage = message => {
        if (token !== generation) return;
        const data = message.data ?? {};
        if (data.type === 'ready') {
          client.startWebcam((frame, timestamp) => { if (workerStatus === 'idle' && !paused && token === generation) worker?.postMessage({type:'step', payload:{frame, timestamp}}); });
        } else if (data.type === 'stepResult') {
          if (!running || paused) return;
          const sample = officialSample(data.result, {frameId:++frameId, receivedAt:clockNow(), viewport:getViewport()});
          try { onSample(sample); } catch {}
        } else if (data.type === 'statusUpdate') {
          workerStatus = data.status;
        }
      };
      worker.postMessage({type:'init', payload:{maxPoints}});
      addEventListener('click', onPageClick);
      running = true; paused = false; diagnose('official_webeyetrack_started');
      // WebcamClient opens the camera itself once the worker is ready (as in the demo); wait for the stream.
      for (let i = 0; i < 300 && token === generation && !video.srcObject; i++) await new Promise(resolve => setTimeout(resolve, 100));
      if (token !== generation) throw startupError('camera_request_aborted');
      if (!video.srcObject) { this.stop(); throw startupError('camera_request_failed'); }
      const settings = video.srcObject.getVideoTracks?.()[0]?.getSettings?.() ?? {};
      return {width:settings.width ?? null, height:settings.height ?? null, frameRate:settings.frameRate ?? null};
    },
    // The page-click listener above sends the point; this only counts it for the status line.
    click(point, target) { if (!running || target?.closest?.(NON_GAZE_CLICK_TARGETS)) return false; clicks++; return true; },
    pause() { if (running) paused = true; },
    resume() { if (running) paused = false; },
    telemetry() { return null; },
    setTimingCalibration() {},
    cancelCalibration() {},
    stop() {
      generation++; running = false; paused = false;
      removeEventListener('click', onPageClick);
      try { client?.stopWebcam(); } catch {}
      try { worker?.terminate(); } catch {}
      try { video.srcObject = null; } catch {}
      worker = null; client = null; diagnose('camera_stopped');
    }
  };
}
