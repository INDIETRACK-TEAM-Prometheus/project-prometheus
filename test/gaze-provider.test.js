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
  assert.deepEqual(await provider.frame({sessionId:created.sessionId,frameId:4,captureTimestampMs:12.5,bytes:jpeg}),{frameId:4,captureTimestampMs:12.5,faceDetected:true,gazeState:'open',normPog:[-.2,.3],eyeAspectRatio:null,trackingFailure:null,durations:{total:8}});
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

const jpegB64 = Buffer.from([255, 216, 255, 217, 1, 2, 3, 4]).toString('base64');
const targetFrames = ids => ids.map(frameId => ({frameId, captureTimestampMs: frameId * 10, jpeg: jpegB64}));
const targetResult = (phase, pointIndex, extra = {}) => ({status: phase === 'train' ? 'accepted' : 'measured', phase, pointIndex, totalFrames: 3, faceFrames: 3, closedFrames: 0, usableFrames: 3, frameErrors: 0, eyeAspectRatio: {min: .24, threshold: .2},
  ...(phase === 'train' ? {collected: pointIndex + 1, requiredPoints: 27} : {normPog: [.1, -.2]}), ...extra});

async function targetProvider(handler) {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/sessions') return json({status: 'ready', sessionId: 'session-1', expiresInSeconds: 600, calibrated: false}, 201);
    seen.push([path, options.method, options.body ? JSON.parse(options.body) : null]);
    return handler(path, options);
  };
  const provider = createRemoteGazeProvider({baseUrl: 'http://127.0.0.1:49191/', fetchImpl});
  const {sessionId} = await provider.createSession({});
  return {provider, sessionId, seen};
}

test('calibration target burst is validated, forwarded once and its answer re-checked', async () => {
  const {provider, sessionId, seen} = await targetProvider(async (path, options) => {
    const body = JSON.parse(options.body);
    return json(targetResult(body.phase, body.pointIndex));
  });
  const trained = await provider.calibrationTarget({sessionId, phase: 'train', pointIndex: 4, target: [-.3, .2], frames: targetFrames([1, 2, 3])});
  assert.deepEqual(trained, {status: 'accepted', phase: 'train', pointIndex: 4, totalFrames: 3, faceFrames: 3, closedFrames: 0, usableFrames: 3, frameErrors: 0, eyePatchFailures: 0, failureMessage: null, eyeAspectRatio: {min: .24, threshold: .2}, collected: 5});
  const measured = await provider.calibrationTarget({sessionId, phase: 'validate', pointIndex: 0, target: [0, 0], frames: targetFrames([4, 5, 6])});
  assert.deepEqual(measured.normPog, [.1, -.2]);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0][2].frames.map(frame => frame.frameId), [1, 2, 3]);
});

test('calibration target requests are rejected before the network when malformed', async () => {
  const {provider, sessionId, seen} = await targetProvider(async () => json({}));
  const good = {sessionId, phase: 'train', pointIndex: 0, target: [0, 0], frames: targetFrames([1, 2, 3])};
  const bad = [{...good, phase: 'x'}, {...good, pointIndex: 27}, {...good, target: [.9, 0]}, {...good, frames: []}, {...good, frames: targetFrames([1, 2, 3, 4, 5, 6, 7, 8, 9])},
    {...good, frames: targetFrames([1, 1])}, {...good, frames: [{frameId: 1, captureTimestampMs: 1, jpeg: 'AAAAAAAA'}]}, {...good, frames: [{...targetFrames([1])[0], extra: 1}]},
    {...good, frames: [{frameId: 1, captureTimestampMs: 1, jpeg: 'not base64!'}]}];
  for (const request of bad) await assert.rejects(provider.calibrationTarget(request), {code: 'GAZE_INVALID_REQUEST'});
  assert.equal(seen.length, 0);
});

test('calibration target answers that disagree with the request are protocol errors', async () => {
  const mismatches = [targetResult('train', 9), targetResult('validate', 0), {...targetResult('train', 0), usableFrames: 4}, {...targetResult('train', 0), status: 'other'},
    {...targetResult('validate', 0), normPog: [2, 0]}, {...targetResult('train', 0), totalFrames: 5}, {...targetResult('train', 0), eyeAspectRatio: {min: 'x', threshold: .2}}];
  for (const answer of mismatches) {
    const {provider, sessionId} = await targetProvider(async () => json(answer));
    const phase = answer.phase === 'validate' && answer.pointIndex === 0 && answer.status === 'measured' ? 'train' : 'train';
    await assert.rejects(provider.calibrationTarget({sessionId, phase, pointIndex: 0, target: [0, 0], frames: targetFrames([1, 2, 3])}), {code: 'GAZE_PROTOCOL_ERROR'});
  }
});

test('calibration target keeps insufficient answers and the worker failure code', async () => {
  const insufficient = {status: 'insufficient', phase: 'train', pointIndex: 2, totalFrames: 3, faceFrames: 3, closedFrames: 3, usableFrames: 0, frameErrors: 0, eyeAspectRatio: {min: .17, threshold: .2}};
  const {provider, sessionId} = await targetProvider(async () => json(insufficient));
  const result = await provider.calibrationTarget({sessionId, phase: 'train', pointIndex: 2, target: [0, 0], frames: targetFrames([1, 2, 3])});
  assert.equal(result.status, 'insufficient');
  assert.deepEqual(result.eyeAspectRatio, {min: .17, threshold: .2});
  assert.equal('collected' in result, false);
  const failing = await targetProvider(async () => json({status: 'error', error: 'GAZE_CANDIDATE_NOT_ADAPTED'}, 409));
  await assert.rejects(failing.provider.calibrationTarget({sessionId: failing.sessionId, phase: 'validate', pointIndex: 0, target: [0, 0], frames: targetFrames([1, 2, 3])}), {code: 'GAZE_CANDIDATE_NOT_ADAPTED'});
});

