import {hashWithout} from '../gaze/accuracy-protocol.js';

const finiteNonnegative = value => Number.isFinite(value) && value >= 0;
const integerNonnegative = value => Number.isInteger(value) && value >= 0;

function requireSummary(summary, name) {
  if (!summary || !integerNonnegative(summary.count)) throw new TypeError(`${name}.count must be a non-negative integer`);
  for (const key of ['mean', 'max']) {
    const value = summary[key];
    if (summary.count === 0 ? value !== null : !finiteNonnegative(value)) throw new TypeError(`${name}.${key} does not match its count`);
  }
  if (summary.count > 0 && summary.mean > summary.max) throw new TypeError(`${name}.mean cannot exceed max`);
  return {count:summary.count, mean:summary.mean, max:summary.max, p50:null, p95:null, distribution:'aggregate_only'};
}

function requirePilot(pilot) {
  if (!pilot || pilot.schemaVersion !== 1 || !finiteNonnegative(pilot.durationMs)) throw new TypeError('Prometheus pilot summary v1 required');
  if (pilot.pilot30Minutes?.targetMs !== 1800000 || !['not_passed', 'completed_with_valid_samples'].includes(pilot.pilot30Minutes.status)) throw new TypeError('invalid 30-minute pilot result');
  if (!integerNonnegative(pilot.samples) || !integerNonnegative(pilot.validGazeSamples) || pilot.validGazeSamples > pilot.samples) throw new TypeError('invalid pilot sample counts');
  if (!integerNonnegative(pilot.faceDetectedSamples) || pilot.faceDetectedSamples > pilot.samples) throw new TypeError('invalid face sample count');
  if (pilot.sampleRateHz !== null && !finiteNonnegative(pilot.sampleRateHz)) throw new TypeError('invalid sampleRateHz');
  requireSummary(pilot.captureIntervalsMs, 'captureIntervalsMs');
  requireSummary(pilot.inferenceMs, 'inferenceMs');
  if (!pilot.calibration || !pilot.queue || !pilot.timestampKinds || typeof pilot.timestampKinds !== 'object') throw new TypeError('pilot calibration, queue and timestamp counts required');
  const timestampKinds = ['browser_capture_estimate', 'callback_time_not_capture'];
  if (Object.keys(pilot.timestampKinds).some(key => !timestampKinds.includes(key)) || timestampKinds.some(key => !integerNonnegative(pilot.timestampKinds[key]))) throw new TypeError('invalid timestamp counts');
  if (pilot.calibration.status != null && !['completed', 'camera_error', 'not_calibrated', 'in_progress', 'failed'].includes(pilot.calibration.status)) throw new TypeError('invalid calibration status');
  for (const key of ['pending', 'dropped', 'peakPending']) {
    const value = pilot.queue[key];
    if (value !== null && value !== undefined && !integerNonnegative(value)) throw new TypeError(`invalid queue.${key}`);
  }
}

function requireAccuracy(report) {
  if (!report || report.kind !== 'accuracy_report' || report.version !== 1 || !['real_user', 'synthetic'].includes(report.testKind)) throw new TypeError('Prometheus accuracy report v1 required');
  if (typeof report.hash !== 'string' || !/^[a-f0-9]{64}$/.test(report.hash) || report.hash !== hashWithout(report)) throw new TypeError('accuracy report hash mismatch');
  const stage = report.stages?.[report.verdictStage], verdict = report.verdict;
  if (!stage || !verdict || verdict.stage !== report.verdictStage || verdict.evidenceKind !== report.testKind || verdict.gateDecision !== 'requires_reviewer' || verdict.scope !== 'single_participant_single_session' || verdict.generalizes !== false) throw new TypeError('invalid independent accuracy result');
  if (!['meets_threshold', 'below_threshold', 'insufficient_trials'].includes(verdict.status)) throw new TypeError('invalid accuracy verdict status');
  for (const [name, value] of Object.entries({attemptedTrials:stage.attemptedTrials, scoredTrials:stage.scoredTrials, totalSamples:stage.samples?.total, validSamples:stage.samples?.valid, requiredTrials:verdict.trials?.required, verdictAttempts:verdict.trials?.attempted, verdictScored:verdict.trials?.scored})) {
    if (!integerNonnegative(value)) throw new TypeError(`invalid accuracy ${name}`);
  }
  if (stage.samples.valid > stage.samples.total || stage.scoredTrials > stage.attemptedTrials || stage.attemptedTrials !== verdict.trials.attempted || stage.scoredTrials !== verdict.trials.scored || stage.error?.unit !== 'screen_diagonal_fraction') throw new TypeError('invalid accuracy sample metrics');
  for (const value of [stage.validRate, stage.samples.validRate]) if (value !== null && !(Number.isFinite(value) && value >= 0 && value <= 1)) throw new TypeError('invalid accuracy validity rate');
  for (const key of ['p50', 'p95']) if (stage.error?.[key] !== null && !finiteNonnegative(stage.error?.[key])) throw new TypeError(`invalid accuracy error.${key}`);
  if (stage.error.p50 !== null && stage.error.p95 !== null && stage.error.p50 > stage.error.p95) throw new TypeError('accuracy error percentiles are out of order');
  if (!Array.isArray(report.conditionsMissing) || report.conditionsMissing.some(key => !['glasses', 'lighting', 'distanceCm'].includes(key))) throw new TypeError('invalid missing accuracy conditions');
  return {stage, verdict};
}

