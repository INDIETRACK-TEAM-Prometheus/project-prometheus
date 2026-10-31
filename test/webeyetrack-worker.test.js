import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {eyeCrop,eyePreviewCrop} from '../src/gaze/index.js';

function workerHarness({offscreen=true,transferFails=false,noCrops=false}={}) {
  const messages=[],bitmaps=[],dots=[],canvases=[];
  const features=[.1,-.2,.3];
  const landmarks=Array.from({length:478},()=>({x:.55,y:.5}));
  const leftEye=[263,249,390,373,374,380,381,382,362,398,384,385,386,387,388,466],leftBrow=[276,283,282,295,285,300,293,334,296,336],rightEye=[33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246],rightBrow=[46,53,52,65,55,70,63,105,66,107];
  for(const index of [...rightEye,...rightBrow,468,469,470,471,472])Object.assign(landmarks[index],{x:.35,y:.5});
  for(const index of leftBrow)landmarks[index].y=.42;
  for(const index of rightBrow)landmarks[index].y=.42;
  Object.assign(landmarks[263],{x:.6,y:.5});Object.assign(landmarks[362],{x:.5,y:.5});
  Object.assign(landmarks[33],{x:.3,y:.5});Object.assign(landmarks[133],{x:.4,y:.5});
  for(const index of [385,386,387])landmarks[index].y=.48;
  for(const index of [158,159,160])landmarks[index].y=.48;
  Object.assign(landmarks[473],{x:.55,y:.49});Object.assign(landmarks[474],{x:.54,y:.49});Object.assign(landmarks[475],{x:.55,y:.48});Object.assign(landmarks[476],{x:.56,y:.49});Object.assign(landmarks[477],{x:.55,y:.5});
  Object.assign(landmarks[468],{x:.35,y:.49});Object.assign(landmarks[469],{x:.34,y:.49});Object.assign(landmarks[470],{x:.35,y:.48});Object.assign(landmarks[471],{x:.36,y:.49});Object.assign(landmarks[472],{x:.35,y:.5});
  const faceLandmarks=noCrops?[]:landmarks;
  const tracker={loaded:true,async step(frame,timestamp){assert.equal(frame.width,100);assert.equal(frame.height,100);assert.equal(timestamp,123);return {facialLandmarks:faceLandmarks,gazeState:'open',normPog:[0,0]};}};
  class ImageData { constructor(data,width,height){this.data=data;this.width=width;this.height=height;} }
  class OffscreenCanvas {
    constructor(width,height){this.width=width;this.height=height;this.calls=[];canvases.push(this);}
    getContext(){
      const canvas=this,state={x:0,y:0,sx:1,sy:1},stack=[];
      return {
        putImageData:(...args)=>canvas.calls.push(['putImageData',...args]),drawImage:(...args)=>canvas.calls.push(['drawImage',...args]),
        save(){stack.push({...state});canvas.calls.push(['save']);},restore(){Object.assign(state,stack.pop());canvas.calls.push(['restore']);},
        translate(x,y){canvas.calls.push(['translate',x,y]);state.x+=state.sx*x;state.y+=state.sy*y;},scale(x,y){canvas.calls.push(['scale',x,y]);state.sx*=x;state.sy*=y;},
        clearRect(){canvas.calls.push(['clearRect']);},beginPath(){},moveTo(){},lineTo(){},stroke(){},fill(){},
        arc:(x,y,radius)=>{canvas.calls.push(['arc',x,y,radius]);dots.push({canvas,x:x*state.sx+state.x,y:y*state.sy+state.y,radius});}
      };
    }
    transferToImageBitmap(){const bitmap={canvas:this,closed:false,close(){this.closed=true;}};bitmaps.push(bitmap);return bitmap;}
  }
  const modules={
    '/src/gaze/index.js':{
      eyeCrop,eyePreviewCrop,
      landmarkGazeFeatures(points,width,height){assert.equal(points,faceLandmarks);assert.equal(width,100);assert.equal(height,100);return features;}
    },
    '/src/gaze/webeyetrack-bootstrap.js':{initializeWebEyeTrack:async()=>tracker},
    '/src/gaze/webeyetrack-adaptation.js':{
      WEBEYETRACK_CALIBRATION_POINTS:27,handleWebEyeTrackAdaptation:async()=>({type:'adapted'}),retainWebEyeTrackCalibrationResult(){},
      takeWebEyeTrackCalibrationResult(){return undefined;},createWebEyeTrackCalibrationAdapter:()=>()=>1
    },
    '/vendor/vision_bundle.mjs':{}
  };
  const self={postMessage(message,transfer=[]){if(transferFails&&transfer.length)throw new Error('bitmap transfer unavailable');messages.push({message,transfer});}};
  const context={self,ImageData,Uint8ClampedArray,importScripts(){},mockImport:path=>Promise.resolve(modules[path]),...(offscreen?{OffscreenCanvas}:{})};
  const source=readFileSync(new URL('../src/gaze/webeyetrack-worker.js',import.meta.url),'utf8').replaceAll('import(','mockImport(');
  vm.runInNewContext(source,context,{filename:'webeyetrack-worker.js'});
  async function waitForResponse(expected){
    for(let attempt=0;attempt<20;attempt++){const response=messages.find(entry=>entry.message.type===expected||entry.message.type==='error');if(response)return response;await new Promise(resolve=>setImmediate(resolve));}
    throw new Error('worker did not respond');
  }
  async function frame(){
    self.onmessage({data:{type:'frame',frameId:7,width:100,height:100,pixels:new Uint8Array(40000),captureTimestampMs:123,callbackTimestampMs:124,timestampKind:'browser_capture_estimate',sentAtMs:120}});
    return await waitForResponse('result');
  }
  return {self,waitForResponse,frame,messages,bitmaps,dots,canvases,features,landmarks};
}

