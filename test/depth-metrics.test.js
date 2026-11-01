import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { computeDepthMetrics, fitScaleCorrection } from '../src/evaluation/depth-metrics.js';
import { encodeDepthMap } from '../src/spatial/world-depth-export.js';
import { readNpz, runEvaluation } from '../scripts/evaluate-depth.mjs';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);
const map = (values, valid) => ({ values: Float32Array.from(values), validMask: Uint8Array.from(valid ?? values.map(() => 1)) });
const rect = (W, H, objectId, l, t, r, b) => ({ objectId, mask: { sourceWidth: W, sourceHeight: H, width: r - l, height: b - t, bounds: { left: l, top: t, right: r, bottom: b }, raster: new Array((r - l) * (b - t)).fill(1) } });

// 4x2 hand-computed case. GT idx 7 is invalid; pred idx 3 is model-missing.
const gt = map([1, 2, 4, 5, 2, 2, 10, 3], [1, 1, 1, 1, 1, 1, 1, 0]);
const pred = map([1.5, 2, 3, 0, 2.5, 2, 5, 9], [1, 1, 1, 0, 1, 1, 1, 1]);

test('metric formulas match hand-computed values; model-missing pixels reduce coverage', () => {
  const m = computeDepthMetrics({ width: 4, height: 2, pred, gt });
  const a = m.regions.all_valid;
  assert.equal(m.experiment, 'raw_metric_no_fit');
  assert.equal(a.gtValidCount, 7);          // idx 7 has no valid GT and is never scored
  assert.equal(a.evaluatedCount, 6);
  assert.equal(a.missingCount, 1);
  close(a.coverage, 6 / 7);
  close(a.mae, 7 / 6);                      // (.5+0+1+.5+0+5)/6
  close(a.rmse, Math.sqrt(26.5 / 6));       // (.25+0+1+.25+0+25)/6
  close(a.absRel, 0.25);                    // (.5+0+.25+.25+0+.5)/6
  close(a.delta125, 2 / 6);                 // only idx 1 and 5; 2.5/2 = 1.25 is not < 1.25
  close(a.delta125OverGtValid, 2 / 7);
});

test('foreground masks are scored separately, per object and as a union', () => {
  const m = computeDepthMetrics({ width: 4, height: 2, pred, gt, foregroundMasks: [rect(4, 2, 'a', 2, 0, 4, 1), rect(4, 2, 'b', 2, 1, 4, 2)] });
  const [a, b] = m.foregroundObjects;
  assert.equal(a.gtValidCount, 2); close(a.coverage, 0.5); close(a.mae, 1); close(a.rmse, 1); close(a.absRel, 0.25); close(a.delta125, 0); close(a.delta125OverGtValid, 0);
  assert.equal(b.gtValidCount, 1); close(b.mae, 5); close(b.absRel, 0.5);
  const f = m.regions.foreground;
  assert.equal(f.gtValidCount, 3); assert.equal(f.evaluatedCount, 2); close(f.mae, 3);
});

test('model that abstains has low coverage and cannot inflate delta over GT-valid pixels', () => {
  const sparse = map([2, 0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 0, 0]);
  const m = computeDepthMetrics({ width: 4, height: 2, pred: sparse, gt: map([2, 2, 2, 2, 2, 2, 2, 2]) }).regions.all_valid;
  close(m.coverage, 1 / 8); close(m.delta125, 1); close(m.delta125OverGtValid, 1 / 8); close(m.mae, 0);
  const none = computeDepthMetrics({ width: 4, height: 2, pred: map(new Array(8).fill(0), new Array(8).fill(0)), gt }).regions.all_valid;
  assert.equal(none.coverage, 0); assert.equal(none.mae, null); assert.equal(none.delta125OverGtValid, 0);
});

test('GT must be valid, positive and in range; out-of-range GT is not scored', () => {
  const g = map([1, 0, 21, 20, -1, 2, 2, 2], [1, 1, 1, 1, 1, 1, 1, 0]);
  const p = map(new Array(8).fill(1));
  assert.equal(computeDepthMetrics({ width: 4, height: 2, pred: p, gt: g }).regions.all_valid.gtValidCount, 4); // 1, 20, 2, 2 (idx 7 masked out)
});

