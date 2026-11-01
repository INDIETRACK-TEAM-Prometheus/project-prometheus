# Starts depth and gaze GPU workers in one Colab session behind one SSH tunnel with two loopback forwards.
# The optional local server mode owns the full VM lifetime and stops it when the server exits.
param(
  [string]$Session,
  [ValidateSet('T4', 'L4', 'G4', 'A100', 'H100')][string]$Gpu = 'T4',
  [switch]$RunServer
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'colab-cli.ps1')
$colab = Resolve-PrometheusColabCLI
$stateDir = Join-Path $env:LOCALAPPDATA 'Prometheus\colab'
$activeSessionFile = Join-Path $stateDir 'system-session.txt'
$gazePidFile = Join-Path $stateDir 'gaze-tunnel.pid'
$depthPidFile = Join-Path $stateDir 'tunnel.pid'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$depthStarter = Join-Path $PSScriptRoot 'start-depth.ps1'
$stopper = Join-Path $PSScriptRoot 'stop-system.ps1'
$gazeService = Join-Path $PSScriptRoot 'gaze_service.py'
$serviceRunner = Join-Path $PSScriptRoot 'run-colab-service.py'
$depthPort = 49190
$gazePort = 49191
$remoteGazePort = 8766
$env:PYTHONIOENCODING = 'utf-8'

if (-not $Session) { $Session = 'prometheus-system-' + [guid]::NewGuid().ToString('N').Substring(0, 8) }
if ($Session -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,63}$') { throw 'Session may contain only letters, numbers, and hyphens (up to 64 characters).' }
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { throw 'OpenSSH client (ssh) is required.' }
if (-not (Test-Path $depthStarter)) { throw "Depth starter not found: $depthStarter" }
if (-not (Test-Path $gazeService)) { throw "Gaze service not found: $gazeService" }
if (-not (Test-Path $serviceRunner)) { throw "Colab service runner not found: $serviceRunner" }
New-Item -ItemType Directory -Force $stateDir | Out-Null
if ((Test-Path $activeSessionFile) -or (Test-Path $depthPidFile) -or (Test-Path $gazePidFile)) {
  throw 'A managed Colab session or tunnel already exists. Run scripts\colab\stop-system.ps1 or stop-depth.ps1 first.'
}
$sessions = (& $colab sessions 2>&1 | Out-String)
if ($LASTEXITCODE) { throw 'Could not inspect Colab sessions; no GPU session was started.' }
if ($sessions -match [regex]::Escape("[$Session]")) { throw "Colab session [$Session] is already active; choose a new -Session name." }

