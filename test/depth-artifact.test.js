import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDepthArtifact, canonicalize, verifyDepthArtifact, depthForDecision, rasterizeMask } from '../src/spatial/depth-artifact.js';

const SHA = 'b782898d8a3e8be1f639de33837ed85e9b4b73e40f8f5e5cd99067588d722545';
const W = 8, H = 4;
const rect = (objectId, l, t, r, b, raster) => ({ objectId, sourceWidth: W, sourceHeight: H, width: r - l, height: b - t, bounds: { left: l, top: t, right: r, bottom: b }, raster: raster ?? new Array((r - l) * (b - t)).fill(1) });
function depthMap(fill = 10) {
  return { frameId: 'f1', observedAt: 1000, width: W, height: H, values: new Float32Array(W * H).fill(fill), validMask: new Uint8Array(W * H).fill(1), units: 'm', convention: 'axial_z', depthSource: 'monocular_estimated_depth' };
}
const base = (over = {}) => ({
  frame: { frameId: 'f1', observedAtMs: 1000 }, depth: depthMap(), model: { id: 'depth-anything/Depth-Anything-V2-Metric-Hypersim-Small', sha256: SHA },
  availableAtMs: 1450, masks: [], manifest: { minValidFraction: 0.5, manifestId: 'm1' }, ...over,
});
const at = (d, x, y) => y * W + x;

test('median and IQR use foreground raster pixels only, not the bounding box', () => {
  const depth = depthMap(10);
  // L-shaped mask in a 4x4 box; foreground depths 1,2,3,4 (column 0) and 4,4,4 (bottom row).
  [1, 2, 3, 4].forEach((v, y) => { depth.values[at(depth, 0, y)] = v; });
  [1, 2, 3].forEach(x => { depth.values[at(depth, x, 3)] = 4; });
  const mask = rect('obj-a', 0, 0, 4, 4, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]);
  const { artifact } = buildDepthArtifact(base({ depth, masks: [mask] }));
  const [o] = artifact.objects;
  assert.equal(o.foregroundPixelCount, 7);
  assert.equal(o.validFraction, 1);
  assert.equal(o.medianDepthM, 4);
  assert.equal(o.q1M, 2.5);
  assert.equal(o.q3M, 4);
  assert.equal(o.iqrM, 1.5);
  assert.deepEqual(Array.from(rasterizeMask(mask, W, H).slice(0, 8)), [1, 0, 0, 0, 0, 0, 0, 0]);
});

test('missing reasons: below minimum valid fraction and empty foreground abstain from depth', () => {
  const depth = depthMap(3);
  for (let x = 0; x < 3; x++) depth.validMask[at(depth, x, 0)] = 0; // 3 of 6 invalid
  depth.validMask[at(depth, 0, 1)] = 0; // 4 of 6 invalid
  const sparse = rect('sparse', 0, 0, 3, 2);
  const empty = rect('empty', 5, 0, 7, 2, [0, 0, 0, 0]);
  const full = rect('full', 4, 2, 8, 4);
  const { artifact } = buildDepthArtifact(base({ depth, masks: [sparse, empty, full] }));
  const by = Object.fromEntries(artifact.objects.map(o => [o.objectId, o]));
  assert.equal(by.sparse.status, 'missing');
  assert.equal(by.sparse.missingReason, 'valid_fraction_below_minimum');
  assert.equal(by.sparse.validFraction, 0.333333);
  assert.equal(by.sparse.medianDepthM, null);
  assert.equal(by.sparse.iqrM, null);
  assert.equal(by.empty.missingReason, 'empty_foreground');
  assert.equal(by.full.status, 'ok');
  assert.equal(by.full.medianDepthM, 3);
  assert.equal(artifact.relations.length, 0);
});

