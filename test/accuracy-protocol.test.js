import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAccuracyPlan, verifyAccuracyPlan, createCalibrationSchedule, sha256Hex, canonicalJson, createSeededRandom, classifyTargetBand, APP_CALIBRATION_GRIDS_NORM, EDGE_BANDS, trialWindow} from '../src/gaze/accuracy-protocol.js';

const screen = {width:1920, height:1080};
const inBand = (v, [lo, hi]) => v >= lo && v <= hi;

test('pure-JS sha256 matches node:crypto, including multi-block and non-ASCII input', () => {
  for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(1000), '시선 정확도']) assert.equal(sha256Hex(text), createHash('sha256').update(text).digest('hex'));
  assert.equal(canonicalJson({b:1, a:[2, {d:null, c:'x'}]}), '{"a":[2,{"c":"x","d":null}],"b":1}');
  assert.throws(() => canonicalJson({a:NaN}), TypeError);
});

test('plan has >=9 targets x 3 repeats in randomised order and verifies', () => {
  const plan = createAccuracyPlan({seed:20261104, screen});
  assert.equal(plan.targets.length, 9);
  assert.equal(plan.trials.length, 27);
  for (const t of plan.targets) assert.equal(plan.trials.filter(x => x.targetId === t.id).length, 3);
  assert.deepEqual(verifyAccuracyPlan(plan), {ok:true, errors:[]});
  for (let i = 1; i < plan.trials.length; i++) assert.notEqual(plan.trials[i].targetId, plan.trials[i - 1].targetId);
  assert.ok(plan.trials.every((t, i) => t.order === i && t.plannedOnsetMs === i * (700 + 1200 + 300)));
  const blocks = [0, 1, 2].map(r => plan.trials.filter(t => t.repeat === r).map(t => t.targetId).join());
  assert.ok(new Set(blocks).size > 1);
});

test('same seed gives the identical plan and hash; different seed or screen changes the hash', () => {
  const a = createAccuracyPlan({seed:7, screen}), b = createAccuracyPlan({seed:7, screen}), c = createAccuracyPlan({seed:8, screen}), d = createAccuracyPlan({seed:7, screen:{width:1366, height:768}});
  assert.deepEqual(a, b);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(a.hash, c.hash);
  assert.notEqual(a.hash, d.hash);
  assert.equal(createAccuracyPlan({seed:'string-seed', screen}).hash, createAccuracyPlan({seed:'string-seed', screen}).hash);
});

test('tampering with a frozen plan is detected by hash, and expectedHash pins it', () => {
  const plan = createAccuracyPlan({seed:3, screen});
  const moved = structuredClone(plan); moved.trials[4].x += 1;
  assert.ok(verifyAccuracyPlan(moved).errors.includes('hash_mismatch'));
  const reordered = structuredClone(plan); [reordered.trials[0], reordered.trials[1]] = [reordered.trials[1], reordered.trials[0]];
  assert.equal(verifyAccuracyPlan(reordered).ok, false);
  assert.ok(verifyAccuracyPlan(plan, {expectedHash:'0'.repeat(64)}).errors.includes('frozen_hash_mismatch'));
  assert.equal(verifyAccuracyPlan(plan, {expectedHash:plan.hash}).ok, true);
  assert.equal(verifyAccuracyPlan({}).ok, false);
});

test('targets are disjoint from calibration grids and cover centre plus 5-10% / 90-95% edge bands', () => {
  for (let seed = 0; seed < 60; seed++) for (const size of [{width:1920, height:1080}, {width:1366, height:768}, {width:800, height:600}]) {
    const plan = createAccuracyPlan({seed, screen:size}), diag = Math.hypot(size.width, size.height);
    assert.equal(verifyAccuracyPlan(plan).ok, true);
    for (const t of plan.targets) for (const c of APP_CALIBRATION_GRIDS_NORM) assert.ok(Math.hypot((t.xNorm - c.x) * size.width, (t.yNorm - c.y) * size.height) / diag >= plan.minSeparationFraction - 1e-9);
    assert.ok(plan.targets.some(t => t.band === 'center'));
    for (const band of [EDGE_BANDS.low, EDGE_BANDS.high]) { assert.ok(plan.targets.some(t => inBand(t.xNorm, band))); assert.ok(plan.targets.some(t => inBand(t.yNorm, band))); }
    for (const t of plan.targets) { assert.ok(Math.abs(t.x - t.xNorm * size.width) < 0.01); assert.equal(t.band, classifyTargetBand({x:t.xNorm, y:t.yNorm})); }
  }
});

