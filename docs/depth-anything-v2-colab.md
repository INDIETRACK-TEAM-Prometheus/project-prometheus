# Colab T4 depth backend

The optional `colab` backend runs the same pinned Depth Anything V2 Metric Hypersim Small checkpoint on a Colab GPU. A loopback-only HTTP service inside the VM is forwarded over SSH to `127.0.0.1:49190` on Windows. When the server selects this backend, virtual-scene RGB frames are sent to Colab for depth inference; webcam frames, face/eye images, landmarks, gaze coordinates, and calibration profiles are not sent through this route. The comparison command below sends only the checked-in synthetic geometric fixture.

The local port is `49190` because the Fetch API rejects reserved port `4190` as a bad port before it attempts a connection. Do not expose the Colab service on a public interface.

## Run a parity and transport comparison

Prerequisites: the official `google-colab-cli` is installed and authenticated, an SSH client is available, and the account can allocate a T4 runtime. The model source commit and checkpoint SHA-256 are pinned and verified by the shared depth worker.

Run from the project root. The checked-in `fixtures/sam-synthetic.png` is a generated geometric image with no camera or user data.

```powershell
$stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$session = "prometheus-depth-transport-$stamp"
$report = "docs/evidence/depth-colab-transport-$stamp.json"
try {
  & scripts/colab/start-depth.ps1 -Session $session -Gpu T4
  if (-not $?) { throw 'Colab depth startup failed' }
  $env:PROMETHEUS_DEPTH_BACKEND = 'colab'
  $env:PROMETHEUS_DEPTH_REMOTE_URL = 'http://127.0.0.1:49190/'
  node scripts/colab/verify-depth-parity.mjs `
    --image fixtures/sam-synthetic.png `
    --output $report `
    --runs 12
  if ($LASTEXITCODE) { throw 'CPU/GPU parity check failed' }
} finally {
  Remove-Item Env:PROMETHEUS_DEPTH_BACKEND -ErrorAction SilentlyContinue
  Remove-Item Env:PROMETHEUS_DEPTH_REMOTE_URL -ErrorAction SilentlyContinue
  & scripts/colab/stop-depth.ps1 -Session $session
}
```

The `finally` block closes the SSH forward and stops the named Colab VM on both success and failure. The VM is billed while it is running. After cleanup, verify that `colab sessions` shows no active session, `%LOCALAPPDATA%\Prometheus\colab\tunnel.pid` is absent, and no listener remains on port 49190.

Each report path includes a UTC timestamp because the verifier refuses to overwrite an existing evidence file.

`--runs 12` records 12 local CPU requests and 12 measured warm requests per remote transport. Each remote transport also gets one discarded warm-up before each six-request block. Legacy sends `Accept-Encoding: identity` and `Connection: close`; optimized leaves gzip negotiation and HTTP/1.1 connection reuse enabled. The blocks run in opposite orders to reduce time-order bias while keeping requests for each mode together. Reports include every request's round-trip and model inference timing, warm p50/p95/max, warm-up timings, and a separate repeated `/health` RTT baseline. The p95 uses the nearest-rank method, so with 12 samples it equals the observed maximum. The health RTT is not subtracted from inference latency.

The JSON report records the input hash, model/device metadata, local and remote timings, legacy versus optimized remote transport timings, and per-pixel agreement. The comparison uses the same synthetic fixture and Colab session for both transports. It is still a single-image backend parity and transport measurement; it does not establish depth accuracy, generalization, camera performance, calibrated metric error, or a general latency guarantee. Small CPU/GPU numeric differences and network-dependent round-trip times are expected.
