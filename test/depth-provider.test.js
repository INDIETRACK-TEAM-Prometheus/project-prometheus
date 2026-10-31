import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDepthProvider } from '../server/depth-provider.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'test', 'fixtures', 'depth-provider-worker.mjs');
const frame = {frameId:'cam-frame-17',observedAt:1234.5,width:2,height:2};
const imageDataUrl = 'data:image/jpeg;base64,/9j/';
const provider = mode => createDepthProvider({
  pythonPath:'unused-in-tests',
  home:path.join(root,'.asset-tmp','depth-runtime'),
  startupTimeoutMs:2000,
  requestTimeoutMs:2000,
  spawnProcess:(_command,_args,options)=>spawn(process.execPath,[fixture],{
    ...options,
    env:{...options.env,...(mode ?? {})},
  }),
});

test('local depth adapter returns validated metric depth for the exact frame',async()=>{
  const service=provider();
  try {
    const result=await service.infer({frame,imageDataUrl});
    assert.deepEqual(result.frame, {frameId:frame.frameId,observedAt:frame.observedAt});
    assert.deepEqual([result.depth.width,result.depth.height,result.depth.units,result.depth.convention,result.depth.depthSource],[2,2,'m','axial_z','monocular_estimated_depth']);
    assert.deepEqual(result.depth.values,[2.5,2.5,2.5,2.5]);
    assert.deepEqual(result.depth.validMask,[1,1,1,1]);
    assert.equal(result.depth.provenance,'depth-anything/Depth-Anything-V2-Metric-Hypersim-Small:sha256:b782898d8a3e8be1f639de33837ed85e9b4b73e40f8f5e5cd99067588d722545');
    assert.equal(result.model.license,'Apache-2.0');
    assert.equal(result.model.device,'cpu');
    assert.equal(result.timing.inferenceMs,11);
    assert.equal(service.status().inFlight,false);
  } finally { await service.close(); }
});

test('rejects malformed or oversized frame media before starting Python',async()=>{
  let starts=0;
  const service=createDepthProvider({pythonPath:'unused',home:root,spawnProcess:()=>{starts++;throw new Error('must not spawn');}});
  try {
    await assert.rejects(service.infer({frame:{...frame,width:4097},imageDataUrl}),{code:'DEPTH_INVALID_FRAME'});
    await assert.rejects(service.infer({frame,imageDataUrl:'data:image/png;base64,YWJj'}),{code:'DEPTH_INVALID_IMAGE'});
    assert.equal(starts,0);
  } finally { await service.close(); }
});

test('provider allows one in-flight inference and rejects stale frame responses',async()=>{
  const busy=provider({DEPTH_TEST_DELAY_MS:'80'});
  try {
    const pending=busy.infer({frame,imageDataUrl});
    await new Promise(resolve=>setTimeout(resolve,20));
    await assert.rejects(busy.infer({frame:{...frame,frameId:'other'},imageDataUrl}),{code:'DEPTH_PROVIDER_BUSY'});
    assert.equal((await pending).frame.frameId,frame.frameId);
  } finally { await busy.close(); }

  const mismatch=provider({DEPTH_TEST_MODE:'mismatch'});
  try { await assert.rejects(mismatch.infer({frame,imageDataUrl}),{code:'DEPTH_PROVIDER_PROTOCOL_ERROR'}); }
  finally { await mismatch.close(); }
});

test('aborting a local inference terminates the worker and withholds its result',async()=>{
  const service=provider({DEPTH_TEST_DELAY_MS:'500'});
  const controller=new AbortController();
  const pending=service.infer({frame,imageDataUrl,signal:controller.signal});
  const cancelled=assert.rejects(pending,{code:'DEPTH_CANCELLED'});
  await new Promise(resolve=>setTimeout(resolve,25));
  controller.abort();
  try {
    await cancelled;
    assert.equal(service.status().inFlight,false);
  } finally { await service.close(); }
});

