import {compareAnchors} from '../spatial/geometry.js';
// In-memory research prototype. Times are monotonic milliseconds, bytes are
// the actual stored representation size supplied by the caller.
const copy = value => structuredClone(value);
const finite = (n, name) => { if (!Number.isFinite(n) || n < 0) throw new TypeError(`${name} must be non-negative and finite`); };
const required = (v, name) => { if (typeof v !== 'string' || !v) throw new TypeError(`${name} required`); };

export class EvidenceRing {
  constructor({maxAgeMs = 10000, maxBytes = 128 * 1024 ** 2, maxPins = 100, maxPinnedBytes = 256 * 1024 ** 2, pinAgeMs = 60000} = {}) {
    for (const [k,v] of Object.entries({maxAgeMs,maxBytes,maxPins,maxPinnedBytes,pinAgeMs})) finite(v,k);
    Object.assign(this,{maxAgeMs,maxBytes,maxPins,maxPinnedBytes,pinAgeMs});
    this.ring = new Map(); this.pins = new Map(); this.evictions = []; this.clock = 0;
  }
  tick(now) { finite(now,'now'); if (now < this.clock) throw new Error('clock must be monotonic'); this.clock = now; this.trim(); }
  add(item, now) {
    required(item.id,'id'); finite(item.observedAt,'observedAt'); finite(item.bytes,'bytes'); this.tick(now);
    if (item.observedAt > now) throw new Error('future evidence');
    if (this.evictions.some(eviction=>eviction.evidenceIds.includes(item.id))) throw new Error('evidence was evicted');
    const existing = this.ring.get(item.id) ?? [...this.pins.values()].flatMap(p => p.items).find(i => i.id === item.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(item)) throw new Error('conflicting evidence id');
    if (!existing) this.ring.set(item.id,copy(item));
    this.trim(); return this.ring.has(item.id);
  }
  trim() {
    for (const [id,p] of this.pins) if (this.clock - p.pinnedAt >= this.pinAgeMs) this.evict(id,'pin_age_limit');
    const ordered = [...this.ring.values()].sort((a,b) => a.observedAt-b.observedAt || a.id.localeCompare(b.id));
    let bytes = ordered.reduce((s,x) => s+x.bytes,0);
    for (const item of ordered) if (this.clock-item.observedAt >= this.maxAgeMs || bytes > this.maxBytes) {
      this.ring.delete(item.id); bytes -= item.bytes;
      if (![...this.pins.values()].some(p=>p.items.some(x=>x.id===item.id))) this.failure(null,this.clock-item.observedAt >= this.maxAgeMs ? 'ring_age_limit' : 'ring_bytes_limit',[item.id]);
    }
  }
  pin(eventId, evidenceIds, now) {
    required(eventId,'eventId'); this.tick(now);
    if (!Array.isArray(evidenceIds) || !evidenceIds.length || evidenceIds.some(id => typeof id !== 'string' || !id)) throw new TypeError('evidenceIds required');
    const ids = [...new Set(evidenceIds)];
    const old = this.pins.get(eventId);
    if (old) { if (JSON.stringify(old.items.map(x=>x.id).sort()) !== JSON.stringify([...ids].sort())) throw new Error('conflicting pin'); return {ok:true}; }
    const available = new Map([...this.ring.values(), ...[...this.pins.values()].flatMap(p=>p.items)].map(x=>[x.id,x]));
    const missing = ids.filter(id=>!available.has(id));
    if (missing.length) return this.failure(eventId,'evidence_unavailable',missing);
    const unique = new Map([...this.pins.values()].flatMap(p=>p.items).map(x=>[x.id,x]));
    for (const id of ids) unique.set(id,available.get(id));
    if (this.pins.size >= this.maxPins) return this.failure(eventId,'pin_count_limit',ids);
    if ([...unique.values()].reduce((s,x)=>s+x.bytes,0) > this.maxPinnedBytes) return this.failure(eventId,'pin_bytes_limit',ids);
    this.pins.set(eventId,{pinnedAt:now,items:ids.map(id=>copy(available.get(id)))}); return {ok:true};
  }
  failure(eventId,reason,evidenceIds) { const result={ok:false,eventId,state:'evidence_evicted',reason,evidenceIds:copy(evidenceIds)}; this.evictions.push(result); return copy(result); }
  evict(eventId,reason) { const p=this.pins.get(eventId); if (!p) return false; this.pins.delete(eventId); this.failure(eventId,reason,p.items.map(x=>x.id)); return true; }
  release(eventId) { return this.pins.delete(eventId); }
  deleteEvidence(id) { this.ring.delete(id); for (const [eventId,p] of this.pins) if (p.items.some(x=>x.id===id)) this.evict(eventId,'evidence_deleted'); }
  get(eventId) { return copy(this.pins.get(eventId) ?? null); }
}

