// G1-F accuracy report: one participant, one session. Each target TRIAL is the unit of analysis, never a frame.
// Invalid samples stay in every denominator. The verdict compares against SRS thresholds but is never a Gate decision.
import {verifyAccuracyPlan, trialWindow, hashWithout} from './accuracy-protocol.js';

const finite = Number.isFinite;
export const ACCURACY_THRESHOLDS = Object.freeze({validRate:0.8, p95DiagonalFraction:0.05});
export const ACCURACY_STAGES = Object.freeze(['raw', 'calibrated', 'filtered']);
export const REQUIRED_CONDITIONS = Object.freeze(['glasses', 'lighting', 'distanceCm']);
const OPTIONAL_CONDITIONS = ['eyeOpening', 'cameraModel', 'participantLabel', 'notes'];
export const ACCURACY_LIMITATIONS = Object.freeze([
  'Single participant and single session: results are never generalised to other users, eye shapes, or populations.',
  'Trial-level statistics; frames inside a fixation are not independent experiments.',
  'Screen-estimate accuracy only; it says nothing about 3D gaze direction or depth accuracy.',
  'The verdict compares against proposed thresholds and is not a Gate decision; a reviewer must judge evidence, commit, and environment.'
]);

const point = p => p && finite(p.x) && finite(p.y);
const percentile = (sorted, p) => { if (!sorted.length) return null; const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };
const quantiles = values => { const s = [...values].sort((a, b) => a - b); return {n:s.length, p50:percentile(s, .5), p95:percentile(s, .95)}; };
const median = values => percentile([...values].sort((a, b) => a - b), .5);
const mean = values => values.reduce((s, v) => s + v, 0) / values.length;

// Required fields may be null only with an explicit reason ("not recorded", "not applicable").
export function normalizeConditions(conditions) {
  if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions)) throw new TypeError('conditions object required');
  const out = {};
  for (const key of [...REQUIRED_CONDITIONS, ...OPTIONAL_CONDITIONS]) {
    const raw = conditions[key], required = REQUIRED_CONDITIONS.includes(key);
    if (raw === undefined) { if (required) throw new TypeError(`condition ${key} is required (use {value:null, reason} when unknown)`); continue; }
    const wrapped = raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw;
    const value = wrapped ? raw.value : raw, reason = wrapped ? (raw.reason ?? null) : null;
    if (value === null) { if (typeof reason !== 'string' || !reason.trim()) throw new TypeError(`condition ${key} is null and needs a reason`); out[key] = {value:null, reason:reason.trim()}; continue; }
    if (key === 'distanceCm' ? !(finite(value) && value > 0 && value < 500) : key === 'glasses' ? !(typeof value === 'boolean' || (typeof value === 'string' && value)) : !(typeof value === 'string' && value)) throw new TypeError(`invalid condition ${key}`);
    out[key] = {value, reason:null};
  }
  const unknown = Object.keys(conditions).filter(k => !REQUIRED_CONDITIONS.includes(k) && !OPTIONAL_CONDITIONS.includes(k));
  if (unknown.length) throw new TypeError(`unknown condition ${unknown[0]}`);
  return out;
}