Set-Content -Path $activeSessionFile -Value $Session -Encoding ascii
$systemReady = $false
try {
  # start-depth downloads/loads depth and owns the SSH process for both forwards.
  $depthOutput = @(& $depthStarter -Session $Session -Gpu $Gpu -LocalPort $depthPort -AdditionalLocalPort $gazePort -AdditionalRemotePort $remoteGazePort)
  if ($depthOutput.Count) { Write-Output $depthOutput[0] }

  # The service checks this copy before bootstrapping its pinned runtime and weights.
  $null | & $colab upload -s $Session $gazeService '/content/prometheus-gaze/app/gaze_service.py'
  if ($LASTEXITCODE) { throw 'Could not upload the gaze service source to the Colab session.' }
  & $colab exec -s $Session --timeout 1200 --env 'PROMETHEUS_COLAB_SERVICE_PATH=/content/prometheus-gaze/app/gaze_service.py' --env 'PROMETHEUS_COLAB_SERVICE_NAME=gaze' -f $serviceRunner
  if ($LASTEXITCODE) { throw 'Colab gaze service failed to start.' }

  $depthTunnelParts = (Get-Content -LiteralPath $depthPidFile -Raw).Trim() -split '\s+'
  if ($depthTunnelParts.Count -lt 2 -or $depthTunnelParts[0] -notmatch '^\d+$' -or $depthTunnelParts[1] -ne $Session) {
    throw 'Depth starter did not record the combined SSH tunnel for this session.'
  }
  $tunnelPid = [int]$depthTunnelParts[0]
  $health = $null
  $lastHealthFailure = 'no /health response received'
  for ($i = 0; $i -lt 30 -and -not $health; $i++) {
    Start-Sleep -Seconds 2
    if (-not (Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue)) { break }
    try {
      $reply = Invoke-RestMethod -TimeoutSec 5 "http://127.0.0.1:$gazePort/health"
      if ($reply.status -eq 'ready' -and $reply.backend -eq 'colab_remote' -and $reply.device -eq 'cuda' -and $reply.model.id -eq 'webeyetrack-blazegaze-mpiifacegaze') { $health = $reply }
      else {
        $lastHealthFailure = 'HTTP health mismatch: status={0}, backend={1}, device={2}, model={3}' -f $reply.status, $reply.backend, $reply.device, $reply.model.id
      }
    } catch { $lastHealthFailure = '{0}: {1}' -f $_.Exception.GetType().Name, $_.Exception.Message }
  }
  if (-not $health) { throw "Gaze tunnel did not return the expected CUDA /health response ($lastHealthFailure)." }
  $systemReady = $true

  Write-Output "Colab session: [$Session]"
  Write-Output ("ready: gaze {0} on {1} ({2}), GPU {3}" -f $health.model.id, $health.device, $health.backend, $health.gpu)
  Write-Output "Depth tunnel: http://127.0.0.1:$depthPort/"
  Write-Output "Gaze tunnel:  http://127.0.0.1:$gazePort/"

  if ($RunServer) {
    $names = @('PROMETHEUS_COMPUTE_PROFILE', 'PROMETHEUS_DEPTH_BACKEND', 'PROMETHEUS_DEPTH_REMOTE_URL', 'PROMETHEUS_GAZE_REMOTE_URL')
    $previous = @{}
    foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    $env:PROMETHEUS_COMPUTE_PROFILE = 'cloud'
    $env:PROMETHEUS_DEPTH_BACKEND = 'colab'
    $env:PROMETHEUS_DEPTH_REMOTE_URL = "http://127.0.0.1:$depthPort/"
    $env:PROMETHEUS_GAZE_REMOTE_URL = "http://127.0.0.1:$gazePort/"
    try {
      Push-Location $root
      Write-Output 'Starting the local Prometheus server. Stop it with Ctrl+C; the Colab VM will be stopped afterward.'
      & npm start
      $serverExitCode = $LASTEXITCODE
      if ($serverExitCode -ne 0) { throw "npm start exited with code $serverExitCode." }
    } finally {
      Pop-Location
      foreach ($name in $names) {
        if ($null -eq $previous[$name]) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
        else { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
      }
    }
  } else {
    Write-Output 'Set these in this PowerShell window before npm start:'
    Write-Output "  `$env:PROMETHEUS_COMPUTE_PROFILE = 'cloud'"
    Write-Output "  `$env:PROMETHEUS_DEPTH_BACKEND = 'colab'"
    Write-Output "  `$env:PROMETHEUS_DEPTH_REMOTE_URL = 'http://127.0.0.1:$depthPort/'"
    Write-Output "  `$env:PROMETHEUS_GAZE_REMOTE_URL = 'http://127.0.0.1:$gazePort/'"
    Write-Output "After the local server exits, run scripts\colab\stop-system.ps1 -Session $Session (the VM is billed until stopped)."
  }
} finally {
  if (-not $systemReady -or $RunServer) {
    try { & $stopper -Session $Session }
    catch {
      if ($systemReady) { throw }
      Write-Warning "Automatic Colab cleanup failed: $($_.Exception.Message). Retry scripts\colab\stop-system.ps1 -Session $Session."
    }
  }
}
