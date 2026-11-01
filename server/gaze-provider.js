const MAX_FRAME_BYTES = 512 * 1024;
const MAX_ADAPTER_BYTES = 64 * 1024;
const ADAPTER_SHAPES = [[518,16],[16],[16,16],[16],[16,2],[2]];
const ADAPTER_ID = 'webeyetrack-gaze-mlp-f32-v1';
const MODEL_ID = 'webeyetrack-blazegaze-mpiifacegaze';
const SOURCE_COMMIT = '75fbd2f5f784f2eb3a39675a8dcbf1b01c697f1c';
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
      !/^[a-f0-9]{64}$/i.test(adapter.modelSha256 ?? '') || adapter.modelSha256 !== model.sha256 || !Array.isArray(adapter.weights) || adapter.weights.length !== ADAPTER_SHAPES.length) return false;
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

function validPog(value) {
  return value === null || (Array.isArray(value) && value.length === 2 && value.every(x => finite(x) && x >= -.5 && x <= .5));
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
        throw fail(workerCode ?? 'GAZE_REMOTE_UNAVAILABLE');
      }
      if (response.status === 204) return null;
      try { return await response.json(); } catch { throw fail('GAZE_PROTOCOL_ERROR'); }
    } catch (error) {
      if (error?.code) throw error;
      if (signal?.aborted) throw fail('GAZE_CANCELLED');
      if (controller.signal.aborted) throw fail('GAZE_REMOTE_TIMEOUT');
      throw fail('GAZE_REMOTE_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

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
    async createSession({screenPxDimensions,adapter} = {}) {
      if (screenPxDimensions !== undefined && (!Array.isArray(screenPxDimensions) || screenPxDimensions.length !== 2 || !screenPxDimensions.every(x => Number.isInteger(x) && x > 0 && x <= 10000))) throw fail('GAZE_INVALID_REQUEST');
      if(adapter!==undefined){const health=await this.health();if(!health.ready)throw fail('GAZE_REMOTE_UNAVAILABLE');if(!validateRemoteGazeAdapter(adapter,health.model))throw fail('GAZE_ADAPTER_INCOMPATIBLE');}
      const body = {...(screenPxDimensions?{screenPxDimensions}:{}),...(adapter?{adapter}:{})};
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
      if (result?.status !== 'ok' || result.frameId !== frameId || result.captureTimestampMs !== captureTimestampMs || typeof result.faceDetected !== 'boolean' || !['open', 'closed', 'unknown'].includes(result.gazeState) || !validPog(result.normPog) || !result.durations || !Object.values(result.durations).every(x => finite(x) && x >= 0)) throw fail('GAZE_PROTOCOL_ERROR');
      return {frameId, captureTimestampMs, faceDetected: result.faceDetected, gazeState: result.gazeState, normPog: result.normPog, durations: result.durations};
    },
    async startCandidate(sessionId, signal) {
      const id = requireSession(sessionId);
      const info = await request(`sessions/${id}/candidate/start`, {method: 'POST', signal});
      if (info?.status!=='started'||info.points!==0||info.requiredPoints!==27) throw fail('GAZE_PROTOCOL_ERROR');
      return {status: 'ready'};
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