// All returned records are defensive copies; mutation is through append only.
export class ExperienceMemory {
  constructor() { this.events=new Map(); this.observations=new Map(); this.relations=new Map(); this.links=new Map(); this.derivations=new Map(); this.deletedEvidence=new Set(); this.version=0; }
  insert(map, record, idKey) {
    const id=record[idKey]; required(id,idKey); finite(record.observedAt,'observedAt'); finite(record.processedAt,'processedAt');
    if (record.processedAt < record.observedAt) throw new Error('processed before observed');
    const old=map.get(id); if (old) { if (JSON.stringify(old)!==JSON.stringify(record)) throw new Error(`conflicting ${idKey}`); return false; }
    map.set(id,copy(record)); this.version++; return true;
  }
  appendEvent(event) {
    if (event.supersedesEventId) {
      const previous=this.events.get(event.supersedesEventId); if (!previous) throw new Error('superseded event missing');
      if (event.observedAt !== previous.observedAt || !(event.associationRevision > (previous.associationRevision ?? 0))) throw new Error('invalid revision');
    }
    return this.insert(this.events,event,'eventId');
  }
  observe(record) {
    required(record.objectId,'objectId');
    const existing=this.observations.get(record.observationId);
    if (existing) return this.insert(this.observations,record,'observationId');
    if (record.supersedesObservationId) {
      const previous=this.observations.get(record.supersedesObservationId);
      if (!previous) throw new Error('superseded observation missing');
      if (record.observedAt!==previous.observedAt || !Number.isInteger(record.associationRevision) || record.associationRevision <= (previous.associationRevision ?? 0) || record.processedAt < previous.processedAt || [...this.observations.values()].some(o=>o.supersedesObservationId===record.supersedesObservationId)) throw new Error('invalid observation revision');
    }
    const added=this.insert(this.observations,record,'observationId');
    if (added && record.supersedesObservationId) for (const d of this.derivations.values()) if (d.observationIds?.includes(record.supersedesObservationId)) { d.valid=false; d.reason='association_revised'; }
    return added;
  }
  addRelation(record) { required(record.subjectId,'subjectId'); required(record.objectId,'objectId'); required(record.relation,'relation'); finite(record.validFrom,'validFrom'); if (record.validTo != null && (!Number.isFinite(record.validTo) || record.validTo < record.validFrom)) throw new Error('invalid relation interval'); return this.insert(this.relations,record,'relationId'); }
  link({linkId, objectIds, observedAt, processedAt}) {
    if (!Array.isArray(objectIds) || objectIds.length < 2 || objectIds.some(x=>typeof x !== 'string' || !x)) throw new Error('two object IDs required');
    return this.insert(this.links,{linkId,objectIds:[...new Set(objectIds)],observedAt,processedAt,active:true},'linkId');
  }
  unlink(linkId) { const link=this.links.get(linkId); if (!link || !link.active) return false; link.active=false; this.version++; for (const d of this.derivations.values()) if (d.linkIds?.includes(linkId)) { d.valid=false; d.reason='identity_link_revoked'; } return true; }
  identities(id, until=Infinity) { const ids=new Set([id]); let changed=true; while(changed) { changed=false; for(const l of this.links.values()) if(l.active && l.observedAt<=until && l.processedAt<=until && l.objectIds.some(x=>ids.has(x))) for(const x of l.objectIds) if(!ids.has(x)){ids.add(x);changed=true;} } return ids; }
  lastSeen(id, until=Infinity, unavailable=new Set()) { const ids=this.identities(id,until); const eligible=[...this.observations.values()].filter(o=>o.observedAt<=until && o.processedAt<=until); const superseded=new Set(eligible.map(o=>o.supersedesObservationId).filter(Boolean)); const rows=eligible.filter(o=>ids.has(o.objectId) && !superseded.has(o.observationId) && !(o.evidenceIds??[]).some(e=>this.deletedEvidence.has(e) || unavailable.has(e))).sort((a,b)=>b.observedAt-a.observedAt || a.observationId.localeCompare(b.observationId)); return rows.length ? copy({...rows[0],positionMeaning:'last_seen_not_current'}) : null; }
  glimpses(until=Infinity) { const eligible=[...this.events.values()].filter(e=>(e.endAt ?? e.observedAt)<=until && e.processedAt<=until); const superseded=new Set(eligible.map(e=>e.supersedesEventId).filter(Boolean)); return copy(eligible.filter(e=>e.type==='briefly_crossed' && !superseded.has(e.eventId) && !(e.evidenceIds??[]).some(id=>this.deletedEvidence.has(id)))); }
  relationsAt(at) { return copy([...this.relations.values()].filter(r=>r.validFrom<=at && r.observedAt<=at && r.processedAt<=at && (r.validTo==null || at<r.validTo) && !(r.evidenceIds??[]).some(id=>this.deletedEvidence.has(id)))); }
  addDerivation(record) { required(record.id,'id'); if (!Array.isArray(record.evidenceIds) || !record.evidenceIds.length) throw new Error('derivation requires evidence'); if (this.derivations.has(record.id)) throw new Error('duplicate derivation'); const deleted=record.evidenceIds.some(id=>this.deletedEvidence.has(id)) || (record.observationIds??[]).some(id=>(this.observations.get(id)?.evidenceIds??[]).some(e=>this.deletedEvidence.has(e))); const missing=(record.observationIds??[]).some(id=>!this.observations.has(id)); const revised=(record.observationIds??[]).some(id=>[...this.observations.values()].some(o=>o.supersedesObservationId===id)); this.derivations.set(record.id,{...copy(record),valid:!deleted&&!missing&&!revised,reason:deleted?'evidence_deleted':missing?'observation_unavailable':revised?'association_revised':null}); }
  deleteEvidence(id) { required(id,'id'); this.deletedEvidence.add(id); for(const d of this.derivations.values()) if(d.evidenceIds.includes(id) || d.observationIds?.some(o=>this.observations.get(o)?.evidenceIds?.includes(id))){d.valid=false;d.reason='evidence_deleted';} this.version++; }
  getDerivation(id) { return copy(this.derivations.get(id) ?? null); }
}

