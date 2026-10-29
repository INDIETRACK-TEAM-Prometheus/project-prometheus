// Each entry declares all evidence and object dependencies and its map identity.
export class DependencyCache {
  constructor(maxEntries = 256) { if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new TypeError('invalid cache limit'); this.maxEntries = maxEntries; this.entries = new Map(); }
  put(entry) {
    if (!entry || !entry.id || !entry.sessionId || !entry.mapId || !Number.isFinite(entry.mapVersion) || !Number.isFinite(entry.expiresAt) || !Array.isArray(entry.objectIds) || !Array.isArray(entry.evidenceIds)) throw new TypeError('invalid cache dependencies');
    this.entries.delete(entry.id); this.entries.set(entry.id, structuredClone(entry));
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }
  prune(now) { if (!Number.isFinite(now)) throw new TypeError('invalid time'); for (const [id,e] of this.entries) if (now >= e.expiresAt) this.entries.delete(id); }
  get(id, {sessionId, mapId, mapVersion, now}) {
    const e = this.entries.get(id);
    if (!e) return null;
    if (!Number.isFinite(now) || e.sessionId !== sessionId || e.mapId !== mapId || e.mapVersion !== mapVersion || now >= e.expiresAt) { this.entries.delete(id); return null; }
    return structuredClone(e);
  }
  invalidate(change) {
    let count = 0;
    for (const [id, e] of this.entries) {
      if (e.sessionId !== change.sessionId) continue;
      const hit = (change.type === 'map' && e.mapId === change.mapId) || (['object_moved', 'object_deleted', 'identity_changed', 'observation_conflict'].includes(change.type) && e.objectIds.includes(change.objectId)) || (change.type === 'evidence_withdrawn' && e.evidenceIds.includes(change.evidenceId));
      if (hit) { this.entries.delete(id); count++; }
    }
    return count;
  }
}