test('boundary band covers both sides of mask contours within the configured width', () => {
  // 10x1: mask x=3..5 -> contour pixels 3 and 5. GT 1 everywhere; model: missing at x=0 and 9, error 3 at x=7.
  const g = map(new Array(10).fill(1));
  const pv = new Array(10).fill(1); pv[7] = 4; pv[0] = 0; pv[9] = 0;
  const valid = new Array(10).fill(1); valid[0] = 0; valid[9] = 0;
  const p = map(pv, valid), masks = [rect(10, 1, 'm', 3, 0, 6, 1)];
  const b1 = computeDepthMetrics({ width: 10, height: 1, pred: p, gt: g, foregroundMasks: masks, boundaryBandPx: 1 });
  assert.equal(b1.regions.boundary_band.gtValidCount, 5); // x=2..6
  assert.equal(b1.regions.boundary_band.coverage, 1);
  close(b1.regions.boundary_band.mae, 0);
  const b2 = computeDepthMetrics({ width: 10, height: 1, pred: p, gt: g, foregroundMasks: masks, boundaryBandPx: 2 });
  assert.equal(b2.regions.boundary_band.gtValidCount, 7); // x=1..7 now includes the error at x=7
  close(b2.regions.boundary_band.mae, 3 / 7);
  close(b2.regions.all_valid.coverage, 0.8);
  assert.equal(b2.regions.foreground.gtValidCount, 3);
  assert.equal(b2.boundaryBandPx, 2);
});

test('gaze ROI uses pixel centres within the radius', () => {
  const g = map(new Array(10).fill(2));
  const pv = new Array(10).fill(2); pv[6] = 4; pv[8] = 4;
  const m = computeDepthMetrics({ width: 10, height: 1, pred: map(pv), gt: g, gaze: { pixel: [5.5, 0.5], radiusPx: 1 } });
  assert.equal(m.regions.gaze_roi.gtValidCount, 3); // x=4,5,6
  close(m.regions.gaze_roi.mae, 2 / 3);
  assert.equal(computeDepthMetrics({ width: 10, height: 1, pred: map(pv), gt: g }).regions.gaze_roi.status, 'not_configured');
});

test('no fitting on test GT; scale correction only from a calibration split, as a separate experiment', () => {
  const g = map([1, 2, 3, 4]);
  const doubled = map([2, 4, 6, 8]);
  const raw = computeDepthMetrics({ width: 4, height: 1, pred: doubled, gt: g });
  close(raw.regions.all_valid.absRel, 1);
  assert.equal(raw.regions.all_valid.delta125, 0);
  assert.equal(raw.scaleCorrection, null);

  const fit = fitScaleCorrection([{ sampleId: 'cal-1', pred: doubled, gt: g }]);
  close(fit.scale, 0.5);
  assert.equal(fit.fitSplit, 'calibration');
  const corrected = computeDepthMetrics({ width: 4, height: 1, pred: doubled, gt: g, scaleCorrection: fit, evaluationSampleId: 'test-1' });
  assert.equal(corrected.experiment, 'scale_corrected_calibration_split');
  close(corrected.regions.all_valid.mae, 0);
  assert.throws(() => computeDepthMetrics({ width: 4, height: 1, pred: doubled, gt: g, scaleCorrection: fit, evaluationSampleId: 'cal-1' }), /fitted on the evaluated sample/);
  assert.throws(() => computeDepthMetrics({ width: 4, height: 1, pred: doubled, gt: g, scaleCorrection: { ...fit, fitSplit: 'test' } }), /calibration split/);
  assert.throws(() => fitScaleCorrection([{ sampleId: 'x', pred: doubled, gt: g }], { split: 'test' }), /calibration/);
});

test('input validation', () => {
  assert.throws(() => computeDepthMetrics({ width: 4, height: 2, pred: map([1]), gt }), /entries/);
  assert.throws(() => computeDepthMetrics({ width: 4, height: 2, pred, gt, boundaryBandPx: 0 }), /boundaryBandPx/);
  assert.throws(() => computeDepthMetrics({ width: 4, height: 2, pred, gt, gaze: { pixel: [1, 1] } }), /radiusPx/);
  assert.throws(() => computeDepthMetrics({ width: 4, height: 2, pred: { ...pred, validMask: [2, 1, 1, 1, 1, 1, 1, 1] }, gt }), /0\/1/);
});

