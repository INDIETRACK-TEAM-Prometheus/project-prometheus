import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccuracyPlan, createSeededRandom} from '../src/gaze/accuracy-protocol.js';
import {computeAccuracyReport, evaluateAccuracyVerdict, normalizeConditions, ACCURACY_THRESHOLDS} from '../src/gaze/accuracy-report.js';

const screen = {width:1920, height:1080}, diag = Math.hypot(screen.width, screen.height);
const plan = createAccuracyPlan({seed:42, screen});
const conditions = {glasses:false, lighting:'office, ceiling light', distanceCm:60};
const STRIDE = 2200;

// Synthetic session: every stage defaults to the exact target. `stageFn(stage, trial, tRel, i)` returns a point, null, or undefined (default exact).
function simulate({trials = plan.trials, stepMs = 50, stageFn = () => undefined, validFn = () => true, extra = () => [], order = trials} = {}) {
  const trialLog = [], samples = [];
  order.forEach((trial, k) => {
    const shownAtMs = 1000 + k * STRIDE;
    trialLog.push({trialId:trial.trialId, shownAtMs});
    let i = 0;
    for (let tRel = 0; tRel <= 1900; tRel += stepMs, i++) {
      const s = {trialId:trial.trialId, tMs:shownAtMs + tRel, valid:validFn(trial, tRel, i), target:{x:trial.x, y:trial.y}, screen};
      for (const stage of ['raw', 'calibrated', 'filtered']) { const p = stageFn(stage, trial, tRel, i); s[stage] = p === undefined ? {x:trial.x, y:trial.y} : p; }
      samples.push(s);
    }
    samples.push(...extra(trial, shownAtMs));
  });
  return {trialLog, samples};
}
const report = (session, extra = {}) => computeAccuracyReport({plan, conditions, testKind:'synthetic', ...session, ...extra});

test('perfect synthetic estimates: zero error, gain 1, offset 0, meets threshold, never a Gate pass', () => {
  const r = report(simulate());
  for (const stage of ['raw', 'calibrated', 'filtered']) {
    const m = r.stages[stage];
    assert.equal(m.scoredTrials, 27); assert.equal(m.validRate, 1); assert.equal(m.error.p50, 0); assert.equal(m.error.p95, 0);
    for (const axis of ['x', 'y']) { assert.ok(Math.abs(m.axis[axis].gain - 1) < 1e-9); assert.ok(Math.abs(m.axis[axis].offset) < 1e-9); }
    assert.ok(m.jitter.p95 < 1e-12); assert.equal(m.switchLag.enteredTrials, 27); assert.equal(m.switchLag.p50, 0);
  }
  assert.equal(r.verdict.status, 'meets_threshold');
  assert.equal(r.verdict.stage, 'calibrated');
  assert.equal(r.verdict.generalizes, false); assert.equal(r.verdict.gateDecision, 'requires_reviewer'); assert.equal(r.verdict.evidenceKind, 'synthetic');
  assert.deepEqual(r.scope, {participants:1, sessions:1, generalizes:false});
  assert.ok(r.limitations.some(l => /generalised/.test(l)));
  assert.equal(JSON.stringify(r).includes('"passed"'), false);
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  assert.equal(report(simulate()).hash, r.hash);
});

test('per-axis gain and offset are recovered from a known linear distortion (trial means)', () => {
  const r = report(simulate({stageFn:(stage, t) => stage === 'raw' ? {x:0.8 * (t.x - 960) + 960 + 0.03 * screen.width, y:1.1 * (t.y - 540) + 540 - 0.02 * screen.height} : undefined}));
  const {x, y} = r.stages.raw.axis;
  assert.ok(Math.abs(x.gain - 0.8) < 1e-9); assert.ok(Math.abs(x.offset - (0.5 * 0.2 + 0.03)) < 1e-9);
  assert.ok(Math.abs(y.gain - 1.1) < 1e-9); assert.ok(Math.abs(y.offset - (0.5 * -0.1 - 0.02)) < 1e-9);
  assert.ok(Math.abs(x.rSquared - 1) < 1e-9);
  assert.equal(r.stages.calibrated.axis.x.gain, 1);
});

