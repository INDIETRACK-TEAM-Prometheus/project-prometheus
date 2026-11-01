import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {eyeCrop,eyePreviewCrop} from '../src/gaze/index.js';
import {restoreWebEyeTrackAdaptationSamples,serializeWebEyeTrackAdaptationSamples} from '../src/gaze/calibration-profile.js';

function workerHarness({offscreen=true,transferFails=false,noCrops=false}={}) {
  const messages=[],bitmaps=[],dots=[],canvases=[],calibrationResults=new Map(),adaptations=[];
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
  let adaptCount=0;
  const tracker={loaded:true,async step(frame,timestamp){assert.equal(frame.width,100);assert.equal(frame.height,100);assert.equal(timestamp,123);return {facialLandmarks:faceLandmarks,gazeState:'open',normPog:[0,0],eyePatch:new ImageData(new Uint8ClampedArray([1,2,3,255]),1,1),headVector:[0,0,1],faceOrigin3D:[0,0,1]};},async adapt(...args){adaptations.push(args);}};
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
      WEBEYETRACK_CALIBRATION_POINTS:27,handleWebEyeTrackAdaptation:async(_result,_add,_target,requestId)=>({type:'adapted',requestId,points:++adaptCount}),retainWebEyeTrackCalibrationResult(results,frameId,result){results.set(frameId,result);},
      takeWebEyeTrackCalibrationResult(results,frameId){const result=results.get(frameId);results.delete(frameId);return result;},createWebEyeTrackCalibrationAdapter:()=>()=>1
    },
    '/src/gaze/calibration-profile.js':{serializeWebEyeTrackAdaptationSamples,restoreWebEyeTrackAdaptationSamples},
    '/vendor/vision_bundle.mjs':{}
  };
  const self={postMessage(message,transfer=[]){if(transferFails&&transfer.length)throw new Error('bitmap transfer unavailable');messages.push({message,transfer});}};
  let clock=0;
  const context={self,ImageData,Uint8ClampedArray,performance:{now:()=>++clock},importScripts(){},mockImport:path=>Promise.resolve(modules[path]),...(offscreen?{OffscreenCanvas}:{})};
  const source=readFileSync(new URL('../src/gaze/webeyetrack-worker.js',import.meta.url),'utf8').replaceAll('import(','mockImport(');
  vm.runInNewContext(source,context,{filename:'webeyetrack-worker.js'});
  async function waitForResponse(expected,after=0){
    for(let attempt=0;attempt<20;attempt++){const response=messages.find((entry,index)=>index>=after&&(entry.message.type===expected||entry.message.type==='error'));if(response)return response;await new Promise(resolve=>setImmediate(resolve));}
    throw new Error('worker did not respond');
  }
  async function frame(frameId=7){
    const after=messages.length;
    const pixels=new Uint8Array(40000);
    for(let index=0;index<10000;index++)pixels[index*4]=(index&255);
    self.onmessage({data:{type:'frame',frameId,width:100,height:100,pixels,captureTimestampMs:123,callbackTimestampMs:124,timestampKind:'browser_capture_estimate',sentAtMs:120}});
    return await waitForResponse('result',after);
  }
  return {self,waitForResponse,frame,messages,bitmaps,dots,canvases,features,landmarks,adaptations};
}

