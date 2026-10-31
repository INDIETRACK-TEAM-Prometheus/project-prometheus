let tracker = null;
let eyeCrop;
let eyePreviewCrop;
let landmarkGazeFeatures;
let addCalibrationSample;
let handleAdaptation;
let retainCalibrationResult;
let takeCalibrationResult;
let calibrationPoints;
const calibrationResults = new Map();
const eyePreviewSize = {width:320,height:260};
const eyeLandmarkIndices = {
  left:{eye:[263,249,390,373,374,380,381,382,362,398,384,385,386,387,388,466],upperLid:[385,386,387],irisCenter:473,irisRing:[474,475,476,477],eyebrow:[[276,283,282,295,285],[300,293,334,296,336]]},
  right:{eye:[33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246],upperLid:[158,159,160],irisCenter:468,irisRing:[469,470,471,472],eyebrow:[[46,53,52,65,55],[70,63,105,66,107]]}
};
let previewFrameCanvas = null;
let previewFrameContext = null;
const eyePreviewCanvases = {left:null,right:null};

function fail(code, step, requestId) {
  self.postMessage({type:'error',fatal:true,code,step,...(requestId?{requestId}:{})});
}

async function initialize() {
  importScripts('/vendor/webeyetrack.js');
  const [{eyeCrop:cropEye,eyePreviewCrop:expandEyePreviewCrop,landmarkGazeFeatures:deriveLandmarkGazeFeatures}, {initializeWebEyeTrack}, adaptation, vision] = await Promise.all([
    import('/src/gaze/index.js'),
    import('/src/gaze/webeyetrack-bootstrap.js'),
    import('/src/gaze/webeyetrack-adaptation.js'),
    import('/vendor/vision_bundle.mjs')
  ]);
  eyeCrop = cropEye;
  eyePreviewCrop = expandEyePreviewCrop;
  landmarkGazeFeatures = deriveLandmarkGazeFeatures;
  calibrationPoints = adaptation.WEBEYETRACK_CALIBRATION_POINTS;
  handleAdaptation = adaptation.handleWebEyeTrackAdaptation;
  retainCalibrationResult = adaptation.retainWebEyeTrackCalibrationResult;
  takeCalibrationResult = adaptation.takeWebEyeTrackCalibrationResult;
  tracker = await initializeWebEyeTrack({
    WebEyeTrack:self.WebEyeTrack,
    FaceLandmarkerClient:self.FaceLandmarkerClient,
    vision,
    wasmRoot:'/vendor',
    modelAssetPath:'/vendor/face_landmarker.task',
    maxPoints:calibrationPoints
  });
  addCalibrationSample = adaptation.createWebEyeTrackCalibrationAdapter(tracker,calibrationPoints);
  self.postMessage({type:'ready'});
}

function previewPoint(points,index,width,height,crop) {
  const point=points?.[index], quality=point && ['visibility','presence'].every(key=>point[key]===undefined||(Number.isFinite(point[key])&&point[key]>=.5&&point[key]<=1));
  if(!quality||!Number.isFinite(point.x)||!Number.isFinite(point.y)||point.x<0||point.x>1||point.y<0||point.y>1)return null;
  const x=(point.x*width-crop.x)/crop.width,y=(point.y*height-crop.y)/crop.height;
  return x>=0&&x<=1&&y>=0&&y<=1?{x:x*eyePreviewSize.width,y:y*eyePreviewSize.height}:null;
}

function drawLandmarkDot(context,point,color,radius) {
  if(!point)return;
  context.beginPath();context.arc(point.x,point.y,radius,0,Math.PI*2);context.fillStyle=color;context.fill();
}

function drawLandmarkPath(context,indices,points,width,height,crop,color,{close=false,radius=2.6,lineWidth=2}={}) {
  const path=indices.map(index=>previewPoint(points,index,width,height,crop));
  context.beginPath();let first=null,previous=null;
  for(const point of path){
    if(!point){previous=null;continue;}
    if(!first)first=point;
    if(previous){context.moveTo(previous.x,previous.y);context.lineTo(point.x,point.y);}
    previous=point;
  }
  if(close&&first&&previous&&path.every(Boolean)){context.moveTo(previous.x,previous.y);context.lineTo(first.x,first.y);}
  context.strokeStyle=color;context.lineWidth=lineWidth;context.stroke();
  for(const point of path)drawLandmarkDot(context,point,color,radius);
}