function validateInputs({plan, trialLog, samples}) {
  const verification = verifyAccuracyPlan(plan);
  if (!verification.ok) throw new TypeError(`invalid accuracy plan: ${verification.errors.join(',')}`);
  if (!Array.isArray(trialLog) || !Array.isArray(samples)) throw new TypeError('trialLog and samples arrays required');
  const planTrials = new Map(plan.trials.map(t => [t.trialId, t])), shown = new Map();
  for (const entry of trialLog) {
    if (!planTrials.has(entry?.trialId) || shown.has(entry.trialId) || !finite(entry.shownAtMs)) throw new TypeError('trialLog entries need unique plan trialId and finite shownAtMs');
    shown.set(entry.trialId, entry.shownAtMs);
  }
  const byTrial = new Map();
  for (const s of samples) {
    if (!shown.has(s?.trialId) || !finite(s.tMs) || typeof s.valid !== 'boolean') throw new TypeError('sample needs a logged trialId, finite tMs and boolean valid');
    for (const stage of ACCURACY_STAGES) if (s[stage] != null && !point(s[stage])) throw new TypeError(`sample ${stage} must be null or finite {x,y}`);
    if (s.target != null && !point(s.target)) throw new TypeError('sample target must be finite {x,y}');
    if (s.screen != null && !(finite(s.screen.width) && finite(s.screen.height))) throw new TypeError('sample screen must be finite {width,height}');
    if (!byTrial.has(s.trialId)) byTrial.set(s.trialId, []);
    byTrial.get(s.trialId).push(s);
  }
  for (const list of byTrial.values()) list.sort((a, b) => a.tMs - b.tMs);
  return {planTrials, shown, byTrial};
}

// Why a sample is unusable for a stage, or null.
function sampleProblem(sample, stage, planTrial, screen) {
  if (sample.valid !== true) return sample.invalidReason || 'sample_invalid';
  if (sample.screen && (Math.abs(sample.screen.width - screen.width) > 0.5 || Math.abs(sample.screen.height - screen.height) > 0.5)) return 'screen_changed';
  if (sample.target && (Math.abs(sample.target.x - planTrial.x) > 1 || Math.abs(sample.target.y - planTrial.y) > 1)) return 'target_mismatch';
  return point(sample[stage]) ? null : 'stage_estimate_withheld';
}

function regress(pairs) { // y on x, trial-level
  const xs = new Set(pairs.map(p => Math.round(p.x * 1e6)));
  if (xs.size < 3) return {available:false, reason:'fewer_than_3_distinct_target_values', trials:pairs.length};
  const mx = mean(pairs.map(p => p.x)), my = mean(pairs.map(p => p.y));
  const sxx = pairs.reduce((s, p) => s + (p.x - mx) ** 2, 0), sxy = pairs.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0), syy = pairs.reduce((s, p) => s + (p.y - my) ** 2, 0);
  if (sxx < 1e-12) return {available:false, reason:'no_target_variance', trials:pairs.length};
  const gain = sxy / sxx, offset = my - gain * mx;
  const sse = pairs.reduce((s, p) => s + (p.y - (gain * p.x + offset)) ** 2, 0);
  return {available:true, gain, offset, rSquared:syy < 1e-12 ? null : 1 - sse / syy, trials:pairs.length, distinctTargets:xs.size, meanSignedError:mean(pairs.map(p => p.y - p.x)), unit:'screen_fraction'};
}

