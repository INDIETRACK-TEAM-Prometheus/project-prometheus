# WebEyeTrack local prototype

Prometheus uses the published `webeyetrack@0.0.2` package, pinned exactly in `package.json`, and the upstream `WebEyeTrack` class and `adapt()` method for gaze estimation and personalization. The source repository is [RedForestAI/WebEyeTrack](https://github.com/RedForestAI/WebEyeTrack), inspected at commit `75fbd2f5f784f2eb3a39675a8dcbf1b01c697f1c`. The package declares MIT; the upstream notice is preserved in [webeyetrack-MIT.txt](licenses/webeyetrack-MIT.txt), and bundled third-party notices are retained in [webeyetrack-bundle-LICENSE.txt](licenses/webeyetrack-bundle-LICENSE.txt).

## Local model assets

The npm tarball contains the browser bundle and type declarations, but not the model files. These files are copied from the official repository's `js/examples/minimal-example/public/web/` directory at the source commit above and served only from local routes:

| File | Upstream Git blob SHA-1 | SHA-256 |
| --- | --- | --- |
| `vendor/webeyetrack-model/model.json` | `7963db6c21ef15c8d1ede988503b420960981d25` | `A214F074CCD4724CF4EBF008814A05485E7EAA5FAF5AAEB85E66B24A1AF55688` |
| `vendor/webeyetrack-model/group1-shard1of1.bin` | `4934aeb0740d32a2b02d952d2d6ce8f229ba36b6` | `C030A762A2D21AC0F3C59700A723B2D8790F2003B3F8E72FBE31129FCB234E58` |

The model is loaded from `/web/model.json`; the face landmarker runtime and task model use the existing local `/vendor` assets. The worker overrides WebEyeTrack's default MediaPipe CDN initialization with those local assets. It does not use the upstream `WebcamClient` or `WebEyeTrackProxy`; Prometheus opens one camera stream and transfers copied pixels to its worker. Face frames and eye crops stay local. Derived gaze coordinates, timing metadata, face/eye state, crop rectangles, and the three-value iris/lid vector used by the local residual candidate leave the worker. Raw landmarks and the upstream `eyePatch` are not sent to the app API or persisted. The feature vector is stripped before memory handoff and is not included in calibration exports. For the eye previews, the worker draws actual MediaPipe eye-contour, upper-lid, iris, and eyebrow landmarks over a crop from the same processed frame, then transfers only temporary `ImageBitmap`s to the page for display. The display crop extends upward for eyebrows; this does not change WebEyeTrack's inference crop. The bitmaps are closed after drawing and never enter samples, logs, or persisted data. If bitmap rendering is unavailable, the UI falls back to the live crop and labels it as frame-asynchronous. The iris center is a MediaPipe iris landmark; this is not pupil detection.

The root MIT license in the upstream repository covers the model files in that tree; those files did not include a separate model license or training-data notice. Recheck model and data terms before redistributing the model outside this repository.

## Calibration and persistence

The 27-point adaptation phase calls upstream `WebEyeTrack.adapt()` with its official eye patches, head vectors, face origins, and screen-normalized targets. A distinct 27-point set measures the resulting gaze estimate. No local affine fit replaces upstream personalization. If validation fails during recalibration, the previous in-memory worker remains active.

The worker also derives a three-value feature vector from the existing MediaPipe landmarks: mean iris offset from eye corners (center `473` with corners `263/362`, center `468` with corners `33/133`), mean vertical iris offset, and mean upper-lid offset (groups `385–387` and `158–160`), each normalized by eye span. These indices follow the [MediaPipe Face Mesh topology](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/python/solutions/face_mesh_connections.py). Raw landmarks remain in the worker. After adaptation, the baseline WebEyeTrack gate still uses all 27 separate samples and its existing 80% valid-rate / 5% p95 thresholds. An optional local residual candidate fits on the first 18 samples (two repeats of the same 3×3 target grid) and is selected only when its fallback-to-baseline policy improves p95 on the remaining third-repeat 9 and meets the same thresholds. Missing, out-of-range, or degenerate features leave the baseline prediction in use. This repeated-sample selection check is not independent spatial validation and does not establish accuracy or generalization. Feature vectors and model coefficients are neither logged nor persisted; the accepted candidate exists only in page memory for the camera session.

The inspected upstream API has no supported save, load, export, or restore method for adapted calibration. `adapt()` updates the tracker's in-memory TensorFlow state. Prometheus therefore keeps the accepted adaptation only in the current camera session; stopping the camera or reloading the page requires calibration again. The legacy `prometheus.gaze-calibration.v1` localStorage entry belongs to the removed hand-built model and is left untouched, but it is incompatible and is not read or applied.

## Dependency security status

`webeyetrack@0.0.2` depends on `mathjs@14.5.2`. The install audit reported two high-severity advisories, [GHSA-29qv-4j9f-fjw5](https://github.com/advisories/GHSA-29qv-4j9f-fjw5) and [GHSA-jvff-x2qm-6286](https://github.com/advisories/GHSA-jvff-x2qm-6286), affecting the bundled `mathjs` dependency. The available package version has no non-breaking upstream fix in its declared dependency range; the advisories remain present in this prototype. `mathjs` runs inside the local browser worker and is not used to read server API keys. Do not treat this audit status as a production approval.

This is an integration prototype. Webcam tracking, calibration quality, browser compatibility, model memory/latency, and the UI eye previews still require interactive user QA with the intended camera and browser.