test('near/far relation only when IQR intervals do not overlap', () => {
  const depth = depthMap(10);
  const put = (l, vals) => vals.forEach((v, i) => { depth.values[at(depth, l + (i % 2), Math.floor(i / 2))] = v; });
  put(0, [1, 1.5, 2, 2.5]); // A: q1 1.375 q3 2.125
  put(2, [2, 2.5, 3, 3.5]); // B: q1 2.375 q3 3.125; A.q3 2.125 < B.q1 -> disjoint
  put(4, [1.5, 2, 2.5, 3]); // C overlaps A and B
  put(6, [8, 8, 8, 8]);     // D far
  const masks = ['A', 'B', 'C', 'D'].map((id, k) => rect(id, k * 2, 0, k * 2 + 2, 2));
  const { artifact } = buildDepthArtifact(base({ depth, masks }));
  const pairs = artifact.relations.map(r => `${r.nearObjectId}<${r.farObjectId}`).sort();
  assert.deepEqual(pairs, ['A<B', 'A<D', 'B<D', 'C<D']);
  assert.ok(!pairs.includes('A<C') && !pairs.includes('C<B') && !pairs.includes('B<C'));
  const none = buildDepthArtifact(base({ depth, masks, manifest: { minValidFraction: 0.5, includeRelations: false } }));
  assert.deepEqual(none.artifact.relations, []);
});

