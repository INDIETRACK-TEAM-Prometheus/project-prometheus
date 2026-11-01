import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionQaReport} from '../src/evaluation/session-qa.js';
import {hashWithout} from '../src/gaze/accuracy-protocol.js';

const pilot = () => ({schemaVersion:1, durationMs:1770000, pilot30Minutes:{targetMs:1800000,elapsed:false,status:'not_passed'},
  samples:100,validGazeSamples:82,faceDetectedSamples:91,sampleRateHz:1,timestampKinds:{browser_capture_estimate:90,callback_time_not_capture:10},
  captureIntervalsMs:{count:99,mean:100,max:180},inferenceMs:{count:100,mean:12,max:31},
  calibration:{status:'completed',passed:true,environmentChanged:false},queue:{pending:0,dropped:3,peakPending:2},
  frozenSceneDemo:{status:'unverified_used',maxObservedCaptureProcessingLagMs:60,maxAcceptedCaptureProcessingLagMs:40,maxAcceptedProcessingAgeMs:80,maxAcceptedSampleAgeMs:50},
  syncGate:{status:'not_passed',t15:'not_run'}});

function accuracyReport(testKind = 'synthetic') {
  const report = {kind:'accuracy_report',version:1,testKind,planHash:'plan',verdictStage:'calibrated',conditionsMissing:[],
    verdict:{stage:'calibrated',status:'meets_threshold',evidenceKind:testKind,gateDecision:'requires_reviewer',scope:'single_participant_single_session',generalizes:false,
      trials:{required:27,attempted:27,scored:26}},
    stages:{calibrated:{attemptedTrials:27,scoredTrials:26,validRate:.9,samples:{total:1000,valid:900,validRate:.9},error:{unit:'screen_diagonal_fraction',n:26,p50:.02,p95:.04}}}};
  return {...report,hash:hashWithout(report)};
}

test('session QA surfaces available pilot measurements and leaves missing metrics explicit', () => {
  const result = createSessionQaReport({pilot:pilot()});
  assert.equal(result.session.durationMs,1770000);
  assert.equal(result.session.durationIncludesPausedTime,false);
  assert.equal(result.session.pausedDurationMs,null);
  assert.equal(result.session.samples.invalid,18);
  assert.equal(result.latency.gazeInferenceMs.mean,12);
  assert.equal(result.latency.gazeInferenceMs.p95,null);
  assert.equal(result.latency.reasonerMs.status,'not_exported');
  assert.equal(result.failures.requestFailures.value,null);
  assert.equal(result.drops.captureQueue,3);
  assert.equal(result.resultAgeMs.maxAcceptedSampleAge,50);
  assert.equal(result.costUsd.status,'not_exported');
  assert.equal(result.independentGazeAccuracy.status,'not_supplied');
});

test('accuracy summary is hash checked, source mode is kept, and synthetic evidence is never assessed as a Gate', () => {
  const accuracy = accuracyReport(), result = createSessionQaReport({pilot:pilot(),accuracyReport:accuracy});
  assert.equal(result.independentGazeAccuracy.status,'synthetic_not_human_evidence');
  assert.equal(result.independentGazeAccuracy.reportedThresholdStatus,'meets_threshold');
  assert.equal(result.independentGazeAccuracy.gateDecision,'not_assessed');
  assert.equal(result.independentGazeAccuracy.error.p95,.04);
  accuracy.hash = 'tampered';
  assert.throws(() => createSessionQaReport({pilot:pilot(),accuracyReport:accuracy}),/hash mismatch/);
});

test('rejects unrecognized pilot fields instead of copying them into the aggregate report', () => {
  const data = pilot();
  data.timestampKinds.privateLabel = 'must not be exported';
  assert.throws(() => createSessionQaReport({pilot:data}),/timestamp counts/);
});
