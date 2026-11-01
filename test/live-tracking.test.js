import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {LiveTracking, maskDigest, sha256Bytes} from '../src/runtime/live-tracking.js';

const W = 64, H = 64;
const rect = (left, top, right, bottom, extra = {}) => ({bounds: {left, top, right, bottom}, sourceWidth: W, sourceHeight: H, width: right - left, height: bottom - top, raster: Array((right - left) * (bottom - top)).fill(1), ...extra});
let clock = 0;
const input = (frameId, masks, {at = (clock += 100), scope = {sessionId: 's1', mapId: 'map', mapVersion: 1}, width = W, height = H} = {}) => ({scope, frameId, observedAt: at, processedAt: at + 1, width, height, masks, sam: {model: 'sam-3.1', provider: 'Meta', requestId: 'req-1'}});
const tracker = (options = {}) => new LiveTracking({nonce: 'n', ...options});

test('sha256 fallback matches node:crypto and mask digests are stable and geometry sensitive', async () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 1000]) {
    const bytes = Uint8Array.from({length: size}, (_, i) => (i * 7 + 3) & 255);
    assert.equal(sha256Bytes(bytes), createHash('sha256').update(bytes).digest('hex'));
  }
  const a = rect(2, 2, 10, 10, {objectId: 'provider-a', confidence: 0.9});
  const same = rect(2, 2, 10, 10, {objectId: 'provider-b', confidence: 0.1});
  const digest = await maskDigest(a);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(await maskDigest(same), digest);
  const holed = rect(2, 2, 10, 10); holed.raster[5] = 0;
  assert.notEqual(await maskDigest(holed), digest);
  assert.notEqual(await maskDigest(rect(3, 2, 11, 10)), digest);
});

test('a moved mask keeps one persistent local ID, becomes linked, and reports movement and digests', async () => {
  const live = tracker();
  const first = await live.ingest(input('f1', [rect(2, 2, 10, 10, {objectId: 'sam-0'})]));
  assert.equal(first.tracks[0].identityStatus, 'tentative');
  assert.deepEqual(first.candidates, []);
  assert.equal(first.tracks[0].area, 64);
  assert.equal(first.tracks[0].firstSeenFrameId, 'f1');
  assert.equal(first.provenance.samModel, 'sam-3.1');
  const id = first.tracks[0].objectId;
  const second = await live.ingest(input('f2', [rect(3, 2, 11, 10, {objectId: 'sam-7'})]));
  assert.equal(second.tracks[0].objectId, id);
  assert.equal(second.tracks[0].identityStatus, 'linked');
  assert.deepEqual(second.candidates, [id]);
  assert.equal(second.tracks[0].previousMaskDigest, first.tracks[0].maskDigest);
  assert.notEqual(second.tracks[0].maskDigest, first.tracks[0].maskDigest);
  assert.equal(second.tracks[0].observations, 2);
  assert.equal(second.tracks[0].firstSeenFrameId, 'f1');
  assert.deepEqual(second.changes.map(c => [c.type, c.objectId]), [['object_moved', id]]);
  // Identical mask: same digest, linked, and no spurious change.
  const third = await live.ingest(input('f3', [rect(3, 2, 11, 10)]));
  assert.equal(third.tracks[0].objectId, id);
  assert.equal(third.tracks[0].maskDigest, second.tracks[0].maskDigest);
  assert.deepEqual(third.changes, []);
  // A small shift above the move threshold keeps identity without invalidating dependents.
  const wide = tracker();
  await wide.ingest(input('g1', [rect(0, 0, 40, 10)]));
  const near = await wide.ingest(input('g2', [rect(1, 0, 41, 10)]));
  assert.equal(near.tracks[0].identityStatus, 'linked');
  assert.deepEqual(near.changes, []);
});

test('a new ID is issued after a gap longer than maxGapMs and the old track is reported deleted', async () => {
  const live = tracker({maxGapMs: 1000});
  const a = await live.ingest(input('f1', [rect(2, 2, 10, 10)], {at: 100}));
  const b = await live.ingest(input('f2', [rect(2, 2, 10, 10)], {at: 1100}));
  assert.equal(b.tracks[0].objectId, a.tracks[0].objectId);
  const c = await live.ingest(input('f3', [rect(2, 2, 10, 10)], {at: 2200}));
  assert.notEqual(c.tracks[0].objectId, a.tracks[0].objectId);
  assert.equal(c.tracks[0].identityStatus, 'tentative');
  assert.deepEqual(c.candidates, []);
  assert.deepEqual(c.changes.map(x => [x.type, x.objectId, x.reason]), [['object_deleted', a.tracks[0].objectId, 'gap_exceeded']]);
  assert.equal(live.status().trackCount, 1);
});

