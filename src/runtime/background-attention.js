import {DependencyCache} from './cache.js';
import {validateScenarios} from './contracts.js';
import {validateNextGaze} from './next-gaze.js';

const text = value => typeof value === 'string' && value.trim().length > 0;
const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const ids = (value, max = 512) => Array.isArray(value) && value.length <= max && value.every(text) && new Set(value).size === value.length;
const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

function stateKey(snapshot, sessionId) {
  if (snapshot.stateKey !== undefined) {
    if (!text(snapshot.stateKey) || snapshot.stateKey.length > 256) throw new TypeError('invalid stateKey');
    return snapshot.stateKey;
  }
  const gaze = snapshot.gaze;
  const attention = gaze == null ? null : {
    x: Number.isFinite(gaze.x) ? Math.round(gaze.x * 100) / 100 : null,
    y: Number.isFinite(gaze.y) ? Math.round(gaze.y * 100) / 100 : null,
    targetId: gaze.targetId ?? gaze.objectId ?? null,
    status: gaze.status ?? null
  };
  const d = snapshot.dependencies;
  return stable({
    sessionId,
    mapId: d.mapId,
    mapVersion: d.mapVersion,
    objectIds: [...d.objectIds].sort(),
    candidates: candidateIds(snapshot).sort(),
    attention,
    eventIds: (snapshot.events ?? []).map(event => event.eventId).sort(),
    memoryIds: (snapshot.context?.memory ?? []).map(item => item.evidenceId).sort(),
    attentionVersion: snapshot.attentionVersion ?? null
  });
}

function candidateIds(snapshot) {
  const candidates = snapshot.candidates ?? snapshot.scene?.candidates ?? [];
  if (!Array.isArray(candidates) || candidates.length > 128 || candidates.some(item => !text(item?.objectId))) throw new TypeError('invalid candidates');
  const ids = candidates.map(item => item.objectId);
  if (new Set(ids).size !== ids.length) throw new TypeError('duplicate candidates');
  return ids;
}

function normalizeSnapshot(input, sessionId, sequence, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('snapshot required');
  const snapshot = structuredClone(input);
  const frame = snapshot.frame;
  const dependencies = snapshot.dependencies;
  if (!frame || !text(frame.frameId) || !time(frame.observedAt) || !time(frame.processedAt) || frame.processedAt < frame.observedAt || frame.processedAt > now) throw new TypeError('invalid frame snapshot');
  if (!dependencies || !text(dependencies.mapId) || !Number.isInteger(dependencies.mapVersion) || dependencies.mapVersion < 0 || !ids(dependencies.objectIds) || !ids(dependencies.evidenceIds)) throw new TypeError('invalid dependencies');
  if (dependencies.expiresAt != null && (!time(dependencies.expiresAt) || dependencies.expiresAt <= now)) throw new TypeError('expired dependencies');
  const cutoff = snapshot.observedUntil ?? Math.max(frame.observedAt, snapshot.gaze?.observedAt ?? 0);
  const processedAt = snapshot.processedAt ?? Math.max(frame.processedAt, snapshot.gaze?.processedAt ?? 0);
  if (!time(cutoff) || cutoff > now || cutoff < frame.observedAt || !time(processedAt) || processedAt < cutoff || processedAt > now) throw new TypeError('invalid causal cutoff');
  if (snapshot.gaze != null) {
    const gaze = snapshot.gaze;
    if (!time(gaze.observedAt) || !time(gaze.processedAt) || gaze.observedAt > cutoff || gaze.processedAt < gaze.observedAt || gaze.processedAt > processedAt || (gaze.frameId != null && gaze.frameId !== frame.frameId)) throw new TypeError('invalid gaze snapshot');
  }
  const records = [frame, ...(snapshot.evidence ?? []), ...(snapshot.events ?? []), ...(snapshot.context?.memory ?? [])];
  if (!Array.isArray(snapshot.evidence ?? []) || !Array.isArray(snapshot.events ?? []) || !Array.isArray(snapshot.context?.memory ?? [])) throw new TypeError('invalid evidence snapshot');
  const knownEvidence = new Set();
  for (const record of records) {
    const id = record.evidenceId ?? record.eventId ?? record.id ?? record.frameId;
    if (!text(id) || !time(record.observedAt) || !time(record.processedAt) || record.observedAt > cutoff || record.processedAt < record.observedAt || record.processedAt > processedAt || (record.causalStatus != null && record.causalStatus !== 'online_causal')) throw new TypeError('noncausal evidence');
    knownEvidence.add(id);
  }
  if (dependencies.evidenceIds.some(id => !knownEvidence.has(id))) throw new TypeError('unknown evidence dependency');
  candidateIds(snapshot);
  if (frame.imageData != null && (typeof frame.imageData !== 'string' || frame.imageData.length > 6000000)) throw new TypeError('invalid frame image');
  if (frame.rgba != null && (!(frame.rgba instanceof Uint8Array || frame.rgba instanceof Uint8ClampedArray) || frame.rgba.byteLength > 4 * 1024 * 1024)) throw new TypeError('invalid frame pixels');
  return {...snapshot, sessionId, sequence, observedUntil:cutoff, processedAt, queuedAt:now, stateKey:stateKey(snapshot, sessionId)};
}

