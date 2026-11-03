import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackgroundBrowserWork} from '../src/runtime/background-browser.js';
import {LiveTracking} from '../src/runtime/live-tracking.js';

const W = 16, H = 16;
const mask = (left, top, right, bottom, extra = {}) => ({objectId: `sam-${left}`, bounds: {left, top, right, bottom}, sourceWidth: W, sourceHeight: H, width: right - left, height: bottom - top, raster: Array((right - left) * (bottom - top)).fill(1), confidence: 0.9, ...extra});
const frameOf = (n, at) => ({frameId: `frame-${n}`, observedAt: at, processedAt: at + 1, width: W, height: H, imageData: 'data:image/png;base64,AA=='});
const snapshotOf = (n, at) => { const frame = frameOf(n, at); return {sessionId: 'sess', frame, gaze: {frameId: frame.frameId, x: .25, y: .75, observedAt: at, processedAt: at + 1}, observedUntil: at, processedAt: at + 1, dependencies: {mapId: 'map', mapVersion: 1, objectIds: ['cup'], evidenceIds: [frame.frameId]}, candidates: [{objectId: 'cup'}], events: [], context: {memory: []}}; };
const samResult = (frame, masks) => ({frame: {frameId: frame.frameId, observedAt: frame.observedAt}, masks, provider: 'Meta', model: 'sam-3.1', requestId: 'req-1'});
const tracker = () => new LiveTracking({nonce: 't'});
const frame = frameOf(1, 10), snapshot = snapshotOf(1, 10);

test('browser work captures, segments, tracks, then reasons; first frame withholds tentative candidates', async () => {
  const calls = [], marks = [];
  const work = createBackgroundBrowserWork({
    now: () => 12, tracker: tracker(),
    capture: async value => { calls.push('capture'); assert.equal(value.frame.frameId, 'frame-1'); return {frame: {...frame}}; },
    sam: async (value, {gaze, observedUntil}) => { calls.push('sam'); assert.equal(gaze.frameId, value.frameId); assert.equal(observedUntil, 10); return samResult(frame, [mask(0, 0, 2, 2)]); },
    reason: async (input, {firstByte}) => { calls.push('reason'); firstByte(); assert.deepEqual(input.masks, [{bounds: {left: 0, top: 0, right: 2, bottom: 2}}]); assert.deepEqual(input.candidates, []); assert.equal(input.tracks[0].identityStatus, 'tentative'); assert.match(input.tracks[0].maskDigest, /^[0-9a-f]{64}$/); assert.equal(input.provenance.samModel, 'sam-3.1'); return {frame: {frameId: 'frame-1', observedAt: 10}, scenarios: []}; }
  });
  const result = await work(snapshot, {signal: new AbortController().signal, mark: name => marks.push(name)});
  assert.deepEqual(calls, ['capture', 'sam', 'reason']);
  assert.deepEqual(marks, ['samDone', 'reasonFirstByte']);
  assert.deepEqual(result, {scenarios: [], objectDependencies: {objectIds: [], objectVersions: {}}, gazeTarget: null});
});

test('later frames reuse persistent IDs with digests, provenance and tracker-driven invalidations', async () => {
  const live = tracker(), invalidations = [], seen = [];
  const rasters = [[mask(0, 0, 8, 8)], [mask(1, 0, 9, 8, {objectId: 'sam-other'})]];
  let n = 0;
  const work = createBackgroundBrowserWork({
    now: () => 100, tracker: live,
    capture: async s => ({frame: s.frame}),
    sam: async value => samResult(value, rasters[n]),
    reason: async input => { seen.push(input); return {frame: {frameId: input.frame.frameId, observedAt: input.frame.observedAt}, scenarios: [], nextGaze: input.candidates.length ? {rankedTargetIds: [input.candidates[0].objectId, 'unknown']} : null}; }
  });
  const first = await work(snapshotOf(1, 10), {invalidate: change => invalidations.push(change)});
  n = 1;
  const second = await work(snapshotOf(2, 20), {invalidate: change => invalidations.push(change)});
  const id = seen[0].tracks[0].objectId;
  assert.match(id, /^trk:t\d+:1$/);
  assert.equal(first.candidateSpace, undefined);
  assert.deepEqual(seen[1].candidates, [{objectId: id, bounds: {left: 1, top: 0, right: 9, bottom: 8}}]);
  assert.equal(seen[1].tracks[0].identityStatus, 'linked');
  assert.deepEqual(second.nextGaze, {rankedTargetIds: [id, 'unknown']});
  assert.equal(second.candidateSpace.frameId, 'frame-2');
  assert.equal(second.candidateSpace.candidates[0].objectId, id);
  assert.equal(second.candidateSpace.candidates[0].maskDigest, seen[1].tracks[0].maskDigest);
  assert.equal(second.candidateSpace.candidates[0].identityStatus, 'linked');
  assert.deepEqual(second.candidateSpace.provenance, {frameId: 'frame-2', observedAt: 20, samModel: 'sam-3.1', samRequestId: 'req-1'});
  assert.deepEqual(second.objectDependencies, {objectIds: [id], objectVersions: {[id]: seen[1].tracks[0].maskDigest}});
  assert.deepEqual(invalidations, [{type: 'object_moved', objectId: id}]);
  assert.notEqual(seen[0].tracks[0].maskDigest, seen[1].tracks[0].maskDigest);
});

