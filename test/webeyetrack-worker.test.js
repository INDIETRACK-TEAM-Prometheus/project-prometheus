import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('worker processes a frame with locally derived landmark gaze features',async()=>{
  const messages=[];
  const features=[.1,-.2,.3];
  let receivedLandmarks;
  const tracker={
    loaded:true,
    async step(frame,timestamp){
      assert.equal(frame.width,2);
      assert.equal(frame.height,2);
      assert.equal(timestamp,123);
      return {facialLandmarks:[{x:.5,y:.5}],gazeState:'open',normPog:[0,0]};
    }
  };
  class ImageData {
    constructor(data,width,height){this.data=data;this.width=width;this.height=height;}
  }
  const modules={
    '/src/gaze/index.js':{
      eyeCrop:()=>({x:0,y:0,width:1,height:1}),
      landmarkGazeFeatures(landmarks,width,height){receivedLandmarks={landmarks,width,height};return features;}
    },
    '/src/gaze/webeyetrack-bootstrap.js':{initializeWebEyeTrack:async()=>tracker},
    '/src/gaze/webeyetrack-adaptation.js':{
      WEBEYETRACK_CALIBRATION_POINTS:27,
      handleWebEyeTrackAdaptation:async()=>({type:'adapted'}),
      retainWebEyeTrackCalibrationResult(){},
      takeWebEyeTrackCalibrationResult(){return undefined;},
      createWebEyeTrackCalibrationAdapter:()=>()=>1
    },
    '/vendor/vision_bundle.mjs':{}
  };
  const self={postMessage:message=>messages.push(message)};
  const context={
    self,
    ImageData,
    Uint8ClampedArray,
    importScripts(){},
    mockImport(path){return Promise.resolve(modules[path]);}
  };
  const source=readFileSync(new URL('../src/gaze/webeyetrack-worker.js',import.meta.url),'utf8').replaceAll('import(','mockImport(');
  vm.runInNewContext(source,context,{filename:'webeyetrack-worker.js'});

  async function waitForResponse(expected){
    for(let attempt=0;attempt<20;attempt++){
      const response=messages.find(message=>message.type===expected||message.type==='error');
      if(response)return response;
      await new Promise(resolve=>setImmediate(resolve));
    }
    throw new Error('worker did not respond');
  }

  self.onmessage({data:{type:'init'}});
  assert.equal((await waitForResponse('ready')).type,'ready');
  self.onmessage({data:{
    type:'frame',frameId:7,width:2,height:2,pixels:[0,0,0,0],captureTimestampMs:123,
    callbackTimestampMs:124,timestampKind:'browser_capture_estimate',sentAtMs:120
  }});
  const response=await waitForResponse('result');
  assert.equal(response.type,'result');
  assert.deepEqual(response.landmarkFeatures,features);
  assert.deepEqual(receivedLandmarks,{landmarks:[{x:.5,y:.5}],width:2,height:2});
});
