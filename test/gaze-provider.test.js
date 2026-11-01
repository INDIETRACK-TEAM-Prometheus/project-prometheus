import test from 'node:test';
import assert from 'node:assert/strict';
import {createRemoteGazeProvider,validateRemoteGazeAdapter} from '../server/gaze-provider.js';

const model={id:'webeyetrack-blazegaze-mpiifacegaze',sourceCommit:'75fbd2f5f784f2eb3a39675a8dcbf1b01c697f1c',sha256:'b'.repeat(64)};
const shapes=[[518,16],[16],[16,16],[16],[16,2],[2]];
function adapter(){return {schemaVersion:1,adapterId:'webeyetrack-gaze-mlp-f32-v1',modelId:model.id,sourceCommit:model.sourceCommit,modelSha256:model.sha256,weights:shapes.map(shape=>{const count=shape.reduce((n,x)=>n*x,1),bytes=Buffer.alloc(count*4);for(let i=0;i<count;i++)bytes.writeFloatLE(.25,i*4);return {shape,dtype:'float32-le',data:bytes.toString('base64')};})};}
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

function serviceMock(){
  const calls=[];
  const fetchImpl=async(url,options={})=>{
    const target=new URL(url);calls.push({url:target,options});
    if(target.pathname==='/health')return json({status:'ready',backend:'colab_remote',device:'cuda',model,runtime:{python:'3',tensorflow:'2',mediapipe:'0'}});
    if(target.pathname==='/sessions'&&options.method==='POST'){const body=JSON.parse(options.body);return json({status:'ready',sessionId:'session-1',expiresInSeconds:600,calibrated:!!body.adapter},201);}
    if(target.pathname==='/sessions/session-1/frame'){return json({status:'ok',frameId:Number(options.headers['x-frame-id']),captureTimestampMs:Number(options.headers['x-capture-timestamp-ms']),faceDetected:true,gazeState:'open',normPog:[-.2,.3],eyeAspectRatio:null,durations:{total:8}});}
    if(target.pathname.endsWith('/candidate/start'))return json({status:'started',points:0,requiredPoints:27});
    if(target.pathname.endsWith('/calibration/sample')){const body=JSON.parse(options.body);return json({status:body.pointIndex===26?'adapted':'collecting',points:body.pointIndex+1});}
    if(target.pathname.endsWith('/candidate/accept'))return json({status:'accepted',calibrated:true,adapter:adapter()});
    if(target.pathname.endsWith('/candidate/discard'))return json({status:'discarded'});
    if(target.pathname==='/sessions/session-1'&&options.method==='DELETE')return json({status:'disposed'});
    throw new Error(`unexpected ${options.method} ${target.pathname}`);
  };
  return {fetchImpl,calls};
}

test('remote gaze proxy adapter validates model hash, tensor shapes and finite little-endian floats',async()=>{
  const sample=adapter();assert.equal(validateRemoteGazeAdapter(sample,model),true);
  const badHash={...sample,modelSha256:'c'.repeat(64)};assert.equal(validateRemoteGazeAdapter(badHash,model),false);
  const badShape={...sample,weights:[{...sample.weights[0],shape:[16,518]},...sample.weights.slice(1)]};assert.equal(validateRemoteGazeAdapter(badShape,model),false);
  const nonfinite={...sample,weights:[{...sample.weights[0],data:Buffer.alloc(518*16*4,255).toString('base64')},...sample.weights.slice(1)]};assert.equal(validateRemoteGazeAdapter(nonfinite,model),false);
  const mock=serviceMock(),provider=createRemoteGazeProvider({baseUrl:'http://127.0.0.1:49191/',fetchImpl:mock.fetchImpl});
  assert.deepEqual(await provider.health(),{ready:true,model});
  const created=await provider.createSession({screenPxDimensions:[800,600],adapter:sample});assert.deepEqual(created,{sessionId:'session-1',expiresInSeconds:600,calibrated:true});
  assert.deepEqual(await provider.startCandidate(created.sessionId),{status:'ready'});
  const jpeg=Buffer.from([255,216,255,217]);
  assert.deepEqual(await provider.frame({sessionId:created.sessionId,frameId:4,captureTimestampMs:12.5,bytes:jpeg}),{frameId:4,captureTimestampMs:12.5,faceDetected:true,gazeState:'open',normPog:[-.2,.3],eyeAspectRatio:null,durations:{total:8}});
  assert.deepEqual(await provider.addCalibrationSample({sessionId:created.sessionId,frameId:4,pointIndex:0,target:[0,.25]}),{adapted:false,points:1});
  const accepted=await provider.acceptCandidate(created.sessionId);assert.equal(accepted.adapter.adapterId,sample.adapterId);
  await provider.discardCandidate(created.sessionId);await provider.deleteSession(created.sessionId);await provider.close();
  const frameCall=mock.calls.find(call=>call.url.pathname.endsWith('/frame'));
  assert.equal(frameCall.options.headers['content-type'],'image/jpeg');assert.equal('authorization' in frameCall.options.headers,false);
});