test('invalidations are delivered even when reasoning later fails, and bounds-only masks are never candidates', async () => {
  const live = tracker(), invalidations = [];
  let calls = 0;
  const work = createBackgroundBrowserWork({
    now: () => 100, tracker: live, capture: async s => ({frame: s.frame}),
    sam: async value => samResult(value, calls++ === 0 ? [mask(0, 0, 8, 8)] : [mask(4, 4, 12, 12)]),
    reason: async () => { throw new Error('reasoner down'); }
  });
  await assert.rejects(() => work(snapshotOf(1, 10), {invalidate: change => invalidations.push(change)}), /reasoner down/);
  await assert.rejects(() => work(snapshotOf(2, 20), {invalidate: change => invalidations.push(change)}), /reasoner down/);
  assert.deepEqual(invalidations, [{type: 'object_moved', objectId: 'trk:t0:1'}]); // delivered although reason() failed both times
  const boundsOnly = createBackgroundBrowserWork({
    now: () => 100, tracker: tracker(), capture: async s => ({frame: s.frame}),
    sam: async value => samResult(value, [{bounds: {left: 0, top: 0, right: 2, bottom: 2}}]),
    reason: async input => { assert.deepEqual(input.candidates, []); assert.equal(input.tracks.length, 0); assert.equal(input.masks.length, 1); return {frame: {frameId: input.frame.frameId, observedAt: input.frame.observedAt}, scenarios: []}; }
  });
  await boundsOnly(snapshotOf(3, 30), {});
});

test('mismatched SAM or reasoner frame is rejected before it can be returned', async () => {
  let reasonCalls = 0, ingests = 0;
  const countingTracker = {ingest: async () => { ingests++; return {tracks: [], changes: [], provenance: {}}; }};
  const badSam = createBackgroundBrowserWork({tracker: countingTracker, capture: async () => frame, sam: async () => ({frame: {frameId: 'wrong', observedAt: 10}, masks: []}), reason: async () => { reasonCalls++; return {frame: {frameId: 'frame-1', observedAt: 10}, scenarios: []}; }, now: () => 12});
  await assert.rejects(() => badSam(snapshot, {signal: new AbortController().signal}), /provider frame mismatch/);
  assert.equal(reasonCalls, 0); assert.equal(ingests, 0);
  const badReason = createBackgroundBrowserWork({tracker: tracker(), capture: async () => frame, sam: async () => samResult(frame, []), reason: async () => ({frame: {frameId: 'frame-1', observedAt: 9}, scenarios: []}), now: () => 12});
  await assert.rejects(() => badReason(snapshot, {signal: new AbortController().signal}), /provider frame mismatch/);
});

test('gaze must join to the captured frame, a tracker is required, and cancellation prevents later provider calls', async () => {
  let samCalls = 0, reasonCalls = 0;
  assert.throws(() => createBackgroundBrowserWork({capture: async () => frame, sam: async () => {}, reason: async () => {}}), /tracker required/);
  const mismatch = createBackgroundBrowserWork({tracker: tracker(), capture: async () => frame, sam: async () => { samCalls++; return samResult(frame, []); }, reason: async () => { reasonCalls++; return {frame: {frameId: 'frame-1', observedAt: 10}, scenarios: []}; }, now: () => 12});
  await assert.rejects(() => mismatch({...snapshot, gaze: {...snapshot.gaze, frameId: 'other'}}, {signal: new AbortController().signal}), /frame and gaze do not match/);
  assert.equal(samCalls, 0);
  const controller = new AbortController();
  const cancelled = createBackgroundBrowserWork({tracker: tracker(), capture: async (_s, {signal}) => { assert.equal(signal, controller.signal); controller.abort(); return frame; }, sam: async () => { samCalls++; }, reason: async () => { reasonCalls++; }, now: () => 12});
  await assert.rejects(() => cancelled(snapshot, {signal: controller.signal}), /cancelled/);
  assert.equal(samCalls, 0); assert.equal(reasonCalls, 0);
  const abortAfterSam = new AbortController();
  const stopped = createBackgroundBrowserWork({tracker: tracker(), capture: async s => ({frame: s.frame}), sam: async value => { abortAfterSam.abort(); return samResult(value, []); }, reason: async () => { reasonCalls++; }, now: () => 12});
  await assert.rejects(() => stopped(snapshot, {signal: abortAfterSam.signal}), /cancelled/);
  assert.equal(reasonCalls, 0);
});

