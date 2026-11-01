import {associateMasks} from '../spatial/mask-association.js';

const text = (value, max = 128) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const int = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const MAX_RASTER = 1048576;

// Pure-JS SHA-256 fallback for contexts without crypto.subtle (for example plain-http pages). Verified against node:crypto in tests.
const K = Uint32Array.from('428a2f9871374491b5c0fbcfe9b5dba53956c25b59f111f1923f82a4ab1c5ed5d807aa9812835b01243185be550c7dc372be5d7480deb1fe9bdc06a7c19bf174e49b69c1efbe47860fc19dc6240ca1cc2de92c6f4a7484aa5cb0a9dc76f988da983e5152a831c66db00327c8bf597fc7c6e00bf3d5a7914706ca635114292967'.concat('27b70a852e1b21384d2c6dfc53380d13650a7354766a0abb81c2c92e92722c85a2bfe8a1a81a664bc24b8b70c76c51a3d192e819d6990624f40e3585106aa07019a4c1161e376c082748774c34b0bcb5391c0cb34ed8aa4a5b9cca4f682e6ff3748f82ee78a5636f84c878148cc7020890befffaa4506cebbef9a3f7c67178f2').match(/.{8}/g), hex => parseInt(hex, 16));
export function sha256Bytes(bytes) {
  const length = bytes.length, padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(bytes); padded[length] = 0x80;
  const view = new DataView(padded.buffer), bits = length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000)); view.setUint32(padded.length - 4, bits >>> 0);
  const h = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19), w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) w[i] = (w[i - 16] + (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) + w[i - 7] + (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10))) >>> 0;
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return [...h].map(value => value.toString(16).padStart(8, '0')).join('');
}

