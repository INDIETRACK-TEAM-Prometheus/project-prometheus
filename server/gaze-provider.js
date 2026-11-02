const MAX_FRAME_BYTES = 512 * 1024;
const MAX_ADAPTER_BYTES = 64 * 1024;
const ADAPTER_SHAPES = [[518,16],[16],[16,16],[16],[16,2],[2]];
const ADAPTER_ID = 'webeyetrack-gaze-mlp-f32-v1';
const MODEL_ID = 'webeyetrack-blazegaze-mpiifacegaze';
const SOURCE_COMMIT = '75fbd2f5f784f2eb3a39675a8dcbf1b01c697f1c';
const ADAPTER_KEYS = new Set(['schemaVersion', 'adapterId', 'modelId', 'sourceCommit', 'modelSha256', 'weights', 'affine']);
const MAX_CLICK_FRAMES = 3;
const fail = code => Object.assign(new Error(code), {code});
const finite = Number.isFinite;

function configuredBase(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new TypeError('invalid PROMETHEUS_GAZE_REMOTE_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('invalid PROMETHEUS_GAZE_REMOTE_URL');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url;
}

function validSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function validateRemoteGazeAdapter(adapter, model = {}) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter) || Buffer.byteLength(JSON.stringify(adapter)) > MAX_ADAPTER_BYTES ||
      adapter.schemaVersion !== 1 || adapter.adapterId !== ADAPTER_ID || adapter.modelId !== MODEL_ID || adapter.sourceCommit !== SOURCE_COMMIT ||
      !/^[a-f0-9]{64}$/i.test(adapter.modelSha256 ?? '') || adapter.modelSha256 !== model.sha256 || !Array.isArray(adapter.weights) || adapter.weights.length !== ADAPTER_SHAPES.length ||
      Object.keys(adapter).some(key => !ADAPTER_KEYS.has(key)) || ('affine' in adapter && !validAffine(adapter.affine))) return false;
  return adapter.weights.every((weight, index) => {
    const shape = ADAPTER_SHAPES[index];
    if (!weight || typeof weight !== 'object' || Array.isArray(weight) || weight.dtype !== 'float32-le' || JSON.stringify(weight.shape) !== JSON.stringify(shape) || typeof weight.data !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(weight.data)) return false;
    const bytes = Buffer.from(weight.data, 'base64');
    if (bytes.length !== shape.reduce((size, part) => size * part, 4) || bytes.toString('base64') !== weight.data) return false;
    for (let offset = 0; offset < bytes.length; offset += 4) if (!finite(bytes.readFloatLE(offset))) return false;
    return true;
  });
}

// The 2x3 calibration affine the GPU worker fits with the adapter (upstream WebEyeTrack applies it after the gaze MLP).
export function validAffine(value) {
  return Array.isArray(value) && value.length === 2 && value.every(row => Array.isArray(row) && row.length === 3 && row.every(x => finite(x) && Math.abs(x) <= 100));
}

export function validScreenCm(value) {
  return Array.isArray(value) && value.length === 2 && value.every(x => finite(x) && x > 0 && x <= 200);
}

function validEar(value) {
  if (value === null || value === undefined) return null;
  const ok = x => finite(x) && x >= 0 && x <= 2;
  return value && typeof value === 'object' && ok(value.left) && ok(value.right) && ok(value.threshold) ? {left: value.left, right: value.right, threshold: value.threshold} : null;
}

const TARGET_STATUSES = new Set(['accepted', 'insufficient', 'measured']);
const MAX_TARGET_FRAMES = 8;
const count = value => Number.isInteger(value) && value >= 0 && value <= 64;

export function validateCalibrationTargetRequest({phase, pointIndex, target, frames} = {}) {
  if (!['train', 'validate'].includes(phase) || !Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex > 26 ||
      !Array.isArray(target) || target.length !== 2 || !target.every(x => finite(x) && x >= -.5 && x <= .5) ||
      !Array.isArray(frames) || frames.length < 1 || frames.length > MAX_TARGET_FRAMES) throw fail('GAZE_INVALID_REQUEST');
  const ids = new Set();
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object' || Object.keys(frame).sort().join(',') !== 'captureTimestampMs,frameId,jpeg' ||
        !Number.isSafeInteger(frame.frameId) || frame.frameId < 1 || ids.has(frame.frameId) || !finite(frame.captureTimestampMs) || frame.captureTimestampMs < 0 ||
        typeof frame.jpeg !== 'string' || frame.jpeg.length < 8 || frame.jpeg.length > 700_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.jpeg) ||
        !Buffer.from(frame.jpeg, 'base64').subarray(0, 3).equals(Buffer.from([255, 216, 255]))) throw fail('GAZE_INVALID_REQUEST');
    ids.add(frame.frameId);
  }
  return {phase, pointIndex, target, frames: frames.map(frame => ({frameId: frame.frameId, captureTimestampMs: frame.captureTimestampMs, jpeg: frame.jpeg}))};
}