test('worker renders eye, eyelid, iris and brow landmarks from eye-only frame pixel copies',async()=>{
  const h=workerHarness();
  h.self.onmessage({data:{type:'init'}});
  assert.equal((await h.waitForResponse('ready')).message.type,'ready');
  const {message,transfer}=await h.frame();
  assert.equal(message.type,'result');assert.deepEqual(message.landmarkFeatures,h.features);
  assert.equal(message.frameId,7);assert.equal(message.previewBitmaps.left,h.bitmaps[0]);assert.equal(message.previewBitmaps.right,h.bitmaps[1]);
  assert.equal(transfer.length,2);assert.equal(transfer[0],h.bitmaps[0]);assert.equal(transfer[1],h.bitmaps[1]);assert.equal(h.dots.length,68);
  assert.equal(message.eyeCrops.left.x,47.5);assert.equal(message.eyeCrops.left.y,40.5);assert.equal(message.eyeCrops.left.width,15);assert.equal(message.eyeCrops.left.height,13.5);
  assert.ok(Number.isFinite(message.durations.eyeRegionMs));assert.ok(Number.isFinite(message.durations.eyePreviewMs));assert.ok(Number.isFinite(message.durations.workerTotalMs));
  const leftPreview=h.canvases.filter(canvas=>canvas.width===320)[0],transformCalls=leftPreview.calls.map(call=>call[0]);
  assert.ok(transformCalls.indexOf('translate')<transformCalls.indexOf('scale')&&transformCalls.indexOf('scale')<transformCalls.indexOf('drawImage'));
  assert.ok(transformCalls.indexOf('drawImage')<transformCalls.indexOf('arc'));
  assert.deepEqual(leftPreview.calls.find(call=>call[0]==='drawImage').slice(2,6),[.5,.5,15,13.5]);
  assert.ok(Math.abs(h.dots[0].x-(320-((60-47.5)/15)*320))<1e-9);assert.ok(Math.abs(h.dots[0].y-((50-40.5)/13.5)*260)<1e-9);
  assert.ok(Math.abs(h.dots[19].x-160)<1e-9);assert.ok(Math.abs(h.dots[19].y-((42-40.5)/13.5)*260)<1e-9);
  assert.equal(h.canvases.some(canvas=>canvas.width===100),false);
  const source=h.canvases.find(canvas=>canvas.width===16&&canvas.height===14),writes=source.calls.filter(call=>call[0]==='putImageData');
  assert.equal(writes.length,2);assert.ok(writes.every(call=>call[1].width*call[1].height<100*100));
  const copiedBytes=writes.reduce((sum,call)=>sum+call[1].data.byteLength,0);
  assert.equal(copiedBytes,2*16*14*4);assert.ok(copiedBytes<100*100*4/20);
  assert.equal(writes[0][1].data[0],(40*100+47)&255);assert.equal(writes[1][1].data[0],(40*100+27)&255);
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

test('worker exports typed ImageData adaptation samples and replays them into tracker.adapt',async()=>{
  const h=workerHarness({noCrops:true});
  h.self.onmessage({data:{type:'init'}});await h.waitForResponse('ready');
  let finalResponse;
  for(let i=0;i<27;i++){
    await h.frame(i+1);
    const after=h.messages.length;
    h.self.onmessage({data:{type:'adapt',requestId:`adapt-${i+1}`,frameId:i+1,target:{x:(i%9)/20-.2,y:Math.floor(i/9)/4-.25}}});
    finalResponse=await h.waitForResponse('adapted',after);
  }
  assert.equal(finalResponse.message.adaptationSamples.length,27);
  assert.equal(finalResponse.message.adaptationSamples[0].eyePatch.format,'ImageData');
  const replay=restoreWebEyeTrackAdaptationSamples(finalResponse.message.adaptationSamples);
  assert.ok(replay[0].eyePatch.data instanceof Uint8ClampedArray);
  assert.deepEqual([...replay[0].eyePatch.data],[1,2,3,255]);

  const after=h.messages.length;
  h.self.onmessage({data:{type:'restoreCalibration',requestId:'restore-1',samples:finalResponse.message.adaptationSamples}});
  const restored=await h.waitForResponse('calibrationRestored',after);
  assert.equal(restored.message.type,'calibrationRestored');assert.equal(restored.message.requestId,'restore-1');assert.equal(restored.message.points,27);
  assert.equal(h.adaptations.length,1);
  assert.equal(h.adaptations[0][0].length,27);
  assert.ok(h.adaptations[0][0][0].data instanceof Uint8ClampedArray);
});