async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.digest !== 'function') return sha256Bytes(bytes);
  return [...new Uint8Array(await subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}

function validMask(mask, width, height) {
  const b = mask?.bounds;
  return !!mask && typeof mask === 'object' && mask.sourceWidth === width && mask.sourceHeight === height && int(mask.width, 1, MAX_RASTER) && int(mask.height, 1, MAX_RASTER) && mask.width * mask.height <= MAX_RASTER &&
    Array.isArray(mask.raster) && mask.raster.length === mask.width * mask.height && !!b && [b.left, b.top, b.right, b.bottom].every(Number.isInteger) &&
    b.left >= 0 && b.top >= 0 && b.right <= width && b.bottom <= height && b.right > b.left && b.bottom > b.top && mask.raster.every(value => value === 0 || value === 1);
}

// SHA-256 over the decoded foreground raster and its geometry, so it is independent of provider objectId/confidence.
// Source dimensions + crop bounds + raster grid are part of the digest; a different crop of the same pixels hashes differently.
export async function maskDigest(mask) {
  const header = new TextEncoder().encode(`sam-mask-v1|${mask.sourceWidth}x${mask.sourceHeight}|${mask.bounds.left},${mask.bounds.top},${mask.bounds.right},${mask.bounds.bottom}|${mask.width}x${mask.height}|`);
  const bytes = new Uint8Array(header.length + mask.raster.length);
  bytes.set(header); bytes.set(Uint8Array.from(mask.raster), header.length);
  return sha256Hex(bytes);
}

const rasterArea = mask => {
  let count = 0; for (const value of mask.raster) count += value;
  return Math.round(count * (mask.bounds.right - mask.bounds.left) * (mask.bounds.bottom - mask.bounds.top) / (mask.width * mask.height));
};

/**
 * Per-camera-session persistent local track IDs over decoded SAM raster masks.
 * Identity comes only from mask-IoU association (src/spatial/mask-association.js); provider objectIds are ignored.
 * identity_status: tentative (no prior track), linked (clear one-to-one match), ambiguous (several close prior tracks).
 * Only `linked` tracks are eligible next-gaze candidates. Local IDs are not semantic identities and not validated for accuracy.
 */
export class LiveTracking {
  constructor({maxTracks = 100, maxGapMs = 1000, moveIoU = 0.9, minIoU = 0.1, ambiguityMargin = 0.05, maxRetainedPixels = 2000000, maxLineage = 256, nonce = null, associate = associateMasks, digest = maskDigest} = {}) {
    if (!int(maxTracks, 1, 100) || !time(maxGapMs) || !(moveIoU > 0 && moveIoU <= 1) || !(minIoU > 0 && minIoU <= 1) || !(ambiguityMargin >= 0 && ambiguityMargin <= 1) || !int(maxRetainedPixels, 1, 4194304) || !int(maxLineage, 1, 4096) || (nonce !== null && !/^[a-z0-9]{1,16}$/.test(nonce)) || typeof associate !== 'function' || typeof digest !== 'function') throw new TypeError('invalid live tracking configuration');
    Object.assign(this, {maxTracks, maxGapMs, moveIoU, minIoU, ambiguityMargin, maxRetainedPixels, maxLineage, associate, digest});
    this.fixedNonce = nonce; this.generation = 0; this.chain = Promise.resolve();
    this.metrics = {ingested: 0, resets: 0, rejectedMasks: 0, evicted: 0, expired: 0};
    this._clear('init');
  }

  _clear(reason) {
    // New ID namespace on every reset, so IDs from before the reset can never be re-linked.
    this.epochId = `${this.fixedNonce ?? Math.random().toString(36).slice(2, 8)}${this.generation++}`;
    this.tracks = new Map(); this.serial = 0; this.scopeKey = null; this.lastObservedAt = -1; this.lastProcessedAt = -1; this.lastFrameId = null; this.lineage = [];
    this.lastReset = reason;
  }

  // Explicit reset (camera/session/map change). Returns object_deleted changes for the dropped tracks.
  reset(reason = 'explicit') {
    const dropped = [...this.tracks.keys()].map(objectId => ({type: 'object_deleted', objectId, reason}));
    this.metrics.resets++; this._clear(reason);
    return dropped;
  }

  status() { return {epochId: this.epochId, trackCount: this.tracks.size, retainedPixels: this._retained(), lineageEntries: this.lineage.length, lastObservedAt: this.lastObservedAt < 0 ? null : this.lastObservedAt, lastReset: this.lastReset, ...this.metrics}; }

  _retained() { let sum = 0; for (const track of this.tracks.values()) sum += track.mask.width * track.mask.height; return sum; }

  // Ingests are serialized so digests (async) cannot interleave with association (sync).
  ingest(input) {
    const run = this.chain.then(() => this._ingest(input));
    this.chain = run.catch(() => {});
    return run;
  }

  async _ingest(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('tracking input required');
    const {scope, frameId, observedAt, processedAt, width, height, masks, sam = {}} = input;
    if (!text(frameId) || !time(observedAt) || !time(processedAt) || processedAt < observedAt || !int(width, 1, 4096) || !int(height, 1, 4096) || !Array.isArray(masks) || masks.length > 1000 || !scope || typeof scope !== 'object' || !text(scope.mapId) || !Number.isInteger(scope.mapVersion) || (scope.sessionId != null && !text(scope.sessionId, 256)) || (scope.cameraId != null && !text(scope.cameraId, 256)) || (sam.model != null && !text(sam.model))) throw new TypeError('invalid tracking input');
    const accepted = [];
    let rejected = 0, truncated = 0;
    masks.forEach((mask, index) => {
      if (!validMask(mask, width, height)) { rejected++; return; }
      if (mask.raster.indexOf(1) < 0) { rejected++; return; }
      if (accepted.length >= this.maxTracks) { truncated++; return; }
      accepted.push({index, mask});
    });
    const digests = await Promise.all(accepted.map(item => this.digest(item.mask)));
    // Everything below is synchronous: no await between reading and mutating tracker state.
    const scopeKey = JSON.stringify([scope.sessionId ?? null, scope.cameraId ?? null, scope.mapId, scope.mapVersion]);
    const changes = [];
    let reset = null;
    const drop = (objectId, reason) => { if (this.tracks.delete(objectId)) changes.push({type: 'object_deleted', objectId, reason}); };
    const restart = reason => {
      for (const objectId of [...this.tracks.keys()]) changes.push({type: 'object_deleted', objectId, reason});
      this.metrics.resets++; const keep = this.scopeKey; this._clear(reason); this.scopeKey = keep; reset = {reason};
    };
    if (this.scopeKey !== null && this.scopeKey !== scopeKey) restart('scope_changed');
    this.scopeKey = scopeKey;
    if (observedAt <= this.lastObservedAt || processedAt < this.lastProcessedAt || frameId === this.lastFrameId) throw new TypeError('frame is not newer than tracker clock');
    this.metrics.rejectedMasks += rejected;
    for (const [objectId, track] of [...this.tracks]) if (observedAt - track.lastSeenAt > this.maxGapMs) { drop(objectId, 'gap_exceeded'); this.metrics.expired++; }
    const incoming = accepted.reduce((sum, item) => sum + item.mask.width * item.mask.height, 0);
    const evictOldest = (limit, reason) => {
      let retained = this._retained();
      const byAge = [...this.tracks.values()].sort((x, y) => x.lastSeenAt - y.lastSeenAt || x.objectId.localeCompare(y.objectId));
      for (const track of byAge) { if (retained <= limit || (touched.has(track.objectId))) continue; retained -= track.mask.width * track.mask.height; drop(track.objectId, reason); this.metrics.evicted++; }
    };
    const touched = new Set();
    // The association helper withholds everything above its raster budget, so leave room for the incoming masks.
    evictOldest(Math.max(0, Math.min(this.maxRetainedPixels, 4194304 - incoming)), 'raster_budget');
    const previous = [...this.tracks.values()];
    const association = this.associate(previous.map(track => ({objectId: track.objectId, mask: track.mask})), accepted.map(item => ({mask: item.mask})), {minIoU: this.minIoU, ambiguityMargin: this.ambiguityMargin});
    if (association.status !== 'ok') restart(association.reason ?? association.status);
    const matches = association.status === 'ok' ? new Map(association.matches.map(match => [match.detectionIndex, match])) : new Map();
    const ambiguous = association.status === 'ok' ? new Map(association.ambiguous.map(item => [item.detectionIndex, item.candidateObjectIds])) : new Map();
    const out = [], identityDoubt = new Set();
    accepted.forEach((item, i) => {
      const matched = matches.get(i), prior = matched ? this.tracks.get(matched.objectId) : null;
      const objectId = matched ? matched.objectId : `trk:${this.epochId}:${++this.serial}`;
      const identityStatus = matched ? 'linked' : ambiguous.has(i) ? 'ambiguous' : 'tentative';
      const candidateObjectIds = ambiguous.get(i) ?? [];
      for (const id of candidateObjectIds) identityDoubt.add(id);
      const maskDigestValue = digests[i];
      const record = {objectId, identityStatus, maskDigest: maskDigestValue, area: rasterArea(item.mask), bounds: structuredClone(item.mask.bounds), detectionIndex: item.index, iou: matched ? matched.iou : null, candidateObjectIds: [...candidateObjectIds], firstSeenFrameId: prior?.firstSeenFrameId ?? frameId, firstSeenAt: prior?.firstSeenAt ?? observedAt, observations: Math.min(1_000_000, (prior?.observations ?? 0) + 1), previousMaskDigest: prior?.maskDigest ?? null};
      if (prior && matched.iou < this.moveIoU) changes.push({type: 'object_moved', objectId, reason: 'mask_iou_below_threshold', iou: matched.iou});
      this.tracks.set(objectId, {...record, lastSeenAt: observedAt, frameId, mask: item.mask});
      touched.add(objectId); out.push(record);
      this.lineage.push({frameId, observedAt, objectId, identityStatus, maskDigest: maskDigestValue, previousMaskDigest: record.previousMaskDigest, candidateObjectIds: [...candidateObjectIds]});
    });
    // A prior track that is now one of several close candidates for an unmatched detection has an uncertain identity.
    for (const id of identityDoubt) if (!touched.has(id) && this.tracks.has(id)) changes.push({type: 'identity_changed', objectId: id, reason: 'ambiguous_association'});
    // Capacity: evict the stalest unmatched tracks. Current-frame tracks are never evicted (detections <= maxTracks).
    if (this.tracks.size > this.maxTracks) {
      const stale = [...this.tracks.values()].filter(track => !touched.has(track.objectId)).sort((a, b) => a.lastSeenAt - b.lastSeenAt || a.objectId.localeCompare(b.objectId));
      for (const track of stale) { if (this.tracks.size <= this.maxTracks) break; drop(track.objectId, 'track_capacity'); this.metrics.evicted++; }
    }
    evictOldest(this.maxRetainedPixels, 'raster_budget');
    while (this.lineage.length > this.maxLineage) this.lineage.shift();
    this.lastObservedAt = observedAt; this.lastProcessedAt = processedAt; this.lastFrameId = frameId; this.metrics.ingested++;
    return structuredClone({
      frameId, observedAt, epochId: this.epochId, reset, rejected, truncated, tracks: out, changes,
      candidates: out.filter(track => track.identityStatus === 'linked').map(track => track.objectId),
      provenance: {frameId, observedAt, samModel: sam.model ?? null, samProvider: sam.provider ?? null, samRequestId: sam.requestId ?? null, maskCount: out.length}
    });
  }
}

export function createLiveTracking(options) { return new LiveTracking(options); }