function stageMetrics(stage, {plan, shown, byTrial, planTrials, expectedSampleRateHz}) {
  const {rules, screen} = plan, diag = Math.hypot(screen.width, screen.height), radiusPx = rules.hitRadiusFraction * diag;
  const expected = expectedSampleRateHz ? Math.round(rules.dwellMs / 1000 * expectedSampleRateHz) : 0;
  const invalidReasons = {}, rows = [];
  for (const planTrial of plan.trials) {
    if (!shown.has(planTrial.trialId)) continue;
    const shownAt = shown.get(planTrial.trialId), win = trialWindow(rules, shownAt), all = byTrial.get(planTrial.trialId) ?? [];
    const inWindow = all.filter(s => s.tMs >= win.settleEndMs && s.tMs <= win.endMs);
    const good = [];
    for (const s of inWindow) { const problem = sampleProblem(s, stage, planTrial, screen); if (problem) invalidReasons[problem] = (invalidReasons[problem] ?? 0) + 1; else good.push(s[stage]); }
    const total = Math.max(inWindow.length, expected), scored = good.length >= rules.minValidSamples && good.length / total >= rules.minValidFraction;
    const row = {trial:planTrial, total, validCount:good.length, scored, error:null, jitter:null, estimate:null, lagMs:null, entered:false};
    if (scored) {
      const est = {x:median(good.map(p => p.x)), y:median(good.map(p => p.y))}, m = {x:mean(good.map(p => p.x)), y:mean(good.map(p => p.y))};
      row.estimate = est;
      row.error = Math.hypot(est.x - planTrial.x, est.y - planTrial.y) / diag;
      row.jitter = Math.sqrt(mean(good.map(p => (p.x - m.x) ** 2 + (p.y - m.y) ** 2))) / diag;
    }
    for (const s of all) { // switch lag uses every usable sample from target onset through the end of the dwell window
      if (s.tMs < shownAt || s.tMs > win.endMs || sampleProblem(s, stage, planTrial, screen)) continue;
      if (Math.hypot(s[stage].x - planTrial.x, s[stage].y - planTrial.y) <= radiusPx) { row.entered = true; row.lagMs = s.tMs - shownAt; break; }
    }
    rows.push(row);
  }
  const summarise = subset => {
    const planned = plan.trials.filter(t => subset(t)).length, attempted = rows.filter(r => subset(r.trial)), scored = attempted.filter(r => r.scored);
    const total = attempted.reduce((s, r) => s + r.total, 0), valid = attempted.reduce((s, r) => s + r.validCount, 0);
    return {plannedTrials:planned, attemptedTrials:attempted.length, scoredTrials:scored.length, trialValidRate:planned ? scored.length / planned : null, sampleValidRate:total ? valid / total : null,
      error:{unit:'screen_diagonal_fraction', unitOfAnalysis:'trial', ...quantiles(scored.map(r => r.error))}, jitter:{unit:'screen_diagonal_fraction', ...quantiles(scored.map(r => r.jitter))}};
  };
  const attempted = rows, scored = rows.filter(r => r.scored), samples = attempted.reduce((a, r) => ({total:a.total + r.total, valid:a.valid + r.validCount}), {total:0, valid:0});
  const lags = attempted.filter(r => r.entered).map(r => r.lagMs), diagnosticErrors = [];
  for (const r of attempted) for (const s of (byTrial.get(r.trial.trialId) ?? [])) { const win = trialWindow(rules, shown.get(r.trial.trialId)); if (s.tMs >= win.settleEndMs && s.tMs <= win.endMs && !sampleProblem(s, stage, r.trial, screen)) diagnosticErrors.push(Math.hypot(s[stage].x - r.trial.x, s[stage].y - r.trial.y) / diag); }
  const base = summarise(() => true);
  return {
    stage, ...base,
    samples:{total:samples.total, valid:samples.valid, invalid:samples.total - samples.valid, invalidReasons, validRate:samples.total ? samples.valid / samples.total : null, expectedSampleRateHz:expectedSampleRateHz ?? null},
    validRate:Math.min(base.sampleValidRate ?? 0, base.trialValidRate ?? 0),
    axis:{x:regress(scored.map(r => ({x:r.trial.xNorm, y:r.estimate.x / screen.width}))), y:regress(scored.map(r => ({x:r.trial.yNorm, y:r.estimate.y / screen.height})))},
    switchLag:{unit:'ms', hitRadiusFraction:rules.hitRadiusFraction, enteredTrials:lags.length, neverEnteredTrials:attempted.length - lags.length, ...quantiles(lags)},
    breakdown:{center:summarise(t => t.band === 'center'), edge:summarise(t => t.band === 'edge'), interior:summarise(t => t.band === 'interior')},
    sampleLevelDiagnostic:{note:'frames are not independent; not evidence for the verdict', unit:'screen_diagonal_fraction', ...quantiles(diagnosticErrors)}
  };
}