function cacheId(sessionId, key) {
  // FNV-1a keeps cache keys bounded; dependencies are still checked separately.
  let hash = 0xcbf29ce484222325n;
  for (const char of `${sessionId}\u0000${key}`) {
    hash ^= BigInt(char.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `attention:${hash.toString(16)}`;
}

const HEX64 = /^[0-9a-f]{64}$/;
const boxKeys = 'bottom,left,right,top';
// Candidates carry persistent local track IDs; only linked tracks may appear. Digest/area/status are optional provenance.
function validateCandidateSpace(space, snapshot) {
  if (space == null) return snapshot.candidates ?? snapshot.scene?.candidates ?? [];
  const frame = snapshot.frame;
  const keys = space && typeof space === 'object' && !Array.isArray(space) ? Object.keys(space).sort().join(',') : '';
  if (!['candidates,frameId,observedAt', 'candidates,frameId,observedAt,provenance'].includes(keys) || space.frameId !== frame.frameId || space.observedAt !== frame.observedAt || !Array.isArray(space.candidates) || space.candidates.length < 1 || space.candidates.length > 10 || !Number.isInteger(frame.width) || !Number.isInteger(frame.height)) throw new TypeError('invalid candidate space');
  const provenance = space.provenance;
  if (provenance !== undefined && (!provenance || typeof provenance !== 'object' || Array.isArray(provenance) || Object.keys(provenance).sort().join(',') !== 'frameId,observedAt,samModel,samRequestId' || provenance.frameId !== frame.frameId || provenance.observedAt !== frame.observedAt || (provenance.samModel !== null && (!text(provenance.samModel) || provenance.samModel.length > 128)) || (provenance.samRequestId !== null && (!text(provenance.samRequestId) || provenance.samRequestId.length > 128)))) throw new TypeError('invalid candidate space');
  const seen = new Set();
  for (const candidate of space.candidates) {
    const bounds = candidate?.bounds;
    const extra = Object.keys(candidate ?? {}).filter(key => !['bounds', 'objectId'].includes(key));
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !text(candidate.objectId) || candidate.objectId.length > 128 || seen.has(candidate.objectId) || extra.some(key => !['maskDigest', 'identityStatus', 'area'].includes(key)) ||
      (candidate.maskDigest !== undefined && !HEX64.test(candidate.maskDigest)) || (candidate.identityStatus !== undefined && candidate.identityStatus !== 'linked') || (candidate.area !== undefined && !(Number.isInteger(candidate.area) && candidate.area >= 0)) ||
      !bounds || typeof bounds !== 'object' || Array.isArray(bounds) || Object.keys(bounds).sort().join(',') !== boxKeys || !['left','top','right','bottom'].every(key=>Number.isInteger(bounds[key])) || bounds.left<0 || bounds.top<0 || bounds.right>frame.width || bounds.bottom>frame.height || bounds.right<=bounds.left || bounds.bottom<=bounds.top) throw new TypeError('invalid candidate space');
    seen.add(candidate.objectId);
  }
  return space.candidates;
}

function validatePrepared(value, snapshot, now, evidenceIds = snapshot.dependencies.evidenceIds) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.scenarios)) throw new TypeError('invalid prepared result');
  validateScenarios(value.scenarios);
  const evidence = new Set(evidenceIds);
  if (value.scenarios.some(scenario => scenario.grounding_refs.some(id => !evidence.has(id)))) throw new TypeError('unknown grounding evidence');
  const nextGaze = value.nextGaze ?? null;
  const candidates = validateCandidateSpace(value.candidateSpace, snapshot);
  validateNextGaze(nextGaze, candidates);
  if (!candidates.length && nextGaze !== null) throw new TypeError('next gaze without candidates');
  const observedUntil = value.observedUntil ?? snapshot.observedUntil;
  if (!time(observedUntil) || observedUntil > snapshot.observedUntil) throw new TypeError('prepared result exceeds causal cutoff');
  const expiresAt = value.expiresAt ?? snapshot.dependencies.expiresAt;
  if (expiresAt != null && (!time(expiresAt) || expiresAt <= now)) throw new TypeError('prepared result expired');
  return {scenarios:structuredClone(value.scenarios), nextGaze:structuredClone(nextGaze), ...(value.candidateSpace ? {candidateSpace:structuredClone(value.candidateSpace)} : {}), observedUntil, expiresAt:expiresAt ?? null, frameId:value.frameId ?? snapshot.frame.frameId, dependencies:structuredClone(value.dependencies ?? snapshot.dependencies)};
}