// Adapter accepts already-normalized records; it is not an Aria dataset loader.
export function causalReplay(records, observedUntil) {
  finite(observedUntil,'observedUntil');
  return records.filter(r=>r.causalStatus==='online_causal' && Number.isFinite(r.observedAt) && r.observedAt<=observedUntil && Number.isFinite(r.processedAt) && r.processedAt<=observedUntil).map(r=> {
    const {future,groundTruth,scenarioGoal,...safe}=copy(r);
    for (const key of ['frame','gaze','depth','pose','calibration']) if (safe[key] == null) { safe[key]=null; safe.unavailableReasons={...safe.unavailableReasons,[key]:safe.unavailableReasons?.[key] ?? 'not_supplied'}; }
    return safe;
  });
}

// Stores one complete session snapshot in one transaction. Multiple concurrent
// writers for the same session are not supported; callers must own the session.
export class EphemeralStorage {
  constructor() { this.snapshots=new Map(); this.durable=false; }
  async load(id) { return copy(this.snapshots.get(id) ?? null); }
  async save(id, value, {signal}={}) { if(signal?.aborted) throw new Error('operation cancelled'); this.snapshots.set(id,copy(value)); }
  async delete(id) { this.snapshots.delete(id); }
}

export class IndexedDBStorage {
  constructor({indexedDB=globalThis.indexedDB, databaseName='prometheus-memory-v1'} = {}) {
    if (!indexedDB) throw new Error('IndexedDB unavailable');
    this.indexedDB=indexedDB; this.databaseName=databaseName; this.durable=true;
  }
  async database() {
    if (!this.dbPromise) this.dbPromise=new Promise((resolve,reject)=>{
      const request=this.indexedDB.open(this.databaseName,1);
      request.onupgradeneeded=()=>request.result.createObjectStore('sessions');
      request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(new Error('IndexedDB upgrade blocked'));
    });
    return this.dbPromise;
  }
  async transaction(mode, operation, {signal}={}) {
    const db=await this.database();
    return new Promise((resolve,reject)=>{
      if(signal?.aborted) { reject(new Error('operation cancelled')); return; }
      const tx=db.transaction('sessions',mode); let request;
      try { request=operation(tx.objectStore('sessions')); } catch(error) { tx.abort(); reject(error); return; }
      const abort=()=>{ try { tx.abort(); } catch {} };
      const cleanup=()=>signal?.removeEventListener('abort',abort);
      signal?.addEventListener('abort',abort,{once:true});
      tx.oncomplete=()=>{cleanup();resolve(request.result ?? null);};
      tx.onerror=()=>{cleanup();reject(tx.error ?? new Error('IndexedDB transaction failed'));};
      tx.onabort=()=>{cleanup();reject(tx.error ?? new Error('IndexedDB transaction aborted'));};
    });
  }
  load(id) { return this.transaction('readonly',s=>s.get(id)); }
  save(id,value,options) { return this.transaction('readwrite',s=>s.put(copy(value),id),options); }
  delete(id) { return this.transaction('readwrite',s=>s.delete(id)); }
  deleteMany(ids) { return this.transaction('readwrite',s=>{ let request; for(const id of ids) request=s.delete(id); return request; }); }
  async close() { if(this.dbPromise) (await this.dbPromise).close(); this.dbPromise=null; }
}