// ---- .npz reader and CLI ----
function npy(descr, shape, bytes) {
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}), }`;
  while ((10 + header.length + 1) % 64) header += ' ';
  header += '\n';
  const h = Buffer.alloc(10); h.write('\x93NUMPY', 0, 'latin1'); h[6] = 1; h[7] = 0; h.writeUInt16LE(header.length, 8);
  return Buffer.concat([h, Buffer.from(header, 'latin1'), bytes]);
}
function zip(entries, { deflate = false } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const payload = deflate ? deflateRawSync(data) : data, nameBuf = Buffer.from(`${name}.npy`);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(payload.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(payload.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, payload); centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + payload.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const f32 = arr => Buffer.from(Float32Array.from(arr).buffer);
const npz = (depth, valid, w, h, opts) => zip([['depth_m', npy('<f4', [h, w], f32(depth))], ['valid_mask', npy('|u1', [h, w], Buffer.from(valid))]], opts);

test('reads worker-style npz (stored and deflate)', () => {
  for (const deflate of [false, true]) {
    const a = readNpz(npz([1, 2, 3, 4, 5, 6], [1, 1, 0, 1, 1, 1], 3, 2, { deflate }));
    assert.deepEqual(a.depth_m.shape, [2, 3]);
    assert.deepEqual(Array.from(a.depth_m.data), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(Array.from(a.valid_mask.data), [1, 1, 0, 1, 1, 1]);
  }
  assert.throws(() => readNpz(Buffer.from('not a zip file at all, too short?!!')), /npz/);
});

test('CLI writes a hashed, exclusive-create synthetic report and rejects mismatches', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'depth-eval-'));
  try {
    const gtMap = encodeDepthMap({ schema: 'prometheus_engine_depth_gt', label: 'engine_oracle', oracle: true, synthetic: true, modelOutput: false, depthSource: 'engine_geometry', units: 'm', convention: 'axial_z', frame: { frameId: 'f1', renderTsMs: 1000 }, downsample: 1, width: 4, height: 2, counts: { hit: 7, noHit: 1, outOfRange: 0 }, ...gt });
    const gtPath = path.join(dir, 'gt.json'), npzPath = path.join(dir, 'pred.npz'), out = path.join(dir, 'report.json');
    await writeFile(gtPath, JSON.stringify(gtMap));
    await writeFile(npzPath, npz(Array.from(pred.values), Array.from(pred.validMask), 4, 2));
    const argv = ['--pred', npzPath, '--gt', gtPath, '--output', out, '--pred-frame-id', 'f1'];
    const { report } = await runEvaluation(argv, { now: () => new Date('2026-11-01T00:00:00Z') });
    assert.equal(report.synthetic, true);
    assert.equal(report.gateStatus, 'not_asserted');
    assert.equal(report.groundTruth.label, 'engine_oracle');
    assert.match(report.inputs.pred.sha256, /^[0-9a-f]{64}$/);
    assert.match(report.inputs.gt.sha256, /^[0-9a-f]{64}$/);
    close(report.metrics.regions.all_valid.mae, 7 / 6);
    assert.equal(JSON.parse(await readFile(out, 'utf8')).schema, 'prometheus_depth_evaluation_report');
    await assert.rejects(runEvaluation(argv), /EEXIST/);
    await assert.rejects(runEvaluation(['--pred', npzPath, '--gt', gtPath, '--output', path.join(dir, 'r2.json')]), /--pred-frame-id/);
    await assert.rejects(runEvaluation(['--pred', npzPath, '--gt', gtPath, '--output', path.join(dir, 'r3.json'), '--pred-frame-id', 'other']), /frame mismatch/);
    const wrongSize = path.join(dir, 'wrong.npz');
    await writeFile(wrongSize, npz([1, 2], [1, 1], 2, 1));
    await assert.rejects(runEvaluation(['--pred', wrongSize, '--gt', gtPath, '--output', path.join(dir, 'r4.json'), '--pred-frame-id', 'f1']), /dimension mismatch/);
    const notOracle = path.join(dir, 'notgt.json');
    await writeFile(notOracle, JSON.stringify({ ...gtMap, label: 'model' }));
    await assert.rejects(runEvaluation(['--pred', npzPath, '--gt', notOracle, '--output', path.join(dir, 'r5.json'), '--pred-frame-id', 'f1']), /engine_oracle/);
    const engineAsPred = path.join(dir, 'engine-pred.json');
    await writeFile(engineAsPred, JSON.stringify(gtMap));
    await assert.rejects(runEvaluation(['--pred', engineAsPred, '--gt', gtPath, '--output', path.join(dir, 'r6.json')]), /engine geometry/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