// Nearest-rank percentile over a bounded sample; null when empty.
export function percentile(values, p) {
  if (!Array.isArray(values) || !values.length || !(p >= 0 && p <= 100)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)];
}
const summary = values => ({n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: values.length ? Math.max(...values) : null});
const round = value => value === null ? null : Math.round(value * 1000) / 1000;

export class BackgroundAttentionCoordinator {
  constructor({work, publish = () => {}, nextTargets = null, lookupPrepared = null, cache = null, maxCacheEntries = 256, cacheTtlMs = 30000, refreshIntervalMs = cacheTtlMs, snapshot = null, now = () => performance.now(), intervalMs = 250, minIntervalMs = 1000, timeoutMs = 30000, retryIntervalMs = 5000, onStatus = () => {}, deadlineMs = 200, telemetrySamples = 256, telemetryWindowMs = 60000} = {}) {
    if (typeof work !== 'function' || typeof publish !== 'function' || (nextTargets !== null && typeof nextTargets !== 'function') || (lookupPrepared !== null && typeof lookupPrepared !== 'function') || (snapshot !== null && typeof snapshot !== 'function') || typeof now !== 'function' || typeof onStatus !== 'function' || !time(cacheTtlMs) || cacheTtlMs === 0 || !time(refreshIntervalMs) || refreshIntervalMs === 0 || !time(intervalMs) || intervalMs === 0 || !time(minIntervalMs) || !time(timeoutMs) || timeoutMs === 0 || !time(retryIntervalMs) || !time(deadlineMs) || deadlineMs === 0 || !Number.isInteger(telemetrySamples) || telemetrySamples < 1 || telemetrySamples > 4096 || !time(telemetryWindowMs) || telemetryWindowMs === 0) throw new TypeError('invalid background attention configuration');
    Object.assign(this, {deadlineMs, telemetrySamples, telemetryWindowMs, work, publish, nextTargets, lookupPrepared, snapshot, now, intervalMs, minIntervalMs, timeoutMs, retryIntervalMs, refreshIntervalMs, onStatus});
    this.cache = cache ?? new DependencyCache(maxCacheEntries);
    this.cacheTtlMs = cacheTtlMs;
    this.phase = 'stopped'; this.sessionId = null; this.running = false; this.pending = null; this.current = null;
    this.lifecycle = 0; this.sequence = 0; this.dispatchTimer = null; this.pollTimer = null; this.lastDispatchAt = -Infinity;
    this.lastStateKey = null; this.lastFailure = null; this.lastPublishedAt = -Infinity; this.latest = null; this.previousSnapshot = null;
    this.epochs = new Map();
    this.workAt = [];
    this.lastPublishedSequence = -1;
    this._resetTelemetry();
    this.metrics = {observed:0, accepted:0, duplicates:0, coalesced:0, dropped:0, cacheLookups:0, cacheHits:0, cacheErrors:0, workCalls:0, workFailures:0, nextTargetCalls:0, nextTargetFailures:0, timeouts:0, invalidations:0, invalidatedResults:0, lifecycleResults:0, published:0, publishFailures:0, snapshotFailures:0, maxConcurrent:0, maxPending:0, totalWorkMs:0, lastWorkMs:null, totalQueueMs:0, lastQueueMs:null, lastSourceAgeMs:null};
    if (this.cache === null || typeof this.cache.get !== 'function' || typeof this.cache.put !== 'function' || typeof this.cache.invalidate !== 'function') throw new TypeError('invalid dependency cache');
  }

