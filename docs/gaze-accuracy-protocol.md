# Gaze accuracy protocol and eye geometry (G1-C/D/E/F)

Status: implemented and unit-tested with **synthetic data only**. No camera, person or real gaze data was used. **G1 real accuracy is unmeasured; no Gate is passed by this document or these tests.** There is no GNN (G1-G is not addressed).

## Modules

| File | Purpose |
|---|---|
| `src/gaze/accuracy-protocol.js` | Frozen, seeded test plan (G1-F) and 30-60 s calibration schedule (G1-E); pure-JS SHA-256, canonical JSON, seeded RNG |
| `src/gaze/accuracy-report.js` | Per-stage accuracy report and verdict from per-sample records |
| `src/gaze/eye-fit.js` | Robust sphere fit, per-eye model builder, kappa estimation, rotation helpers |
| `src/gaze/eye-sphere.js` | Per-eye >=30 node sphere, `validateEyeSphere`, `transformEyeSphere`, `eyeSphereMotion` |
| `src/gaze/binocular-screen.js` | Ray/screen intersection, `closestApproachOfRays`, depth and screen-hit uncertainty |

## Running the real user test (what is needed in `src/app.js`)

`app.js` is not modified by this work. The CTO wiring is:

1. **Plan.** After calibration (or after restoring a stored profile), call
   `createAccuracyPlan({seed, screen:{width:innerWidth, height:innerHeight}})`. The default exclusions are the existing 27-point training grid (0.12/0.50/0.88) and validation grid (0.20/0.48/0.76); pass `calibrationTargets` (normalised `{x,y}`) if those change. Record `plan.hash` **before** the first target is shown and keep it (display it, store it). Never regenerate the plan after seeing results.
2. **Display.** Show `plan.trials[i]` in order at `trial.x, trial.y` (CSS px, same unmirrored viewport space as `#target`). Set `shownAtMs = performance.now()` when the target is actually painted (after a `requestAnimationFrame`) and push `{trialId, shownAtMs}` to `trialLog`. Advance after `rules.settleMs + rules.dwellMs + rules.interTrialMs`; do not let the user click through (the app's 27-point flow clicks on stability; this test must not). Do not run `adapt()` or any fitting during the test.
3. **Capture.** For every tracker frame during a trial (including invalid frames, never skipped) push
   `{trialId, tMs, valid, invalidReason, raw, calibrated, filtered, target, screen}`.
   `tMs` must use the same clock as `shownAtMs` (`performance.now()` base, e.g. `captureMs`). `raw`, `calibrated` and `filtered` are `{x,y}` in CSS px (multiply normalised outputs by `innerWidth/innerHeight`) or `null` when that stage produced no value (a withheld display-filter result is `null` for `filtered`; `valid:false` for blink/face-lost frames). `target` and `screen` are optional but, when present, are cross-checked against the frozen plan (a resized window makes those samples count as invalid).
4. **Report.** `computeAccuracyReport({plan, trialLog, samples, conditions, testKind:'real_user', expectedPlanHash, expectedSampleRateHz})` then export the JSON (it carries its own hash). `conditions` requires `glasses`, `lighting`, `distanceCm`; an unknown value must be written `{value:null, reason:'...'}`. Keep raw samples in a git-excluded local directory and put only the report JSON under `docs/evidence/demo-20261104/`.
5. **Repeat** after reload / stop-restart restoration of the stored profile (the audit asks for repeated independent evaluation), each with a new seed and plan hash.

Optional G1-E: `createCalibrationSchedule({seed, screen})` returns the target sequence and planned timing (default 27 targets, 40.2 s; throws outside 30-60 s). It is planned timing only; the real start/finish time must still be measured.

## What the report contains

* Stages `raw`, `calibrated`, `filtered`, each with: valid rate (invalid and withheld samples stay in the denominator; optional `expectedSampleRateHz` also counts dropped frames), error p50/p95 as a fraction of the screen diagonal, per-axis gain/offset (OLS of trial estimate on target, normalised coordinates), jitter (RMS dispersion in the dwell window), switch lag (first usable sample inside `hitRadiusFraction` of the diagonal, measured from target onset; never-entered trials are counted, not dropped), and an edge / centre / interior breakdown.
* **Unit of analysis is the target trial.** Trial error = distance from the component-wise median of valid dwell-window estimates to the target. A trial is scored only with `minValidSamples` valid samples and `minValidFraction` of its window; unscored trials remain in the trial valid rate. Frame-level error is reported only as `sampleLevelDiagnostic`.
* `verdict` (for `verdictStage`, default `calibrated`) is `meets_threshold`, `below_threshold` or `insufficient_trials` against valid rate >= 0.8 (the stricter of sample- and trial-level rate) and p95 <= 0.05 of the diagonal. The thresholds are proposed development targets. The verdict carries `evidenceKind`, `gateDecision:'requires_reviewer'`, `generalizes:false`; it is never a Gate pass. `protocolDeviations` records out-of-order trials.
* Scope is one participant, one session; results are never generalised to other users, eye shapes or populations.

## Eye geometry notes (G1-C/D)

* `fitSphere` is a Huber/IRLS Levenberg-Marquardt fit with optional Gaussian priors. `status` is `ok`, `ambiguous` (data do not constrain radius/centre; prior-based, `measured:false`) or `unavailable`. Defaults: ambiguous when data-only radius std > 25% of the radius prior or centre std > 50% of it.
* `eyeSphereFromFit` yields >=30 modeled nodes (`source:'modeled_sphere'`, `observed:false`) plus optional observed-point nodes (`source:'observed_point'`, `observed:true`); `validateEyeSphere` checks unit normals (<=1e-6), outward direction, unique model nodes and 100% provenance flags. Modeled nodes are generated geometry, not 30 independent detections.
* `estimateKappa` gives horizontal/vertical optical-to-visual offsets in a gaze-aligned frame built from an `upHint`; it needs >=6 observations, >=5 degrees of optical-axis spread, and flags implausible (>15 degrees) results. It does not estimate torsion or separate kappa from optical-axis bias.
* `closestApproachOfRays` returns midpoint, ray distance, vergence angle and `vergenceDepthM`, or `unavailable` with `rays_near_parallel`, `closest_point_behind_origin`, `excessive_ray_disparity`, `vergence_depth_out_of_range`, or `invalid_*_ray`. Vergence depth and `screenDepthM` are separate fields. `vergenceDepthUncertainty` (Monte Carlo or finite-difference Jacobian) returns `ok`, `uncertain` (relative std over limit) or `unavailable`; at laptop distances small angular noise already makes depth beyond ~1-2 m unreliable. `binocularScreenUncertainty` propagates direction noise to the screen hit.

## Limits

* Synthetic tests prove arithmetic and decision logic, not accuracy on people. Reprojection/sphere-fit residuals are not gaze accuracy, and 2D screen accuracy is not 3D direction or depth accuracy.
* The 3D inputs (optical axes, eye origins, ray directions, observed surface points) must come from a measured pipeline that does not exist yet in this repo; none of these helpers infers 3D from 2D landmarks.
* One participant's result is never evidence about other users.
