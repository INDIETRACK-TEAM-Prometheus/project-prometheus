import {verifyAccuracyPlan} from './accuracy-protocol.js';
import {computeAccuracyReport} from './accuracy-report.js';
import {createCausalDisplayFilter} from './display-filter.js';

const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) ? {x:p.x, y:p.y} : null;

// Runs one frozen accuracy plan: shows targets on a fixed schedule (never click-through), records every tracker
// sample while a trial is visible, and builds the report. No fitting or adaptation happens here.
export function createAccuracySession({plan, conditions, testKind = 'real_user', now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout, nextFrame = callback => requestAnimationFrame(callback), filter = createCausalDisplayFilter(), onTrial = () => {}, onFinish = () => {}, maxSamples = 50000} = {}) {
  const checked = verifyAccuracyPlan(plan, {expectedHash:plan?.hash});
  if (!checked.ok) throw new TypeError(`invalid accuracy plan: ${checked.errors.join(', ')}`);
  if (typeof now !== 'function' || typeof setTimer !== 'function' || typeof nextFrame !== 'function' || typeof onTrial !== 'function' || typeof onFinish !== 'function') throw new TypeError('session callbacks required');
  const stride = plan.rules.settleMs + plan.rules.dwellMs + plan.rules.interTrialMs;
  const trialLog = [], samples = [];
  let phase = 'ready', index = -1, current = null, timer = null, dropped = 0, startedAtMs = null;

  function finish(status, reason = null) {
    if (phase === 'finished' || phase === 'cancelled') return;
    if (timer !== null) clearTimer(timer);
    timer = null; current = null; phase = status === 'completed' ? 'finished' : 'cancelled';
    if (status !== 'completed') { onFinish({status, reason, planHash:plan.hash, trialLog:[...trialLog], samples:samples.length}); return; }
    let report = null, error = null;
    try { report = computeAccuracyReport({plan, trialLog, samples, conditions, testKind, expectedPlanHash:plan.hash}); }
    catch (cause) { error = cause instanceof Error ? cause.message : 'report_failed'; }
    onFinish({status:error ? 'report_failed' : 'completed', reason:error, planHash:plan.hash, report, samples:[...samples], droppedSamples:dropped, startedAtMs});
  }
  function advance() {
    timer = null;
    if (phase !== 'running') return;
    index++;
    if (index >= plan.trials.length) { finish('completed'); return; }
    const trial = plan.trials[index];
    current = null;
    onTrial({trial, index, total:plan.trials.length});
    nextFrame(() => {
      if (phase !== 'running' || plan.trials[index] !== trial) return;
      const shownAtMs = now();
      current = {trialId:trial.trialId, shownAtMs};
      trialLog.push({trialId:trial.trialId, shownAtMs});
      timer = setTimer(advance, stride);
    });
  }
  return {
    planHash:plan.hash,
    start() {
      if (phase !== 'ready') throw new Error('accuracy session already used');
      phase = 'running'; startedAtMs = now(); filter.reset?.(); advance();
    },
    // sample: {valid, invalidReason, timestampMs, baseScreenXY, calibratedScreenXY, screen:{width,height}} in CSS px.
    record(sample) {
      if (phase !== 'running' || !current || !sample) return false;
      if (samples.length >= maxSamples) { dropped++; return false; }
      const tMs = Number.isFinite(sample.timestampMs) ? sample.timestampMs : now();
      const screen = sample.screen && Number.isFinite(sample.screen.width) && Number.isFinite(sample.screen.height) ? {width:sample.screen.width, height:sample.screen.height} : null;
      const valid = sample.valid === true;
      const raw = valid ? finitePoint(sample.baseScreenXY) : null, calibrated = valid ? finitePoint(sample.calibratedScreenXY) : null;
      let filtered = null;
      if (screen && screen.width > 0 && screen.height > 0) {
        const result = filter.update(calibrated ? {x:calibrated.x / screen.width, y:calibrated.y / screen.height} : null, tMs, {valid:!!calibrated});
        if (result?.point) filtered = {x:result.point.x * screen.width, y:result.point.y * screen.height};
      }
      samples.push({trialId:current.trialId, tMs, valid, invalidReason:valid ? null : (typeof sample.invalidReason === 'string' ? sample.invalidReason : 'invalid_sample'), raw, calibrated, filtered, ...(screen ? {screen} : {})});
      return true;
    },
    cancel(reason = 'cancelled') { if (phase === 'running' || phase === 'ready') finish('cancelled', reason); },
    status() { return {phase, index, total:plan.trials.length, trials:trialLog.length, samples:samples.length, droppedSamples:dropped}; }
  };
}