test('worker renders detected eye, eyelid, iris and brow landmarks into the same mirrored frame crop',async()=>{
  const h=workerHarness();
  h.self.onmessage({data:{type:'init'}});
  assert.equal((await h.waitForResponse('ready')).message.type,'ready');
  const {message,transfer}=await h.frame();
  assert.equal(message.type,'result');assert.deepEqual(message.landmarkFeatures,h.features);
  assert.equal(message.frameId,7);assert.equal(message.previewBitmaps.left,h.bitmaps[0]);assert.equal(message.previewBitmaps.right,h.bitmaps[1]);
  assert.equal(transfer.length,2);assert.equal(transfer[0],h.bitmaps[0]);assert.equal(transfer[1],h.bitmaps[1]);assert.equal(h.dots.length,68);
  assert.equal(message.eyeCrops.left.x,47.5);assert.equal(message.eyeCrops.left.y,40.5);assert.equal(message.eyeCrops.left.width,15);assert.equal(message.eyeCrops.left.height,13.5);
  const leftPreview=h.canvases.filter(canvas=>canvas.width===320)[0],transformCalls=leftPreview.calls.map(call=>call[0]);
  assert.ok(transformCalls.indexOf('translate')<transformCalls.indexOf('scale')&&transformCalls.indexOf('scale')<transformCalls.indexOf('drawImage'));
  assert.ok(transformCalls.indexOf('drawImage')<transformCalls.indexOf('arc'));
  assert.ok(Math.abs(h.dots[0].x-(320-((60-47.5)/15)*320))<1e-9);assert.ok(Math.abs(h.dots[0].y-((50-40.5)/13.5)*260)<1e-9);
  assert.ok(Math.abs(h.dots[19].x-160)<1e-9);assert.ok(Math.abs(h.dots[19].y-((42-40.5)/13.5)*260)<1e-9);
  assert.equal(h.canvases.filter(canvas=>canvas.width===100)[0].calls.filter(call=>call[0]==='putImageData').length,1);
  assert.equal('facialLandmarks' in message,false);assert.equal('landmarks' in message,false);
});

test('worker does not copy a full frame for preview when neither eye crop is available',async()=>{
  const h=workerHarness({noCrops:true});h.self.onmessage({data:{type:'init'}});await h.waitForResponse('ready');
  const {message}=await h.frame();
  assert.equal(message.type,'result');assert.equal(message.faceDetected,false);
  assert.equal(message.previewBitmaps.left,null);assert.equal(message.previewBitmaps.right,null);assert.equal(h.canvases.length,0);
});

test('worker keeps inference results flowing when offscreen bitmaps are unsupported or rejected',async()=>{
  for(const options of [{offscreen:false},{offscreen:true,transferFails:true}]){
    const h=workerHarness(options);h.self.onmessage({data:{type:'init'}});await h.waitForResponse('ready');
    const {message}=await h.frame();
    assert.equal(message.type,'result');assert.equal(message.previewBitmaps.left,null);assert.equal(message.previewBitmaps.right,null);
    assert.equal(h.messages.some(entry=>entry.message.type==='error'),false);
    if(options.transferFails)assert.ok(h.bitmaps.every(bitmap=>bitmap.closed));
  }
});
