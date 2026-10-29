import {LatestScheduler} from './scheduler.js';
import {DependencyCache} from './cache.js';
import {validateScenarios} from './contracts.js';
import {validateNextGaze} from './next-gaze.js';

const nonempty = x => typeof x === 'string' && x.trim().length > 0;
const nonnegative = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const ids = x => Array.isArray(x) && x.every(nonempty);
const fixture = p => p && p.kind === 'local_fixture' && typeof p.run === 'function';
const exact = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k));
const reasonerMetadata = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = x => typeof x === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(x) ? x : null;
  const count = x => Number.isSafeInteger(x) && x >= 0 && x <= 10000000 ? x : null;
  const usage = value.usage && typeof value.usage === 'object' ? {inputTokens:count(value.usage.inputTokens),outputTokens:count(value.usage.outputTokens),cachedInputTokens:count(value.usage.cachedInputTokens)} : null;
  return {provider:text(value.provider),model:text(value.model),requestId:text(value.requestId),usage};
};
const timed = (item, observedUntil, now) => nonnegative(item.observedAt) && item.observedAt <= observedUntil && nonnegative(item.processedAt) && item.processedAt >= item.observedAt && item.processedAt <= now;
export function project(input, now) {
  if (!exact(input, ['frame','gaze','events','context','dependencies','observedUntil','candidates'])) throw new TypeError('invalid input fields');
  const {frame:f, gaze:g, events, context:c, dependencies:d} = input;
  const candidates=input.candidates ?? [];
  if (!Array.isArray(candidates) || candidates.length>20 || candidates.some(c=>!exact(c,['objectId','bounds']) || !nonempty(c.objectId) || ['unknown','outside_view'].includes(c.objectId) || c.objectId.length>128 || !exact(c.bounds,['left','top','right','bottom']) || ![c.bounds.left,c.bounds.top,c.bounds.right,c.bounds.bottom].every(Number.isFinite) || c.bounds.left<0 || c.bounds.top<0 || c.bounds.right<=c.bounds.left || c.bounds.bottom<=c.bounds.top || !d?.objectIds?.includes(c.objectId)) || new Set(candidates.map(c=>c.objectId)).size!==candidates.length) throw new TypeError('invalid candidates');
  const observedUntil=input.observedUntil ?? f?.observedAt;
  if (!nonnegative(observedUntil) || observedUntil>now || !nonnegative(f?.observedAt) || f.observedAt>observedUntil) throw new TypeError('invalid observation cutoff');
  if (!exact(f,['frameId','observedAt','processedAt','imageData','sceneText','causalStatus','provenanceKind']) || !nonempty(f.frameId) || !nonnegative(f.observedAt) || !timed(f,f.observedAt,now) || !(f.imageData == null || typeof f.imageData === 'string') || !(f.sceneText == null || typeof f.sceneText === 'string')) throw new TypeError('invalid frame');
  if (!exact(g,['x','y','observedAt','processedAt']) || !Number.isFinite(g.x) || !Number.isFinite(g.y) || g.x < 0 || g.x > 1 || g.y < 0 || g.y > 1 || !timed(g,observedUntil,now)) throw new TypeError('invalid gaze');
  if (!Array.isArray(events) || events.length > 1000 || events.some(e => !exact(e,['eventId','observedAt','processedAt','type','endAt','dwellValidMs','x','y','candidateObjectIds']) || !nonempty(e.eventId) || !timed(e,observedUntil,now) || (e.type != null && !['fixated','briefly_crossed','seen_in_scene'].includes(e.type)) || (e.endAt != null && (!nonnegative(e.endAt) || e.endAt < e.observedAt || e.endAt > observedUntil || e.endAt > e.processedAt)) || (e.dwellValidMs != null && (!nonnegative(e.dwellValidMs) || e.endAt == null || e.dwellValidMs > e.endAt-e.observedAt)) || ((e.x != null || e.y != null) && (!Number.isFinite(e.x) || !Number.isFinite(e.y) || e.x<0 || e.x>1 || e.y<0 || e.y>1)) || (e.candidateObjectIds != null && (!ids(e.candidateObjectIds) || e.candidateObjectIds.length>20 || e.candidateObjectIds.some(id=>id.length>64))))) throw new TypeError('invalid events');
  if (!exact(c,['memory']) || !Array.isArray(c.memory) || c.memory.length > 1000 || c.memory.some(m => !exact(m,['evidenceId','text','observedAt','processedAt','causalStatus']) || !nonempty(m.evidenceId) || typeof m.text !== 'string' || m.causalStatus !== 'online_causal' || !timed(m,observedUntil,now))) throw new TypeError('invalid context');
  if (!exact(d,['mapId','mapVersion','objectIds','evidenceIds','expiresAt']) || !nonempty(d.mapId) || !Number.isInteger(d.mapVersion) || d.mapVersion < 0 || !ids(d.objectIds) || !ids(d.evidenceIds) || !nonnegative(d.expiresAt)) throw new TypeError('invalid dependencies');
  const evidence = new Set([f.frameId,...events.map(e => e.eventId),...c.memory.map(m => m.evidenceId)]);
  if (d.evidenceIds.some(id => !evidence.has(id))) throw new TypeError('unknown evidence dependency');
  return structuredClone({frame:f,gaze:g,events,context:c,dependencies:d,observedUntil,...(input.candidates===undefined?{}:{candidates})});
}