  start(sessionId) {
    if (!text(sessionId)) throw new TypeError('sessionId required');
    if (this.phase !== 'stopped') this.stop();
    this.lifecycle++; this.phase = 'running'; this.sessionId = sessionId; this.pending = null; this.lastStateKey = null; this.lastFailure = null; this.lastPublishedAt = -Infinity; this.previousSnapshot = null;
    this.lastPublishedSequence = -1; this._resetTelemetry();
    this._schedulePoll(0);
    this._status('started');
    return this.status();
  }

  observe(input) {
    if (this.phase !== 'running') return {accepted:false, reason:this.phase};
    const now = this.now(); if (!time(now)) throw new TypeError('invalid clock');
    const request = normalizeSnapshot(input, this.sessionId, ++this.sequence, now);
    this.metrics.observed++; this.tel.counts.observed++;
    this._invalidateSnapshotChanges(request);
    this.latest = request;
    this.previousSnapshot = request;
    if (request.dependencies.expiresAt != null && request.dependencies.expiresAt <= now) return {accepted:false, reason:'expired'};
    const sameAsPending = this.pending?.stateKey === request.stateKey;
    const sameAsCurrent = this.current?.request.stateKey === request.stateKey;
    if (!this.pending && !this.running && request.stateKey === this.lastStateKey && !this.lastFailure && now - this.lastPublishedAt < this.refreshIntervalMs) { this.metrics.duplicates++; return {accepted:false, reason:'duplicate'}; }
    if (sameAsCurrent && !this.pending) { this.metrics.duplicates++; return {accepted:false, reason:'duplicate'}; }
    if (this.lastFailure?.stateKey === request.stateKey && now - this.lastFailure.at < this.retryIntervalMs) { this.metrics.duplicates++; return {accepted:false, reason:'retry_limited'}; }
    if (this.running) {
      if (this.pending && this.pending.stateKey !== request.stateKey) { this.metrics.dropped++; this.metrics.coalesced++; this.tel.counts.dropped++; }
      this.pending = request;
      this.metrics.maxPending = Math.max(this.metrics.maxPending, 1);
    } else {
      this.pending = request;
      this._drain();
    }
    this.metrics.accepted++;
    this._status('observed');
    return {accepted:true, coalesced:sameAsPending};
  }

  pause() {
    if (this.phase !== 'running') return false;
    this.phase = 'paused'; this.lifecycle++; this._clearTimers(); this.pending = null;
    this.current?.controller.abort();
    this._status('paused');
    return true;
  }

  resume() {
    if (this.phase !== 'paused') return false;
    this.phase = 'running'; this.lifecycle++; this._schedulePoll(0); this._status('resumed');
    return true;
  }

  stop() {
    if (this.phase === 'stopped') return false;
    const sessionId = this.sessionId;
    this.phase = 'stopped'; this.lifecycle++; this._clearTimers(); this.pending = null; this.current?.controller.abort();
    if (this.cache.entries instanceof Map) for (const [id, entry] of this.cache.entries) if (entry.sessionId === sessionId) this.cache.entries.delete(id);
    this.sessionId = null; this.lastStateKey = null; this.lastFailure = null; this.previousSnapshot = null;
    this._status('stopped');
    return true;
  }

  invalidate(change) {
    const sessionId = change?.sessionId ?? this.sessionId;
    if (!text(sessionId) || !change || !['map','object_moved','object_deleted','identity_changed','observation_conflict','evidence_withdrawn'].includes(change.type)) throw new TypeError('invalid dependency invalidation');
    if (change.type === 'map' && !text(change.mapId)) throw new TypeError('mapId required');
    if (['object_moved','object_deleted','identity_changed','observation_conflict'].includes(change.type) && !text(change.objectId)) throw new TypeError('objectId required');
    if (change.type === 'evidence_withdrawn' && !text(change.evidenceId)) throw new TypeError('evidenceId required');
    const key = change.type === 'map' ? `map:${sessionId}:${change.mapId}` : change.type === 'evidence_withdrawn' ? `evidence:${sessionId}:${change.evidenceId}` : `object:${sessionId}:${change.objectId}`;
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
    this.metrics.invalidations++;
    const removed = this.cache.invalidate({...change, sessionId});
    if (this.latest?.sessionId === sessionId && this._changeAffects(change, this.latest)) this.lastStateKey = null;
    if (this.current && this.current.request.sessionId === sessionId && this._changeAffects(change, this.current.request)) this.current.controller.abort();
    if (this.pending && this.pending.sessionId === sessionId && this._changeAffects(change, this.pending)) this.pending = null;
    this._status('invalidated');
    return removed;
  }

