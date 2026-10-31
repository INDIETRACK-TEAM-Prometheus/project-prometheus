import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeHome = path.join(projectRoot, '.asset-tmp', 'depth-runtime');
const defaultPython = path.join(runtimeHome, 'venv312', 'Scripts', 'python.exe');
const workerPath = path.join(projectRoot, 'scripts', 'depth', 'worker.py');
const MODEL_ID = 'depth-anything/Depth-Anything-V2-Metric-Hypersim-Small';
const MODEL_SHA256 = 'b782898d8a3e8be1f639de33837ed85e9b4b73e40f8f5e5cd99067588d722545';
const SOURCE_COMMIT = 'a561b849ebae10a6f5ef49e26c83cbbcd36c71bf';
const MAX_PIXELS = 1024 * 1024;
const MAX_DIMENSION = 4096;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const fail = code => Object.assign(new Error(code), { code });
const providerCodes = new Set([
  'DEPTH_MODEL_MISSING', 'DEPTH_MODEL_HASH_MISMATCH', 'DEPTH_SOURCE_MISSING',
  'DEPTH_RUNTIME_UNAVAILABLE', 'DEPTH_MODEL_INVALID', 'DEPTH_INVALID_REQUEST',
  'DEPTH_INVALID_FRAME', 'DEPTH_INVALID_IMAGE', 'DEPTH_FRAME_MISMATCH',
  'DEPTH_INVALID_OUTPUT', 'DEPTH_INFERENCE_FAILED', 'DEPTH_REQUEST_TOO_LARGE',
  'DEPTH_PROVIDER_BUSY', 'DEPTH_PROVIDER_TIMEOUT', 'DEPTH_CANCELLED',
  'DEPTH_PROVIDER_CLOSED', 'DEPTH_PROVIDER_PROTOCOL_ERROR',
]);

function normalizedError(code) {
  return fail(providerCodes.has(code) ? code : 'DEPTH_RUNTIME_UNAVAILABLE');
}

function parseImage(imageDataUrl, frame) {
  if (typeof imageDataUrl !== 'string' || imageDataUrl.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 32) throw fail('DEPTH_INVALID_IMAGE');
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]*={0,2})$/.exec(imageDataUrl);
  if (!match || match[2].length % 4) throw fail('DEPTH_INVALID_IMAGE');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== match[2]) throw fail('DEPTH_INVALID_IMAGE');
  if (match[1] === 'png') {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw fail('DEPTH_INVALID_IMAGE');
    if (bytes.length < 24 || bytes.readUInt32BE(16) !== frame.width || bytes.readUInt32BE(20) !== frame.height) throw fail('DEPTH_FRAME_MISMATCH');
  } else if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw fail('DEPTH_INVALID_IMAGE');
  return imageDataUrl;
}

function validateFrame(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.frameId !== 'string' || !frame.frameId.trim() || frame.frameId.length > 128 || !Number.isFinite(frame.observedAt) || frame.observedAt < 0 || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width > MAX_DIMENSION || frame.height > MAX_DIMENSION || frame.width * frame.height > MAX_PIXELS) throw fail('DEPTH_INVALID_FRAME');
  return { frameId: frame.frameId, observedAt: frame.observedAt, width: frame.width, height: frame.height };
}

function validateReady(value) {
  const model = value?.model;
  if (value?.type !== 'ready' || value.status !== 'ready' || !model || model.id !== MODEL_ID || model.sha256 !== MODEL_SHA256 || model.license !== 'Apache-2.0' || model.sourceCommit !== SOURCE_COMMIT || model.units !== 'm' || model.convention !== 'axial_z' || model.device !== 'cpu' || !Number.isFinite(value.modelLoadMs) || value.modelLoadMs < 0) throw normalizedError(value?.error);
  return { ...model, modelLoadMs: value.modelLoadMs, pythonVersion: value.pythonVersion, torchVersion: value.torchVersion };
}

