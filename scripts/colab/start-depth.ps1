# Starts the Depth Anything GPU worker on a Colab session and tunnels it to 127.0.0.1:<LocalPort>.
# Only virtual scene frames reach Colab; webcam, face and eye data never use this path.
# The Colab VM is billed to the signed-in Google account until stop-depth.ps1 runs.
param(
  [string]$Session = 'prom-depth',
  [ValidateSet('T4', 'L4', 'G4', 'A100', 'H100')][string]$Gpu = 'T4',
  [int]$LocalPort = 49190
)
# Native tools write warnings to stderr; failures are judged by exit codes, not stderr.
$ErrorActionPreference = 'Continue'
$colab = Join-Path $env:USERPROFILE '.local\bin\colab.exe'
$stateDir = Join-Path $env:LOCALAPPDATA 'Prometheus\colab'
$key = Join-Path $stateDir 'id_ed25519'
$pidFile = Join-Path $stateDir 'tunnel.pid'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$env:PYTHONIOENCODING = 'utf-8'

if (-not (Test-Path $colab)) { throw "colab CLI not found at $colab (uv tool install google-colab-cli==0.7.5)" }
New-Item -ItemType Directory -Force $stateDir | Out-Null
# Dedicated key outside ~/.ssh and the repository; used only for this tunnel.
if (-not (Test-Path $key)) { & ssh-keygen -q -t ed25519 -N '""' -C 'prometheus-colab' -f $key; if ($LASTEXITCODE) { throw 'ssh-keygen failed' } }
if (Test-Path $pidFile) { throw "A tunnel may already be running (pid file $pidFile). Run stop-depth.ps1 first." }

$existing = (& $colab sessions 2>&1 | Out-String)
if ($existing -notmatch [regex]::Escape("[$Session]")) {
  & $colab new -s $Session --gpu $Gpu
  if ($LASTEXITCODE) { throw "colab new failed (no $Gpu entitlement?)" }
}
& $colab exec -s $Session --timeout 60 -f (Join-Path $PSScriptRoot 'prepare_dirs.py')
if ($LASTEXITCODE) { throw 'remote directory preparation failed' }
foreach ($name in 'model.py', 'worker.py') {
  # Closed stdin: a pending prompt fails fast instead of hanging.
  $null | & $colab upload -s $Session (Join-Path $root "scripts\depth\$name") "/content/prometheus-depth/app/$name"
  if ($LASTEXITCODE) { throw "upload of $name failed" }
}
& $colab exec -s $Session --timeout 900 -f (Join-Path $PSScriptRoot 'depth_service.py')
if ($LASTEXITCODE) { throw 'remote depth service failed to start' }

$proxy = "$colab ssh --proxy-mode -s $Session -i $key"
# Start-Process joins arguments with spaces, so values containing spaces are quoted explicitly.
$sshArgs = @('-i', "`"$key`"", '-o', "`"ProxyCommand=$proxy`"", '-o', 'StrictHostKeyChecking=accept-new', '-o', "UserKnownHostsFile=$(Join-Path $stateDir 'known_hosts')",
  '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-N', '-L', "127.0.0.1:${LocalPort}:127.0.0.1:8765", "root@$Session")
$tunnel = Start-Process -FilePath ssh -ArgumentList $sshArgs -WindowStyle Hidden -PassThru
Set-Content -Path $pidFile -Value "$($tunnel.Id) $Session" -Encoding ascii

$health = $null
for ($i = 0; $i -lt 30 -and -not $health; $i++) {
  Start-Sleep -Seconds 2
  try { $health = Invoke-RestMethod -TimeoutSec 5 "http://127.0.0.1:$LocalPort/health" } catch {}
}
if (-not $health) { throw 'tunnel opened but /health did not answer; run stop-depth.ps1 and retry' }
Write-Output ("ready: {0} on {1} ({2}), torch {3}" -f $health.model.id, $health.gpu, $health.device, $health.torchVersion)
Write-Output "Before npm start, set:"
Write-Output "  `$env:PROMETHEUS_DEPTH_BACKEND = 'colab'"
Write-Output "  `$env:PROMETHEUS_DEPTH_REMOTE_URL = 'http://127.0.0.1:$LocalPort/'"
Write-Output "Stop with scripts\colab\stop-depth.ps1 when done (the VM bills until stopped)."