test('custom calibration targets are excluded and an unplaceable layout fails loudly', () => {
  const calibration = [{x:0.5, y:0.5}, {x:0.3, y:0.3}, {x:0.9, y:0.5}];
  const plan = createAccuracyPlan({seed:1, screen, calibrationTargets:calibration, minSeparationFraction:0.05});
  for (const t of plan.targets) for (const c of calibration) assert.ok(Math.hypot((t.xNorm - c.x) * screen.width, (t.yNorm - c.y) * screen.height) / Math.hypot(screen.width, screen.height) >= 0.05 - 1e-9);
  const dense = []; for (let x = 0; x <= 1; x += 0.02) for (let y = 0; y <= 1; y += 0.02) dense.push({x, y});
  assert.throws(() => createAccuracyPlan({seed:1, screen, calibrationTargets:dense, minSeparationFraction:0.05}), /disjoint/);
});

test('extra interior targets, rules, and input validation', () => {
  const plan = createAccuracyPlan({seed:5, screen, targetCount:12, repeats:4, fixation:{dwellMs:1500, minValidSamples:12}});
  assert.equal(plan.targets.length, 12); assert.equal(plan.trials.length, 48); assert.equal(plan.rules.dwellMs, 1500);
  assert.deepEqual(trialWindow(plan.rules, 1000), {settleEndMs:1700, endMs:3200});
  assert.throws(() => createAccuracyPlan({seed:1, screen, targetCount:8}), TypeError);
  assert.throws(() => createAccuracyPlan({seed:1, screen, repeats:2}), TypeError);
  assert.throws(() => createAccuracyPlan({seed:-1, screen}), TypeError);
  assert.throws(() => createAccuracyPlan({seed:1, screen:{width:10, height:10}}), TypeError);
  assert.throws(() => createAccuracyPlan({seed:1, screen, fixation:{settleMs:10}}), TypeError);
  assert.throws(() => createAccuracyPlan({seed:1, screen, fixation:{bogus:1}}), TypeError);
  assert.ok(createSeededRandom(1)() !== createSeededRandom(2)());
});

test('calibration schedule is deterministic, covers positions evenly, and lasts 30-60 s', () => {
  const s = createCalibrationSchedule({seed:11, screen});
  assert.ok(s.totalMs >= 30000 && s.totalMs <= 60000);
  assert.equal(s.targets.length, 27);
  assert.equal(s.totalMs, s.targets.at(-1).endMs - 300);
  for (let i = 1; i < s.targets.length; i++) { assert.equal(s.targets[i].shownAtMs, s.targets[i - 1].endMs); assert.notEqual(s.targets[i].positionIndex, s.targets[i - 1].positionIndex); }
  for (let p = 0; p < 9; p++) assert.equal(s.targets.filter(t => t.positionIndex === p).length, 3);
  assert.deepEqual(createCalibrationSchedule({seed:11, screen}), s);
  assert.notEqual(createCalibrationSchedule({seed:12, screen}).hash, s.hash);
  assert.equal(s.targets[0].windowStartMs - s.targets[0].shownAtMs, 500);
  assert.throws(() => createCalibrationSchedule({seed:1, screen, repeats:1}), RangeError);
  assert.throws(() => createCalibrationSchedule({seed:1, screen, repeats:6}), RangeError);
  assert.throws(() => createCalibrationSchedule({seed:1, screen, positionsNorm:[{x:.5, y:.5}]}), TypeError);
  assert.throws(() => createCalibrationSchedule({seed:1, screen, positionsNorm:Array(6).fill({x:.5, y:.5})}), TypeError);
});

test('calibration schedule positions can be fed back as exclusions for the accuracy plan', () => {
  const s = createCalibrationSchedule({seed:2, screen, positionsNorm:[0.1, 0.5, 0.9].flatMap(y => [0.1, 0.5, 0.9].map(x => ({x, y})))});
  const plan = createAccuracyPlan({seed:2, screen, calibrationTargets:s.uniquePositionsNorm});
  assert.equal(plan.excludedCalibrationTargets.length, 9);
  assert.equal(verifyAccuracyPlan(plan).ok, true);
});
