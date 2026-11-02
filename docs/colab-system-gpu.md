# Shared Colab GPU profile

The system profile runs the pinned Depth Anything and WebEyeTrack gaze workers in one Colab GPU session. Their services bind to loopback inside the VM and use separate SSH forwards on this computer:

| Worker | Colab port | Local port | Input |
| --- | ---: | ---: | --- |
| Depth Anything V2 Metric Hypersim Small | 8765 | 49190 | Virtual-scene RGB frames |
| WebEyeTrack BlazeGaze MPII Face Gaze | 8766 | 49191 | Downscaled camera JPEG frames and calibration targets |

Browser camera capture, JPEG encoding, the local Node.js server, and scene rendering stay on this computer. With the cloud profile active and camera consent granted, the browser sends full camera JPEGs to the local server, which relays them through the gaze SSH tunnel to Colab; the browser does not send eye crops or landmarks. Frames are limited to 640 pixels on the longest side, JPEG quality 0.72, at most 8 frames per second, and 512 KiB per frame. Colab decodes and infers from each JPEG in memory without logging or writing raw frames to disk. During calibration, it temporarily caches derived eye patches and head/face vectors in a bounded RAM ring and uses 27 samples for adaptation; those samples are cleared after adaptation. The service deletes a session on camera stop or after 10 minutes idle. The local camera recording remains governed by the existing recording controls and stays under `data/recordings/` on this computer. Depth receives virtual-scene RGB only.

The Colab services expose no public listener. The launcher creates its SSH key under `%LOCALAPPDATA%\Prometheus\colab`, outside the repository. It does not upload provider API keys. Colab runs are billed to the signed-in Google account until stopped.

## Start both workers and the local app

Prerequisites: `google-colab-cli==0.7.5` is installed and authenticated, OpenSSH is available, Node.js meets the version in the project README, and the Google account can allocate the selected GPU. On Windows, install the pinned CLI once from the project root with `pwsh -NoProfile -File scripts\colab\setup-colab.ps1`. It stores the uv environment in `%USERPROFILE%\.prometheus\uv-tools` and the executable in `%USERPROFILE%\.prometheus\bin`; this only installs the CLI and does not log in or start a GPU session. Run the launcher from the project root:

```powershell
& scripts\colab\start-system.ps1 -Gpu T4 -RunServer
```

The launcher starts depth first and creates one SSH process with both local forwards, then starts gaze in the same named Colab session. Each Python service runs in an isolated persistent namespace through `run-colab-service.py`. After checking the gaze CUDA health, it sets the process environment and runs `npm start`. Press Ctrl+C to exit the local app; the `finally` cleanup closes both forwards and stops the Colab VM. Startup failures also attempt cleanup. If cleanup reports an error, run `& scripts\colab\stop-system.ps1 -Session <session-name>` using the session name printed by the launcher. The VM remains billable until Colab reports that session stopped.

To start the workers without running Node in the same PowerShell process, omit `-RunServer`. The launcher prints the commands to set in that PowerShell window before `npm start`; after Node exits, run `& scripts\colab\stop-system.ps1 -Session <session-name>`. Stopping removes the VM and tunnels but does not delete local recordings or browser data.

The local server receives these settings in `-RunServer` mode:

```powershell
$env:PROMETHEUS_COMPUTE_PROFILE = 'cloud'
$env:PROMETHEUS_DEPTH_BACKEND = 'colab'
$env:PROMETHEUS_DEPTH_REMOTE_URL = 'http://127.0.0.1:49190/'
$env:PROMETHEUS_GAZE_REMOTE_URL = 'http://127.0.0.1:49191/'
```

`PROMETHEUS_COMPUTE_PROFILE=cloud` selects remote GPU gaze inference; the gaze provider fails closed if its remote URL or worker is unavailable. Depth uses the existing `PROMETHEUS_DEPTH_BACKEND=colab` switch. Browser requests continue through the loopback-only Node server; do not expose either worker or the Node server on a public interface.

## Depth acceleration (xFormers, optional)

`WARNING:dinov2:xFormers not available` is printed by the pinned DINOv2 attention code when the optional xFormers accelerator is not installed; DINOv2 then uses plain PyTorch attention. The depth model itself runs either way. The depth service now tries to install `xformers==0.0.35` (`--no-deps`, so PyTorch is never replaced; it requires `torch>=2.10`) before the DINOv2 modules are imported. The install is kept only if a real GPU attention call in a separate process matches PyTorch's attention to 1e-3; otherwise xFormers is uninstalled and the service starts without it. `PROMETHEUS_XFORMERS=0` disables the attempt. The startup line shows `xformers 0.0.35` or `xformers unavailable (plain PyTorch attention)`, and `/health` carries `accelerators.xformers`. Attention results can differ from the plain path by floating-point rounding; the earlier CPU/GPU parity and transport evidence was recorded without xFormers.

## Calibration with the cloud profile (key-driven, batched)

The cloud worker handles one request at a time and rejects overlapping requests with 429, so calibration does not stream frames while it runs. Instead:

1. The live frame stream is held as soon as calibration starts (the frame in flight finishes first).
2. For each of the 27 adaptation targets the user looks at the target with eyes open and presses **Enter or Space**. The browser then captures a burst of 5 JPEG frames over about 0.5 s and keeps it in memory; Esc cancels. Key repeat is ignored and a target accepts a press only 0.5 s after it appears.
3. The **first target is analysed at once** (`POST .../calibration/target`), so a missing face or closed-eye judgement is reported with the per-eye EAR before the other 26 targets are collected. The remaining targets are sent together after the 27th press, one burst per request; a retry re-sends the same frame IDs and the worker answers idempotently.
4. For each target the worker keeps the open-eye frame closest to the median gaze of the burst (at least 3 usable frames and half of the burst). Targets without enough usable frames are re-collected one at a time (up to 3 attempts in adaptation).
5. `POST .../candidate/adapt` adapts the candidate model once from the 27 stored samples. The separate 27 validation targets follow the same key-driven, batched path; the worker only measures them. A validation target that still fails after one re-collection counts as invalid and stays in the denominator of the valid rate.
6. The existing verdict (valid rate and p95 against the screen diagonal) decides acceptance. The live stream resumes after accept or cancel; the previously accepted model is kept on failure.

Adaptation follows the upstream demo: an affine fit from the base predictions to the targets, then 10 steps at 1e-4 with that affine in the loss. The affine (2x3) is stored in the adapter next to the MLP weights and restored with them. The worker's Kalman filter is off; the browser smooths the display.

After an accepted calibration, clicking the live view sends two frames to `POST .../calibration/click` (upstream click calibration). It changes the current session's model only, is never saved and is not independently validated.

Live frames are pipelined: up to two are in flight, a frame waits at most 0.5 s for the GPU (a click up to 2 s) instead of failing with 429, and the browser sends at most 12 frames per second.

During live tracking a single failed frame no longer stops the camera: five consecutive failures stop it, except unrecoverable ones (lost session, oversize frame, incompatible adapter), which stop at once. The stop message names the underlying reason.

Verified with the real app in a browser pane against a fake cloud provider and synthetic frames; not yet run with a real camera or the real Colab worker.

This setup verifies worker readiness and model/device metadata, not gaze accuracy, optical timing, or camera performance. No user-camera run is included in this launcher change. Any accuracy claim still requires separate consented validation on a physical camera and display.