test('invalid samples stay in the denominator and drive the verdict below threshold', () => {
  const r = report(simulate({validFn:(t, tRel, i) => i % 5 !== 0}));
  const m = r.stages.calibrated;
  assert.ok(m.samples.invalid > 0 && m.samples.invalidReasons.sample_invalid === m.samples.invalid);
  assert.equal(m.samples.valid + m.samples.invalid, m.samples.total);
  assert.ok(Math.abs(m.samples.validRate - m.samples.valid / m.samples.total) < 1e-12);
  assert.ok(m.samples.validRate > 0.75 && m.samples.validRate < 0.85);
  const heavy = report(simulate({validFn:(t, tRel, i) => i % 5 < 2})); // 40% valid
  assert.ok(heavy.stages.calibrated.samples.validRate < 0.5);
  assert.equal(heavy.verdict.status, 'below_threshold'); assert.ok(heavy.verdict.reasons.includes('valid_rate_below_threshold'));
});

test('a trial with no usable window is unscored but still counts in the trial valid rate; verdict compares the stricter rate', () => {
  const dead = new Set(plan.trials.slice(0, 8).map(t => t.trialId));
  const r = report(simulate({validFn:t => !dead.has(t.trialId)}));
  const m = r.stages.calibrated;
  assert.equal(m.scoredTrials, 19); assert.equal(m.plannedTrials, 27);
  assert.ok(Math.abs(m.trialValidRate - 19 / 27) < 1e-12);
  assert.ok(m.samples.validRate > 0.7 && m.samples.validRate < 0.71);
  assert.equal(m.validRate, Math.min(m.samples.validRate, m.trialValidRate));
  assert.equal(r.verdict.status, 'below_threshold');
});

test('minValidSamples makes sparse trials unscored even when every sample is valid', () => {
  const r = report(simulate({stepMs:300}));
  assert.equal(r.stages.calibrated.scoredTrials, 0);
  assert.equal(r.stages.calibrated.error.p95, null);
  assert.equal(r.verdict.status, 'below_threshold'); assert.ok(r.verdict.reasons.includes('no_scored_trials'));
});

test('each trial is the unit: thousands of extra frames in one trial do not move the trial percentiles', () => {
  const heavyTrial = plan.trials[0];
  const noisy = (stage, t) => stage === 'calibrated' && t.trialId !== heavyTrial.trialId ? {x:t.x + 0.03 * diag, y:t.y} : undefined;
  const extra = (trial, shownAtMs) => trial.trialId === heavyTrial.trialId ? Array.from({length:5000}, (_, i) => ({trialId:trial.trialId, tMs:shownAtMs + 800 + (i % 1000) / 1000 * 1000, valid:true, raw:{x:trial.x, y:trial.y}, calibrated:{x:trial.x, y:trial.y}, filtered:{x:trial.x, y:trial.y}})) : [];
  const m = report(simulate({stageFn:noisy, extra})).stages.calibrated;
  assert.ok(Math.abs(m.error.p50 - 0.03) < 1e-9);
  assert.equal(m.error.n, 27); assert.equal(m.error.unitOfAnalysis, 'trial');
  assert.ok(m.sampleLevelDiagnostic.p50 < 0.005); // frame-level view is dominated by the heavy trial and is only a diagnostic
});

test('p95 above 5% of the diagonal is below_threshold; at or under is meets_threshold', () => {
  const at = f => report(simulate({stageFn:(stage, t) => stage === 'calibrated' ? {x:t.x + f * diag, y:t.y} : undefined}));
  assert.equal(at(0.049).verdict.status, 'meets_threshold');
  const bad = at(0.06);
  assert.equal(bad.verdict.status, 'below_threshold'); assert.deepEqual(bad.verdict.reasons, ['p95_above_threshold']);
  assert.ok(Math.abs(bad.stages.calibrated.error.p95 - 0.06) < 1e-9);
  assert.equal(bad.verdict.checks.p95.threshold, ACCURACY_THRESHOLDS.p95DiagonalFraction);
});

