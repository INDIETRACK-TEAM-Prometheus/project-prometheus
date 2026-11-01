# Live attention path: persistent identity, dependencies, telemetry

Covers audit A03 (mask provenance and frame-scoped IDs), A05 (candidate space), A12 (latency/age/deadline accounting) and gates G2-A/D, G4-A/B/C/D/E. Evidence is synthetic unit tests only; no gate is claimed as passed.

## What changed

| File | Change |
| --- | --- |
| `src/runtime/live-tracking.js` (new) | `LiveTracking`: per-camera-session wrapper over `associateMasks` (`src/spatial/mask-association.js`). Ingests decoded SAM raster masks and returns persistent local IDs `trk:<epoch>:<n>`, `identity_status` (`tentative` / `linked` / `ambiguous`), SHA-256 mask digest, area, bounds, lineage fields and a `changes` list (`object_moved`, `object_deleted`, `identity_changed`). |
| `src/runtime/background-browser.js` | `createBackgroundBrowserWork` now requires an injected `tracker`. SAM masks are tracked instead of being reduced to frame-scoped `${frameId}:mask:${i}` IDs. |
| `src/runtime/background-attention.js` | Persistent IDs become cache dependencies; `candidateSpace` validation accepts persistent IDs, digests and provenance; stale-sequence guard; `telemetry()`. Work now receives `{signal, mark, invalidate}`. |

Provider (SAM) `objectId`s are ignored: they are per-image. `/api/sam/segment` returns `{frame, masks:[{objectId,bounds,sourceWidth,sourceHeight,width,height,raster,confidence}], provider, model, requestId, ...}`; `raster` is the decoded one-bit crop mask, which is what the tracker uses. Masks that lack a valid raster, whose `sourceWidth/Height` differ from the captured frame, or that are empty are rejected and counted (`rejected`), never tracked and never candidates.

## Identity rules

- First sighting: `tentative`. Clear one-to-one IoU match to a recent track: `linked`, same ID. Several close prior tracks: `ambiguous`, new ID, `candidateObjectIds` lists the contenders, and those prior tracks emit `identity_changed`.
- Only `linked` tracks (max 10) become `input.candidates`, `candidateSpace` and next-gaze targets. Tentative and ambiguous tracks stay in `input.tracks` (with status and digest) for the reasoner/telemetry but are withheld as candidates. Consequence: the first frame of a session, and the first frame after any reset, has no candidates and a null next gaze.
- Reset (new ID namespace, old IDs can never re-link): scope change (`sessionId`, `cameraId`, `mapId`, `mapVersion`), source-dimension change, association budget exhaustion, or explicit `reset()`. Tracks older than `maxGapMs` (default 1000 ms, same as `ObjectTracker`) are dropped and emit `object_deleted`.
- `object_moved` is emitted when a linked mask's IoU with its previous mask is below `moveIoU` (default 0.9; engineering threshold, not calibrated). Digest-only differences above that threshold do not invalidate caches.
- Bounds: at most `maxTracks` (100) tracks, `maxRetainedPixels` (2,000,000) raster cells, `maxLineage` (256) lineage entries; oldest unmatched tracks are evicted first. Ingests are serialized.
- The digest is SHA-256 over `sam-mask-v1|source dims|crop bounds|raster dims|raster bytes` (WebCrypto, with a pure-JS fallback verified against `node:crypto`). It identifies a decoded mask, not an object.

## Dependencies and invalidation

Work returns `objectDependencies: {objectIds, objectVersions}` (linked persistent IDs mapped to mask digests). The coordinator merges them into the published `dependencies` and the cache entry's `objectIds`; the snapshot-time object list is kept separately (`snapshotObjectIds`) for the presence check, because persistent IDs are only known after segmentation. `background-browser` calls the injected `invalidate(change)` immediately after tracking, so moved/deleted/identity-changed objects drop only the cache entries that list them, even if reasoning later fails. Unrelated changes leave entries intact.

Known gap: the tracker runs only when `work` runs. A cache hit does not segment, so object motion during a cache TTL is not detected unless something else calls `invalidate()`. The app currently sets `stateKey` to the frame ID and `dependencies.objectIds` to `[]`, so cache hits cannot occur at all there; G4-C/D cache behaviour needs a stable `stateKey` (for example tracked linked IDs plus a coarse gaze target) chosen by the app.

## Telemetry (`coordinator.telemetry()`)

Reset by `start()`, kept after `stop()`. Bounded: at most `telemetrySamples` (default 256, max 4096) cycle records and publish timestamps. Returns:

- `counts`: observed, dropped (pending slot replaced before dispatch), superseded (completed but a newer sequence was already published), stale (discarded after invalidation, pause/stop, abort, or expiry), failed (work/publish errors), timeouts, published, generated, cacheHits.
- `generated` and `cached` (kept separate for G4-E vs G4-D): `latencyMs` (published minus snapshot `processedAt`), `resultAgeMs` (published minus `observedUntil` of the data used; a cache hit reports the age of its original observation), `samMs`, `reasonFirstByteMs`, each `{n,p50,p95,max}` by nearest-rank; `deadlineMet/Missed/MetRate` against `deadlineMs` (default 200).
- `effectiveHz` over `telemetryWindowMs` (default 60 s): all, generated, cache_hit.
- `recent`: last 8 cycles with `snapshotAt, dispatchAt, samDoneAt, reasonFirstByteAt, doneAt, publishedAt, outcome`.

`samDoneAt` is stamped by `background-browser` via `mark('samDone')`. `reasonFirstByteAt` is `null` unless the reason callback calls `firstByte()` (the app's non-streaming `sendProvisionalSparkRequest` cannot observe first bytes). Times use the injected `now()`; in the app that is the browser monotonic clock, not a calibrated display clock.

## app.js wiring (CTO)

```js
import {LiveTracking} from './runtime/live-tracking.js';
// in startBackgroundAttention(), before createBackgroundBrowserWork:
const tracker = new LiveTracking();          // one per camera session; a stopped/restarted loop gets fresh IDs
const work = createBackgroundBrowserWork({tracker, capture: /* unchanged */, sam: /* unchanged */, reason: /* unchanged: input.candidates now holds persistent IDs */});
// optional: expose summaries, e.g. for the status line / G4 exports
window.backgroundAttentionTelemetry = () => backgroundAttention?.telemetry();
```

Also required outside my files: `server.js` `/api/reason-provisional` currently requires `candidate.objectId === `${frameId}:mask:${index}``, `candidates.length === masks.length` and per-index equal bounds; persistent linked candidates (a subset of the masks) are rejected until that validator accepts unique IDs of at most 128 characters whose bounds each equal some entry in `masks`. `server/reasoner-adapter.js` already accepts any such ID. Pass `reason`'s `input.tracks`/`input.provenance` onward only if the request schema is extended.

Observed defect for the CTO (not changed): `BackgroundAttentionCoordinator`'s constructor does not store its `snapshot` option (`Object.assign` omits it), so `_schedulePoll` never runs and `app.js`'s polling never starts. Adding `snapshot` to that `Object.assign` fixes it, but it would start roughly one paid SAM call per second after camera start without any consent gate on the SAM call, so I left it for a deliberate decision.

## Limits

- All evidence is synthetic: rectangular masks, fake providers, controlled clocks. Real tracking accuracy, ID-switch rate, split/merge, occlusion and re-appearance behaviour are unmeasured; no appearance feature is used here (the `ObjectTracker` color veto needs RGBA, which the background path does not decode).
- IoU thresholds (`minIoU 0.1`, `ambiguityMargin 0.05`, `moveIoU 0.9`) are engineering defaults. SAM per-call latency and mask stability under real video are unknown; mask digests change with any pixel difference.
- Local track IDs are not semantic identities. `linked` means a clear mask-overlap match, not a verified same object.
- Telemetry shows timing of what ran; it does not establish the 200 ms goal, a 30-minute run, or next-gaze accuracy.

## Depth in the live path (2026-11-01)

`createBackgroundBrowserWork` takes an optional `depth(frame,{signal})` callback. The app passes one that calls `/api/depth/estimate` (local CPU or the Colab GPU backend, per `PROMETHEUS_DEPTH_BACKEND`) on the same scene frame, in parallel with SAM. After SAM and tracking, the work waits at most `depthWaitMs` (1500 ms). If the result has arrived for the same frame, `buildDepthArtifact` computes foreground-mask median/IQR for **linked** tracks only (raster masks matched by digest), near/far relations only when IQR intervals are disjoint, and the gaze-pixel depth. Availability time is when the result arrived, never the frame time. The reasoner receives a compact `depth` object (no map); `/api/reason-provisional` validates it strictly (object IDs must be candidates, availability no later than the request, metric units) and adds one `kind:'depth'` evidence item for Spark. Late, failed or mismatched depth is withheld with a reason and reasoning still runs. The work result reports `depth:{status, reason, artifactSha256?}`.

Limits: synthetic tests only; the effect of depth on reasoning quality is not measured (comparison v2 `depth_context` arm); depth is a monocular scene-surface estimate, not fixation depth; XYZ is withheld because intrinsics and pose are not passed in this path.