const unavailable = reason => ({value:null, status:'not_exported', reason});

// Keeps the summary aggregate-only. Accuracy sample exports contain individual gaze coordinates and are not needed here.
export function createSessionQaReport({pilot, accuracyReport = null} = {}) {
  requirePilot(pilot);
  const frozen = pilot.frozenSceneDemo ?? {};
  const accuracy = accuracyReport ? requireAccuracy(accuracyReport) : null;
  const accuracyStatus = !accuracy ? 'not_supplied' : accuracyReport.testKind === 'synthetic' ? 'synthetic_not_human_evidence' : 'reported_real_user_mode_unverified';
  return {
    kind:'prometheus_session_qa', schemaVersion:1,
    session:{durationMs:pilot.durationMs, durationIncludesPausedTime:false, pausedDurationMs:null,
      targetMs:1800000, targetReached:pilot.durationMs >= 1800000,
      pilotStatus:pilot.pilot30Minutes.status,
      samples:{total:pilot.samples, valid:pilot.validGazeSamples, invalid:pilot.samples - pilot.validGazeSamples, faceDetected:pilot.faceDetectedSamples,
        sampleRateHz:pilot.sampleRateHz, timestampKinds:{browser_capture_estimate:pilot.timestampKinds.browser_capture_estimate, callback_time_not_capture:pilot.timestampKinds.callback_time_not_capture}},
      calibration:{status:pilot.calibration.status ?? null, passed:pilot.calibration.passed === true,
        invalidated:typeof pilot.calibration.invalidatedAtUtc === 'string', environmentChanged:pilot.calibration.environmentChanged === true}},
    latency:{captureIntervalMs:requireSummary(pilot.captureIntervalsMs, 'captureIntervalsMs'),
      gazeInferenceMs:requireSummary(pilot.inferenceMs, 'inferenceMs'),
      samMs:unavailable('pilot export does not retain SAM request timings'),
      reasonerMs:unavailable('pilot export does not retain reasoner request timings')},
    failures:{invalidGazeSamples:pilot.samples - pilot.validGazeSamples,
      calibrationInvalidated:typeof pilot.calibration.invalidatedAtUtc === 'string', syncGateStatus:pilot.syncGate?.status ?? 'not_exported',
      requestFailures:unavailable('pilot export does not include provider request outcomes')},
    drops:{captureQueue:pilot.queue.dropped ?? null, queuePendingAtExport:pilot.queue.pending ?? null,
      accuracySamples:unavailable('accuracy report export contains aggregate counts only')},
    resultAgeMs:{maxCaptureProcessingLag:frozen.maxObservedCaptureProcessingLagMs ?? null,
      maxAcceptedCaptureProcessingLag:frozen.maxAcceptedCaptureProcessingLagMs ?? null,
      maxAcceptedProcessingAge:frozen.maxAcceptedProcessingAgeMs ?? null,
      maxAcceptedSampleAge:frozen.maxAcceptedSampleAgeMs ?? null,
      status:frozen.status === 'unverified_used' ? 'observed_in_unverified_frozen_scene_demo' : 'not_measured'},
    costUsd:unavailable('pilot export does not retain provider cost'),
    independentGazeAccuracy:accuracy ? {
      status:accuracyStatus, evidenceKind:accuracyReport.testKind, reportHash:accuracyReport.hash,
      stage:accuracyReport.verdictStage, reportedThresholdStatus:accuracy.verdict.status,
      gateDecision:accuracyReport.testKind === 'real_user' ? 'requires_reviewer' : 'not_assessed', conditionsMissing:Array.isArray(accuracyReport.conditionsMissing) ? [...accuracyReport.conditionsMissing] : [],
      trials:{required:accuracy.verdict.trials.required, attempted:accuracy.stage.attemptedTrials, scored:accuracy.stage.scoredTrials},
      validRate:accuracy.stage.validRate, sampleValidRate:accuracy.stage.samples.validRate,
      error:{unit:accuracy.stage.error.unit, p50:accuracy.stage.error.p50, p95:accuracy.stage.error.p95},
      droppedAccuracySamples:unavailable('overflow count is in the detailed gaze sample export, which is excluded from this aggregate report')
    } : {status:'not_supplied', evidenceKind:null, gateDecision:'not_assessed'},
    limitations:[
      'Pilot duration is the app exported pause-adjusted duration; the paused-time total is not exported.',
      'Latency is available only as aggregate camera intervals and gaze inference mean/max; request stage percentiles are unavailable.',
      'Request failures, provider spend, and per-call outcome records are not included in the pilot export.',
      'The real_user label in an accuracy export cannot prove a human ran it; retain consent and source evidence separately.',
      'This QA report is descriptive and never makes or records a synthetic Gate pass.'
    ]
  };
}
