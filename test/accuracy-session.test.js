import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccuracyPlan} from '../src/gaze/accuracy-protocol.js';
import {createAccuracySession} from '../src/gaze/accuracy-session.js';

const screen = {width:1280, height:720}, conditions = {glasses:false, lighting:'synthetic', distanceCm:60};
function harness(extra = {}) {
  let clock = 0, timers = [], frames = [];
  const shown = [], finished = [];
  const session = createAccuracySession({plan:createAccuracyPlan({seed:7, screen}), conditions, testKind:'synthetic', now:() => clock,
    setTimer:(fn, ms) => { const t = {fn, at:clock + ms}; timers.push(t); return t; }, clearTimer:t => { timers = timers.filter(x => x !== t); },
    nextFrame:fn => frames.push(fn), onTrial:value => shown.push(value), onFinish:value => finished.push(value), ...extra});
  const paint = () => { const pending = frames; frames = []; for (const fn of pending) fn(); };
  const tick = ms => { clock += ms; for (const t of timers.filter(x => x.at <= clock)) { timers = timers.filter(x => x !== t); t.fn(); } };
  return {session, shown, finished, paint, tick, get clock() { return clock; }};
}

test('session shows every planned trial in order and reports with the frozen plan hash', () => {
  const h = harness(), plan = h.session;
  h.session.start();
  let trials = 0;
  while (!h.finished.length && trials < 100) {
    h.paint();
    const trial = h.shown.at(-1).trial;
    for (let i = 0; i < 40; i++) { h.tick(50); if (h.shown.at(-1).trial !== trial || h.finished.length) break; h.session.record({valid:true, timestampMs:h.clock, baseScreenXY:{x:trial.x + 9, y:trial.y}, calibratedScreenXY:{x:trial.x + 3, y:trial.y - 2}, screen}); }
    trials++;
  }
  assert.equal(h.shown.length, 27);
  assert.equal(h.finished[0].status, 'completed');
  assert.equal(h.finished[0].planHash, plan.planHash);
  const {stages} = h.finished[0].report; assert.equal(stages.calibrated.attemptedTrials, 27); assert.ok(stages.calibrated.error.p95 < stages.raw.error.p95, JSON.stringify(stages.calibrated.error));
  assert.ok(h.finished[0].samples.every(s => s.filtered === null || Number.isFinite(s.filtered.x)));
});

test('samples outside a visible trial are ignored and invalid samples keep their reason', () => {
  const h = harness();
  assert.equal(h.session.record({valid:true, timestampMs:0, calibratedScreenXY:{x:1, y:1}, screen}), false);
  h.session.start();
  assert.equal(h.session.record({valid:true, timestampMs:0, calibratedScreenXY:{x:1, y:1}, screen}), false);
  h.paint();
  assert.equal(h.session.record({valid:false, invalidReason:'blink', timestampMs:1, calibratedScreenXY:{x:1, y:1}, screen}), true);
  h.session.cancel('user');
  assert.equal(h.finished[0].status, 'cancelled');
  assert.equal(h.finished[0].reason, 'user');
  assert.equal(h.session.record({valid:true, timestampMs:2, calibratedScreenXY:{x:1, y:1}, screen}), false);
});

test('a tampered plan is refused before any target is shown', () => {
  const plan = createAccuracyPlan({seed:1, screen});
  plan.trials[0].x += 1;
  assert.throws(() => createAccuracySession({plan, conditions}), /invalid accuracy plan/);
});
