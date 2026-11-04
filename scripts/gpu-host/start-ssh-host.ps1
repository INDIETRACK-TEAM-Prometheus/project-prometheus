# Starts the gaze and depth workers on a self-hosted Linux GPU (set up once with setup-host.sh) and opens one SSH
# process with the same two loopback forwards the Colab launcher uses, so the local server settings stay the same.
param(
  [Parameter(Mandatory)][string]$HostName,  # user@host of your Linux GPU machine
  [switch]$RunServer
)
$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'Prometheus\gpu-host'
$key = Join-Path $stateDir 'id_ed25519'
$tunnelFile = Join-Path $stateDir 'tunnel.pid'
$colabState = Join-Path $env:LOCALAPPDATA 'Prometheus\colab'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$depthPort = 49190
$gazePort = 49191
$sshOptions = @('-i', $key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=10')

if ($HostName -notmatch '^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$') { throw 'HostName must look like user@host.' }
if (-not (Test-Path $key)) { throw "SSH key not found: $key. Create it and add the .pub file to the host's authorized_keys." }
if (Test-Path $tunnelFile) { throw 'A GPU host tunnel is already recorded. Run scripts\gpu-host\stop-ssh-host.ps1 -HostName <user@host> first.' }
if ((Test-Path (Join-Path $colabState 'system-session.txt')) -or (Test-Path (Join-Path $colabState 'tunnel.pid'))) {
  throw 'A Colab session owns the tunnel ports. Run scripts\colab\stop-system.ps1 first.'
}
foreach ($port in $depthPort, $gazePort) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw "Local port $port is already in use." }
}

# Copy the current worker code; the host keeps its Python environments and downloaded weights between runs.
$copies = @(
  @{ From = 'scripts\colab\gaze_service.py'; To = 'prometheus-gpu/gaze/app/gaze_service.py' },
  @{ From = 'scripts\colab\depth_service.py'; To = 'prometheus-gpu/depth/app/depth_service.py' },
  @{ From = 'scripts\depth\model.py'; To = 'prometheus-gpu/depth/app/model.py' },
  @{ From = 'scripts\depth\worker.py'; To = 'prometheus-gpu/depth/app/worker.py' },
  @{ From = 'scripts\gpu-host\run_service.py'; To = 'prometheus-gpu/run_service.py' },
  @{ From = 'scripts\gpu-host\host-service.sh'; To = 'prometheus-gpu/host-service.sh' }
)
& ssh @sshOptions $HostName 'mkdir -p ~/prometheus-gpu/gaze/app ~/prometheus-gpu/depth/app ~/prometheus-gpu/logs ~/prometheus-gpu/run'
if ($LASTEXITCODE) { throw "Cannot reach $HostName over SSH with the Prometheus key." }
foreach ($copy in $copies) {
  & scp -q @sshOptions (Join-Path $root $copy.From) "${HostName}:$($copy.To)"
  if ($LASTEXITCODE) { throw "Copy of $($copy.From) failed." }
}

Write-Output 'Starting gaze and depth workers on the GPU host (first start downloads weights)...'
& ssh @sshOptions $HostName 'sed -i "s/\r$//" ~/prometheus-gpu/host-service.sh && bash ~/prometheus-gpu/host-service.sh start'
if ($LASTEXITCODE) { throw 'GPU host workers did not become ready; see the log lines above.' }

$tunnel = Start-Process ssh -PassThru -WindowStyle Hidden -ArgumentList ($sshOptions + @(
  '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
  '-L', "127.0.0.1:${depthPort}:127.0.0.1:8765", '-L', "127.0.0.1:${gazePort}:127.0.0.1:8766", $HostName))
Set-Content -Path $tunnelFile -Value "$($tunnel.Id) $HostName" -Encoding ascii

$gaze = $null
for ($i = 0; $i -lt 15 -and -not $gaze; $i++) {
  Start-Sleep -Seconds 1
  if ($tunnel.HasExited) { break }
  try { $gaze = Invoke-RestMethod -TimeoutSec 5 "http://127.0.0.1:$gazePort/health" } catch {}
}
if (-not $gaze -or $gaze.status -ne 'ready' -or $gaze.device -ne 'cuda') {
  & (Join-Path $PSScriptRoot 'stop-ssh-host.ps1') -HostName $HostName
  throw 'The SSH tunnel did not reach a ready CUDA gaze worker.'
}
$depth = Invoke-RestMethod -TimeoutSec 5 "http://127.0.0.1:$depthPort/health"
Write-Output ("ready: gaze {0} on {1}, depth {2} on {3} ({4})" -f $gaze.model.id, $gaze.gpu, $depth.model.id, $depth.gpu, $gaze.backend)
Write-Output "Depth tunnel: http://127.0.0.1:$depthPort/"
Write-Output "Gaze tunnel:  http://127.0.0.1:$gazePort/"

if ($RunServer) {
  $env:PROMETHEUS_COMPUTE_PROFILE = 'cloud'
  $env:PROMETHEUS_DEPTH_BACKEND = 'colab'
  $env:PROMETHEUS_DEPTH_REMOTE_URL = "http://127.0.0.1:$depthPort/"
  $env:PROMETHEUS_GAZE_REMOTE_URL = "http://127.0.0.1:$gazePort/"
  try { Push-Location $root; & npm start }
  finally { Pop-Location; & (Join-Path $PSScriptRoot 'stop-ssh-host.ps1') -HostName $HostName }
} else {
  Write-Output 'The local server settings are the same as for Colab (PROMETHEUS_COMPUTE_PROFILE=cloud, DEPTH_BACKEND=colab, the two URLs above).'
  Write-Output "Stop with scripts\gpu-host\stop-ssh-host.ps1 -HostName $HostName (the host GPU stays busy until then)."
}