test('camera session, map and source-dimension changes reset identity and start a new ID namespace', async () => {
  const live = tracker();
  const a = await live.ingest(input('f1', [rect(2, 2, 10, 10)]));
  const sameScopeId = a.tracks[0].objectId;
  const b = await live.ingest(input('f2', [rect(2, 2, 10, 10)], {scope: {sessionId: 's2', mapId: 'map', mapVersion: 1}}));
  assert.deepEqual(b.reset, {reason: 'scope_changed'});
  assert.notEqual(b.tracks[0].objectId, sameScopeId);
  assert.equal(b.tracks[0].identityStatus, 'tentative');
  assert.notEqual(b.epochId, a.epochId);
  assert.deepEqual(b.changes.map(x => [x.type, x.objectId]), [['object_deleted', sameScopeId]]);
  const c = await live.ingest(input('f3', [rect(2, 2, 10, 10)], {scope: {sessionId: 's2', mapId: 'map', mapVersion: 2}}));
  assert.deepEqual(c.reset, {reason: 'scope_changed'});
  assert.equal(c.tracks[0].identityStatus, 'tentative');
  const resized = rect(2, 2, 10, 10, {sourceWidth: 32, sourceHeight: 32});
  const d = await live.ingest(input('f4', [resized], {scope: {sessionId: 's2', mapId: 'map', mapVersion: 2}, width: 32, height: 32}));
  assert.equal(d.reset.reason, 'source_dimensions_changed');
  assert.equal(d.tracks[0].identityStatus, 'tentative');
  const dropped = live.reset('camera_changed');
  assert.deepEqual(dropped.map(x => x.type), ['object_deleted']);
  assert.equal(live.status().trackCount, 0);
});

test('ambiguous associations are withheld from candidates and flag the prior tracks as identity-uncertain', async () => {
  const live = tracker();
  const a = await live.ingest(input('f1', [rect(0, 0, 10, 10), rect(10, 0, 20, 10)]));
  const [left, right] = a.tracks.map(track => track.objectId);
  const b = await live.ingest(input('f2', [rect(5, 0, 15, 10)]));
  assert.equal(b.tracks[0].identityStatus, 'ambiguous');
  assert.deepEqual(b.tracks[0].candidateObjectIds.sort(), [left, right].sort());
  assert.notEqual(b.tracks[0].objectId, left);
  assert.notEqual(b.tracks[0].objectId, right);
  assert.deepEqual(b.candidates, []);
  assert.deepEqual(b.changes.filter(x => x.type === 'identity_changed').map(x => x.objectId).sort(), [left, right].sort());
});

test('masks without a valid decoded raster are rejected, never tracked, and provider IDs are ignored', async () => {
  const live = tracker();
  const bad = [{bounds: {left: 0, top: 0, right: 4, bottom: 4}}, rect(0, 0, 4, 4, {raster: Array(16).fill(2)}), rect(0, 0, 4, 4, {sourceWidth: 10}), rect(0, 0, 4, 4, {raster: Array(16).fill(0)}), null];
  const result = await live.ingest(input('f1', [...bad, rect(20, 20, 30, 30, {objectId: 'sam-9'})]));
  assert.equal(result.rejected, 5);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].detectionIndex, 5);
  assert.match(result.tracks[0].objectId, /^trk:n\d+:1$/);
  await assert.rejects(() => live.ingest(input('f1b', [], {at: 50})), /not newer/);
  await assert.rejects(() => live.ingest({...input('f9', []), scope: undefined}), /invalid tracking input/);
});

test('memory is bounded by track count, raster budget and lineage length', async () => {
  const live = tracker({maxTracks: 3, maxLineage: 5, maxRetainedPixels: 300, maxGapMs: 100000});
  for (let frame = 0; frame < 12; frame++) {
    const x = (frame % 4) * 16;
    // Two disjoint masks per frame at moving positions, so unmatched old tracks accumulate until evicted.
    await live.ingest(input(`f${frame}`, [rect(x, 0, x + 8, 8), rect(x, 32, x + 8, 40)]));
    const status = live.status();
    assert.ok(status.trackCount <= 3, `tracks ${status.trackCount}`);
    assert.ok(status.retainedPixels <= 300, `pixels ${status.retainedPixels}`);
    assert.ok(status.lineageEntries <= 5);
  }
  assert.ok(live.status().evicted > 0);
  const many = tracker({maxTracks: 2});
  const out = await many.ingest(input('m1', [rect(0, 0, 4, 4), rect(8, 0, 12, 4), rect(16, 0, 20, 4)]));
  assert.equal(out.tracks.length, 2);
  assert.equal(out.truncated, 1);
});

test('concurrent ingests are serialized in call order', async () => {
  const live = tracker();
  const [one, two] = await Promise.all([live.ingest(input('f1', [rect(2, 2, 10, 10)])), live.ingest(input('f2', [rect(2, 2, 10, 10)]))]);
  assert.equal(one.tracks[0].identityStatus, 'tentative');
  assert.equal(two.tracks[0].identityStatus, 'linked');
  assert.equal(two.tracks[0].objectId, one.tracks[0].objectId);
});

test('invalid configuration is rejected', () => {
  assert.throws(() => new LiveTracking({maxTracks: 0}), /invalid live tracking/);
  assert.throws(() => new LiveTracking({maxTracks: 101}), /invalid live tracking/);
  assert.throws(() => new LiveTracking({moveIoU: 0}), /invalid live tracking/);
  assert.throws(() => new LiveTracking({nonce: 'BAD NONCE'}), /invalid live tracking/);
});