test('remote gaze provider rejects invalid adapters before opening a remote session',async()=>{
  const mock=serviceMock(),provider=createRemoteGazeProvider({baseUrl:'http://127.0.0.1:49191/',fetchImpl:mock.fetchImpl});
  await assert.rejects(provider.createSession({adapter:{schemaVersion:1}}),error=>error.code==='GAZE_ADAPTER_INCOMPATIBLE');
  assert.equal(mock.calls.some(call=>call.url.pathname==='/sessions'),false);
});

test('remote gaze provider keeps the worker failure code and falls back to a generic code for anything else',async()=>{
  const frame=(status,body)=>async(url,options={})=>{const path=new URL(url).pathname;if(path==='/sessions')return json({status:'ready',sessionId:'session-1',expiresInSeconds:600,calibrated:false},201);return status===null?new Response('<html>',{status:502}):json(body,status);};
  const attempt=async(status,body)=>{const provider=createRemoteGazeProvider({baseUrl:'http://127.0.0.1:49191/',fetchImpl:frame(status,body)});const {sessionId}=await provider.createSession({});return provider.frame({sessionId,frameId:1,captureTimestampMs:5,bytes:Buffer.from([255,216,255,217])}).then(()=>null,error=>error.code);};
  assert.equal(await attempt(409,{status:'error',error:'GAZE_FRAME_OUT_OF_ORDER'}),'GAZE_FRAME_OUT_OF_ORDER');
  assert.equal(await attempt(503,{status:'error',error:'GAZE_INFERENCE_FAILED'}),'GAZE_INFERENCE_FAILED');
  assert.equal(await attempt(503,{status:'error',error:'not a code <script>'}),'GAZE_REMOTE_UNAVAILABLE');
  assert.equal(await attempt(502,{status:'error',error:'x'.repeat(100)}),'GAZE_REMOTE_UNAVAILABLE');
  assert.equal(await attempt(null),'GAZE_REMOTE_UNAVAILABLE');
  assert.equal(await attempt(404,{status:'error',error:'GAZE_SESSION_NOT_FOUND'}),'GAZE_SESSION_UNAVAILABLE');
});

test('remote gaze provider forwards only bounded eye aspect ratios',async()=>{
  const reply=ear=>async(url)=>{const path=new URL(url).pathname;if(path==='/sessions')return json({status:'ready',sessionId:'session-1',expiresInSeconds:600,calibrated:false},201);return json({status:'ok',frameId:1,captureTimestampMs:5,faceDetected:true,gazeState:'closed',normPog:[0,0],eyeAspectRatio:ear,durations:{total:1}});};
  const run=async ear=>{const provider=createRemoteGazeProvider({baseUrl:'http://127.0.0.1:49191/',fetchImpl:reply(ear)});const {sessionId}=await provider.createSession({});return provider.frame({sessionId,frameId:1,captureTimestampMs:5,bytes:Buffer.from([255,216,255,217])});};
  assert.deepEqual((await run({left:.18,right:.26,threshold:.2,extra:1})).eyeAspectRatio,{left:.18,right:.26,threshold:.2});
  assert.equal((await run({left:9,right:.26,threshold:.2})).eyeAspectRatio,null);
  assert.equal((await run('0.2')).eyeAspectRatio,null);
  assert.equal((await run(undefined)).eyeAspectRatio,null);
});