  getPrepared(input = this.latest) {
    if (!input || !this.sessionId) return null;
    const request = input.sessionId ? input : normalizeSnapshot(input, this.sessionId, this.sequence, this.now());
    const entry = this.cache.get(cacheId(request.sessionId, request.stateKey), {sessionId:request.sessionId, mapId:request.dependencies.mapId, mapVersion:request.dependencies.mapVersion, now:this.now()});
    if (!entry || !this._cacheObjectsStillPresent(entry, request)) return null;
    return structuredClone(entry.prepared);
  }

  status() {
    const now = this.now();
    this.workAt = this.workAt.filter(at => now >= at && now - at < 60000);
    const work = this.metrics.workCalls;
    return {phase:this.phase, active:this.phase === 'running', paused:this.phase === 'paused', running:this.running, pending:!!this.pending, maxPending:1, metrics:{...this.metrics, generationCallsPerMinute:this.workAt.length, averageWorkMs:work ? this.metrics.totalWorkMs / work : null}};
  }

  _invalidateSnapshotChanges(request) {
    const previous = this.previousSnapshot;
    if (!previous || previous.sessionId !== request.sessionId) return;
    const old = previous.dependencies, next = request.dependencies;
    if (old.mapId !== next.mapId || old.mapVersion !== next.mapVersion) this.invalidate({type:'map', mapId:old.mapId, sessionId:request.sessionId});
    const oldObjects = new Set(old.objectIds), nextObjects = new Set(next.objectIds);
    for (const id of oldObjects) if (!nextObjects.has(id)) this.invalidate({type:'object_deleted', objectId:id, sessionId:request.sessionId});
    for (const id of oldObjects) {
      if (nextObjects.has(id) && old.objectVersions?.[id] !== undefined && next.objectVersions?.[id] !== undefined && old.objectVersions[id] !== next.objectVersions[id]) this.invalidate({type:'object_moved', objectId:id, sessionId:request.sessionId});
      if (nextObjects.has(id) && old.identityVersions?.[id] !== undefined && next.identityVersions?.[id] !== undefined && old.identityVersions[id] !== next.identityVersions[id]) this.invalidate({type:'identity_changed', objectId:id, sessionId:request.sessionId});
    }
  }

  _snapshotTokens(request) {
    const d = request.dependencies, sessionId = request.sessionId;
    const keys = [`map:${sessionId}:${d.mapId}`, ...d.objectIds.map(id => `object:${sessionId}:${id}`), ...d.evidenceIds.map(id => `evidence:${sessionId}:${id}`)];
    return keys.map(key => [key, this.epochs.get(key) ?? 0]);
  }

  _contextAffected(context) {
    return context.tokens.some(([key, version]) => (this.epochs.get(key) ?? 0) !== version);
  }

  _changeAffects(change, request) {
    if (request.sessionId !== (change.sessionId ?? this.sessionId)) return false;
    const d = request.dependencies;
    if (change.type === 'map') return d.mapId === change.mapId;
    if (change.type === 'evidence_withdrawn') return d.evidenceIds.includes(change.evidenceId);
    return d.objectIds.includes(change.objectId);
  }

  _cacheObjectsStillPresent(entry, request) {
    // Persistent track IDs are only known after segmentation, so presence is checked against the snapshot-time list.
    const current = new Set(request.dependencies.objectIds), present = entry.snapshotObjectIds ?? entry.objectIds;
    return Array.isArray(entry.objectIds) && Array.isArray(present) && present.every(id => current.has(id));
  }

  _drain() {
    if (this.phase !== 'running' || this.running || !this.pending) return;
    const wait = this.minIntervalMs - (this.now() - this.lastDispatchAt);
    if (wait > 0) {
      if (this.dispatchTimer === null) this.dispatchTimer = setTimeout(() => { this.dispatchTimer = null; this._drain(); }, wait);
      return;
    }
    const request = this.pending; this.pending = null; this.running = true; this.lastDispatchAt = this.now();
    this.metrics.maxConcurrent = Math.max(this.metrics.maxConcurrent, 1);
    void this._execute(request);
  }