function decodeMap(message, frame, model) {
  if (message?.status !== 'ok' || message.frame?.frameId !== frame.frameId || message.frame?.observedAt !== frame.observedAt || message.width !== frame.width || message.height !== frame.height || message.units !== 'm' || message.convention !== 'axial_z' || message.depthSource !== 'monocular_estimated_depth' || message.model?.id !== model.id || message.model?.sha256 !== model.sha256 || !message.timing || !['decodeMs', 'inferenceMs', 'totalMs'].every(k => Number.isFinite(message.timing[k]) && message.timing[k] >= 0)) throw fail('DEPTH_PROVIDER_PROTOCOL_ERROR');
  const count = frame.width * frame.height;
  const valuesBytes = Buffer.from(message.valuesF32LE ?? '', 'base64');
  const maskBytes = Buffer.from(message.validMaskU8 ?? '', 'base64');
  if (valuesBytes.length !== count * 4 || maskBytes.length !== count || valuesBytes.toString('base64') !== message.valuesF32LE || maskBytes.toString('base64') !== message.validMaskU8 || message.summary?.validCount < 1 || message.summary?.validCount > count || message.summary?.invalidCount !== count - message.summary.validCount) throw fail('DEPTH_PROVIDER_PROTOCOL_ERROR');
  const values = new Array(count);
  const validMask = new Array(count);
  let validCount = 0;
  for (let i = 0; i < count; i++) {
    const value = valuesBytes.readFloatLE(i * 4);
    const valid = maskBytes[i];
    if ((valid !== 0 && valid !== 1) || !Number.isFinite(value) || (valid && (value <= 0 || value > 20)) || (!valid && value !== 0)) throw fail('DEPTH_PROVIDER_PROTOCOL_ERROR');
    values[i] = value;
    validMask[i] = valid;
    validCount += valid;
  }
  if (validCount !== message.summary.validCount) throw fail('DEPTH_PROVIDER_PROTOCOL_ERROR');
  return {
    frame: { frameId: frame.frameId, observedAt: frame.observedAt },
    depth: {
      frameId: frame.frameId,
      observedAt: frame.observedAt,
      width: frame.width,
      height: frame.height,
      values,
      validMask,
      units: 'm',
      convention: 'axial_z',
      depthSource: 'monocular_estimated_depth',
      provenance: `${model.id}:sha256:${model.sha256}`,
    },
    model: Object.fromEntries(Object.entries(model).filter(([key]) => key !== 'modelLoadMs')),
    timing: { ...message.timing, modelLoadMs: model.modelLoadMs },
  };
}