function sanitizeTargetResult(info, request) {
  const ear = info?.eyeAspectRatio;
  const validEarSummary = ear === null || (ear && finite(ear.min) && ear.min >= 0 && ear.min <= 2 && finite(ear.threshold) && ear.threshold >= 0 && ear.threshold <= 2);
  if (!TARGET_STATUSES.has(info?.status) || info.pointIndex !== request.pointIndex || info.phase !== request.phase || ![info.totalFrames, info.faceFrames, info.closedFrames, info.usableFrames, info.frameErrors, info.eyePatchFailures ?? 0].every(count) ||
      info.totalFrames !== request.frames.length || info.usableFrames > info.faceFrames || info.faceFrames > info.totalFrames || !validEarSummary ||
      (info.status === 'measured') !== (request.phase === 'validate' && info.normPog !== undefined) || (info.status === 'measured' && !Array.isArray(edgePog(info.normPog))) ||
      (info.status === 'measured' && request.phase !== 'validate') || (info.status === 'accepted' && request.phase !== 'train')) throw fail('GAZE_PROTOCOL_ERROR');
  return {status: info.status, phase: info.phase, pointIndex: info.pointIndex, totalFrames: info.totalFrames, faceFrames: info.faceFrames, closedFrames: info.closedFrames, usableFrames: info.usableFrames, frameErrors: info.frameErrors,
    eyePatchFailures: info.eyePatchFailures ?? 0, failureMessage: typeof info.failureMessage === 'string' && FAILURE_MESSAGE.test(info.failureMessage) ? info.failureMessage : null,
    eyeAspectRatio: ear === null || ear === undefined ? null : {min: ear.min, threshold: ear.threshold}, ...(info.status === 'measured' ? {normPog: edgePog(info.normPog)} : {}), ...(info.status === 'accepted' && count(info.collected) ? {collected: info.collected} : {})};
}

const FAILURE_MESSAGE = /^[A-Za-z0-9 _.,:()\[\]/=?-]{1,160}$/;
function validTrackingFailure(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || !['landmarks', 'eye_patch'].includes(value.stage)) return null;
  const message = typeof value.message === 'string' && FAILURE_MESSAGE.test(value.message) ? value.message : null;
  return {stage: value.stage, message};
}

// The calibration affine can place a gaze point slightly past the screen edge; that is a point at the edge, not a
// protocol error. Values far outside the screen (beyond one screen width/height from the centre) are still rejected.
export function edgePog(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 2 || !value.every(x => finite(x) && x >= -1 && x <= 1)) return undefined;
  return value.map(x => Math.min(.5, Math.max(-.5, x)));
}

