# Session QA report

Build an aggregate QA report from the browser's `prometheus-pilot-summary.json` export and, when available, the separate `prometheus-gaze-accuracy-*.json` report:

```sh
node scripts/evaluate-session-qa.mjs --pilot prometheus-pilot-summary.json --accuracy prometheus-gaze-accuracy-report.json --output session-qa.json
```

The `--accuracy` input is optional. The command creates a new output file and refuses to overwrite one. It does not call a provider, inspect or include individual gaze coordinates, or include participant labels and notes. The accuracy report's hash is checked before its aggregate metrics are included.

The pilot export provides pause-adjusted elapsed duration, valid gaze sample counts, calibration state, camera sample intervals, gaze inference mean/max, queue drops, and maximum age measurements from the optional frozen-scene demo. It does not provide the paused-time total, request-stage latency distributions, provider request failure counts, or provider spend. Those report as unavailable; camera sample interval and gaze inference timing are not presented as SAM or reasoner latency. Accuracy sample overflow is also unavailable in this aggregate-only report because its count is in the detailed gaze-samples export.

## Human run required for actual results

No pilot or independent accuracy export is checked into this repository. A real end-to-end result requires a person to run the app with the camera and consent in place, keep a valid calibration, and complete at least 1,800,000 unpaused milliseconds with valid gaze samples. Then run the separate frozen-plan gaze accuracy session against its independent targets and export its accuracy report with the observed conditions. The accuracy test is a single-session screen-estimate check; it is not 3D gaze accuracy or a generalization result.

The accuracy export's `testKind: "real_user"` field is only a mode label and cannot prove that a human ran the task. The exported hash detects accidental changes but is not a signature or identity attestation. Preserve consent and human-run/source evidence separately for review. This script never turns synthetic results into a Gate pass: synthetic results are labeled as not human evidence, and every accuracy result still requires reviewer assessment.
