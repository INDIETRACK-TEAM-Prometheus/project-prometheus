import test from 'node:test';
import assert from 'node:assert/strict';
import {fitSphere, eyeSphereFromFit, estimateKappa, applyKappa, gazeFrame, rotationBetween, rotationMatrixFromAxisAngle, rotateVector, angleBetweenRad} from '../src/gaze/eye-fit.js';
import {validateEyeSphere, eyeSphereMotion} from '../src/gaze/eye-sphere.js';
import {createSeededRandom} from '../src/gaze/accuracy-protocol.js';

const deg = Math.PI / 180, C = [0.03, -0.01, 0.6], R = 0.012, prior = {radiusM:0.0125, radiusSigmaM:0.001};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
function makeRandom(seed) { const random = createSeededRandom(seed); return {random, gauss:() => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random())}; }
// Points on the camera-facing cap with cos(polar) in [capCos,1], optional noise (m).
function cap(n, capCos, noise, seed) {
  const {random, gauss} = makeRandom(seed);
  return Array.from({length:n}, () => { const z = capCos + (1 - capCos) * random(), a = 2 * Math.PI * random(), r = Math.sqrt(1 - z * z); return [r * Math.cos(a), r * Math.sin(a), -z].map((v, i) => C[i] + R * v + noise * gauss()); });
}

test('sphere fit recovers an exact sphere with zero residuals', () => {
  const pts = cap(40, -0.9, 0, 1), fit = fitSphere(pts);
  assert.equal(fit.status, 'ok'); assert.equal(fit.measured, true); assert.equal(fit.reason, null);
  assert.ok(fit.centerM.every((v, i) => Math.abs(v - C[i]) < 1e-9)); assert.ok(Math.abs(fit.radiusM - R) < 1e-9);
  assert.equal(fit.residualsM.length, 40); assert.ok(fit.residualsM.every(d => Math.abs(d) < 1e-9)); assert.ok(fit.rmsM < 1e-9);
  assert.equal(fit.pointCount, 40); assert.equal(fit.inlierCount, 40); assert.equal(fit.units, 'm');
  assert.ok(fitSphere(pts, {prior}).centerM.every((v, i) => Math.abs(v - C[i]) < 1e-8));
  assert.ok(fitSphere(pts.map(p => ({positionM:p}))).radiusM > 0);
});

test('sphere fit with noise stays near truth and reports residual scale and data-only std', () => {
  const pts = cap(80, -0.6, 2e-4, 2), fit = fitSphere(pts, {prior});
  assert.equal(fit.status, 'ok');
  assert.ok(Math.hypot(...fit.centerM.map((v, i) => v - C[i])) < 5e-4); assert.ok(Math.abs(fit.radiusM - R) < 5e-4);
  assert.ok(fit.rmsM > 1e-4 && fit.rmsM < 4e-4);
  assert.ok(fit.dataStd.radiusM > 0 && fit.dataStd.radiusM < 3e-4);
  assert.ok(fit.posteriorStd.radiusM <= fit.dataStd.radiusM + 1e-12);
});

test('Huber loss resists gross outliers that an unweighted fit would follow', () => {
  const pts = cap(60, -0.8, 1e-4, 3); pts[0] = [C[0] + 0.02, C[1], C[2] + 0.02]; pts[1] = [C[0], C[1] - 0.03, C[2]]; pts[2] = [C[0] - 0.015, C[1] + 0.02, C[2] - 0.01];
  const fit = fitSphere(pts, {prior});
  assert.equal(fit.status, 'ok');
  assert.ok(Math.hypot(...fit.centerM.map((v, i) => v - C[i])) < 6e-4); assert.ok(Math.abs(fit.radiusM - R) < 6e-4);
  assert.ok(fit.inlierCount >= 55 && fit.inlierCount <= 58);
  assert.ok(Math.abs(fit.residualsM[1]) > 0.01 && Math.abs(fit.residualsM[0]) > 0.005); // outliers keep large reported residuals
  assert.ok(fit.weights[1] < 0.2 && fit.weights[10] > 0.5);
});