test('hash is deterministic, order independent, and changes with content or availability', () => {
  const depth = depthMap(2);
  const masks = [rect('b', 4, 0, 8, 2), rect('a', 0, 0, 4, 2)];
  const one = buildDepthArtifact(base({ depth, masks }));
  const two = buildDepthArtifact(base({ depth: depthMap(2), masks: [...masks].reverse() }));
  assert.equal(one.sha256, two.sha256);
  assert.equal(one.canonicalJson, two.canonicalJson);
  assert.match(one.sha256, /^[0-9a-f]{64}$/);
  assert.ok(verifyDepthArtifact(one.artifact, one.sha256));
  assert.notEqual(buildDepthArtifact(base({ depth, masks, availableAtMs: 1451 })).sha256, one.sha256);
  assert.notEqual(buildDepthArtifact(base({ depth: depthMap(2.5), masks })).sha256, one.sha256);
  assert.equal(canonicalize({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
  assert.throws(() => canonicalize({ a: NaN }), /non-finite/);
  assert.equal(one.artifact.units, 'm');
  assert.equal(one.artifact.convention, 'axial_z');
  assert.equal(one.artifact.depthSource, 'monocular_estimated_depth');
  assert.equal(one.artifact.observedAtMs, 1000);
  assert.equal(one.artifact.availableAtMs, 1450);
  assert.equal(one.artifact.model.sha256, SHA);
  assert.equal(one.artifact.policy.sampling, 'foreground_mask_pixels');
});

test('XYZ is withheld without both K and pose, and computed from axial z when supplied', () => {
  const depth = depthMap(4);
  const masks = [rect('o', 3, 2, 4, 3)]; // single pixel (3,2), z=4
  const none = buildDepthArtifact(base({ depth, masks, gazePixel: [3.5, 2.5] }));
  assert.equal(none.artifact.xyz.status, 'withheld');
  assert.equal(none.artifact.xyz.objects, undefined);
  const onlyK = buildDepthArtifact(base({ depth, masks, intrinsics: { fx: 2, fy: 2, cx: 2, cy: 2 } }));
  assert.equal(onlyK.artifact.xyz.status, 'withheld');

  const pose = [1, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1];
  const K = { fx: 2, fy: 2, cx: 2, cy: 2 };
  const r = buildDepthArtifact(base({ depth, masks, gazePixel: [3.5, 2.5], intrinsics: K, cameraToWorld: pose }));
  assert.equal(r.artifact.xyz.status, 'ok');
  // pixel centre (3.5,2.5): X = (3.5-2)/2*4 = 3, Y = (2.5-2)/2*4 = 1, Z = 4
  assert.deepEqual(r.artifact.xyz.objects[0].pointCameraM, [3, 1, 4]);
  assert.deepEqual(r.artifact.xyz.objects[0].pointWorldM, [4, 3, 7]);
  assert.deepEqual(r.artifact.xyz.gaze.pointCameraM, [3, 1, 4]);
  assert.deepEqual(r.artifact.xyz.transform.identity, true);
  assert.notEqual(r.sha256, none.sha256);

  // Resize: depth map is a 2x downsample of an 8x8 original; K refers to the original.
  const t = { originalWidth: 16, originalHeight: 8, cropLeft: 0, cropTop: 0, cropWidth: 16, cropHeight: 8 };
  const resized = buildDepthArtifact(base({ depth, masks, intrinsics: { fx: 4, fy: 4, cx: 8, cy: 4 }, cameraToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], imageTransform: t }));
  // original = (3.5*2, 2.5*2) = (7,5) => X=(7-8)/4*4=-1, Y=(5-4)/4*4=1
  assert.deepEqual(resized.artifact.xyz.objects[0].pointCameraM, [-1, 1, 4]);
  assert.equal(resized.artifact.xyz.transform.originalWidth, 16);
  assert.equal(resized.artifact.xyz.transform.identity, false);
});

test('XYZ rejects invalid pose or crop', () => {
  const masks = [rect('o', 3, 2, 4, 3)];
  const K = { fx: 2, fy: 2, cx: 2, cy: 2 };
  assert.throws(() => buildDepthArtifact(base({ masks, intrinsics: K, cameraToWorld: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })), /pose/);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.throws(() => buildDepthArtifact(base({ masks, intrinsics: K, cameraToWorld: identity, imageTransform: { originalWidth: 8, originalHeight: 4, cropLeft: 4, cropTop: 0, cropWidth: 8, cropHeight: 4 } })), /transform/);
});

test('gaze pixel depth is reported only when valid', () => {
  const depth = depthMap(5);
  depth.values[at(depth, 1, 1)] = 2.5;
  depth.validMask[at(depth, 6, 3)] = 0; depth.values[at(depth, 6, 3)] = 0;
  const g = pixel => buildDepthArtifact(base({ depth, gazePixel: pixel })).artifact.gaze;
  assert.equal(g([1.2, 1.9]).depthM, 2.5);
  assert.equal(g([6.5, 3.5]).depthM, null);
  assert.equal(g([6.5, 3.5]).reason, 'gaze_pixel_invalid_depth');
  assert.equal(g([-1, 0]).reason, 'gaze_outside_frame');
  assert.equal(g([8, 0]).reason, 'gaze_outside_frame');
  assert.equal(buildDepthArtifact(base({ depth })).artifact.gaze.reason, 'no_gaze');
});

test('rejects engine depth, relative units, backdated availability, and mismatched inputs', () => {
  const m = [rect('o', 0, 0, 2, 2)];
  assert.throws(() => buildDepthArtifact(base({ masks: m, depth: { ...depthMap(), depthSource: 'engine_geometry' } })), /monocular_estimated_depth/);
  assert.throws(() => buildDepthArtifact(base({ masks: m, depth: { ...depthMap(), units: 'relative' } })), /units/);
  assert.throws(() => buildDepthArtifact(base({ masks: m, availableAtMs: 999 })), /backdated/);
  assert.throws(() => buildDepthArtifact(base({ masks: m, depth: { ...depthMap(), frameId: 'other' } })), /frame ID/);
  assert.throws(() => buildDepthArtifact(base({ masks: m, manifest: {} })), /minValidFraction/);
  assert.throws(() => buildDepthArtifact(base({ masks: [{ ...rect('o', 0, 0, 2, 2), sourceWidth: 16 }] })), /source dimensions/);
  assert.throws(() => buildDepthArtifact(base({ masks: [rect('o', 0, 0, 2, 2), rect('o', 2, 0, 4, 2)] })), /duplicated/);
  const bigDepth = depthMap(); bigDepth.values[0] = 25;
  assert.throws(() => buildDepthArtifact(base({ masks: m, depth: bigDepth })), /maxDepthM/);
});

test('late depth is withheld for the decision, never backdated', () => {
  const { artifact } = buildDepthArtifact(base({ masks: [rect('o', 0, 0, 2, 2)] }));
  assert.equal(depthForDecision(artifact, 1450).status, 'ok');
  const late = depthForDecision(artifact, 1449);
  assert.equal(late.status, 'withheld');
  assert.equal(late.reason, 'depth_available_after_cutoff');
});