  async _execute(request) {
    const controller = new AbortController();
    const context = {request, controller, lifecycle:this.lifecycle, tokens:this._snapshotTokens(request)};
    this.current = context;
    const queuedAt = request.queuedAt ?? request.processedAt;
    this.metrics.lastQueueMs = Math.max(0, this.now() - queuedAt); this.metrics.totalQueueMs += this.metrics.lastQueueMs;
    const cycle = context.cycle = {sequence:request.sequence, snapshotAt:request.processedAt, observedUntil:request.observedUntil, queuedAt, dispatchAt:this.now(), samDoneAt:null, reasonFirstByteAt:null, doneAt:null, publishedAt:null, outcome:null, tel:this.tel};
    let timer, generated = false, prepared = null, cacheLookupMs = 0, generationMs = null, nextTargetsMs = null;
    const isLive = () => this.phase === 'running' && this.sessionId === request.sessionId && this.lifecycle === context.lifecycle && !controller.signal.aborted && !this._contextAffected(context);
    const stamps = {samDone:'samDoneAt', reasonFirstByte:'reasonFirstByteAt'};
    // Work may report stage times and tracker-driven invalidations; both are ignored once the cycle is no longer live.
    const mark = name => { const key = stamps[name]; if (key && cycle[key] === null && isLive()) cycle[key] = this.now(); };
    const invalidate = change => isLive() ? this.invalidate(change) : 0;
    try {
      timer = setTimeout(() => { this.metrics.timeouts++; this.tel.counts.timeouts++; controller.abort(); this._status('timeout'); }, this.timeoutMs);
      const cacheStarted = this.now();
      prepared = this._cached(request);
      if (!prepared && this.lookupPrepared && isLive()) {
        this.metrics.cacheLookups++;
        try {
          const value = await this.lookupPrepared(structuredClone(request), {signal:controller.signal, now:this.now()});
          if (isLive() && value != null && this._externalCacheCompatible(value, request)) {
            const record = value.prepared ?? value;
            prepared = validatePrepared(record, request, this.now(), value.evidenceIds ?? record.dependencies?.evidenceIds ?? request.dependencies.evidenceIds);
            this.metrics.cacheHits++;
          }
        } catch { if (isLive()) this.metrics.cacheErrors++; }
      }
      cacheLookupMs = Math.max(0, this.now() - cacheStarted);
      if (!prepared && isLive()) {
        this.metrics.workCalls++;
        this.workAt.push(this.now());
        this.workAt = this.workAt.filter(at => this.now() >= at && this.now() - at < 60000);
        const generateStarted = this.now();
        let output;
        try {
          output = await this.work(structuredClone(request), {signal:controller.signal, mark, invalidate});
          if (!isLive()) { this._recordDiscard(context); return; }
          if (!output || !Array.isArray(output.scenarios)) throw new TypeError('hypothesis result required');
          const merged = structuredClone(request.dependencies);
          const extra = output.objectDependencies ?? null;
          if (extra !== null) {
            const versions = extra?.objectVersions;
            if (!extra || typeof extra !== 'object' || Array.isArray(extra) || !ids(extra.objectIds, 128) || (versions !== undefined && (!versions || typeof versions !== 'object' || Array.isArray(versions) || Object.entries(versions).some(([id, version]) => !extra.objectIds.includes(id) || !text(version) || version.length > 128)))) throw new TypeError('invalid object dependencies');
            merged.objectIds = [...new Set([...merged.objectIds, ...extra.objectIds])];
            if (versions) merged.objectVersions = {...merged.objectVersions, ...versions};
          }
          generationMs = Math.max(0, this.now() - generateStarted);
          let nextGaze;
          if (Object.hasOwn(output, 'nextGaze')) nextGaze = output.nextGaze ?? null;
          else if (this.nextTargets) {
            this.metrics.nextTargetCalls++;
            const targetStarted = this.now();
            try { nextGaze = await this.nextTargets(structuredClone(request), {signal:controller.signal}); }
            catch { if (isLive()) this.metrics.nextTargetFailures++; nextGaze = null; }
            finally { nextTargetsMs = Math.max(0, this.now() - targetStarted); }
          } else nextGaze = null;
          if (!isLive()) { this._recordDiscard(context); return; }
          const normalized = validatePrepared({...output, nextGaze}, request, this.now());
          prepared = normalized;
          generated = true;
          this.metrics.lastWorkMs = generationMs; this.metrics.totalWorkMs += generationMs;
          // Persistent object IDs (from tracking) are cache dependencies: only a related change invalidates this entry.
          prepared.frameId = request.frame.frameId; prepared.dependencies = merged;
          const expiry = Math.min(request.dependencies.expiresAt ?? this.now() + this.cacheTtlMs, this.now() + this.cacheTtlMs);
          if (expiry > this.now()) {
            prepared.expiresAt = expiry;
            this.cache.put({id:cacheId(request.sessionId, request.stateKey), sessionId:request.sessionId, mapId:request.dependencies.mapId, mapVersion:request.dependencies.mapVersion, objectIds:[...merged.objectIds], snapshotObjectIds:[...request.dependencies.objectIds], evidenceIds:[...request.dependencies.evidenceIds], expiresAt:expiry, observedUntil:prepared.observedUntil, prepared});
          }
        } catch (error) {
          if (isLive()) { this.metrics.workFailures++; this.tel.counts.failed++; this._recordCycle(cycle, 'failed'); this.lastFailure = {stateKey:request.stateKey, at:this.now()}; this.lastStateKey = null; this._status(error instanceof TypeError ? 'invalid_result' : 'work_failed'); }
          else this._recordDiscard(context);
          return;
        }
      }
      if (!prepared || !isLive()) {
        this._recordDiscard(context);
        return;
      }
      cycle.doneAt = this.now();
      if (request.sequence <= this.lastPublishedSequence) { this.tel.counts.superseded++; this._recordCycle(cycle, 'superseded'); return; }
      const publishedAt = this.now();
      if (prepared.expiresAt != null && publishedAt >= prepared.expiresAt) { this.tel.counts.stale++; this._recordCycle(cycle, 'expired'); return; }
      const value = {id:`${request.sessionId}:${request.sequence}`, sessionId:request.sessionId, sequence:request.sequence, frameId:prepared.frameId, observedUntil:prepared.observedUntil, sourceAgeMs:Math.max(0, publishedAt - prepared.observedUntil), dependencies:structuredClone(prepared.dependencies), scenarios:structuredClone(prepared.scenarios), nextGaze:structuredClone(prepared.nextGaze), ...(prepared.candidateSpace ? {candidateSpace:structuredClone(prepared.candidateSpace)} : {}), deliveryState:generated ? 'generated' : 'cache_hit', timings:{cacheLookupMs, generationMs, nextTargetsMs, totalMs:Math.max(0,publishedAt-request.processedAt), publishedAt}};
      this.metrics.lastSourceAgeMs = value.sourceAgeMs; this.metrics.published++; this.lastStateKey = request.stateKey; this.lastPublishedAt = publishedAt; this.lastFailure = null; this.lastPublishedSequence = request.sequence;
      this.latest = request;
      cycle.publishedAt = publishedAt;
      try { this.publish(structuredClone(value)); }
      catch { this.metrics.publishFailures++; this.tel.counts.failed++; this._recordCycle(cycle, 'publish_failed'); this._status('publish_failed'); return; }
      this._recordCycle(cycle, value.deliveryState, value.sourceAgeMs);
      this._status(value.deliveryState);
    } catch {
      if (isLive()) { this.metrics.workFailures++; this.tel.counts.failed++; this._recordCycle(cycle, 'failed'); this.lastFailure = {stateKey:request.stateKey, at:this.now()}; this._status('processing_failed'); }
      else this._recordDiscard(context);
    } finally {
      clearTimeout(timer);
      this.current = null; this.running = false;
      if (this.phase === 'running' && this.pending) this._drain();
    }
  }