test('a tight cap leaves radius/centre to the prior and is flagged ambiguous, never measured', () => {
  const pts = cap(40, 0.995, 2e-4, 4), fit = fitSphere(pts, {prior});
  assert.equal(fit.status, 'ambiguous'); assert.equal(fit.measured, false); assert.match(fit.reason, /not_constrained_by_data/);
  assert.ok(fit.dataStd.radiusM > 0.25 * prior.radiusM || Math.max(...fit.dataStd.centerM) > 0.5 * prior.radiusM);
  assert.ok(Math.abs(fit.radiusM - prior.radiusM) < 4 * prior.radiusSigmaM); // regularised, bounded
  const strongPrior = fitSphere(pts, {prior:{radiusM:R, radiusSigmaM:1e-5}});
  assert.ok(Math.abs(strongPrior.radiusM - R) < 2e-5);
  const without = fitSphere(pts);
  assert.equal(without.status, 'unavailable'); assert.equal(without.centerM, null);
  assert.equal(fitSphere(pts, {ambiguityRadiusStdM:1, ambiguityCenterStdM:1}).status, 'ok'); // caller-chosen bounds are honoured
});

test('degenerate and malformed input: too few, collinear, coplanar, non-finite, bad prior', () => {
  assert.equal(fitSphere(cap(3, -0.9, 0, 5)).reason, 'too_few_points');
  assert.equal(fitSphere([]).status, 'unavailable');
  assert.equal(fitSphere([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0]]).reason, 'degenerate_point_geometry');
  assert.equal(fitSphere([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0.5, 0.5, 0]]).reason, 'degenerate_point_geometry');
  const planar = fitSphere([[0, 0, 0], [1e-3, 0, 0], [0, 1e-3, 0], [1e-3, 1e-3, 0], [0.5e-3, 0.5e-3, 0]], {prior});
  assert.equal(planar.status, 'ambiguous'); assert.equal(planar.measured, false); assert.ok(planar.dataStd.radiusM === Infinity);
  assert.throws(() => fitSphere('x'), TypeError);
  assert.throws(() => fitSphere([[0, 0, NaN], [1, 0, 0], [0, 1, 0], [0, 0, 1]]), TypeError);
  assert.throws(() => fitSphere([[0, 0], [1, 0], [0, 1], [0, 0]]), TypeError);
  assert.throws(() => fitSphere(cap(10, -0.9, 0, 6), {prior:{radiusM:-1, radiusSigmaM:1}}), TypeError);
  assert.throws(() => fitSphere(cap(10, -0.9, 0, 6), {maxIterations:0}), TypeError);
});

test('per-eye model from a fit: >=30 unique modeled nodes, unit outward normals, observed/model provenance on every node', () => {
  const pts = cap(50, -0.8, 1e-4, 7), fit = fitSphere(pts, {prior});
  for (const eye of ['left', 'right']) {
    const model = eyeSphereFromFit({fit, eye, coordinateFrameId:'camera', observedAt:0, count:40, points:pts});
    assert.equal(model.status, 'ok'); assert.equal(model.measured, true);
    const v = validateEyeSphere(model.sphere);
    assert.deepEqual(v.errors, []); assert.equal(v.modelNodeCount, 40); assert.equal(v.observedNodeCount, 50); assert.equal(v.provenanceCoverage, 1);
    assert.ok(v.maxNormError <= 1e-6); assert.equal(v.outwardViolations, 0);
    assert.ok(model.sphere.nodes.filter(n => n.observed).every(n => n.source === 'observed_point' && Number.isFinite(n.residualM)));
    assert.ok(model.sphere.nodes.filter(n => !n.observed).every(n => n.source === 'modeled_sphere'));
    assert.equal(model.sphere.fit.measured, true);
  }
  const bare = eyeSphereFromFit({fit, eye:'left', coordinateFrameId:'camera', observedAt:0});
  assert.equal(bare.sphere.nodes.length, 32); assert.equal(validateEyeSphere(bare.sphere).observedNodeCount, 0);
  const next = eyeSphereFromFit({fit, eye:'left', coordinateFrameId:'camera', observedAt:100, points:pts});
  assert.equal(eyeSphereMotion(eyeSphereFromFit({fit, eye:'left', coordinateFrameId:'camera', observedAt:0, points:pts}).sphere, next.sphere).status, 'ok');
});

test('an ambiguous fit yields a prior-based sphere flagged unmeasured; an unavailable fit yields no sphere', () => {
  const ambiguous = fitSphere(cap(40, 0.995, 2e-4, 4), {prior}), model = eyeSphereFromFit({fit:ambiguous, eye:'right', coordinateFrameId:'camera', observedAt:0});
  assert.equal(model.status, 'ambiguous'); assert.equal(model.measured, false); assert.equal(model.sphere.fit.measured, false); assert.equal(validateEyeSphere(model.sphere).ok, true);
  const none = eyeSphereFromFit({fit:fitSphere([[0, 0, 0]]), eye:'left', coordinateFrameId:'camera', observedAt:0});
  assert.deepEqual([none.status, none.reason, none.sphere, none.measured], ['unavailable', 'too_few_points', null, false]);
  assert.equal(eyeSphereFromFit({}).status, 'unavailable');
  assert.throws(() => eyeSphereFromFit({fit:fitSphere(cap(20, -0.9, 0, 1)), eye:'left', coordinateFrameId:'c', observedAt:0, points:[[0, 0, 0]]}), TypeError);
});