export function createRemoteGazeProvider({baseUrl, fetchImpl = fetch, timeoutMs = 15000, healthTimeoutMs = 2500} = {}) {
  const base = configuredBase(baseUrl);
  const sessions = new Set();
  let model = null;

  async function request(path, {method = 'GET', headers = {}, body, signal, timeout = timeoutMs} = {}) {
    if (!base) throw fail('GAZE_REMOTE_NOT_CONFIGURED');
    if (signal?.aborted) throw fail('GAZE_CANCELLED');
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, timeout);
    signal?.addEventListener('abort', abort, {once: true});
    try {
      const response = await fetchImpl(new URL(path, base), {method, headers, body, signal: controller.signal});
      if (response.status === 429) throw fail('GAZE_PROVIDER_BUSY');
      if (!response.ok) {
        if (response.status === 404) throw fail('GAZE_SESSION_UNAVAILABLE');
        // The Colab worker reports why it refused (for example GAZE_FRAME_OUT_OF_ORDER or GAZE_INFERENCE_FAILED); keep that bounded token.
        let workerCode = null;
        try { const body = await response.json(); if (typeof body?.error === 'string' && /^GAZE_[A-Z_]{3,48}$/.test(body.error)) workerCode = body.error; } catch {}
        const rejected = fail(workerCode ?? 'GAZE_REMOTE_UNAVAILABLE');
        if (!workerCode) rejected.cause = `HTTP_${response.status}`;
        throw rejected;
      }
      if (response.status === 204) return null;
      try { return await response.json(); } catch { throw fail('GAZE_PROTOCOL_ERROR'); }
    } catch (error) {
      if (error?.code) throw error;
      if (signal?.aborted) throw fail('GAZE_CANCELLED');
      if (controller.signal.aborted) throw fail('GAZE_REMOTE_TIMEOUT');
      // Keep the network-level reason (for example ECONNRESET) as a bounded token so the server log can name it.
      const unavailable = fail('GAZE_REMOTE_UNAVAILABLE');
      const reason = error?.cause?.code ?? error?.cause?.name ?? error?.name;
      if (typeof reason === 'string' && /^[A-Za-z0-9_]{3,48}$/.test(reason)) unavailable.cause = reason;
      throw unavailable;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  const request_ = request;

  function requireSession(sessionId) {
    if (!validSessionId(sessionId) || !sessions.has(sessionId)) throw fail('GAZE_SESSION_UNAVAILABLE');
    return encodeURIComponent(sessionId);
  }

  return {
    kind: 'remote_gpu_gaze_provider',
    async health() {
      if (!base) return {ready: false, reason: 'not_configured'};
      try {
        const info = await request('health', {timeout: healthTimeoutMs});
        const ready=info?.status === 'ready' && info?.backend === 'colab_remote' && info?.device === 'cuda' && info?.model?.id===MODEL_ID && info?.model?.sourceCommit===SOURCE_COMMIT && /^[a-f0-9]{64}$/i.test(info?.model?.sha256??'');
        model=ready?{id:info.model.id,sourceCommit:info.model.sourceCommit,sha256:info.model.sha256}:null;
        return {ready,model};
      } catch {
        return {ready: false, reason: 'remote_unavailable'};
      }
    },
    async createSession({screenPxDimensions,screenCmDimensions,adapter} = {}) {
      if (screenPxDimensions !== undefined && (!Array.isArray(screenPxDimensions) || screenPxDimensions.length !== 2 || !screenPxDimensions.every(x => Number.isInteger(x) && x > 0 && x <= 10000))) throw fail('GAZE_INVALID_REQUEST');
      if (screenCmDimensions !== undefined && !validScreenCm(screenCmDimensions)) throw fail('GAZE_INVALID_REQUEST');
      if(adapter!==undefined){const health=await this.health();if(!health.ready)throw fail('GAZE_REMOTE_UNAVAILABLE');if(!validateRemoteGazeAdapter(adapter,health.model))throw fail('GAZE_ADAPTER_INCOMPATIBLE');}
      const body = {...(screenPxDimensions?{screenPxDimensions}:{}),...(screenCmDimensions?{screenCmDimensions}:{}),...(adapter?{adapter}:{})};
      const info = await request('sessions', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
      if (info?.status !== 'ready' || !validSessionId(info.sessionId) || !Number.isFinite(info.expiresInSeconds) || info.expiresInSeconds <= 0) throw fail('GAZE_PROTOCOL_ERROR');
      sessions.add(info.sessionId);
      if(typeof info.calibrated!=='boolean'||(adapter&&info.calibrated!==true))throw fail('GAZE_PROTOCOL_ERROR');
      return {sessionId: info.sessionId, expiresInSeconds: info.expiresInSeconds,calibrated:info.calibrated};
    },
    async frame({sessionId, frameId, captureTimestampMs, bytes, signal} = {}) {
      const id = requireSession(sessionId);
      if (!Number.isSafeInteger(frameId) || frameId < 1 || !finite(captureTimestampMs) || captureTimestampMs < 0 || !Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > MAX_FRAME_BYTES || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw fail('GAZE_INVALID_REQUEST');
      const result = await request(`sessions/${id}/frame`, {
        method: 'POST', headers: {'content-type': 'image/jpeg', 'x-frame-id': String(frameId), 'x-capture-timestamp-ms': String(captureTimestampMs)}, body: bytes, signal
      });
      if (result?.status !== 'ok' || result.frameId !== frameId || result.captureTimestampMs !== captureTimestampMs || typeof result.faceDetected !== 'boolean' || !['open', 'closed', 'unknown'].includes(result.gazeState) || edgePog(result.normPog) === undefined || !result.durations || !Object.values(result.durations).every(x => finite(x) && x >= 0)) throw fail('GAZE_PROTOCOL_ERROR');
      return {frameId, captureTimestampMs, faceDetected: result.faceDetected, gazeState: result.gazeState, normPog: edgePog(result.normPog), eyeAspectRatio: validEar(result.eyeAspectRatio), trackingFailure: validTrackingFailure(result.trackingFailure), durations: result.durations};
    },
    async startCandidate(sessionId, signal) {
      const id = requireSession(sessionId);
      const info = await request(`sessions/${id}/candidate/start`, {method: 'POST', signal});
      if (info?.status!=='started'||info.points!==0||info.requiredPoints!==27) throw fail('GAZE_PROTOCOL_ERROR');
      return {status: 'ready'};
    },
    // A short burst for one calibration target; train keeps the best open-eye frame, validate only measures.
    async calibrationTarget({sessionId, phase, pointIndex, target, frames, signal} = {}) {
      const id = requireSession(sessionId);
      const request = validateCalibrationTargetRequest({phase, pointIndex, target, frames});
      const info = await request_(`sessions/${id}/calibration/target`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(request), signal, timeout: 60000});
      return sanitizeTargetResult(info, request);
    },
    // Upstream click calibration: the user looked at the point they clicked; applies to this live session only.
    async clickCorrection({sessionId, target, frames, signal} = {}) {
      const id = requireSession(sessionId);
      if (!Array.isArray(frames) || frames.length > MAX_CLICK_FRAMES) throw fail('GAZE_INVALID_REQUEST');
      const checked = validateCalibrationTargetRequest({phase: 'train', pointIndex: 0, target, frames});
      const info = await request_(`sessions/${id}/calibration/click`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({target: checked.target, frames: checked.frames}), signal, timeout: 30000});
      if (!['adapted', 'insufficient'].includes(info?.status) || !count(info.usableFrames) || info.totalFrames !== checked.frames.length || info.usableFrames > info.totalFrames) throw fail('GAZE_PROTOCOL_ERROR');
      return {status: info.status, usableFrames: info.usableFrames, totalFrames: info.totalFrames};
    },
    async finalizeCandidate(sessionId, signal) {
      const id = requireSession(sessionId);
      const info = await request_(`sessions/${id}/candidate/adapt`, {method: 'POST', signal, timeout: 120000});
      if (info?.status !== 'adapted' || info.points !== 27) throw fail('GAZE_PROTOCOL_ERROR');
      return {adapted: true, points: 27};
    },
    async addCalibrationSample({sessionId, frameId, pointIndex, target, signal} = {}) {
      const id = requireSession(sessionId);
      if (!Number.isSafeInteger(frameId) || frameId < 1 || !Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex > 26 || !Array.isArray(target) || target.length !== 2 || !target.every(x => finite(x) && x >= -.5 && x <= .5)) throw fail('GAZE_INVALID_REQUEST');
      const info = await request(`sessions/${id}/calibration/sample`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({frameId, pointIndex, target}), signal});
      if (!['collecting', 'adapted'].includes(info?.status) || !Number.isInteger(info.points) || info.points !== pointIndex + 1) throw fail('GAZE_PROTOCOL_ERROR');
      return {adapted: info.status === 'adapted', points: info.points};
    },
    async acceptCandidate(sessionId) {
      const id = requireSession(sessionId);
      const info = await request(`sessions/${id}/candidate/accept`, {method: 'POST'});
      if (info?.status!=='accepted'||info.calibrated!==true||!validateRemoteGazeAdapter(info.adapter,model)) throw fail('GAZE_PROTOCOL_ERROR');
      return {status:'accepted',calibrated:true,adapter:info.adapter};
    },
    async discardCandidate(sessionId) {
      const id = requireSession(sessionId);
      const info = await request(`sessions/${id}/candidate/discard`, {method: 'POST'});
      if (info?.status!=='discarded') throw fail('GAZE_PROTOCOL_ERROR');
    },
    async deleteSession(sessionId) {
      const id = requireSession(sessionId);
      const info = await request(`sessions/${id}`, {method: 'DELETE'});
      if (info?.status !== 'disposed') throw fail('GAZE_PROTOCOL_ERROR');
      sessions.delete(sessionId);
    },
    async close() {
      await Promise.allSettled([...sessions].map(sessionId => this.deleteSession(sessionId)));
    }
  };
}

export function createConfiguredGazeProvider(env = process.env, options = {}) {
  const profile = env.PROMETHEUS_COMPUTE_PROFILE ?? 'cloud';
  if (!['cloud', 'local'].includes(profile)) throw new TypeError('PROMETHEUS_COMPUTE_PROFILE must be cloud or local');
  return profile === 'cloud'
    ? {profile, provider: createRemoteGazeProvider({baseUrl: env.PROMETHEUS_GAZE_REMOTE_URL, ...options})}
    : {profile, provider: null};
}