// Remote processing is enabled only through an explicitly constructed provider.
export class RuntimeFacade {
  constructor({sessionId, segmenter, reasoner, analyzer, publish = () => {}, store = null, now = () => Date.now(), timeoutMs = 10000, minIntervalMs = 1000, maxCallsPerMinute = 60, maxCostPerMinute = 0, estimatedCostPerCall = 0} = {}) {
    if (!nonempty(sessionId) || typeof publish !== 'function' || typeof now !== 'function' || !nonnegative(minIntervalMs) || !Number.isInteger(maxCallsPerMinute) || maxCallsPerMinute < 0 || !nonnegative(maxCostPerMinute) || !nonnegative(estimatedCostPerCall) || (store !== null && typeof store.append !== 'function')) throw new TypeError('invalid runtime configuration');
    Object.assign(this, {sessionId, segmenter, reasoner, analyzer, publish, store, now, minIntervalMs, maxCallsPerMinute, maxCostPerMinute, estimatedCostPerCall});
    this.cache = new DependencyCache(); this.calls = []; this.seenEvents = new Set(); this.lastCallAt = -Infinity; this.started = false; this.lastError = null; this.remoteResponded = false;
    this.scheduler = new LatestScheduler({timeoutMs, work: (input, context) => this.execute(input, context), publish: result => this.commit(result)});
  }
  start() { if (this.started) throw new Error('already started'); this.scheduler.start(this.sessionId); this.started = true; }
  submit(input) {
    if (!this.started) return {accepted:false, reason:'stopped'};
    if (!(this.analyzer?.kind === 'server_provider' && typeof this.analyzer.run === 'function') && (!fixture(this.segmenter) || !fixture(this.reasoner))) return {accepted:false, reason:'provider_blocked'};
    const timestamp = this.now(); if (!nonnegative(timestamp)) throw new TypeError('invalid clock');
    this.cache.prune(timestamp);
    const safe = project(input, timestamp);
    if (this.analyzer?.kind === 'server_provider' && (safe.frame.causalStatus !== 'online_causal' || !['synthetic','sensor'].includes(safe.frame.provenanceKind))) throw new TypeError('remote frame provenance required');
    return {accepted:this.scheduler.submit(safe)};
  }
  async execute(input, {signal}) {
    const timestamp = this.now();
    if (!nonnegative(timestamp)) { this.lastError = 'invalid_clock'; return null; }
    this.calls = this.calls.filter(c => timestamp >= c.at && timestamp - c.at < 60000);
    if (timestamp < this.lastCallAt || timestamp - this.lastCallAt < this.minIntervalMs) { this.lastError = 'minimum_interval'; return null; }
    if (this.calls.length >= this.maxCallsPerMinute || this.calls.reduce((sum, c) => sum + c.cost, 0) + this.estimatedCostPerCall > this.maxCostPerMinute) { this.lastError = 'budget_exceeded'; return null; }
    this.calls.push({at:timestamp, cost:this.estimatedCostPerCall}); this.lastCallAt = timestamp;
    try {
      let output;
      if (this.analyzer?.kind === 'server_provider') output = await this.analyzer.run(structuredClone(input), {signal});
      else {
        const masks = await this.segmenter.run(structuredClone(input.frame), {signal});
        if (signal.aborted || !this.started) return null;
        const bundle = {frame:input.frame, gaze:input.gaze, events:input.events, context:input.context, masks, observedUntil:input.observedUntil};
        output = await this.reasoner.run(bundle, {signal});
      }
      if (signal.aborted || !this.started) return null;
      validateScenarios(output?.scenarios);
      const nextGaze=output.nextGaze ?? null;
      validateNextGaze(nextGaze,input.candidates ?? []);
      if (!(input.candidates?.length) && nextGaze !== null) throw new TypeError('no candidate space');
      const available = new Set(input.dependencies.evidenceIds);
      if (output.scenarios.some(s => s.grounding_refs.some(id => !available.has(id)))) throw new TypeError('unknown grounding evidence');
      if (this.analyzer?.kind === 'server_provider') this.remoteResponded = true;
      return {input, nextGaze:structuredClone(nextGaze), scenarios:structuredClone(output.scenarios), reasoner:this.analyzer?.kind === 'server_provider' ? reasonerMetadata(output.reasoner) : null};
    } catch (error) { if (!signal.aborted) this.lastError = this.analyzer?.kind === 'server_provider' ? 'provider_failed' : 'local_processing_failed'; return null; }
  }
  commit(result) {
    if (!result || !this.started || result.input.invalidated) return;
    const {input, scenarios, reasoner, nextGaze} = result; const d = input.dependencies;
    const now = this.now();
    if (!nonnegative(now) || now >= d.expiresAt) { this.lastError = 'expired'; return; }
    const prepared = {id:input.frame.frameId, sessionId:this.sessionId, mapId:d.mapId, mapVersion:d.mapVersion, objectIds:d.objectIds, evidenceIds:d.evidenceIds, expiresAt:d.expiresAt, observedUntil:input.observedUntil, scenarios, nextGaze, reasoner, deliveryState:'silent_ready'};
    // Synchronous append contract: durable transactional idempotency remains the
    // responsibility of a storage implementation, not this in-memory guard.
    try { if (this.store) for (const event of input.events) if (!this.seenEvents.has(event.eventId)) { const outcome = this.store.append(structuredClone(event)); if (outcome && typeof outcome.then === 'function') throw new TypeError('store append must be synchronous'); this.seenEvents.add(event.eventId); if (this.seenEvents.size > 1024) this.seenEvents.delete(this.seenEvents.values().next().value); } }
    catch { this.lastError = 'store_failed_partial_possible'; return; }
    this.cache.put(prepared);
    try { this.publish(structuredClone(prepared)); this.lastError = null; }
    catch { this.lastError = 'publish_failed'; }
  }
  getPrepared(id, {mapId, mapVersion} = {}) { return this.cache.get(id, {sessionId:this.sessionId, mapId, mapVersion, now:this.now()}); }
  invalidate(change) {
    for (const request of [this.scheduler.current, this.scheduler.pending]) {
      const input = request?.frame, d = input?.dependencies;
      if (!d) continue;
      if ((change.type === 'map' && d.mapId === change.mapId) || (['object_moved','object_deleted','identity_changed','observation_conflict'].includes(change.type) && d.objectIds.includes(change.objectId)) || (change.type === 'evidence_withdrawn' && d.evidenceIds.includes(change.evidenceId))) input.invalidated = true;
    }
    return this.cache.invalidate({...change, sessionId:this.sessionId});
  }
  stop() { this.started = false; this.scheduler.stop(); this.cache.entries.clear(); this.seenEvents.clear(); this.lastError = null; }
  status() { return {active:this.started, sam:this.analyzer?.kind === 'server_provider' ? (this.remoteResponded ? 'responded_unverified' : 'configured_unverified') : 'blocked', wonder:'blocked', reasoner:this.analyzer?.kind === 'server_provider' ? (this.remoteResponded ? 'responded_unverified' : 'configured_unverified') : 'blocked', localFixturesAvailable:!!(fixture(this.segmenter) && fixture(this.reasoner)), lastError:this.lastError, dropped:this.scheduler.dropped, timeouts:this.scheduler.timeouts, callsInWindow:this.calls.filter(c => this.now() >= c.at && this.now() - c.at < 60000).length}; }
}