const mapSnapshot = map => [...map.entries()].map(([key,value])=>[key,copy(value)]);
function snapshot(memory,ring) {
  return {schemaVersion:1, memory:{events:mapSnapshot(memory.events),observations:mapSnapshot(memory.observations),relations:mapSnapshot(memory.relations),links:mapSnapshot(memory.links),derivations:mapSnapshot(memory.derivations),deletedEvidence:[...memory.deletedEvidence],version:memory.version},ring:{settings:{maxAgeMs:ring.maxAgeMs,maxBytes:ring.maxBytes,maxPins:ring.maxPins,maxPinnedBytes:ring.maxPinnedBytes,pinAgeMs:ring.pinAgeMs},ring:mapSnapshot(ring.ring),pins:mapSnapshot(ring.pins),evictions:copy(ring.evictions),clock:ring.clock}};
}
function checkpointCovers(state, checkpoint) {
  if (!Number.isFinite(checkpoint) || checkpoint < 0 || !Number.isFinite(state?.ring?.clock) || state.ring.clock < 0 || state.ring.clock > checkpoint) return false;
  return ['events','observations','relations','links','derivations'].every(key => Array.isArray(state.memory?.[key]) && state.memory[key].every(([,record]) => record && (record.processedAt === undefined || Number.isFinite(record.processedAt) && record.processedAt >= 0 && record.processedAt <= checkpoint)));
}
function restore(state) {
  if(state.schemaVersion!==1) throw new Error('unsupported memory schema version');
  const m=new ExperienceMemory(); for(const key of ['events','observations','relations','links','derivations']) m[key]=new Map(copy(state.memory[key]));
  m.deletedEvidence=new Set(state.memory.deletedEvidence); m.version=state.memory.version;
  const b=new EvidenceRing(state.ring.settings); b.ring=new Map(copy(state.ring.ring)); b.pins=new Map(copy(state.ring.pins)); b.evictions=copy(state.ring.evictions); b.clock=state.ring.clock;
  return {memory:m,ring:b};
}