  _resetTelemetry() {
    this.tel = {startedAt:this.now(), counts:{observed:0, dropped:0, superseded:0, stale:0, failed:0, timeouts:0, published:0, generated:0, cacheHits:0}, cycles:[], publishes:[]};
  }

  // Bounded: at most telemetrySamples cycles and publish timestamps are retained.
  _recordCycle(cycle, outcome, sourceAgeMs = null) {
    if (cycle.outcome !== null) return;
    cycle.outcome = outcome;
    const published = outcome === 'generated' || outcome === 'cache_hit';
    const record = {sequence:cycle.sequence, outcome, snapshotAt:cycle.snapshotAt, observedUntil:cycle.observedUntil, dispatchAt:cycle.dispatchAt, samDoneAt:cycle.samDoneAt, reasonFirstByteAt:cycle.reasonFirstByteAt, doneAt:cycle.doneAt, publishedAt:cycle.publishedAt, resultAgeMs:published ? sourceAgeMs : null, latencyMs:published ? Math.max(0, cycle.publishedAt - cycle.snapshotAt) : null};
    record.deadlineMet = published ? record.latencyMs <= this.deadlineMs : null;
    const tel = cycle.tel, counts = tel.counts; // a late cycle from a previous start() lands in its own (discarded) telemetry, not the new session's
    if (published) { counts.published++; if (outcome === 'generated') counts.generated++; else counts.cacheHits++; tel.publishes.push({at:cycle.publishedAt, kind:outcome}); if (tel.publishes.length > this.telemetrySamples) tel.publishes.shift(); }
    tel.cycles.push(record); if (tel.cycles.length > this.telemetrySamples) tel.cycles.shift();
  }

