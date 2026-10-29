// Local, provider-independent foundations. Times are monotonic milliseconds.
export function alignGaze(sample, frames, budgetMs = 50) {
  if (!sample.valid || !Number.isFinite(sample.captureMs)) return {status: 'withheld', reason: 'invalid_gaze'};
  if (!Number.isFinite(sample.syncUncertaintyMs) || sample.syncUncertaintyMs < 0 || !Number.isFinite(budgetMs) || budgetMs < 0) return {status:'withheld',reason:'invalid_sync_uncertainty'};
  const eligible = frames.filter(f => Number.isFinite(f.presentMs) && f.presentMs <= sample.captureMs);
  const frame = eligible.reduce((a, b) => !a || b.presentMs > a.presentMs ? b : a, null);
  if (!frame) return {status: 'withheld', reason: 'no_presented_frame'};
  if (!Number.isFinite(frame.displayUncertaintyMs) || frame.displayUncertaintyMs < 0) return {status:'withheld',reason:'invalid_display_uncertainty'};
  const error = sample.captureMs - frame.presentMs + frame.displayUncertaintyMs + sample.syncUncertaintyMs;
  return error <= budgetMs ? {status: 'aligned', frameId: frame.id, totalErrorMs: error} : {status: 'withheld', reason: 'alignment_budget_exceeded', totalErrorMs: error};
}

export class EvidenceBuffer {
  constructor({maxAgeMs = 10000, maxBytes = 128 * 1024 * 1024, maxPins = 100, maxPinnedBytes = 256 * 1024 * 1024, pinAgeMs = 60000} = {}) {
    Object.assign(this, {maxAgeMs, maxBytes, maxPins, maxPinnedBytes, pinAgeMs}); this.frames = new Map(); this.pins = new Map(); this.evictions = [];
  }
  add(frame, now) { this.frames.set(frame.id, frame); this.trim(now); }
  trim(now) {
    for (const [id, p] of this.pins) if (now - p.pinnedAt > this.pinAgeMs) this.evict(id, 'pin_age_limit');
    const entries = [...this.frames.values()].sort((a,b) => a.at-b.at);
    let bytes = entries.reduce((n,f) => n+f.bytes, 0);
    for (const f of entries) if (now - f.at > this.maxAgeMs || bytes > this.maxBytes) { this.frames.delete(f.id); bytes -= f.bytes; }
  }
  pin(eventId, frameId, now) {
    this.trim(now); const frame = this.frames.get(frameId) ?? [...this.pins.values()].find(p => p.frame.id === frameId)?.frame;
    if (!frame) { this.evictions.push({eventId, reason:'evidence_unavailable'}); return false; }
    if (this.pins.has(eventId)) return true;
    const unique = new Map([...this.pins.values()].map(p => [p.frame.id, p.frame])); unique.set(frame.id, frame);
    if (this.pins.size >= this.maxPins || [...unique.values()].reduce((n,f)=>n+f.bytes,0) > this.maxPinnedBytes) { this.evictions.push({eventId, reason:'pin_capacity'}); return false; }
    this.pins.set(eventId, {frame, pinnedAt:now}); return true;
  }
  evict(id, reason) { this.pins.delete(id); this.evictions.push({eventId:id, reason}); }
}

export class Memory {
  constructor() { this.events = new Map(); this.objects = new Map(); this.poses = []; }
  appendEvent(event) { if (this.events.has(event.id)) return false; this.events.set(event.id, structuredClone(event)); return true; }
  observeObject(observation) { const history = this.objects.get(observation.objectId) ?? []; history.push(structuredClone(observation)); this.objects.set(observation.objectId, history); }
  lastSeen(id, until = Infinity) { return (this.objects.get(id) ?? []).filter(x => x.observedAt <= until).sort((a,b) => b.observedAt-a.observedAt)[0] ?? null; }
  recordPose(pose) { this.poses.push(structuredClone(pose)); }
  glimpses(until = Infinity) { return [...this.events.values()].filter(e => e.type === 'briefly_crossed' && e.end <= until); }
  clear() { this.events.clear(); this.objects.clear(); this.poses = []; }
}

export function invalidate(response, change, now) {
  if (now >= response.expiresAt) return {...response, stale:true, invalidationReason:'expired'};
  const d = response.dependencies;
  const hit = (change.objectId && d.objectIds?.includes(change.objectId)) || (change.evidenceId && d.evidenceIds?.includes(change.evidenceId)) || (change.mapId && d.mapIds?.includes(change.mapId));
  return hit ? {...response, stale:true, invalidationReason:change.reason} : response;
}
export function causalBundle(records, observedUntil) {
  return records.filter(r => r.causalStatus === 'online_causal' && r.observedAt <= observedUntil).map(({future, groundTruth, scenarioGoal, ...r}) => r);
}