test('incomplete runs are insufficient_trials, never meets_threshold', () => {
  const r = report(simulate({trials:plan.trials.slice(0, 20)}));
  assert.equal(r.verdict.status, 'insufficient_trials'); assert.equal(r.verdict.trials.attempted, 20); assert.equal(r.verdict.trials.required, 27);
  assert.equal(r.stages.calibrated.plannedTrials, 27);
  assert.equal(r.verdicts.raw.status, 'insufficient_trials');
  assert.throws(() => evaluateAccuracyVerdict(r.stages.calibrated, {requiredTrials:0}), TypeError);
});

test('edge versus centre breakdown separates a distortion that only affects edge targets', () => {
  const squeeze = (stage, t) => {
    if (stage !== 'calibrated' || t.band !== 'edge') return undefined;
    return {x:960 + 0.9 * (t.x - 960), y:540 + 0.9 * (t.y - 540)};
  };
  const r = report(simulate({stageFn:squeeze})), b = r.stages.calibrated.breakdown;
  assert.equal(b.center.plannedTrials, 3); assert.equal(b.edge.plannedTrials, 24); assert.equal(b.interior.plannedTrials, 0);
  assert.equal(b.center.error.p95, 0); assert.ok(b.edge.error.p50 > 0.02);
  assert.equal(b.interior.error.p95, null);
  assert.equal(b.edge.scoredTrials, 24);
  assert.ok(r.stages.calibrated.axis.x.gain < 1);
});

test('stages are reported separately: raw bias, calibrated exact, filter withholds samples and lags', () => {
  const lagMs = 400;
  const r = report(simulate({stageFn:(stage, t, tRel, i) => {
    if (stage === 'raw') return {x:t.x + 0.1 * diag, y:t.y};
    if (stage === 'filtered') { if (i % 4 === 0) return null; return tRel < lagMs ? {x:t.x + 0.3 * diag, y:t.y} : undefined; }
    return undefined;
  }}));
  assert.ok(Math.abs(r.stages.raw.error.p95 - 0.1) < 1e-9); assert.equal(r.stages.raw.switchLag.enteredTrials, 0); assert.equal(r.stages.raw.switchLag.neverEnteredTrials, 27);
  assert.equal(r.verdicts.raw.status, 'below_threshold'); assert.equal(r.verdicts.calibrated.status, 'meets_threshold');
  assert.ok(r.stages.filtered.samples.invalidReasons.stage_estimate_withheld > 0);
  assert.ok(r.stages.filtered.samples.validRate < 0.8 && r.stages.filtered.samples.validRate > 0.7);
  assert.equal(r.stages.calibrated.switchLag.p50, 0);
  assert.ok(r.stages.filtered.switchLag.p50 >= lagMs && r.stages.filtered.switchLag.p50 <= lagMs + 150);
  assert.equal(computeAccuracyReport({plan, conditions, testKind:'synthetic', ...simulate(), verdictStage:'filtered'}).verdict.stage, 'filtered');
});

test('jitter is dispersion within a fixation, independent of accuracy', () => {
  const d = 8, wobble = (stage, t, tRel, i) => stage === 'calibrated' ? {x:t.x + (i % 2 ? d : -d) + 30, y:t.y} : undefined;
  const m = report(simulate({stageFn:wobble})).stages.calibrated;
  assert.ok(Math.abs(m.jitter.p50 - d / diag) / (d / diag) < 0.05);
  assert.ok(Math.abs(m.error.p50 - 30 / diag) <= d / diag + 1e-9);
});

test('samples outside the dwell window do not count toward validity or error; resized screens count as invalid', () => {
  const wild = (stage, t, tRel) => stage === 'calibrated' && tRel < 700 ? {x:t.x + 500, y:t.y} : undefined;
  assert.equal(report(simulate({stageFn:wild})).stages.calibrated.error.p95, 0);
  const r = report(simulate({}).samples.length ? (() => { const s = simulate(); s.samples.forEach((x, i) => { if (i % 3 === 0) x.screen = {width:1280, height:720}; }); return s; })() : null);
  assert.ok(r.stages.calibrated.samples.invalidReasons.screen_changed > 0);
  assert.ok(r.stages.calibrated.samples.validRate < 0.7);
});

