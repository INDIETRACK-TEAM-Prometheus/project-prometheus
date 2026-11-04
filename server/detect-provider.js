import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

// Object boxes on the local CPU (scripts/detect/worker.py, RT-DETRv2 via Hugging Face transformers, Apache-2.0),
// reusing the depth runtime's Python: an auxiliary to SAM 3.1 that finds everything in the frame for Muse Spark to
// name. One request at a time; a busy worker answers DETECT_PROVIDER_BUSY.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultPython = path.join(projectRoot, '.asset-tmp', 'depth-runtime', 'venv312', 'Scripts', 'python.exe');
const defaultModel = 'PekingU/rtdetr_v2_r18vd';
// model weights are cached here (Hugging Face hub layout) and loaded offline after the first download
const modelCache = path.join(projectRoot, '.asset-tmp', 'rtdetr', 'hf');
const workerPath = path.join(projectRoot, 'scripts', 'detect', 'worker.py');
const fail = code => Object.assign(new Error(code), {code});
const codes = new Set(['DETECT_INVALID_REQUEST','DETECT_INVALID_FRAME','DETECT_INVALID_IMAGE','DETECT_INFERENCE_FAILED','DETECT_RUNTIME_UNAVAILABLE','DETECT_PROVIDER_BUSY','DETECT_PROVIDER_TIMEOUT','DETECT_PROVIDER_CLOSED','DETECT_CANCELLED']);
const IMAGE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

export function validDetectRequest(input) {
  const frame = input?.frame;
  return !!input && typeof input === 'object' && Object.keys(input).sort().join(',') === 'frame,imageDataUrl' &&
    frame && Object.keys(frame).sort().join(',') === 'frameId,height,observedAt,width' && typeof frame.frameId === 'string' && frame.frameId.trim() && frame.frameId.length <= 128 &&
    Number.isFinite(frame.observedAt) && frame.observedAt >= 0 && Number.isInteger(frame.width) && Number.isInteger(frame.height) && frame.width > 0 && frame.height > 0 && frame.width * frame.height <= 1048576 &&
    typeof input.imageDataUrl === 'string' && input.imageDataUrl.length <= 8 * 1024 * 1024 && IMAGE.test(input.imageDataUrl);
}

export function createDetectProvider({pythonPath = process.env.PROMETHEUS_DETECT_PYTHON || defaultPython, model = process.env.PROMETHEUS_DETECT_MODEL || defaultModel,
  spawnProcess = spawn, startupTimeoutMs = 120_000, requestTimeoutMs = 15_000} = {}) {
  let worker = null, starting = null, launching = null, pending = null, closed = false;

  function finish(error, value) {
    const job = pending; if (!job) return;
    pending = null; clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.abort);
    error ? job.reject(error) : job.resolve(value);
  }
  function stop(error = fail('DETECT_RUNTIME_UNAVAILABLE')) {
    const current = worker; worker = null; starting = null;
    if (current) { current.stopped = true; current.lines.close(); try { current.child.kill(); } catch {} }
    finish(error);
  }
  function ensureWorker() {
    if (closed) return Promise.reject(fail('DETECT_PROVIDER_CLOSED'));
    if (worker) return Promise.resolve(worker);
    starting ??= new Promise((resolve, reject) => {
      let child;
      try { child = spawnProcess(pythonPath, ['-u', workerPath, '--model', model], {cwd:projectRoot, windowsHide:true, stdio:['pipe','pipe','ignore'], env:{...process.env, HF_HOME:modelCache}}); }
      catch { starting = null; reject(fail('DETECT_RUNTIME_UNAVAILABLE')); return; }
      const lines = createInterface({input:child.stdout, crlfDelay:Infinity}), state = {child, lines, model:null, stopped:false};
      launching = child;
      let ready = false;
      const timer = setTimeout(() => { if (!ready) { starting = null; try { child.kill(); } catch {} reject(fail('DETECT_PROVIDER_TIMEOUT')); } }, startupTimeoutMs);
      timer.unref?.();
      lines.on('line', line => {
        let message; try { message = JSON.parse(line); } catch { return; }
        if (!ready) {
          clearTimeout(timer); starting = null; launching = null;
          if (message?.type !== 'ready' || message.status !== 'ready') { try { child.kill(); } catch {} reject(fail('DETECT_RUNTIME_UNAVAILABLE')); return; }
          ready = true; state.model = message.model; worker = state; resolve(state); return;
        }
        if (!pending || message?.id !== pending.id) return;
        if (message.status !== 'ok') { finish(fail(codes.has(message.error) ? message.error : 'DETECT_INFERENCE_FAILED')); return; }
        finish(null, {frame:message.frame, detections:message.detections, model:state.model, timing:message.timing});
      });
      child.once('error', () => { clearTimeout(timer); if (!ready) { starting = null; reject(fail('DETECT_RUNTIME_UNAVAILABLE')); } else if (worker === state) stop(); });
      child.once('close', () => { clearTimeout(timer); lines.close(); if (!ready) { starting = null; reject(fail('DETECT_RUNTIME_UNAVAILABLE')); } else if (worker === state && !state.stopped) stop(); });
    });
    return starting;
  }

  async function detect({frame, imageDataUrl, signal} = {}) {
    if (closed) throw fail('DETECT_PROVIDER_CLOSED');
    if (pending) throw fail('DETECT_PROVIDER_BUSY');
    if (signal?.aborted) throw fail('DETECT_CANCELLED');
    if (!validDetectRequest({frame, imageDataUrl})) throw fail('DETECT_INVALID_REQUEST');
    const id = randomUUID(), started = performance.now();
    const result = new Promise((resolve, reject) => {
      pending = {id, resolve, reject, signal, abort:() => finish(fail('DETECT_CANCELLED'))};
      signal?.addEventListener('abort', pending.abort, {once:true});
    });
    result.catch(() => {});
    const job = pending;
    try {
      const current = await ensureWorker();
      if (pending !== job) return await result;
      // the request timeout starts once the worker has the request (model load is covered by startupTimeoutMs)
      job.timer = setTimeout(() => { if (pending === job) stop(fail('DETECT_PROVIDER_TIMEOUT')); }, requestTimeoutMs);
      current.child.stdin.write(JSON.stringify({id, frame, imageDataUrl}) + '\n');
    } catch (error) { if (pending === job) finish(error?.code ? error : fail('DETECT_RUNTIME_UNAVAILABLE')); }
    const value = await result;
    return {...value, timing:{...value.timing, roundTripMs:Math.round(performance.now() - started)}};
  }

  async function close() {
    closed = true; stop(fail('DETECT_PROVIDER_CLOSED'));
    if (launching) { try { launching.kill(); } catch {} launching = null; }
  }
  // Starts the worker ahead of the first frame (model load and warm-up take a few seconds).
  function warm() { void ensureWorker().catch(() => {}); }
  return {kind:'local_detect_provider', detect, close, warm, status:() => ({available:!!worker, inFlight:!!pending, model:worker?.model ?? null})};
}
