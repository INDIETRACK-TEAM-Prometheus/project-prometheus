# Colab T4 depth backend

The optional `colab` backend runs the same pinned Depth Anything V2 Metric Hypersim Small checkpoint on a Colab GPU. A loopback-only HTTP service inside the VM is forwarded over SSH to `127.0.0.1:49190` on Windows. When the server selects this backend, virtual-scene RGB frames are sent to Colab for depth inference; webcam frames, face/eye images, landmarks, gaze coordinates, and calibration profiles are not sent through this route. The parity command below sends only the checked-in synthetic geometric fixture.

The local port is `49190` because the Fetch API rejects reserved port `4190` as a bad port before it attempts a connection. Do not expose the Colab service on a public interface.

## Run a parity check

Prerequisites: the official `google-colab-cli` is installed and authenticated, an SSH client is available, and the account can allocate a T4 runtime. The model source commit and checkpoint SHA-256 are pinned and verified by the shared depth worker.

Run from the project root. The checked-in `fixtures/sam-synthetic.png` is a generated geometric image with no camera or user data.

```powershell
$session = 'prometheus-depth-parity-20261101'
$report = "docs/evidence/depth-colab-parity-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')).json"
try {
  & scripts/colab/start-depth.ps1 -Session $session -Gpu T4
  if (-not $?) { throw 'Colab depth startup failed' }
  $env:PROMETHEUS_DEPTH_BACKEND = 'colab'
  $env:PROMETHEUS_DEPTH_REMOTE_URL = 'http://127.0.0.1:49190/'
  node scripts/colab/verify-depth-parity.mjs `
    --image fixtures/sam-synthetic.png `
    --output $report `
    --runs 5
  if ($LASTEXITCODE) { throw 'CPU/GPU parity check failed' }
} finally {
  Remove-Item Env:PROMETHEUS_DEPTH_BACKEND -ErrorAction SilentlyContinue
  Remove-Item Env:PROMETHEUS_DEPTH_REMOTE_URL -ErrorAction SilentlyContinue
  & scripts/colab/stop-depth.ps1 -Session $session
}
```

The `finally` block closes the SSH forward and stops the named Colab VM on both success and failure. The VM is billed while it is running. Verify that `colab sessions` no longer lists the named session after cleanup.

Each report path includes a UTC timestamp because the parity command refuses to overwrite an existing evidence file.

The JSON report records the input hash, model/device metadata, CPU and GPU timings, and per-pixel agreement. It is a single synthetic-image backend parity check; it does not establish depth accuracy, generalization, camera performance, or calibrated metric error. Small CPU/GPU numeric differences and network-dependent round-trip times are expected.