test('finalizeCandidate requires the adapted answer and allows a long adaptation', async () => {
  const ok = await targetProvider(async () => json({status: 'adapted', points: 27, requiredPoints: 27}));
  assert.deepEqual(await ok.provider.finalizeCandidate(ok.sessionId), {adapted: true, points: 27});
  assert.equal(ok.seen[0][0], '/sessions/session-1/candidate/adapt');
  const bad = await targetProvider(async () => json({status: 'collecting', points: 26}));
  await assert.rejects(bad.provider.finalizeCandidate(bad.sessionId), {code: 'GAZE_PROTOCOL_ERROR'});
});

test('remote gaze provider forwards only a bounded tracking failure reason', async () => {
  const reply = failure => async (url) => { const path = new URL(url).pathname; if (path === '/sessions') return json({status: 'ready', sessionId: 'session-1', expiresInSeconds: 600, calibrated: false}, 201);
    return json({status: 'ok', frameId: 1, captureTimestampMs: 5, faceDetected: false, gazeState: 'unknown', normPog: null, trackingFailure: failure, durations: {total: 1}}); };
  const run = async failure => { const provider = createRemoteGazeProvider({baseUrl: 'http://127.0.0.1:49191/', fetchImpl: reply(failure)}); const {sessionId} = await provider.createSession({}); return provider.frame({sessionId, frameId: 1, captureTimestampMs: 5, bytes: Buffer.from([255, 216, 255, 217])}); };
  assert.deepEqual((await run({stage: 'eye_patch', message: 'shape mismatch (3,) into (2,)', extra: 1})).trackingFailure, {stage: 'eye_patch', message: 'shape mismatch (3,) into (2,)'});
  assert.deepEqual((await run({stage: 'eye_patch', message: '<script>alert(1)</script>'})).trackingFailure, {stage: 'eye_patch', message: null});
  assert.deepEqual((await run({stage: 'landmarks', message: null})).trackingFailure, {stage: 'landmarks', message: null});
  assert.equal((await run({stage: 'other', message: 'x'})).trackingFailure, null);
  assert.equal((await run(undefined)).trackingFailure, null);
});

test('calibration target summaries carry eye patch failure counts and a bounded message', async () => {
  const frames = [1, 2, 3].map(frameId => ({frameId, captureTimestampMs: frameId, jpeg: Buffer.from([255, 216, 255, 217, 1, 2, 3, 4]).toString('base64')}));
  const answer = extra => ({status: 'insufficient', phase: 'train', pointIndex: 0, totalFrames: 3, faceFrames: 0, closedFrames: 0, usableFrames: 0, frameErrors: 0, eyeAspectRatio: null, ...extra});
  const run = async extra => { const fetchImpl = async (url) => new URL(url).pathname === '/sessions' ? json({status: 'ready', sessionId: 'session-1', expiresInSeconds: 600, calibrated: false}, 201) : json(answer(extra));
    const provider = createRemoteGazeProvider({baseUrl: 'http://127.0.0.1:49191/', fetchImpl}); const {sessionId} = await provider.createSession({});
    return provider.calibrationTarget({sessionId, phase: 'train', pointIndex: 0, target: [0, 0], frames}); };
  const ok = await run({eyePatchFailures: 3, failureMessage: 'shape mismatch'});
  assert.deepEqual([ok.eyePatchFailures, ok.failureMessage], [3, 'shape mismatch']);
  assert.deepEqual([(await run({})).eyePatchFailures, (await run({})).failureMessage], [0, null]);
  assert.equal((await run({eyePatchFailures: 1, failureMessage: '<b>x</b>'})).failureMessage, null);
  await assert.rejects(run({eyePatchFailures: 99}), {code: 'GAZE_PROTOCOL_ERROR'});
});

test('connection failures keep a bounded network reason on the unavailable error', async () => {
  const frame = async fetchImpl => { const provider = createRemoteGazeProvider({baseUrl: 'http://127.0.0.1:49191/', fetchImpl}); const {sessionId} = await provider.createSession({}); return provider.frame({sessionId, frameId: 1, captureTimestampMs: 5, bytes: Buffer.from([255, 216, 255, 217])}).then(() => null, error => [error.code, error.cause ?? null]); };
  const session = async (url) => new URL(url).pathname === '/sessions' ? json({status: 'ready', sessionId: 'session-1', expiresInSeconds: 600, calibrated: false}, 201) : null;
  const reset = Object.assign(new TypeError('fetch failed'), {cause: Object.assign(new Error('read ECONNRESET'), {code: 'ECONNRESET'})});
  assert.deepEqual(await frame(async url => (await session(url)) ?? Promise.reject(reset)), ['GAZE_REMOTE_UNAVAILABLE', 'ECONNRESET']);
  assert.deepEqual(await frame(async url => (await session(url)) ?? Promise.reject(Object.assign(new TypeError('x'), {cause: {code: 'bad value!'}}))), ['GAZE_REMOTE_UNAVAILABLE', null]);
  assert.deepEqual(await frame(async url => (await session(url)) ?? new Response('<html>', {status: 502})), ['GAZE_REMOTE_UNAVAILABLE', 'HTTP_502']);
});
