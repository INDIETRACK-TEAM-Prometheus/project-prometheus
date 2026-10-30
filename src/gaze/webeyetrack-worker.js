let tracker = null;
let adaptedPoints = 0;
let eyeCrop;

function fail(code, step, requestId) {
  self.postMessage({type:'error',fatal:true,code,step,...(requestId?{requestId}:{})});
}

async function initialize() {
  importScripts('/vendor/webeyetrack.js');
  const [{eyeCrop:cropEye}, {initializeWebEyeTrack}, vision] = await Promise.all([
    import('/src/gaze/index.js'),
    import('/src/gaze/webeyetrack-bootstrap.js'),
    import('/vendor/vision_bundle.mjs')
  ]);
  eyeCrop = cropEye;
  tracker = await initializeWebEyeTrack({
    WebEyeTrack:self.WebEyeTrack,
    FaceLandmarkerClient:self.FaceLandmarkerClient,
    vision,
    wasmRoot:'/vendor',
    modelAssetPath:'/vendor/face_landmarker.task',
    maxPoints:27
  });
  self.postMessage({type:'ready'});
}

async function processFrame(message) {
  const frame = new ImageData(new Uint8ClampedArray(message.pixels),message.width,message.height);
  const result = await tracker.step(frame,message.captureTimestampMs);
  const points = result?.facialLandmarks;
  const pixel = index => {
    const point = points?.[index];
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x>=0 && point.x<=1 && point.y>=0 && point.y<=1
      ? {x:point.x*message.width,y:point.y*message.height}
      : null;
  };
  const leftA=pixel(263),leftB=pixel(362),rightA=pixel(33),rightB=pixel(133);
  const cropFrame={x:0,y:0,width:message.width,height:message.height};
  const eyeCrops={
    left:leftA&&leftB?eyeCrop(leftA,leftB,cropFrame):null,
    right:rightA&&rightB?eyeCrop(rightA,rightB,cropFrame):null
  };
  self.postMessage({
    type:'result',
    faceDetected:Array.isArray(result?.facialLandmarks)&&result.facialLandmarks.length>0,
    gazeState:result?.gazeState??'unknown',
    normPog:Array.isArray(result?.normPog)?result.normPog:null,
    eyeCrops,
    durations:result?.durations??null,
    width:message.width,
    height:message.height,
    captureTimestampMs:message.captureTimestampMs,
    callbackTimestampMs:message.callbackTimestampMs,
    timestampKind:message.timestampKind,
    sentAtMs:message.sentAtMs
  });
}

self.onmessage = event => {
  const message = event.data;
  if (message?.type === 'init') {
    initialize().catch(()=>fail('worker_initialization_failed','worker_initialization'));
    return;
  }
  if (!tracker?.loaded) {
    fail('worker_initialization_failed','worker_initialization',message?.requestId);
    return;
  }
  if (message?.type === 'frame') {
    processFrame(message).catch(()=>fail('worker_inference_failed','worker_inference'));
    return;
  }
  if (message?.type === 'adapt') {
    try {
      const result = tracker.latestGazeResult;
      if (!result || result.gazeState !== 'open' || !result.eyePatch || !Array.isArray(result.headVector) || !Array.isArray(result.faceOrigin3D)) throw new Error('fresh open-eye WebEyeTrack result required');
      tracker.adapt([result.eyePatch],[result.headVector],[result.faceOrigin3D],[[message.target.x,message.target.y]]);
      adaptedPoints++;
      self.postMessage({type:'adapted',requestId:message.requestId,points:adaptedPoints});
    } catch (error) {
      self.postMessage({type:'adaptError',requestId:message.requestId,code:'worker_adaptation_failed',step:'worker_adaptation'});
    }
  }
};
