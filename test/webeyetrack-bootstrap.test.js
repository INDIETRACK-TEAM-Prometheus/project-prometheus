import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeWebEyeTrack} from '../src/gaze/webeyetrack-bootstrap.js';

test('worker bootstrap consumes individually exported UMD globals and keeps MediaPipe local',async()=>{
  const calls={fileset:[],create:[],construct:[]};
  class FaceLandmarkerClient {constructor(){this.faceLandmarker=null;}}
  class WebEyeTrack {
    constructor(maxPoints){calls.construct.push(maxPoints);this.loaded=false;}
    async initialize(){
      const faceClient=new FaceLandmarkerClient();
      await faceClient.initialize();
      this.faceLandmarkerClient=faceClient;this.loaded=true;
    }
  }
  const localFaceLandmarker={local:true};
  const vision={
    FilesetResolver:{async forVisionTasks(path){calls.fileset.push(path);return {path};}},
    FaceLandmarker:{async createFromOptions(files,options){calls.create.push({files,options});return localFaceLandmarker;}}
  };
  // The UMD wrapper assigns export names directly on self, rather than
  // providing a self.WebEyeTrack namespace object.
  const workerGlobal={WebEyeTrack,FaceLandmarkerClient};
  assert.equal(typeof workerGlobal.WebEyeTrack,'function');
  assert.equal(workerGlobal.WebEyeTrack.WebEyeTrack,undefined);
  const tracker=await initializeWebEyeTrack({...workerGlobal,vision});
  assert.equal(tracker.loaded,true);
  assert.equal(tracker.faceLandmarkerClient.faceLandmarker,localFaceLandmarker);
  assert.deepEqual(calls.construct,[27]);
  assert.deepEqual(calls.fileset,['/vendor']);
  assert.deepEqual(calls.create,[{
    files:{path:'/vendor'},
    options:{
      baseOptions:{modelAssetPath:'/vendor/face_landmarker.task'},
      outputFaceBlendshapes:true,
      outputFacialTransformationMatrixes:true,
      runningMode:'IMAGE',
      numFaces:1
    }
  }]);
});

test('worker bootstrap rejects a namespace-shaped or missing UMD global',async()=>{
  const vision={FilesetResolver:{forVisionTasks(){}},FaceLandmarker:{createFromOptions(){}}};
  await assert.rejects(initializeWebEyeTrack({api:{WebEyeTrack:class{},FaceLandmarkerClient:class{}},vision}),/globals are unavailable/);
  await assert.rejects(initializeWebEyeTrack({WebEyeTrack:{WebEyeTrack:class{}},FaceLandmarkerClient:class{},vision}),/globals are unavailable/);
});
