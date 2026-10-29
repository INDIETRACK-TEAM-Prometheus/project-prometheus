import {IndexedDBStorage} from './index.js';

const clone = value => structuredClone(value);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const time = value => Number.isFinite(value) && value >= 0;
const text = (value, max=2000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const point = (value, size) => Number.isFinite(value) && value >= 0 && value < size;
const sparkStatuses = ['pending','complete','failed','cancelled','withheld','skipped'];
const sparkFailureReasons = ['network_error','request_failed','timeout','rate_limited','budget_exceeded','provider_busy','service_unavailable','not_configured','access_denied','incomplete_response','invalid_response','request_rejected','provider_failed'];
const estimateStatuses = ['uncalibrated_estimate','validated_calibration_estimate'];
const provisionalClass = estimateStatus => estimateStatus==='uncalibrated_estimate'?'uncalibrated_provisional':'calibrated_provisional';
const calibrationClass = estimateStatus => estimateStatus==='uncalibrated_estimate'?'uncalibrated':'calibrated_estimate';

function cleanBounds(bounds, frame) {
  const {left,top,right,bottom} = bounds ?? {};
  if (![left,top,right,bottom].every(Number.isInteger) || left < 0 || top < 0 || right > frame.width || bottom > frame.height || right <= left || bottom <= top) throw new TypeError('invalid provisional mask bounds');
  return {left,top,right,bottom};
}

function cleanScenario(value) {
  const {scenario_id,possible_next_action,horizon_ms,grounding_refs,assumptions,status} = value ?? {};
  if (!text(scenario_id,200) || !text(possible_next_action) || !time(horizon_ms) || !Array.isArray(grounding_refs) || grounding_refs.length > 100 || !grounding_refs.every(id=>text(id,128)) || !Array.isArray(assumptions) || assumptions.length > 20 || !assumptions.every(item=>typeof item==='string' && item.length<=1000) || !['active','withdrawn','abstained'].includes(status)) throw new TypeError('invalid provisional Spark scenario');
  return {scenario_id,possible_next_action,horizon_ms,grounding_refs:[...grounding_refs],assumptions:[...assumptions],status};
}

function cleanSpark({status,scenarios=[],reason}={}) {
  if (!sparkStatuses.includes(status) || !Array.isArray(scenarios) || scenarios.length>5 || (reason!==undefined && (status!=='failed' || !sparkFailureReasons.includes(reason)))) throw new TypeError('invalid provisional Spark result');
  return {status,scenarios:scenarios.map(cleanScenario),...(reason===undefined?{}:{reason})};
}

function cleanRecord({frame,gazePoint,gazeTiming,masks,scenarios,sparkStatus='complete',sparkReason,recordedAt}) {
  if (!text(frame?.frameId,128) || !time(frame.observedAt) || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width*frame.height > 1048576) throw new TypeError('invalid provisional frame');
  if (!point(gazePoint?.x,1) || !point(gazePoint?.y,1) || !time(gazeTiming?.sampleAtMs) || !time(gazeTiming?.processedAtMs) || gazeTiming.processedAtMs < gazeTiming.sampleAtMs || !['browser_capture_estimate','callback_time_not_capture'].includes(gazeTiming.timestampKind) || !estimateStatuses.includes(gazeTiming.estimateStatus) || gazeTiming.timestampKind==='callback_time_not_capture'&&gazeTiming.estimateStatus!=='uncalibrated_estimate') throw new TypeError('invalid provisional gaze estimate');
  if (!Array.isArray(masks) || masks.length > 1024 || !Array.isArray(scenarios) || scenarios.length > 5 || !sparkStatuses.includes(sparkStatus) || !time(recordedAt)) throw new TypeError('invalid provisional tracking result');
  const bounds=masks.slice(0,10).map(mask=>cleanBounds(mask?.bounds,frame));
  return {
    classification:provisionalClass(gazeTiming.estimateStatus),
    timingStatus:'provisional',
    calibrationStatus:calibrationClass(gazeTiming.estimateStatus),
    recordedAt,
    frame:{frameId:frame.frameId,observedAt:frame.observedAt,width:frame.width,height:frame.height},
    gaze:{x:gazePoint.x,y:gazePoint.y,sampleAtMs:gazeTiming.sampleAtMs,processedAtMs:gazeTiming.processedAtMs,timestampKind:gazeTiming.timestampKind,estimateStatus:gazeTiming.estimateStatus},
    sam:{maskCount:masks.length,bounds},
    spark:cleanSpark({status:sparkStatus,scenarios,reason:sparkReason})
  };
}

function cleanStoredRecord(record) {
  if (!text(record?.id,32) || !['uncalibrated_provisional','calibrated_provisional'].includes(record.classification) || record.timingStatus!=='provisional' || !['uncalibrated','calibrated_estimate'].includes(record.calibrationStatus) || !time(record.recordedAt)) throw new Error('invalid stored provisional tracking record');
  const frame=record.frame, gaze=record.gaze, sam=record.sam, spark=record.spark;
  if (!text(frame?.frameId,128) || !time(frame.observedAt) || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width<1 || frame.height<1 || frame.width*frame.height>1048576 || !point(gaze?.x,1) || !point(gaze?.y,1) || !time(gaze.sampleAtMs) || !time(gaze.processedAtMs) || gaze.processedAtMs<gaze.sampleAtMs || !['browser_capture_estimate','callback_time_not_capture'].includes(gaze.timestampKind) || !estimateStatuses.includes(gaze.estimateStatus) || gaze.estimateStatus!== (record.calibrationStatus==='uncalibrated'?'uncalibrated_estimate':'validated_calibration_estimate') || record.classification!==provisionalClass(gaze.estimateStatus) || gaze.timestampKind==='callback_time_not_capture'&&gaze.estimateStatus!=='uncalibrated_estimate' || !Number.isInteger(sam?.maskCount) || sam.maskCount<0 || sam.maskCount>1024 || !Array.isArray(sam.bounds) || sam.bounds.length>10 || !sparkStatuses.includes(spark?.status) || !Array.isArray(spark?.scenarios) || spark.scenarios.length>5) throw new Error('invalid stored provisional tracking record');
  return {
    id:record.id,classification:record.classification,timingStatus:'provisional',calibrationStatus:record.calibrationStatus,recordedAt:record.recordedAt,
    frame:{frameId:frame.frameId,observedAt:frame.observedAt,width:frame.width,height:frame.height},
    gaze:{x:gaze.x,y:gaze.y,sampleAtMs:gaze.sampleAtMs,processedAtMs:gaze.processedAtMs,timestampKind:gaze.timestampKind,estimateStatus:gaze.estimateStatus},
    sam:{maskCount:sam.maskCount,bounds:sam.bounds.map(bound=>cleanBounds(bound,frame))},
    spark:cleanSpark(spark)
  };
}

async function acquireLock(locks, sessionId) {
  if (!locks?.request) throw new Error('exclusive provisional tracking lock required');
  let release, opened, fail;
  const acquired=new Promise((resolve,reject)=>{opened=resolve;fail=reject;});
  const held=new Promise(resolve=>{release=resolve;});
  const operation=locks.request(`prometheus-provisional-tracking-${sessionId}`,{ifAvailable:true},async lock=>{
    if (!lock) { fail(new Error('provisional tracking is open elsewhere')); return; }
    opened(); await held;
  });
  operation.catch(fail);
  await acquired;
  return {release,operation};
}

const storageKey = sessionId => `provisional-tracking:${sessionId}`;

// Provisional demo output is kept in a separate, non-expiring local store. Only
// normalized coordinates, mask bounds, and scenario text are persisted.
export class ProvisionalTrackingStore {
  static async open({sessionId='local-research',retentionConsent=false,locks=globalThis.navigator?.locks,storage=new IndexedDBStorage({databaseName:'prometheus-provisional-tracking-v1'}),now=Date.now,maxRecords=10000,maxSnapshotBytes=64*1024**2}={}) {
    if (retentionConsent!==true || !validId(sessionId) || typeof now!=='function' || !Number.isSafeInteger(maxRecords) || maxRecords<1 || !Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes<1 || !storage?.load || !storage?.save || !storage?.delete) throw new Error('explicit retention consent and valid storage required');
    const lock=await acquireLock(locks,sessionId), key=storageKey(sessionId);
    try {
      const saved=await storage.load(key);
      if (saved!=null && (saved.schemaVersion!==1 || !Array.isArray(saved.records) || saved.records.length>maxRecords)) throw new Error('unsupported provisional tracking snapshot');
      const records=(saved?.records ?? []).map(cleanStoredRecord);
      if (new Set(records.map(record=>record.id)).size!==records.length) throw new Error('duplicate provisional tracking record id');
      if (new TextEncoder().encode(JSON.stringify({schemaVersion:1,records})).byteLength>maxSnapshotBytes) throw new Error('provisional tracking snapshot quota exceeded');
      return new ProvisionalTrackingStore({sessionId,key,storage,records,now,maxRecords,maxSnapshotBytes,...lock});
    } catch(error) {
      try { await storage.close?.(); } finally { lock.release(); await lock.operation; }
      throw error;
    }
  }
  constructor({sessionId,key,storage,records,now,maxRecords,maxSnapshotBytes,release,operation}) {
    Object.assign(this,{sessionId,key,storage,records,now,maxRecords,maxSnapshotBytes,release,operation});
    this.queue=Promise.resolve(); this.closed=false; this.closing=false;
  }
  async list() {
    if (this.closing || this.closed) throw new Error('provisional tracking store closed');
    await this.queue;
    if (this.closed) throw new Error('provisional tracking store closed');
    return clone(this.records);
  }
  appendDemoResult({frame,gazePoint,gazeTiming,masks,scenarios=[],sparkStatus='complete',sparkReason}={}, {signal}={}) {
    if (this.closing || this.closed) return Promise.reject(new Error('provisional tracking store closed'));
    const operation=this.queue.then(async()=>{
      if (this.closed) throw new Error('provisional tracking store closed');
      if (signal?.aborted) throw new Error('operation cancelled');
      const record={id:`demo-${this.records.length+1}`,...cleanRecord({frame,gazePoint,gazeTiming,masks,scenarios,sparkStatus,sparkReason,recordedAt:this.now()})};
      const next=[...this.records,record];
      if (next.length>this.maxRecords) throw new Error('provisional tracking record quota exceeded');
      const snapshot={schemaVersion:1,records:next};
      if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength>this.maxSnapshotBytes) throw new Error('provisional tracking snapshot quota exceeded');
      if (signal?.aborted) throw new Error('operation cancelled');
      await this.storage.save(this.key,snapshot,{signal});
      this.records=next;
      return clone(record);
    });
    this.queue=operation.catch(()=>{});
    return operation;
  }
  updateSparkResult(recordId,{status,scenarios=[],reason}={}) {
    if (this.closing || this.closed) return Promise.reject(new Error('provisional tracking store closed'));
    if (!text(recordId,32)) return Promise.reject(new TypeError('invalid provisional Spark result'));
    const operation=this.queue.then(async()=>{
      if (this.closed) throw new Error('provisional tracking store closed');
      const index=this.records.findIndex(record=>record.id===recordId);
      if (index<0) throw new Error('provisional SAM result unavailable');
      const next=[...this.records];
      next[index]={...next[index],spark:cleanSpark({status,scenarios,reason})};
      const snapshot={schemaVersion:1,records:next};
      if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength>this.maxSnapshotBytes) throw new Error('provisional tracking snapshot quota exceeded');
      await this.storage.save(this.key,snapshot);
      this.records=next;
      return clone(next[index]);
    });
    this.queue=operation.catch(()=>{});
    return operation;
  }
  deleteAll() {
    if (this.closing || this.closed) return Promise.reject(new Error('provisional tracking store closed'));
    const operation=this.queue.then(async()=>{if(this.closed)throw new Error('provisional tracking store closed');await this.storage.delete(this.key);this.records=[];return true;});
    this.queue=operation.catch(()=>{});
    return operation;
  }
  async close({remove=false}={}) {
    if (this.closed) return false;
    if (this.closing) throw new Error('provisional tracking store is closing');
    this.closing=true;
    try {
      await this.queue;
      if (remove) { await this.storage.delete(this.key); this.records=[]; }
      this.closed=true;
      return true;
    } finally {
      try { await this.storage.close?.(); }
      finally { this.release(); await this.operation; }
    }
  }
}

export async function deleteProvisionalTracking({sessionId='local-research',locks=globalThis.navigator?.locks,storage=new IndexedDBStorage({databaseName:'prometheus-provisional-tracking-v1'})}={}) {
  if (!validId(sessionId) || !storage?.delete) throw new Error('valid session and storage required');
  const lock=await acquireLock(locks,sessionId);
  try { await storage.delete(storageKey(sessionId)); }
  finally { try { await storage.close?.(); } finally { lock.release(); await lock.operation; } }
}