// status: meets_threshold | below_threshold | insufficient_trials. No path here produces a Gate "pass".
export function evaluateAccuracyVerdict(metrics, {thresholds = ACCURACY_THRESHOLDS, requiredTrials, testKind = 'real_user'} = {}) {
  if (!finite(thresholds?.validRate) || !finite(thresholds?.p95DiagonalFraction) || !Number.isInteger(requiredTrials) || requiredTrials < 1) throw new TypeError('thresholds and requiredTrials required');
  const checks = {validRate:{value:metrics.validRate, threshold:thresholds.validRate, pass:metrics.validRate >= thresholds.validRate},
    p95:{value:metrics.error.p95, threshold:thresholds.p95DiagonalFraction, pass:metrics.error.p95 !== null && metrics.error.p95 <= thresholds.p95DiagonalFraction}};
  const reasons = [];
  let status;
  if (metrics.attemptedTrials < requiredTrials) { status = 'insufficient_trials'; reasons.push(`attempted ${metrics.attemptedTrials} of ${requiredTrials} planned trials`); }
  else if (checks.validRate.pass && checks.p95.pass) status = 'meets_threshold';
  else { status = 'below_threshold'; if (!checks.validRate.pass) reasons.push('valid_rate_below_threshold'); if (!checks.p95.pass) reasons.push(metrics.error.p95 === null ? 'no_scored_trials' : 'p95_above_threshold'); }
  return {status, stage:metrics.stage, checks, thresholds:{...thresholds}, trials:{required:requiredTrials, attempted:metrics.attemptedTrials, scored:metrics.scoredTrials}, reasons,
    evidenceKind:testKind, gateDecision:'requires_reviewer', scope:'single_participant_single_session', generalizes:false};
}

// samples: {trialId, tMs, valid, invalidReason?, raw, calibrated, filtered, target?, screen?}; all positions in CSS px.
// trialLog: [{trialId, shownAtMs}] in the same clock as tMs. The plan hash is re-verified; pass the frozen hash as expectedPlanHash.
export function computeAccuracyReport({plan, trialLog, samples, conditions, testKind, thresholds = ACCURACY_THRESHOLDS, verdictStage = 'calibrated', expectedPlanHash = null, expectedSampleRateHz = null} = {}) {
  if (!['real_user', 'synthetic'].includes(testKind)) throw new TypeError("testKind must be 'real_user' or 'synthetic'");
  if (!ACCURACY_STAGES.includes(verdictStage)) throw new TypeError('unknown verdictStage');
  if (expectedSampleRateHz !== null && !(finite(expectedSampleRateHz) && expectedSampleRateHz > 0)) throw new TypeError('expectedSampleRateHz must be positive');
  if (expectedPlanHash !== null && plan?.hash !== expectedPlanHash) throw new TypeError('plan hash differs from the frozen hash');
  const normalized = normalizeConditions(conditions), context = {plan, ...validateInputs({plan, trialLog, samples}), expectedSampleRateHz};
  const stages = Object.fromEntries(ACCURACY_STAGES.map(stage => [stage, stageMetrics(stage, context)]));
  const verdicts = Object.fromEntries(ACCURACY_STAGES.map(stage => [stage, evaluateAccuracyVerdict(stages[stage], {thresholds, requiredTrials:plan.trials.length, testKind})]));
  const attemptedOrder = [...context.shown].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  const protocolDeviations = [];
  if (attemptedOrder.some((id, i) => id !== plan.trials[i].trialId)) protocolDeviations.push('trial_order_differs_from_frozen_plan');
  const report = {
    kind:'accuracy_report', version:1, testKind, planHash:plan.hash, screen:{...plan.screen}, rules:{...plan.rules}, conditions:normalized,
    conditionsMissing:Object.entries(normalized).filter(([, v]) => v.value === null).map(([k]) => k),
    thresholds:{...thresholds}, stages, verdictStage, verdict:verdicts[verdictStage], verdicts, protocolDeviations,
    scope:{participants:1, sessions:1, generalizes:false}, limitations:[...ACCURACY_LIMITATIONS]
  };
  return {...report, hash:hashWithout(report)};
}