function preparePreviewFrame(frame) {
  if(typeof OffscreenCanvas!=='function')return false;
  try {
    if(!previewFrameCanvas||previewFrameCanvas.width!==frame.width||previewFrameCanvas.height!==frame.height){
      previewFrameCanvas=new OffscreenCanvas(frame.width,frame.height);
      previewFrameContext=previewFrameCanvas.getContext('2d');
    }
    if(!previewFrameContext)return false;
    previewFrameContext.putImageData(frame,0,0);
    return true;
  } catch { return false; }
}

function renderEyePreview(crop,points,side,width,height) {
  if(!crop||!previewFrameCanvas||!previewFrameContext)return null;
  try {
    let preview=eyePreviewCanvases[side];
    if(!preview){const canvas=new OffscreenCanvas(eyePreviewSize.width,eyePreviewSize.height);preview={canvas,context:canvas.getContext('2d')};eyePreviewCanvases[side]=preview;}
    const {canvas,context}=preview;
    if(!context)return null;
    context.clearRect(0,0,eyePreviewSize.width,eyePreviewSize.height);
    context.save();context.translate(eyePreviewSize.width,0);context.scale(-1,1);
    context.drawImage(previewFrameCanvas,crop.x,crop.y,crop.width,crop.height,0,0,eyePreviewSize.width,eyePreviewSize.height);
    const indices=eyeLandmarkIndices[side];
    drawLandmarkPath(context,indices.eye,points,width,height,crop,'#55e6d1',{close:true,radius:2.5,lineWidth:1.5});
    drawLandmarkPath(context,indices.upperLid,points,width,height,crop,'#ffe08a',{radius:3.5,lineWidth:2.5});
    for(const chain of indices.eyebrow)drawLandmarkPath(context,chain,points,width,height,crop,'#ff9c82',{radius:3,lineWidth:2});
    drawLandmarkPath(context,indices.irisRing,points,width,height,crop,'#c6a3ff',{close:true,radius:3,lineWidth:2});
    drawLandmarkDot(context,previewPoint(points,indices.irisCenter,width,height,crop),'#c6a3ff',4);
    context.restore();
    return canvas.transferToImageBitmap();
  } catch { return null; }
}

function postFrameResult(result,previewBitmaps) {
  const transfer=Object.values(previewBitmaps).filter(Boolean);
  if(transfer.length){
    try { self.postMessage({...result,previewBitmaps},transfer); return; }
    catch { for(const bitmap of transfer)try{bitmap.close?.();}catch{} }
  }
  self.postMessage({...result,previewBitmaps:{left:null,right:null}});
}

async function processFrame(message) {
  const frame = new ImageData(new Uint8ClampedArray(message.pixels),message.width,message.height);
  const result = await tracker.step(frame,message.captureTimestampMs);
  retainCalibrationResult(calibrationResults,message.frameId,result);
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
    left:leftA&&leftB?eyePreviewCrop(eyeCrop(leftA,leftB,cropFrame),cropFrame,Math.hypot(leftB.x-leftA.x,leftB.y-leftA.y)):null,
    right:rightA&&rightB?eyePreviewCrop(eyeCrop(rightA,rightB,cropFrame),cropFrame,Math.hypot(rightB.x-rightA.x,rightB.y-rightA.y)):null
  };
  const gazeFeatures=landmarkGazeFeatures(points,message.width,message.height);
  const canRenderPreview=preparePreviewFrame(frame);
  const previewBitmaps={
    left:canRenderPreview?renderEyePreview(eyeCrops.left,points,'left',message.width,message.height):null,
    right:canRenderPreview?renderEyePreview(eyeCrops.right,points,'right',message.width,message.height):null
  };
  postFrameResult({
    type:'result',
    faceDetected:Array.isArray(result?.facialLandmarks)&&result.facialLandmarks.length>0,
    gazeState:result?.gazeState??'unknown',
    normPog:Array.isArray(result?.normPog)?result.normPog:null,
    landmarkFeatures:gazeFeatures,
    eyeCrops,
    durations:result?.durations??null,
    width:message.width,
    height:message.height,
    frameId:message.frameId,
    captureTimestampMs:message.captureTimestampMs,
    callbackTimestampMs:message.callbackTimestampMs,
    timestampKind:message.timestampKind,
    sentAtMs:message.sentAtMs
  },previewBitmaps);
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
    const result = takeCalibrationResult(calibrationResults,message.frameId);
    handleAdaptation(result,addCalibrationSample,message.target,message.requestId).then(response=>self.postMessage(response));
  }
};