export function createDepthProvider({
  pythonPath = process.env.PROMETHEUS_DEPTH_PYTHON || defaultPython,
  home = runtimeHome,
  spawnProcess = spawn,
  startupTimeoutMs = 120_000,
  requestTimeoutMs = 90_000,
} = {}) {
  if (typeof pythonPath !== 'string' || typeof home !== 'string' || typeof spawnProcess !== 'function' || !Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0 || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new TypeError('invalid local depth provider configuration');
  let worker = null;
  let launching = null;
  let workerPromise = null;
  let pending = null;
  let closed = false;

  function stopWorker(error = fail('DEPTH_RUNTIME_UNAVAILABLE')) {
    const current = worker ?? launching;
    worker = null;
    launching = null;
    workerPromise = null;
    if (current) {
      current.intentionalStop = true;
      current.lines.close();
      try { current.child.kill(); } catch {}
    }
    if (pending) finishPending(error);
  }

  function finishPending(error, value) {
    const job = pending;
    if (!job) return;
    pending = null;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    error ? job.reject(error) : job.resolve(value);
  }

  function ensureWorker() {
    if (closed) return Promise.reject(fail('DEPTH_PROVIDER_CLOSED'));
    if (worker) return Promise.resolve(worker);
    if (workerPromise) return workerPromise;
    workerPromise = new Promise((resolve, reject) => {
      let settled = false;
      let outputBytes = 0;
      let startupTimer;
      let readyInfo = null;
      let child;
      try {
        child = spawnProcess(pythonPath, ['-u', workerPath, '--home', home], {
          cwd: projectRoot,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
          env: { ...process.env, TEMP: path.join(home, 'temp'), TMP: path.join(home, 'temp') },
        });
      } catch {
        workerPromise = null;
        reject(fail('DEPTH_RUNTIME_UNAVAILABLE'));
        return;
      }
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const state = { child, lines, model: null, intentionalStop: false };
      launching = state;
      const clearStartup = () => clearTimeout(startupTimer);
      const startupFailure = error => {
        if (settled) return;
        settled = true;
        clearStartup();
        workerPromise = null;
        if (launching === state) launching = null;
        state.intentionalStop = true;
        lines.close();
        try { child.kill(); } catch {}
        reject(error);
      };
      startupTimer = setTimeout(() => startupFailure(fail('DEPTH_PROVIDER_TIMEOUT')), startupTimeoutMs);
      lines.on('line', line => {
        outputBytes += Buffer.byteLength(line) + 1;
        if (outputBytes > MAX_RESPONSE_BYTES) {
          if (!readyInfo) startupFailure(fail('DEPTH_PROVIDER_PROTOCOL_ERROR'));
          else stopWorker(fail('DEPTH_PROVIDER_PROTOCOL_ERROR'));
          return;
        }
        let message;
        try { message = JSON.parse(line); } catch {
          if (!readyInfo) startupFailure(fail('DEPTH_PROVIDER_PROTOCOL_ERROR'));
          else stopWorker(fail('DEPTH_PROVIDER_PROTOCOL_ERROR'));
          return;
        }
        outputBytes = 0;
        if (!readyInfo) {
          try { readyInfo = validateReady(message); } catch (error) { startupFailure(error); return; }
          state.model = readyInfo;
          worker = state;
          if (launching === state) launching = null;
          settled = true;
          clearStartup();
          resolve(state);
          return;
        }
        if (!pending || message.id !== pending.id) { stopWorker(fail('DEPTH_PROVIDER_PROTOCOL_ERROR')); return; }
        if (message.status === 'error') { finishPending(normalizedError(message.error)); return; }
        try { finishPending(null, decodeMap(message, pending.frame, readyInfo)); }
        catch { finishPending(fail('DEPTH_PROVIDER_PROTOCOL_ERROR')); }
      });
      child.once('error', () => {
        if (!readyInfo) startupFailure(fail('DEPTH_RUNTIME_UNAVAILABLE'));
        else stopWorker(fail('DEPTH_RUNTIME_UNAVAILABLE'));
      });
      child.once('close', () => {
        lines.close();
        if (!readyInfo) startupFailure(fail('DEPTH_RUNTIME_UNAVAILABLE'));
        else if (worker === state && !state.intentionalStop) stopWorker(fail('DEPTH_RUNTIME_UNAVAILABLE'));
      });
    });
    return workerPromise;
  }

  async function infer({ frame, imageDataUrl, signal } = {}) {
    if (closed) throw fail('DEPTH_PROVIDER_CLOSED');
    if (pending) throw fail('DEPTH_PROVIDER_BUSY');
    if (signal?.aborted) throw fail('DEPTH_CANCELLED');
    const alignedFrame = validateFrame(frame);
    const image = parseImage(imageDataUrl, alignedFrame);
    const id = randomUUID();
    const started = performance.now();
    let resolveJob;
    let rejectJob;
    const jobPromise = new Promise((resolve, reject) => { resolveJob = resolve; rejectJob = reject; });
    jobPromise.catch(() => {});
    const job = { id, frame: alignedFrame, resolve: resolveJob, reject: rejectJob, signal, abort: null, timer: null };
    job.abort = () => {
      if (pending === job) {
        stopWorker(fail('DEPTH_CANCELLED'));
      }
    };
    job.timer = setTimeout(() => {
      if (pending === job) stopWorker(fail('DEPTH_PROVIDER_TIMEOUT'));
    }, requestTimeoutMs);
    pending = job;
    signal?.addEventListener('abort', job.abort, { once: true });
    try {
      const current = await ensureWorker();
      if (pending !== job) return await jobPromise;
      const request = JSON.stringify({ id, frame: alignedFrame, imageDataUrl: image });
      if (Buffer.byteLength(request) + 1 > 8 * 1024 * 1024) throw fail('DEPTH_REQUEST_TOO_LARGE');
      current.child.stdin.write(request + '\n', error => {
        if (error && pending === job) stopWorker(fail('DEPTH_RUNTIME_UNAVAILABLE'));
      });
      const result = await jobPromise;
      result.timing.requestRoundTripMs = roundMs(performance.now() - started);
      return result;
    } catch (error) {
      if (pending === job) finishPending(error?.code ? normalizedError(error.code) : fail('DEPTH_RUNTIME_UNAVAILABLE'));
      return await jobPromise;
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (pending) finishPending(fail('DEPTH_PROVIDER_CLOSED'));
    const current = worker;
    worker = null;
    workerPromise = null;
    if (launching) {
      const starter = launching;
      launching = null;
      starter.intentionalStop = true;
      starter.lines.close();
      try { starter.child.kill(); } catch {}
    }
    if (!current) return;
    current.intentionalStop = true;
    current.lines.close();
    try { current.child.stdin.end(); } catch {}
    await new Promise(resolve => {
      const timer = setTimeout(() => { try { current.child.kill(); } catch {} resolve(); }, 1000);
      current.child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }

  function status() {
    return { available: !!worker, inFlight: !!pending, closed, model: worker ? { id: worker.model.id, sha256: worker.model.sha256, device: worker.model.device } : null };
  }

  return { kind: 'local_depth_provider', infer, close, status };
}

function roundMs(value) { return Math.round(value * 1000) / 1000; }

