import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteDepthProvider, createConfiguredDepthProvider } from '../server/depth-provider.js';

const frame = {frameId:'scene-9', observedAt:50, width:2, height:2};
const imageDataUrl = 'data:image/jpeg;base64,/9j/';
const model = {id:'depth-anything/Depth-Anything-V2-Metric-Hypersim-Small', sha256:'b782898d8a3e8be1f639de33837ed85e9b4b73e40f8f5e5cd99067588d722545', license:'Apache-2.0', sourceCommit:'a561b849ebae10a6f5ef49e26c83cbbcd36c71bf', units:'m', convention:'axial_z', device:'cuda'};
const ready = {type:'ready', status:'ready', model, modelLoadMs:900, pythonVersion:'3.13', torchVersion:'2.11', device:'cuda', gpu:'Tesla T4', backend:'colab_remote'};
const values = Buffer.alloc(16); for (let i = 0; i < 4; i++) values.writeFloatLE(3, i * 4);
const ok = id => ({id, status:'ok', frame:{frameId:frame.frameId, observedAt:frame.observedAt}, width:2, height:2, valuesF32LE:values.toString('base64'), validMaskU8:Buffer.from([1,1,1,1]).toString('base64'), units:'m', convention:'axial_z', depthSource:'monocular_estimated_depth', model, timing:{decodeMs:1, inferenceMs:40, totalMs:45}, summary:{validCount:4, invalidCount:0}});
const reply = (status, body) => ({status, text:async () => JSON.stringify(body)});
function tunnel(handler) {
  const calls = [];
  return {calls, fetchImpl:async (target, init) => { calls.push([String(target), init.method]); return handler(new URL(target).pathname, init); }};
}

test('remote provider validates the GPU worker and returns the exact frame depth', async () => {
  const t = tunnel((path, init) => path === '/health' ? reply(200, ready) : reply(200, ok(JSON.parse(init.body).id)));
  const provider = createRemoteDepthProvider({baseUrl:'http://127.0.0.1:49190/', fetchImpl:t.fetchImpl});
  const result = await provider.infer({frame, imageDataUrl});
  assert.deepEqual(result.depth.values, [3,3,3,3]);
  assert.equal(result.model.device, 'cuda');
  assert.equal(result.model.gpu, 'Tesla T4');
  assert.equal(result.model.backend, 'colab_remote');
  assert.ok(Number.isFinite(result.timing.requestRoundTripMs));
  assert.deepEqual(t.calls.map(c => c[1]), ['GET', 'POST']);
  await provider.infer({frame, imageDataUrl});
  assert.equal(t.calls.filter(c => c[1] === 'GET').length, 1);
});

test('remote provider refuses non-loopback URLs, CPU workers, wrong ids and busy overlap', async () => {
  for (const baseUrl of ['https://127.0.0.1:49190/', 'http://10.0.0.5:49190/', 'http://127.0.0.1:49190/x', 'http://user:p@127.0.0.1:49190/']) assert.throws(() => createRemoteDepthProvider({baseUrl}), /loopback|required/);
  const cpu = tunnel(() => reply(200, {...ready, model:{...model, device:'cpu'}}));
  await assert.rejects(createRemoteDepthProvider({baseUrl:'http://127.0.0.1:49190/', fetchImpl:cpu.fetchImpl}).infer({frame, imageDataUrl}), {code:'DEPTH_RUNTIME_UNAVAILABLE'});
  const wrongId = tunnel(path => path === '/health' ? reply(200, ready) : reply(200, ok('other')));
  await assert.rejects(createRemoteDepthProvider({baseUrl:'http://127.0.0.1:49190/', fetchImpl:wrongId.fetchImpl}).infer({frame, imageDataUrl}), {code:'DEPTH_PROVIDER_PROTOCOL_ERROR'});
  let release;
  const slow = tunnel(async (path, init) => { if (path === '/health') return reply(200, ready); await new Promise(r => { release = r; }); return reply(200, ok(JSON.parse(init.body).id)); });
  const provider = createRemoteDepthProvider({baseUrl:'http://127.0.0.1:49190/', fetchImpl:slow.fetchImpl});
  const first = provider.infer({frame, imageDataUrl});
  await assert.rejects(provider.infer({frame, imageDataUrl}), {code:'DEPTH_PROVIDER_BUSY'});
  while (!release) await new Promise(r => setImmediate(r));
  release();
  assert.deepEqual((await first).depth.validMask, [1,1,1,1]);
});

test('remote provider maps tunnel loss and remote errors to fixed codes and rechecks health', async () => {
  let down = true;
  const t = tunnel((path, init) => { if (down) throw new Error('ECONNREFUSED'); return path === '/health' ? reply(200, ready) : reply(200, {id:JSON.parse(init.body).id, status:'error', error:'DEPTH_INVALID_IMAGE'}); });
  const provider = createRemoteDepthProvider({baseUrl:'http://127.0.0.1:49190/', fetchImpl:t.fetchImpl});
  await assert.rejects(provider.infer({frame, imageDataUrl}), {code:'DEPTH_RUNTIME_UNAVAILABLE'});
  down = false;
  await assert.rejects(provider.infer({frame, imageDataUrl}), {code:'DEPTH_INVALID_IMAGE'});
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.infer({frame, imageDataUrl, signal:controller.signal}), {code:'DEPTH_CANCELLED'});
});

test('configured provider uses the Colab tunnel only when explicitly selected', () => {
  assert.equal(createConfiguredDepthProvider({PROMETHEUS_DEPTH_BACKEND:'colab', PROMETHEUS_DEPTH_REMOTE_URL:'http://127.0.0.1:49190/'}).kind, 'remote_depth_provider');
  assert.equal(createConfiguredDepthProvider({}).kind, 'local_depth_provider');
});

test('configured Colab provider defaults to a Fetch-compatible loopback port', async () => {
  const t = tunnel((path, init) => path === '/health' ? reply(200, ready) : reply(200, ok(JSON.parse(init.body).id)));
  const provider = createConfiguredDepthProvider({PROMETHEUS_DEPTH_BACKEND:'colab'}, {fetchImpl:t.fetchImpl});
  try {
    await provider.infer({frame, imageDataUrl});
    assert.ok(t.calls.every(([target]) => new URL(target).port === '49190'));
  } finally { await provider.close(); }
});