test('rotation helpers: axis-angle, between-vectors and angle', () => {
  const z90 = rotationMatrixFromAxisAngle([0, 0, 1], Math.PI / 2), r = rotateVector(z90, [1, 0, 0]);
  assert.ok(Math.abs(r[0]) < 1e-12 && Math.abs(r[1] - 1) < 1e-12);
  const {random} = makeRandom(8);
  for (let i = 0; i < 50; i++) {
    const a = unit([random() - .5, random() - .5, random() - .5]), b = unit([random() - .5, random() - .5, random() - .5]), m = rotationBetween(a, b);
    assert.ok(rotateVector(m, a).every((v, k) => Math.abs(v - b[k]) < 1e-12));
    const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    assert.ok(Math.abs(det - 1) < 1e-12);
  }
  assert.ok(rotateVector(rotationBetween([0, 0, 1], [0, 0, -1]), [0, 0, 1]).every((v, k) => Math.abs(v - [0, 0, -1][k]) < 1e-12));
  assert.deepEqual(rotationBetween([0, 1, 0], [0, 2, 0]), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.ok(Math.abs(angleBetweenRad([1, 0, 0], [0, 1, 0]) - Math.PI / 2) < 1e-15);
  assert.throws(() => rotationBetween([0, 0, 0], [1, 0, 0]), TypeError);
  assert.throws(() => rotationMatrixFromAxisAngle([0, 0, 0], 1), TypeError);
});

// Optical axes spread over +-15 degrees; visual axis produced from a known kappa by an independent construction.
function kappaObservations(n, alpha, beta, {noiseRad = 0, seed = 9, spreadDeg = 15} = {}) {
  const {random, gauss} = makeRandom(seed), kappa = {alphaRad:alpha, betaRad:beta};
  return Array.from({length:n}, () => {
    const az = (random() * 2 - 1) * spreadDeg * deg, el = (random() * 2 - 1) * spreadDeg * deg * 0.7;
    const opticalAxis = unit([Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)]);
    const visual = applyKappa(opticalAxis, kappa);
    const jitter = noiseRad ? unit([visual[0] + gauss() * noiseRad, visual[1] + gauss() * noiseRad, visual[2] + gauss() * noiseRad]) : visual;
    return {opticalAxis, targetDirection:jitter};
  });
}

test('applyKappa offsets the optical axis by exactly the kappa magnitude, horizontally and vertically in the gaze frame', () => {
  const alpha = 5 * deg, beta = -1.5 * deg, o = unit([0.1, 0.05, 1]), v = applyKappa(o, {alphaRad:alpha, betaRad:beta});
  assert.ok(Math.abs(angleBetweenRad(o, v) - Math.acos(Math.cos(alpha) * Math.cos(beta))) < 1e-12);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-12);
  const f = gazeFrame(o); assert.ok(Math.abs(Math.atan2(dot(v, f.x), dot(v, f.z)) - alpha) < 1e-12); assert.ok(Math.abs(Math.asin(dot(v, f.y)) - beta) < 1e-12);
  assert.ok(applyKappa(o, {alphaRad:0, betaRad:0}).every((x, i) => Math.abs(x - o[i]) < 1e-15));
  assert.equal(applyKappa([0, 1, 0], {alphaRad:alpha, betaRad:beta}), null); // optical axis parallel to the up hint
  assert.equal(applyKappa(o, {alphaRad:NaN, betaRad:0}), null);
});

test('kappa is recovered exactly from noise-free calibration targets and its rotation maps optical to visual', () => {
  const k = estimateKappa(kappaObservations(25, 5 * deg, -1.5 * deg));
  assert.equal(k.status, 'ok'); assert.ok(Math.abs(k.alphaRad - 5 * deg) < 1e-12); assert.ok(Math.abs(k.betaRad + 1.5 * deg) < 1e-12);
  assert.ok(k.residualRad.rms < 1e-12); assert.deepEqual(k.outlierIndices, []); assert.equal(k.usedObservations, 25);
  assert.ok(Math.abs(k.magnitudeRad - Math.acos(Math.cos(5 * deg) * Math.cos(1.5 * deg))) < 1e-12);
  const expectedLocal = [Math.cos(-1.5 * deg) * Math.sin(5 * deg), Math.sin(-1.5 * deg), Math.cos(-1.5 * deg) * Math.cos(5 * deg)];
  assert.ok(rotateVector(k.rotationMatrix, [0, 0, 1]).every((v, i) => Math.abs(v - expectedLocal[i]) < 1e-12));
  // The estimate predicts held-out targets.
  for (const o of kappaObservations(10, 5 * deg, -1.5 * deg, {seed:77})) assert.ok(angleBetweenRad(applyKappa(o.opticalAxis, {alphaRad:k.alphaRad, betaRad:k.betaRad}), o.targetDirection) < 1e-12);
});