export class MemoryService {
  static async open({sessionId,storage=new EphemeralStorage(),retentionConsent=false,retentionMs,now,clock,retentionClock=Date.now,ringOptions,maxRecords=10000,maxSnapshotBytes=1024**3}={}) {
    if(clock===undefined) clock=now===undefined ? Date.now : ()=>now;
    if(typeof clock!=='function' || typeof retentionClock!=='function') throw new TypeError('clock must be a function');
    now=now ?? clock();
    required(sessionId,'sessionId'); finite(now,'now');
    finite(maxRecords,'maxRecords'); finite(maxSnapshotBytes,'maxSnapshotBytes'); if(maxSnapshotBytes>2*1024**3) throw new Error('memory snapshot quota exceeds limit');
    if(storage.durable && (retentionConsent!==true || !Number.isFinite(retentionMs) || retentionMs<=0)) throw new Error('durable storage requires explicit consent and positive retentionMs');
    const retentionNow=storage.durable ? retentionClock() : null; if(storage.durable && (!Number.isSafeInteger(retentionNow) || retentionNow<0)) throw new Error('invalid retention clock');
    const service=new MemoryService(sessionId,storage,ringOptions,clock,retentionClock,maxRecords,maxSnapshotBytes);
    const saved=await storage.load(sessionId);
    if(saved && (saved.schemaVersion!==1 || !saved.state)) throw new Error('unsupported stored session');
    if(saved && storage.durable && (saved.expiryClock!=='unix_ms' || !Number.isSafeInteger(saved.expiresAt) || saved.expiresAt<0 || !Number.isSafeInteger(saved.checkpointWallMs) || saved.checkpointWallMs<0 || saved.checkpointWallMs>retentionNow || saved.checkpointWallMs>saved.expiresAt || !checkpointCovers(saved.state,saved.checkpointMonotonicMs))) throw new Error('invalid or ambiguous durable retention metadata');
    if(saved && storage.durable && retentionNow>=saved.expiresAt) await storage.delete(sessionId);
    else if(saved) {
      Object.assign(service,restore(saved.state)); service.expiresAt=saved.expiresAt; service.checkpointWallMs=saved.checkpointWallMs ?? null; service.checkpointMonotonicMs=saved.checkpointMonotonicMs ?? null;
      service.enforceBudget(saved.state);
    }
    if(storage.durable && service.expiresAt==null) service.expiresAt=retentionNow+retentionMs;
    if(storage.durable && !Number.isSafeInteger(service.expiresAt)) throw new Error('invalid retention expiry');
    return service;
  }
  constructor(sessionId,storage,ringOptions,clock,retentionClock,maxRecords,maxSnapshotBytes) { this.sessionId=sessionId; this.storage=storage; this.memory=new ExperienceMemory(); this.ring=new EvidenceRing(ringOptions); this.expiresAt=null; this.checkpointWallMs=null; this.checkpointMonotonicMs=null; this.queue=Promise.resolve(); this.closed=false; this.closing=false; this.clock=clock; this.retentionClock=retentionClock; this.maxRecords=maxRecords; this.maxSnapshotBytes=maxSnapshotBytes; this.invalidationListeners=new Set(); }
  checkExpiry() { const now=this.storage.durable ? this.retentionClock() : this.clock(); finite(now,'clock'); if(this.storage.durable && (!Number.isSafeInteger(now) || (this.checkpointWallMs!==null && now<this.checkpointWallMs))) throw new Error('invalid retention clock'); if(this.expiresAt!=null && now>=this.expiresAt) throw new Error('retention expired; delete session'); }
  enforceBudget(state) {
    const m=state.memory, r=state.ring;
    const count=['events','observations','relations','links','derivations','deletedEvidence'].reduce((n,k)=>n+m[k].length,0)+r.ring.length+r.pins.length+r.evictions.length;
    if(count>this.maxRecords) throw new Error('memory record quota exceeded');
    if(new TextEncoder().encode(JSON.stringify(state)).byteLength>this.maxSnapshotBytes) throw new Error('memory snapshot quota exceeded');
  }
  propagateEvictions(start) {
    for(const eviction of this.ring.evictions.slice(start)) for(const d of this.memory.derivations.values()) {
      if (this.derivationUsesEviction(d,eviction)) { d.valid=false; d.reason=eviction.reason; }
    }
  }
  derivationUsesEviction(d,eviction) { return (eviction.eventId && d.eventIds?.includes(eviction.eventId)) || eviction.evidenceIds.some(id=>d.evidenceIds?.includes(id) || d.observationIds?.some(observationId=>this.memory.observations.get(observationId)?.evidenceIds?.includes(id))); }
  subscribeInvalidations(listener) { if(typeof listener!=='function') throw new TypeError('invalid listener'); this.invalidationListeners.add(listener); return ()=>this.invalidationListeners.delete(listener); }
  change(fn, {signal}={}) {
    if(this.closing || this.closed) return Promise.reject(new Error('session closed'));
    const operation=this.queue.then(async()=>{
      if(this.closed) throw new Error('session closed');
      if(signal?.aborted) throw new Error('operation cancelled');
      this.checkExpiry();
      const before=snapshot(this.memory,this.ring);
      try { const result=fn(); this.propagateEvictions(before.ring.evictions.length); const next=snapshot(this.memory,this.ring); this.enforceBudget(next); if(signal?.aborted) throw new Error('operation cancelled'); const checkpointWallMs=this.storage.durable ? this.retentionClock() : null; const checkpointMonotonicMs=this.storage.durable ? this.clock() : null; if(this.storage.durable && !checkpointCovers(next,checkpointMonotonicMs)) throw new Error('invalid monotonic checkpoint'); if(this.storage.durable && (!Number.isSafeInteger(checkpointWallMs) || checkpointWallMs<0 || checkpointWallMs>=this.expiresAt || (this.checkpointWallMs!==null && checkpointWallMs<this.checkpointWallMs))) throw new Error('invalid retention clock'); await this.storage.save(this.sessionId,{schemaVersion:1,expiresAt:this.expiresAt,...(this.storage.durable ? {expiryClock:'unix_ms',checkpointWallMs,checkpointMonotonicMs} : {}),state:next},{signal}); this.checkpointWallMs=checkpointWallMs; this.checkpointMonotonicMs=checkpointMonotonicMs;
        const ids=new Set([...this.memory.deletedEvidence].filter(id=>!before.memory.deletedEvidence.includes(id)));
        const evictions=this.ring.evictions.slice(before.ring.evictions.length);
        for(const eviction of evictions) { for(const id of eviction.evidenceIds) ids.add(id); if(eviction.eventId) ids.add(eviction.eventId); }
        for(const event of this.memory.events.values()) if((event.evidenceIds??[]).some(id=>ids.has(id))) ids.add(event.eventId);
        for(const observation of this.memory.observations.values()) if((observation.evidenceIds??[]).some(id=>ids.has(id))) ids.add(observation.observationId);
        if(ids.size) for(const listener of this.invalidationListeners) { try { listener([...ids]); } catch {} }
        return copy(result); }
      catch(error) { Object.assign(this,restore(before)); throw error; }
    });
    this.queue=operation.catch(()=>{}); return operation;
  }
  ingestPerception({frame, observations, event, mapCorrection, now}, {signal}={}) { return this.change(()=>{
    if (!Array.isArray(observations)) throw new TypeError('observations required');
    if (this.memory.deletedEvidence.has(frame.id)) throw new Error('evidence was deleted');
    if (!this.ring.add(frame,now)) throw new Error('frame evidence unavailable');
    for (const observation of observations) this.memory.observe(observation);
    if (mapCorrection) {
      const {from,to}=mapCorrection;
      const check=compareAnchors({...from,objectAnchorWorld:[0,0,0]},{...to,objectAnchorWorld:[0,0,0]},mapCorrection);
      if (check.status!=='comparable' || check.correction===null || to.mapId!==frame.mapId || to.mapVersion!==frame.mapVersion || to.coordinateFrameId!==frame.coordinateFrameId || !observations.every(o=>o.mapId===to.mapId && o.mapVersion===to.mapVersion && o.coordinateFrameId===to.coordinateFrameId) || mapCorrection.causalStatus!=='online_causal' || !Number.isFinite(mapCorrection.observedAt) || !Number.isFinite(mapCorrection.processedAt) || mapCorrection.observedAt<0 || mapCorrection.processedAt<mapCorrection.observedAt || mapCorrection.processedAt>now || mapCorrection.observedAt>frame.observedAt) throw new Error('invalid map correction');
      if (mapCorrection.evidenceIds !== undefined && (!Array.isArray(mapCorrection.evidenceIds) || mapCorrection.evidenceIds.some(id=>typeof id!=='string' || !id || this.memory.deletedEvidence.has(id) || this.ring.evictions.some(e=>e.evidenceIds.includes(id)) || (!this.ring.ring.has(id) && ![...this.ring.pins.values()].some(p=>p.items.some(item=>item.id===id)))))) throw new Error('invalid correction evidence');
      this.memory.appendEvent({...mapCorrection,evidenceIds:[...new Set([frame.id,...(mapCorrection.evidenceIds??[])])],eventId:mapCorrection.id,type:'map_correction'});
    }
    let savedEvent=null;
    if (event) {
      const previous=this.memory.events.get(event.eventId);
      savedEvent=previous ? {...event,eventId:`${event.eventId}:association:1`,supersedesEventId:event.eventId,associationRevision:1} : event;
      const pin=this.ring.pin(savedEvent.eventId,[frame.id],now);
      savedEvent={...savedEvent,evidenceIds:[frame.id],evidencePinState:pin.ok?'pinned':'evidence_evicted'};
      const added=this.memory.appendEvent(savedEvent);
      if(added && savedEvent.supersedesEventId) for(const d of this.memory.derivations.values()) if(d.eventIds?.includes(savedEvent.supersedesEventId)) {d.valid=false;d.reason='association_revised';}
    }
    return {event:savedEvent};
  },{signal}); }
  ingestFrame(frame,now) { return this.change(()=>{ if(this.memory.deletedEvidence.has(frame.id)) throw new Error('evidence was deleted'); return this.ring.add(frame,now); }); }
  pinFrameForEvent(frame,eventId,now) { return this.change(()=>{if(this.memory.deletedEvidence.has(frame.id))throw new Error('evidence was deleted');this.ring.add(frame,now);return this.ring.pin(eventId,[frame.id],now);}); }
  releaseEventPin(eventId) { return this.change(()=>this.ring.release(eventId)); }
  advanceTime(now) { return this.change(()=>{this.ring.tick(now); return true;}); }
  ingestEvent(event,evidenceIds,now,{requireExistingPin=false}={}) { return this.change(()=>{
    const existing=this.memory.events.get(event.eventId);
    if(existing) {
      const expected={...copy(event),evidenceIds:copy(evidenceIds),evidencePinState:existing.evidencePinState};
      if(JSON.stringify(existing)!==JSON.stringify(expected)) throw new Error('conflicting eventId');
      return {inserted:false,pin:existing.evidencePinState};
    }
    if(evidenceIds.some(id=>this.memory.deletedEvidence.has(id))) throw new Error('evidence was deleted');
    let pin;
    if(requireExistingPin){this.ring.tick(now);const existingPin=this.ring.get(event.eventId);const previous=[...this.ring.evictions].reverse().find(e=>e.eventId===event.eventId);pin=existingPin && evidenceIds.every(id=>existingPin.items.some(item=>item.id===id))?{ok:true}:{ok:false,reason:previous?.reason ?? 'evidence_unavailable'};}
    else pin=this.ring.pin(event.eventId,evidenceIds,now);
    const pinState=pin.ok ? 'pinned' : 'evidence_evicted';
    this.memory.appendEvent({...event,evidenceIds:copy(evidenceIds),evidencePinState:pinState});
    return {inserted:true,pin:pinState,reason:pin.reason ?? null};
  }); }
  reviseEvent(event) { return this.change(()=>{
    const added=this.memory.appendEvent(event);
    if(added && event.supersedesEventId) for(const d of this.memory.derivations.values()) if(d.eventIds?.includes(event.supersedesEventId)) {d.valid=false;d.reason='association_revised';}
    return added;
  }); }
  observe(observation) { return this.change(()=>this.memory.observe(observation)); }
  addDerivation(derivation) { return this.change(()=>{this.memory.addDerivation(derivation); const d=this.memory.derivations.get(derivation.id); const eviction=[...this.ring.evictions].reverse().find(x=>this.derivationUsesEviction(d,x)); if(eviction){d.valid=false; d.reason=eviction.reason;} return true;}); }
  async getDerivation(id) { if(this.closing || this.closed) throw new Error('session closed'); await this.queue; if(this.closed) throw new Error('session closed'); this.checkExpiry(); return this.memory.getDerivation(id); }
  addRelation(relation) { return this.change(()=>this.memory.addRelation(relation)); }
  link(link) { return this.change(()=>this.memory.link(link)); }
  unlink(linkId) { return this.change(()=>this.memory.unlink(linkId)); }
  deleteEvidence(id) { return this.change(()=>{this.ring.deleteEvidence(id); this.memory.deleteEvidence(id); return true;}); }
  async attentionHistory({observedUntil,processedUntil,limit=20}={}) {
    finite(observedUntil,'observedUntil'); finite(processedUntil,'processedUntil');
    if(observedUntil>processedUntil || !Number.isInteger(limit) || limit<0 || limit>20) throw new TypeError('invalid attention history cutoff');
    if(this.closing || this.closed) throw new Error('session closed'); await this.queue;
    if(this.closing || this.closed) throw new Error('session closed'); this.checkExpiry();
    const now=this.clock(); finite(now,'clock');
    if(processedUntil>now) throw new Error('future processing cutoff');
    const eligible=[...this.memory.events.values()].filter(e=>e.causalStatus==='online_causal' && ['fixated','briefly_crossed'].includes(e.type) && Number.isFinite(e.observedAt) && Number.isFinite(e.endAt) && e.endAt>=e.observedAt && e.endAt<=observedUntil && Number.isFinite(e.processedAt) && e.processedAt>=e.endAt && e.processedAt<=processedUntil);
    const superseded=new Set(eligible.map(e=>e.supersedesEventId).filter(Boolean));
    const selected=eligible.filter(e=>{
      const pin=this.ring.pins.get(e.eventId);
      return !superseded.has(e.eventId) && e.evidencePinState==='pinned' && pin && now>=pin.pinnedAt && now-pin.pinnedAt<this.ring.pinAgeMs && Array.isArray(e.evidenceIds) && e.evidenceIds.length>0 && e.evidenceIds.every(id=>!this.memory.deletedEvidence.has(id) && pin.items.some(item=>item.id===id));
    }).sort((a,b)=>a.endAt-b.endAt || a.eventId.localeCompare(b.eventId));
    return copy(limit ? selected.slice(-limit) : []);
  }
  async retrieve({objectId,observedUntil=Infinity,targetMap}={}) { if(this.closing || this.closed) throw new Error('session closed'); await this.queue; if(this.closed) throw new Error('session closed'); this.checkExpiry(); const evictions=this.ring.evictions; const glimpses=this.memory.glimpses(observedUntil).map(e=>{const lineage=new Set([e.eventId]); let previous=e.supersedesEventId; while(previous && !lineage.has(previous)){lineage.add(previous);previous=this.memory.events.get(previous)?.supersedesEventId;} const eviction=[...evictions].reverse().find(x=>lineage.has(x.eventId) || (x.eventId==null && x.evidenceIds.some(id=>e.evidenceIds?.includes(id)))); return eviction ? {...e,evidencePinState:'evidence_evicted',evidenceEvictionReason:eviction.reason} : e;}); const lastSeen=objectId ? this.memory.lastSeen(objectId,observedUntil,new Set(evictions.flatMap(e=>e.evidenceIds))) : null; let position=null;
    if(lastSeen && targetMap) {
      let correction=[...this.memory.events.values()].filter(e=>e.type==='map_correction' && e.processedAt<=observedUntil && e.from?.mapId===lastSeen.mapId && e.from?.mapVersion===lastSeen.mapVersion && e.from?.coordinateFrameId===lastSeen.coordinateFrameId && e.to?.coordinateFrameId===targetMap.coordinateFrameId && e.to?.mapId===targetMap.mapId && e.to?.mapVersion===targetMap.mapVersion).sort((a,b)=>b.processedAt-a.processedAt)[0];
      if(correction && (correction.causalStatus!=='online_causal' || !Number.isFinite(correction.observedAt) || correction.observedAt>observedUntil || !Number.isFinite(correction.processedAt) || correction.processedAt<correction.observedAt || !Array.isArray(correction.evidenceIds) || !correction.evidenceIds.length || correction.evidenceIds.some(id=>this.memory.deletedEvidence.has(id) || evictions.some(e=>e.evidenceIds.includes(id))))) correction=null;
      position={status:'unavailable',reason:'map_transform_unavailable'};
      const converted={};
      for(const key of ['surfacePointWorld','gazeHitPointWorld','objectAnchorWorld']) if(lastSeen[key]) {
        const result=compareAnchors({...lastSeen,objectAnchorWorld:lastSeen[key]},{...targetMap,objectAnchorWorld:[0,0,0]},correction);
        if(result.status==='comparable') converted[key]=result.displacement.map(x=>-x);
      }
      if(Object.keys(converted).length) position={status:'ok',points:converted,correction:correction ? copy(correction) : null,meaning:'last_seen_not_current'};
    }
    return {contextVersion:this.memory.version,lastSeen,position,glimpses,relations:this.memory.relationsAt(observedUntil),evictions:copy(evictions)}; }
  finish(remove) { if(this.closing || this.closed) return Promise.reject(new Error('session closed')); this.closing=true; const operation=this.queue.then(async()=>{ if(remove) await this.storage.delete(this.sessionId); this.memory=new ExperienceMemory(); this.ring=new EvidenceRing(); this.closed=true; }); this.queue=operation.catch(()=>{this.closing=false;}); return operation; }
  deleteSession() { return this.finish(true); }
  close() { return this.finish(!this.storage.durable); }
}




