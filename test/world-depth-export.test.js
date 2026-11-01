import test from 'node:test';
import assert from 'node:assert/strict';
import { pixelRay, firstSurface } from '../src/spatial/geometry.js';
import { exportEngineDepth, encodeDepthMap, decodeDepthMap } from '../src/spatial/world-depth-export.js';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const frame = { frameId: 'f1', renderTsMs: 1000, viewport: { width: 8, height: 6 }, intrinsics: { fx: 8, fy: 8, cx: 4, cy: 3 }, cameraToWorld: identity };

// World-like fake: a finite plane perpendicular to the optical axis at axial z, via the shared geometry fixture.
function fakeWorld(z, { halfWidth = 0.5, halfHeight = 10, axialZM } = {}) {
  const calls = [];
  const surfaces = [{ type: 'rectangle', center: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], halfWidth, halfHeight }];
  return {
    calls,
    raycastFrame(f, x, y) {
      calls.push([x, y]);
      if (f.frameId === 'evicted') return { status: 'unavailable', point: null, reason: 'frame_unavailable_or_evicted' };
      const ray = pixelRay([x, y], f.intrinsics, f.cameraToWorld).ray;
      const hit = firstSurface(ray, surfaces, 'fake');
      return hit.status === 'hit' ? { status: 'hit', point: hit.point, rayRangeM: hit.range, axialZM: axialZM ?? hit.point[2], depthSource: 'engine_geometry' } : { status: 'no_hit', point: null, reason: 'no_visible_surface', depthSource: 'engine_geometry' };
    },
  };
}

test('converts ray range to axial z; no-hit pixels are invalid', () => {
  const world = fakeWorld(4);
  const gt = exportEngineDepth({ world, frame });
  assert.equal(gt.width, 8); assert.equal(gt.height, 6);
  // plane half width 0.5 at z=4 => |x-4| <= 1 in pixel units at fx=8 (pixel centres x=3.5, 4.5 hit)
  let hits = 0;
  for (let j = 0; j < 6; j++) for (let i = 0; i < 8; i++) {
    const k = j * 8 + i, x = i + 0.5;
    const expectHit = Math.abs(x - 4) <= 1;
    assert.equal(gt.validMask[k], expectHit ? 1 : 0, `pixel ${i},${j}`);
    if (expectHit) { hits++; assert.ok(Math.abs(gt.values[k] - 4) < 1e-5); } else assert.equal(gt.values[k], 0);
  }
  assert.equal(gt.counts.hit, hits);
  assert.equal(gt.counts.noHit, 48 - hits);
  assert.ok(hits > 0 && hits < 48);
  assert.ok(gt.worldAxialZMaxAbsDiffM < 1e-5);
});

test('engine oracle is labelled separately and never as model output', () => {
  const gt = exportEngineDepth({ world: fakeWorld(4), frame });
  assert.equal(gt.label, 'engine_oracle');
  assert.equal(gt.oracle, true);
  assert.equal(gt.modelOutput, false);
  assert.equal(gt.depthSource, 'engine_geometry');
  assert.notEqual(gt.depthSource, 'monocular_estimated_depth');
  assert.equal(gt.convention, 'axial_z');
  assert.equal(gt.frame.frameId, 'f1');
});

test('uses axial z, not world.axialZM, and reports any disagreement', () => {
  const gt = exportEngineDepth({ world: fakeWorld(4, { axialZM: 3.5 }), frame });
  assert.ok(Math.abs(gt.values[3] - 4) < 1e-5);
  assert.ok(Math.abs(gt.worldAxialZMaxAbsDiffM - 0.5) < 1e-5);
});

test('out-of-range hits are invalid and counted separately', () => {
  const gt = exportEngineDepth({ world: fakeWorld(25, { halfWidth: 100 }), frame });
  assert.equal(gt.counts.hit, 0);
  assert.equal(gt.counts.outOfRange, 48);
  assert.ok(gt.validMask.every(v => v === 0));
});

test('downsample samples block centres and handles partial edge blocks', () => {
  const world = fakeWorld(4);
  const gt = exportEngineDepth({ world, frame, downsample: 4 });
  assert.equal(gt.width, 2); assert.equal(gt.height, 2);
  assert.deepEqual(world.calls, [[2, 2], [6, 2], [2, 5], [6, 5]]);
  assert.equal(gt.downsample, 4);
  assert.throws(() => exportEngineDepth({ world, frame, downsample: 0 }), /downsample/);
  assert.throws(() => exportEngineDepth({ world, frame, maxPixels: 10 }), /budget/);
});

test('evicted frame fails loudly instead of producing an all-invalid map', () => {
  assert.throws(() => exportEngineDepth({ world: fakeWorld(4), frame: { ...frame, frameId: 'evicted' } }), error => error.code === 'ENGINE_DEPTH_UNAVAILABLE');
  assert.throws(() => exportEngineDepth({ world: fakeWorld(4), frame: { ...frame, intrinsics: undefined } }), /intrinsics/);
});

test('JSON encoding round-trips and detects tampering', () => {
  const gt = exportEngineDepth({ world: fakeWorld(4), frame });
  const json = JSON.parse(JSON.stringify(encodeDepthMap(gt)));
  const back = decodeDepthMap(json);
  assert.deepEqual(Array.from(back.values), Array.from(gt.values));
  assert.deepEqual(Array.from(back.validMask), Array.from(gt.validMask));
  assert.equal(back.label, 'engine_oracle');
  const tampered = { ...json, validMaskU8: Buffer.alloc(48, 1).toString('base64') };
  assert.throws(() => decodeDepthMap(tampered), /hash mismatch/);
  assert.throws(() => decodeDepthMap({ ...json, mapVersion: 2 }), /unsupported/);
});