const depthModel = {id: 'depth-anything/Depth-Anything-V2-Metric-Hypersim-Small', sha256: 'b782898d8a3e8be1f639de33837ed85e9b4b73e40f8f5e5cd99067588d722545', device: 'cuda'};
const depthOf = (frame, fill = (x, y) => (x < 8 ? 1.5 : 4)) => ({frame: {frameId: frame.frameId, observedAt: frame.observedAt}, model: depthModel, depth: {frameId: frame.frameId, observedAt: frame.observedAt, width: W, height: H, units: 'm', convention: 'axial_z', depthSource: 'monocular_estimated_depth', values: Array.from({length: W * H}, (_, i) => fill(i % W, Math.floor(i / W))), validMask: Array(W * H).fill(1)}});

test('depth from the same frame reaches reasoning as foreground statistics for linked objects only', async () => {
  const live = tracker(), inputs = [];
  let clock = 20;
  const work = createBackgroundBrowserWork({now: () => clock, tracker: live, depth: async value => { clock += 5; return depthOf(value); },
    capture: async value => ({frame: {...value.frame}}),
    sam: async value => samResult(value, [mask(0, 0, 4, 4), mask(10, 10, 14, 14)]),
    reason: async (input) => { inputs.push(input); return {frame: {frameId: input.frame.frameId, observedAt: input.frame.observedAt}, scenarios: []}; }});
  await work(snapshotOf(1, 10), {signal: new AbortController().signal});
  const second = await work(snapshotOf(2, 15), {signal: new AbortController().signal});
  const depth = inputs[1].depth;
  assert.equal(second.depth.status, 'ok');
  assert.equal(second.depth.artifactSha256, depth.artifactSha256);
  assert.deepEqual(depth.objects.map(o => o.objectId).sort(), inputs[1].candidates.map(c => c.objectId).sort());
  const near = depth.objects.find(o => o.medianDepthM === 1.5), far = depth.objects.find(o => o.medianDepthM === 4);
  assert.ok(near && far);
  assert.deepEqual(depth.relations, [{nearObjectId: near.objectId, farObjectId: far.objectId}]);
  assert.equal(depth.gazeDepthM, 1.5);
  assert.ok(depth.availableAtMs >= inputs[1].frame.observedAt);
  assert.equal(Object.hasOwn(depth, 'values'), false);
  assert.equal(inputs[0].depth.objects.length, 0);
});

test('late, failed or mismatched depth is withheld while reasoning still runs', async () => {
  const cases = [
    [async () => new Promise(() => {}), 'depth_late'],
    [async () => { throw Object.assign(new Error('x'), {code: 'DEPTH_RUNTIME_UNAVAILABLE'}); }, 'DEPTH_RUNTIME_UNAVAILABLE'],
    [async value => depthOf({...value, frameId: 'other'}), 'depth_artifact_invalid'],
  ];
  for (const [depth, reason] of cases) {
    const inputs = [];
    const work = createBackgroundBrowserWork({now: () => 12, tracker: tracker(), depth, depthWaitMs: 20,
      capture: async value => ({frame: {...value.frame}}), sam: async value => samResult(value, [mask(0, 0, 2, 2)]),
      reason: async input => { inputs.push(input); return {frame: {frameId: input.frame.frameId, observedAt: input.frame.observedAt}, scenarios: []}; }});
    const result = await work(snapshot, {signal: new AbortController().signal});
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].depth, null);
    assert.deepEqual(result.depth, {status: 'withheld', reason});
  }
});

test('linked objects are ranked by distance from the fixation and the nearest becomes the gaze target', async () => {
  const live = tracker(), seen = [];
  // gaze (.25,.75) on 16x16 = pixel (4,12): inside "near", far from "far"
  const masks = [mask(10, 0, 14, 4, {objectId: 'far'}), mask(2, 10, 6, 14, {objectId: 'near'})];
  const work = createBackgroundBrowserWork({now: () => 100, tracker: live, capture: async s => ({frame: s.frame}),
    sam: async value => samResult(value, masks.map(m => ({...m}))),
    reason: async input => { seen.push(input); return {frame: {frameId: input.frame.frameId, observedAt: input.frame.observedAt}, scenarios: [], nextGaze: input.candidates.length ? {rankedTargetIds: [input.candidates[0].objectId]} : null}; }});
  await work(snapshotOf(1, 10));
  const second = await work(snapshotOf(2, 20));
  const nearId = seen[1].tracks.find(track => track.bounds.left === 2).objectId;
  assert.equal(seen[1].candidates[0].objectId, nearId);
  assert.equal(seen[1].gazeTarget.objectId, nearId);
  assert.equal(seen[1].gazeTarget.distance, 0);
  assert.deepEqual(seen[1].gazeTarget.rankedObjectIds, [nearId]);
  assert.equal(second.gazeTarget.objectId, nearId);
});