  // Per-session (reset by start()) bounded summaries. Cached publish (G4-D) and fresh generation (G4-E) are separate.
  // latencyMs = publishedAt - snapshotAt (frame processedAt); resultAgeMs = publishedAt - observedUntil of the data used.
  telemetry() {
    const now = this.now(), {counts, cycles, publishes} = this.tel;
    const stat = name => {
      const items = cycles.filter(c => c.outcome === name), met = items.filter(c => c.deadlineMet).length;
      return {latencyMs:summary(items.map(c => c.latencyMs)), resultAgeMs:summary(items.map(c => c.resultAgeMs)), samMs:summary(items.filter(c => c.samDoneAt !== null).map(c => c.samDoneAt - c.dispatchAt)), reasonFirstByteMs:summary(items.filter(c => c.reasonFirstByteAt !== null).map(c => c.reasonFirstByteAt - (c.samDoneAt ?? c.dispatchAt))), deadlineMet:met, deadlineMissed:items.length - met, deadlineMetRate:items.length ? round(met / items.length) : null};
    };
    let since = Math.max(this.tel.startedAt, now - this.telemetryWindowMs);
    if (publishes.length === this.telemetrySamples && publishes[0].at > since) since = publishes[0].at;
    const hz = name => { const seconds = (now - since) / 1000; return seconds > 0 ? round(publishes.filter(item => item.at >= since && (name === 'all' || item.kind === name)).length / seconds) : null; };
    return {deadlineMs:this.deadlineMs, windowMs:this.telemetryWindowMs, retainedCycles:cycles.length, maxRetainedCycles:this.telemetrySamples, counts:{...counts}, effectiveHz:{all:hz('all'), generated:hz('generated'), cache_hit:hz('cache_hit')}, generated:stat('generated'), cached:stat('cache_hit'), recent:cycles.slice(-8).map(c => ({...c}))};
  }

  _cached(request) {
    this.metrics.cacheLookups++;
    const entry = this.cache.get(cacheId(request.sessionId, request.stateKey), {sessionId:request.sessionId, mapId:request.dependencies.mapId, mapVersion:request.dependencies.mapVersion, now:this.now()});
    if (!entry || !this._cacheObjectsStillPresent(entry, request)) return null;
    try { const value = validatePrepared(entry.prepared, request, this.now(), entry.evidenceIds); this.metrics.cacheHits++; return value; }
    catch { this.metrics.cacheErrors++; return null; }
  }

  _externalCacheCompatible(value, request) {
    const record = value.prepared ?? value;
    return record.sessionId === request.sessionId && record.mapId === request.dependencies.mapId && record.mapVersion === request.dependencies.mapVersion && time(record.expiresAt) && record.expiresAt > this.now() && Array.isArray(record.objectIds) && record.objectIds.every(id => request.dependencies.objectIds.includes(id));
  }

  _recordDiscard(context) {
    if (context.discarded) return;
    context.discarded = true; context.cycle.tel.counts.stale++; this._recordCycle(context.cycle, 'stale');
    if (this._contextAffected(context)) this.metrics.invalidatedResults++;
    else this.metrics.lifecycleResults++;
  }

  _schedulePoll(delay) {
    if (this.phase !== 'running' || !this.snapshot || this.pollTimer !== null) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (this.phase !== 'running') return;
      const lifecycle = this.lifecycle;
      Promise.resolve().then(() => this.snapshot()).then(value => {
        if (this.phase === 'running' && lifecycle === this.lifecycle && value) this.observe(value);
      }).catch(() => { this.metrics.snapshotFailures++; this._status('snapshot_failed'); }).finally(() => {
        if (this.phase === 'running' && lifecycle === this.lifecycle) this._schedulePoll(this.intervalMs);
      });
    }, delay);
  }

  _clearTimers() {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    if (this.dispatchTimer !== null) clearTimeout(this.dispatchTimer);
    this.pollTimer = null; this.dispatchTimer = null;
  }

  _status(event) { try { this.onStatus({event, ...this.status()}); } catch {} }
}
