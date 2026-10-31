import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function workerHarness({offscreen=true,transferFails=false}={}) {
  const messages=[],bitmaps=[],dots=[],canvases=[];
  const features=[.1,-.2,.3];
  const landmarks=Array.from({length:478},()=>({x:.5,y:.5}));
  Object.assign(landmarks[263],{x:.6,y:.5});Object.assign(landmarks[362],{x:.5,y:.5});
  Object.assign(landmarks[33],{x:.4,y:.5});Object.assign(landmarks[133],{x:.6,y:.5});
  const tracker={loaded:true,async step(frame,timestamp){assert.equal(frame.width,2);assert.equal(frame.height,2);assert.equal(timestamp,123);return {facialLandmarks:landmarks,gazeState:'open',normPog:[0,0]};}};
  class ImageData { constructor(data,width,height){this.data=data;this.width=width;this.height=height;} }
  class OffscreenCanvas {
    constructor(width,height){this.width=width;this.height=height;this.calls=[];canvases.push(this);}
    getContext(){return {
      putImageData:(...args)=>this.calls.push(['putImageData',...args]),drawImage:(...args)=>this.calls.push(['drawImage',...args]),
      save(){},restore(){},translate(){},scale(){},clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},fill(){},
      arc:(x,y,radius)=>dots.push({x,y,radius})
    };}
    transferToImageBitmap(){const bitmap={canvas:this,closed:false,close(){this.closed=true;}};bitmaps.push(bitmap);return bitmap;}
  }
  const modules={
    '/src/gaze/index.js':{
      eyeCrop:()=>({x:.5,y:.5,width:1,height:1}),
      eyePreviewCrop(crop,frame,span){const top=Math.max(frame.y,crop.y-span*.55);return {...crop,y:top,height:crop.y+crop.height-top};},
      landmarkGazeFeatures(points,width,height){assert.equal(points,landmarks);assert.equal(width,2);assert.equal(height,2);return features;}
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
    self.onmessage({data:{type:'frame',frameId:7,width:2,height:2,pixels:[0,0,0,0],captureTimestampMs:123,callbackTimestampMs:124,timestampKind:'browser_capture_estimate',sentAtMs:120}});
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
  assert.ok(h.canvases.filter(canvas=>canvas.width===320).every(canvas=>canvas.calls.some(call=>call[0]==='drawImage'&&(Math.abs(call[3]-.39)<1e-9||Math.abs(call[3]-.28)<1e-9))));
  assert.equal(h.canvases.filter(canvas=>canvas.width===2)[0].calls.filter(call=>call[0]==='putImageData').length,1);
  assert.equal('facialLandmarks' in message,false);assert.equal('landmarks' in message,false);
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
