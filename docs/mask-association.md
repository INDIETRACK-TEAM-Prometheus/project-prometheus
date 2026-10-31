# Mask association

`src/spatial/mask-association.js` associates caller-owned local track IDs with masks returned by SAM for the current image. It ignores SAM's per-image `objectId`, compares decoded raster masks at source-pixel centers, and uses the MIT `munkres@2.1.1` package for a global one-to-one assignment. `ObjectTracker` also supplies a mean RGB appearance vector and vetoes a pair when its normalized color distance exceeds `0.35`; this simple feature is not trained or lighting-invariant.

```js
const result = associateMasks(
  [{objectId: 'local-1', mask: previousSamMask}],
  currentSamMasks
);
```

Only `result.matches` is safe to use for identity carry-forward. `result.proposedMatches` exposes the optimizer's assignment before ambiguity checks for diagnostics; do not use proposals to persist IDs. Close alternatives, assignment conflicts, dimension changes, and work-budget exhaustion return no reusable matches. New detections have no association, and ambiguous detections include candidate local IDs for review.

The defaults (`minIoU: 0.1`, `ambiguityMargin: 0.05`, `maxAppearanceDistance: 0.35`) are engineering thresholds, not calibrated probabilities or a trained model's confidence. The appearance veto applies only when both sides supply a color vector. The helper accepts at most 100 tracks and detections, 4,194,304 total mask-raster cells, and 20 million overlapping-run comparisons per call. A budget limit withholds all matches for that call.

`ObjectTracker` uses this helper and retains its default `maxGapMs: 1000`. A later frame outside that configured gap starts tentative observations instead of carrying IDs forward. A caller may explicitly choose a longer gap, but matching masks several seconds apart has not been validated and should not be treated as reliable identity. Keep track state within one camera/session and discard it when that stream changes. This helper does not propagate masks or IDs after the latest frame.

The active browser background path in `src/runtime/background-browser.js` currently sends frame-scoped SAM candidate IDs to the reasoner; it does not yet use persistent mask associations. The helper is available to local `ObjectTracker`/`PerceptionPipeline` callers. No ByteTrack, SAM2, or other trained temporal tracker is included.