test('kappa under noise and outliers: estimate stays within noise, outliers are trimmed and reported', () => {
  const noisy = kappaObservations(60, -4 * deg, 1 * deg, {noiseRad:0.5 * deg, seed:10}), k = estimateKappa(noisy);
  assert.equal(k.status, 'ok'); assert.ok(Math.abs(k.alphaRad + 4 * deg) < 0.3 * deg); assert.ok(Math.abs(k.betaRad - 1 * deg) < 0.3 * deg);
  assert.ok(k.residualRad.rms > 0.2 * deg && k.stdRad.alpha < k.residualRad.rms);
  const bad = kappaObservations(30, 5 * deg, -1.5 * deg, {seed:11}); bad[3].targetDirection = unit([0.3, -0.2, 1]); bad[17].targetDirection = unit([-0.4, 0.3, 1]);
  const trimmed = estimateKappa(bad);
  assert.equal(trimmed.status, 'ok'); assert.deepEqual(trimmed.outlierIndices, [3, 17]); assert.ok(Math.abs(trimmed.alphaRad - 5 * deg) < 1e-9);
  assert.ok(Math.abs(trimmed.betaRad + 1.5 * deg) < 1e-9);
});

test('kappa degenerate cases: too few, no gaze diversity, implausible magnitude, unusable frames, malformed input', () => {
  assert.equal(estimateKappa(kappaObservations(3, 5 * deg, 0)).reason, 'too_few_usable_observations');
  const same = Array.from({length:12}, () => ({opticalAxis:[0, 0, 1], targetDirection:applyKappa([0, 0, 1], {alphaRad:5 * deg, betaRad:0})}));
  const flat = estimateKappa(same); assert.equal(flat.status, 'unavailable'); assert.equal(flat.reason, 'insufficient_optical_axis_spread'); assert.equal(flat.opticalSpreadRad, 0);
  const narrow = estimateKappa(kappaObservations(20, 5 * deg, 0, {spreadDeg:1}));
  assert.equal(narrow.reason, 'insufficient_optical_axis_spread');
  const big = estimateKappa(kappaObservations(20, 40 * deg, 0));
  assert.equal(big.status, 'unavailable'); assert.equal(big.reason, 'kappa_outside_plausible_range'); assert.ok(Math.abs(big.diagnostic.alphaRad - 40 * deg) < 1e-9);
  const poles = Array.from({length:10}, () => ({opticalAxis:[0, 1, 0], targetDirection:[0, 1, 0.1]}));
  assert.equal(estimateKappa(poles).reason, 'too_few_usable_observations');
  assert.equal(estimateKappa(kappaObservations(20, 5 * deg, 0), {minObservations:30}).reason, 'too_few_usable_observations');
  assert.throws(() => estimateKappa('x'), TypeError);
  assert.throws(() => estimateKappa([{opticalAxis:[0, 0, 0], targetDirection:[0, 0, 1]}]), TypeError);
  assert.throws(() => estimateKappa([{opticalAxis:[0, 0, 1]}]), TypeError);
});

test('kappa works with a different up hint and does not depend on a hidden global frame', () => {
  const obs = kappaObservations(20, 5 * deg, -1.5 * deg).map(({opticalAxis}) => opticalAxis);
  const upHint = unit([0.1, 1, 0.05]), withHint = obs.map(o => ({opticalAxis:o, targetDirection:applyKappa(o, {alphaRad:3 * deg, betaRad:2 * deg}, {upHint})}));
  const k = estimateKappa(withHint, {upHint});
  assert.ok(Math.abs(k.alphaRad - 3 * deg) < 1e-12 && Math.abs(k.betaRad - 2 * deg) < 1e-12);
  const wrong = estimateKappa(withHint);
  assert.ok(wrong.status === 'unavailable' || Math.abs(wrong.alphaRad - 3 * deg) > 1e-6 || Math.abs(wrong.betaRad - 2 * deg) > 1e-6);
});
