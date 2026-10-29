# Browser gaze-to-scene timing

## Current behavior

The app timestamps each synthetic scene image at its render callback and copies that exact framebuffer into the short in-memory ring. It does not know when the corresponding pixels emitted from the display. `presentTsEstimateMs` and `displayUncertaintyMs` therefore stay null. The old 100 ms value was a hard-coded hold threshold, not a measured uncertainty, and has been removed.

When supplied, `requestVideoFrameCallback`'s `captureTime` is retained as a browser capture estimate. There is no measured source-clock offset, drift, or uncertainty model, so `sceneAssociationEligible` remains false and the verified gaze-to-scene / gaze-target SAM path stays withheld. Scene-only SAM still works with scene-transfer consent and does not receive gaze. No camera frame or landmark is sent remotely.

## Provisional frozen-scene QA

The separate **잠정 고정 장면 시선 탐색** is for local UI and point-prompt QA without optical equipment. After its visible remote consent and successful gaze calibration, it stops WebGL scene updates, copies the current framebuffer bytes, and begins sampling. Each cycle waits 1.5s before selecting a recent gaze point; SAM requests are automatically spaced at least 5s apart (up to 12 per minute). It accepts only a valid `browser_capture_estimate` sample whose browser-reported capture-to-processing lag is at most 250ms and processing age is at most 100ms. It also requires the estimated capture and callback to occur after the frozen window begins. The 350ms combined software admission window is not a measured physical timestamp error: `opticalTimingUncertaintyMs` and display presentation uncertainty remain null. The interface labels the association `unverified_frozen_scene_window`, never `online_causal`.

The frozen frame and gaze point go to SAM only after the explicit remote consent and are matched by the existing frame ID response check. The returned mask and selected point are displayed on that same copied frame. This only demonstrates the point prompt and response rendering for a static image. It is not a time-alignment measurement, T15 run, Gate result, behavioral result, or permission to record gaze memory. Stop, consent withdrawal, tab hiding, resize/recalibration, and invalid calibration cancel the request loop, clear the temporary sample/result, and resume the world.

## Measurement needed before enabling gaze-target SAM

Measure the actual browser, OS, camera, display, refresh rate, resolution, and scene location together. Re-measure after changing that setup; a profile from another setup is not evidence for this one.

1. Use an external optical reference with a shared, logged timebase: a fast photodiode and acquisition device for display light output, plus a timestamped optical marker visible to the webcam. A high-speed camera may document scanout and rolling-shutter effects, but browser callback times alone are not an optical reference.
2. Render unique, time-coded scene markers and record their frame IDs, `renderTsMs`, browser capture estimates, processing and ingest timestamps, and the reference instrument's observed light transitions. Include the relevant screen region because scanout time can vary by position.
3. Fit and retain capture-clock offset and drift over the intended session duration. Measure residual error, exposure/rolling-shutter effects, display scanout, and run-to-run variation. Report conservative uncertainty bounds and detect clock jumps; do not substitute callback delay or arrival order for capture time.
4. For each candidate association, compute the conservative total as `capture time - measured presentation estimate + camera/clock uncertainty + display uncertainty`. Accept only when the total is at most the SRS 50 ms budget and the exact `frameId` image is retained. Otherwise return `withheld` with the reason.
5. Run T15 with injected clock drift, clock jumps, and display delay. Verify that every out-of-budget case is withheld and that no sample is assigned by response arrival order. Repeat the optical measurement after any relevant browser, camera, display, refresh, or layout change.

## Local measurement-record workflow

The diagnostics panel now offers **Export timing template** and **Check and apply measurement**. Start the camera, enter a human-readable camera label, export the template, then collect a separate optical log while that page and camera session remain open. The template is tied to a random page ID, camera-session ID, browser, viewport, display position/scale, camera dimensions, frame rate and camera label. A reload, camera restart, layout/display change, or setup mismatch invalidates it.

Use the shared optical reference to provide at least three fit pairs and three independent holdout pairs for the camera clock, plus the same for each `top`, `middle`, and `bottom` display band. Camera rows use `{id, sourceMs, performanceMs, callbackMs}`. `performanceMs` is the independently correlated reference time expressed on the current browser performance timeline; `callbackMs` is only used to establish a callback-lag range and detect a later jump, never as the capture timestamp. Display rows use `{id, renderMs, presentMs}` where `presentMs` is the photodiode-observed light transition mapped to that same browser timeline. Region y ranges are normalized `[0,1/3]`, `[1/3,2/3]`, and `[2/3,1]` to bound scanout variation across the scene.

The manifest also records reference-instrument uncertainty and the raw optical log's filename and SHA-256. Choose both the manifest and the matching raw log; the app hashes the raw bytes locally and requires a match. It checks independent row IDs, monotonic times, fit/holdout residuals, setup/session identity, capture timestamp availability, clock jumps over 50 ms, and uncertainty growth through the declared intended session duration. Runtime monitoring latches on a non-monotonic clock, a callback-lag departure, or a >50 ms clock/callback interval mismatch. It then withholds gaze association until a new measurement record is applied.

Importing the record is **not** optical-instrument authentication or a T15 pass. The hash detects file mismatch, not source authenticity; the app cannot inspect/calibrate the hardware from this environment. A user click is required to send the currently retained, exactly frame-ID-matched gaze frame to SAM, with a separate gaze-SAM consent plus the existing scene and reasoner consents. Import, template export, calibration checks, and tests make no network calls. The pilot report retains the evidence hash and keeps `syncGate.status=not_passed`, `t15=not_run`.

No external photodiode/camera timebase log exists in this checkout, and no physical optical measurement was performed. Therefore the runtime remains withheld until the operator supplies matching measurements. The 50 ms software limit and synthetic tests are not hardware evidence.
