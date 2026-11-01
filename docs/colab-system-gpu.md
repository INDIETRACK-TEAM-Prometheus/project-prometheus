# Shared Colab GPU profile

The system profile runs the pinned Depth Anything and WebEyeTrack gaze workers in one Colab GPU session. Their services bind to loopback inside the VM and use separate SSH forwards on this computer:

| Worker | Colab port | Local port | Input |
| --- | ---: | ---: | --- |
| Depth Anything V2 Metric Hypersim Small | 8765 | 49190 | Virtual-scene RGB frames |
| WebEyeTrack BlazeGaze MPII Face Gaze | 8766 | 49191 | Downscaled camera JPEG frames and calibration targets |

Browser camera capture, JPEG encoding, the local Node.js server, and scene rendering stay on this computer. With the cloud profile active and camera consent granted, the browser sends full camera JPEGs to the local server, which relays them through the gaze SSH tunnel to Colab; the browser does not send eye crops or landmarks. Frames are limited to 640 pixels on the longest side, JPEG quality 0.72, at most 8 frames per second, and 512 KiB per frame. Colab decodes and infers from each JPEG in memory without logging or writing raw frames to disk. During calibration, it temporarily caches derived eye patches and head/face vectors in a bounded RAM ring and uses 27 samples for adaptation; those samples are cleared after adaptation. The service deletes a session on camera stop or after 10 minutes idle. The local camera recording remains governed by the existing recording controls and stays under `data/recordings/` on this computer. Depth receives virtual-scene RGB only.

The Colab services expose no public listener. The launcher creates its SSH key under `%LOCALAPPDATA%\Prometheus\colab`, outside the repository. It does not upload provider API keys. Colab runs are billed to the signed-in Google account until stopped.

## Start both workers and the local app

Prerequisites: `google-colab-cli==0.7.5` is installed and authenticated, OpenSSH is available, Node.js meets the version in the project README, and the Google account can allocate the selected GPU. Run from the project root:

```powershell
& scripts\colab\start-system.ps1 -Gpu T4 -RunServer
```

The launcher starts depth first, then the gaze service in the same named Colab session, verifies that the gaze health response reports the pinned model on CUDA, opens the second tunnel, sets the process environment, and runs `npm start`. Press Ctrl+C to exit the local app; the `finally` cleanup closes both forwards and stops the Colab VM. Startup failures also attempt cleanup. If cleanup reports an error, run `& scripts\colab\stop-system.ps1 -Session <session-name>` using the session name printed by the launcher. The VM remains billable until Colab reports that session stopped.

To start the workers without running Node in the same PowerShell process, omit `-RunServer`. The launcher prints the commands to set in that PowerShell window before `npm start`; after Node exits, run `& scripts\colab\stop-system.ps1 -Session <session-name>`. Stopping removes the VM and tunnels but does not delete local recordings or browser data.

The local server receives these settings in `-RunServer` mode:

```powershell
$env:PROMETHEUS_COMPUTE_PROFILE = 'cloud'
$env:PROMETHEUS_DEPTH_BACKEND = 'colab'
$env:PROMETHEUS_DEPTH_REMOTE_URL = 'http://127.0.0.1:49190/'
$env:PROMETHEUS_GAZE_REMOTE_URL = 'http://127.0.0.1:49191/'
```

`PROMETHEUS_COMPUTE_PROFILE=cloud` selects remote GPU gaze inference; the gaze provider fails closed if its remote URL or worker is unavailable. Depth uses the existing `PROMETHEUS_DEPTH_BACKEND=colab` switch. Browser requests continue through the loopback-only Node server; do not expose either worker or the Node server on a public interface.

This setup verifies worker readiness and model/device metadata, not gaze accuracy, optical timing, or camera performance. No user-camera run is included in this launcher change. Any accuracy claim still requires separate consented validation on a physical camera and display.