test('a sample whose target differs from the frozen plan is invalid, not silently re-scored', () => {
  const s = simulate(); s.samples.forEach(x => { x.target = {x:x.target.x + 50, y:x.target.y}; });
  const m = report(s).stages.calibrated;
  assert.equal(m.samples.valid, 0); assert.ok(m.samples.invalidReasons.target_mismatch > 0);
  assert.equal(report(s).verdict.status, 'below_threshold');
});

test('expectedSampleRateHz exposes dropped frames in the denominator', () => {
  const sparse = simulate({stepMs:100}); // 10 Hz delivered
  const plain = report(sparse).stages.calibrated, strict = report(sparse, {expectedSampleRateHz:30}).stages.calibrated;
  assert.equal(plain.samples.validRate, 1);
  assert.ok(Math.abs(strict.samples.validRate - 13 / 36) < 1e-9);
  assert.equal(strict.scoredTrials, 0);
});

test('conditions: required fields, explicit null reasons, and no unknown keys', () => {
  assert.throws(() => normalizeConditions({glasses:false, lighting:'x'}), /distanceCm is required/);
  assert.throws(() => normalizeConditions({...conditions, glasses:{value:null}}), /needs a reason/);
  assert.throws(() => normalizeConditions({...conditions, distanceCm:-5}), /invalid condition/);
  assert.throws(() => normalizeConditions({...conditions, ethnicity:'x'}), /unknown condition/);
  assert.throws(() => normalizeConditions(null), TypeError);
  const n = normalizeConditions({glasses:{value:null, reason:'not recorded'}, lighting:'dim', distanceCm:{value:55}, notes:'fatigued'});
  assert.deepEqual(n.glasses, {value:null, reason:'not recorded'}); assert.deepEqual(n.distanceCm, {value:55, reason:null}); assert.equal(n.notes.value, 'fatigued');
  const r = report(simulate(), {conditions:{glasses:{value:null, reason:'not recorded'}, lighting:'dim', distanceCm:60}});
  assert.deepEqual(r.conditionsMissing, ['glasses']);
});

test('input validation: frozen hash, tampered plan, unknown trials, malformed samples, testKind', () => {
  const s = simulate();
  assert.throws(() => report(s, {expectedPlanHash:'0'.repeat(64)}), /frozen hash/);
  assert.doesNotThrow(() => report(s, {expectedPlanHash:plan.hash}));
  const moved = structuredClone(plan); moved.trials[0].x += 5;
  assert.throws(() => report(s, {plan:moved}), /invalid accuracy plan/);
  assert.throws(() => report({trialLog:s.trialLog, samples:[{...s.samples[0], trialId:'nope'}]}), TypeError);
  assert.throws(() => report({trialLog:s.trialLog, samples:[{...s.samples[0], tMs:NaN}]}), TypeError);
  assert.throws(() => report({trialLog:s.trialLog, samples:[{...s.samples[0], calibrated:{x:NaN, y:1}}]}), TypeError);
  assert.throws(() => report({trialLog:[...s.trialLog, s.trialLog[0]], samples:s.samples}), TypeError);
  assert.throws(() => report(s, {testKind:'passed'}), TypeError);
  assert.throws(() => computeAccuracyReport({plan, conditions, ...s}), TypeError);
});

test('running trials out of the frozen order is recorded as a protocol deviation', () => {
  assert.deepEqual(report(simulate()).protocolDeviations, []);
  const swapped = [...plan.trials]; [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
  assert.deepEqual(report(simulate({order:swapped})).protocolDeviations, ['trial_order_differs_from_frozen_plan']);
});

test('regression is unavailable, not fabricated, when fewer than 3 distinct target values are scored', () => {
  const only = plan.trials.filter(t => t.targetId === plan.trials[0].targetId);
  const r = report(simulate({trials:only}));
  assert.equal(r.stages.calibrated.axis.x.available, false);
  assert.equal(r.stages.calibrated.axis.x.reason, 'fewer_than_3_distinct_target_values');
  assert.equal(r.verdict.status, 'insufficient_trials');
});

test('invalidReason from the capture layer is preserved in the reason counts', () => {
  const s = simulate(); s.samples.forEach((x, i) => { if (i % 4 === 0) { x.valid = false; x.invalidReason = 'blink'; } });
  assert.ok(report(s).stages.raw.samples.invalidReasons.blink > 0);
});
