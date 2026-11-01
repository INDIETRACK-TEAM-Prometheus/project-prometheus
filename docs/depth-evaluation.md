# Depth artifact and depth accuracy evaluation

Implements the Depth Anything contracts in [COMPARISON_PROTOCOL.md](COMPARISON_PROTOCOL.md) (structured artifact, G2-B accuracy). Nothing here runs a model, calls a network, or asserts a Gate pass. All accuracy numbers it can produce today are **synthetic engine-GT results**, not real-scene accuracy.

## Modules

| File | Purpose |
| --- | --- |
| `src/spatial/depth-artifact.js` | `buildDepthArtifact(...)` -> `{artifact, canonicalJson, sha256}`; `depthForDecision(artifact, cutoffMs)`; `canonicalize`, `verifyDepthArtifact`, `rasterizeMask` |
| `src/evaluation/depth-metrics.js` | `computeDepthMetrics(...)`, `fitScaleCorrection(...)` |
| `src/spatial/world-depth-export.js` | `exportEngineDepth({world, frame, downsample})`, `encodeDepthMap` / `decodeDepthMap` |
| `scripts/evaluate-depth.mjs` | CLI (`readNpz`, `runEvaluation` exported for tests) |

## Depth artifact (what the LLM receives)

Per candidate object ID: foreground valid-pixel fraction, median axial depth, IQR (q1/q3/IQR in m), all computed over the **raster foreground pixels** of the same-frame SAM mask (never the bounding box). `manifest.minValidFraction` (required, frozen before scoring) decides `status: "missing"` with `missingReason` `valid_fraction_below_minimum` or `empty_foreground`; missing objects carry no numbers. `gaze.depthM` is the single gaze pixel's depth, only when valid (otherwise a reason). `relations` lists `nearObjectId < farObjectId` only when the two `[q1,q3]` intervals are disjoint; these describe map spread, not confidence. Quantiles are linear (type 7); values are rounded to 1e-6 m.

Recorded: `units: m`, `convention: axial_z`, `depthSource: monocular_estimated_depth`, model id + checkpoint sha256, frame ID, `observedAtMs`, `availableAtMs` (must be >= observation; `depthForDecision` withholds depth that became available after the decision cutoff), policy. Engine geometry, relative units, or non-axial depth are rejected. Serialization is canonical (sorted keys, no whitespace) and the SHA-256 is of that text; the digest is what belongs in the `kind: depth` evidence row.

XYZ appears only when both intrinsics K and a camera-to-world pose are supplied (`X_cam = z * K^-1 [u,v,1]`, then pose). Pixel index (u,v) is sampled at (u+0.5, v+0.5). If the depth map is a resized/cropped version of the image K refers to, pass `imageTransform` (`originalWidth/Height`, `cropLeft/Top/Width/Height`); it is recorded in the artifact. Per-object XYZ is the component-wise median of the unprojected valid foreground pixels (not a guaranteed surface point). Without K/pose: `xyz: {status: "withheld"}`.

## Metrics

Over GT pixels that are valid, positive and `<= maxDepthM` (20 m): `coverage` = model-valid/GT-valid (model-missing pixels count against it and are never dropped from the denominator), `mae`, `rmse`, `absRel`, `delta125` (strict `< 1.25`) over pixels both valid, plus `delta125OverGtValid` where missing pixels count as failures. Regions: `all_valid`, `foreground` (union and per object), `boundary_band` (Chebyshev `boundaryBandPx` around mask contours, both sides), `gaze_roi` (`radiusPx` around the gaze pixel). Raw metric output only: no scale/shift is fitted on the evaluated GT. `fitScaleCorrection` may fit one scale on `calibration`-split pairs; the result is labelled `experiment: scale_corrected_calibration_split` and refused for the sample it was fitted on.

## Engine GT export

`exportEngineDepth` calls `world.raycastFrame(frame, x, y)` at block centres of a retained frame, converts ray range to axial z with the frame intrinsics (`z = range / |[(x-cx)/fx, (y-cy)/fy, 1]|`), marks no-hit and out-of-range pixels invalid, and labels the result `engine_oracle` / `engine_geometry` / `modelOutput: false`. Use `downsample` to reduce raycast cost (the model map must then be at the same size). The oracle arm must be reported as a separate experiment; it must never enter the model-depth artifact.

## CLI

```powershell
node scripts/evaluate-depth.mjs --pred .asset-tmp/depth-runtime/frame-depth.npz --pred-frame-id synthetic-12 `
  --gt study-data/synthetic-12-gt.json --masks study-data/synthetic-12-masks.json `
  --gaze 320,180 --gaze-radius 8 --boundary-band 3 --output study-data/synthetic-12-depth-report.json
```

`--pred` is the worker `.npz` (`depth_m`, `valid_mask`; read in pure Node, no Python) or a depth-map JSON from `encodeDepthMap`. `--gt` is the JSON from `encodeDepthMap(exportEngineDepth(...))`. `.npz` carries no frame identity, so `--pred-frame-id` is mandatory and must equal the GT frame ID. `--masks` is `[{objectId, mask}]` in SAM raster format. The report records both input SHA-256 digests, is created with exclusive create (never overwrites), and states `synthetic: true`, `gateStatus: "not_asserted"`.

## Limits

- Synthetic engine GT only (WebGL fixture); says nothing about real-scene accuracy. Real validation needs independent sensor/range GT.
- GT and model maps must have identical dimensions; no resampling is done in the evaluator.
- `world.js` `raycastFrame` rebuilds the scene per call, so full-resolution export is slow; use `downsample`.
- Artifact `relations` and IQR describe map spread; they are not calibrated confidence. Gaze depth is scene-surface depth, not fixation depth.
- Wiring into the live reasoning path and comparison generator is not done here.
