# Starts depth and gaze GPU workers in one Colab session with separate loopback SSH forwards.
# The optional local server mode owns the full VM lifetime and stops it when the server exits.
param(
  [string]$Session,
  [ValidateSet('T4', 'L4', 'G4', 'A100', 'H100')][string]$Gpu = 'T4',
  [switch]$RunServer
)
$ErrorActionPreference = 'Stop'
$colab = Join-Path $env:USERPROFILE '.local\bin\colab.exe'
$stateDir = Join-Path $env:LOCALAPPDATA 'Prometheus\colab'
$activeSessionFile = Join-Path $stateDir 'system-session.txt'
$gazePidFile = Join-Path $stateDir 'gaze-tunnel.pid'
$depthPidFile = Join-Path $stateDir 'tunnel.pid'
$key = Join-Path $stateDir 'id_ed25519'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$depthStarter = Join-Path $PSScriptRoot 'start-depth.ps1'
$stopper = Join-Path $PSScriptRoot 'stop-system.ps1'
$gazeService = Join-Path $PSScriptRoot 'gaze_service.py'
$depthPort = 49190
$gazePort = 49191
$remoteGazePort = 8766
$env:PYTHONIOENCODING = 'utf-8'

if (-not $Session) { $Session = 'prometheus-system-' + [guid]::NewGuid().ToString('N').Substring(0, 8) }
if ($Session -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,63}$') { throw 'Session may contain only letters, numbers, and hyphens (up to 64 characters).' }
if (-not (Test-Path $colab)) { throw "colab CLI not found at $colab (uv tool install google-colab-cli==0.7.5)" }
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { throw 'OpenSSH client (ssh) is required.' }
if (-not (Test-Path $depthStarter)) { throw "Depth starter not found: $depthStarter" }
if (-not (Test-Path $gazeService)) { throw "Gaze service not found: $gazeService" }
New-Item -ItemType Directory -Force $stateDir | Out-Null
if ((Test-Path $activeSessionFile) -or (Test-Path $depthPidFile) -or (Test-Path $gazePidFile)) {
  throw 'A managed Colab session or tunnel already exists. Run scripts\colab\stop-system.ps1 or stop-depth.ps1 first.'
}
$sessions = (& $colab sessions 2>&1 | Out-String)
if ($LASTEXITCODE) { throw 'Could not inspect Colab sessions; no GPU session was started.' }
if ($sessions -match [regex]::Escape("[$Session]")) { throw "Colab session [$Session] is already active; choose a new -Session name." }

Set-Content -Path $activeSessionFile -Value $Session -Encoding ascii
$systemReady = $false
$gazeTunnel = $null
try {
  # start-depth owns the first forward and downloads/loads the pinned depth checkpoint.
  $depthOutput = @(& $depthStarter -Session $Session -Gpu $Gpu -LocalPort $depthPort)
  if ($depthOutput.Count) { Write-Output $depthOutput[0] }

  # The service checks this copy before bootstrapping its pinned runtime and weights.
  $null | & $colab upload -s $Session $gazeService '/content/prometheus-gaze/app/gaze_service.py'
  if ($LASTEXITCODE) { throw 'Could not upload the gaze service source to the Colab session.' }
  & $colab exec -s $Session --timeout 1200 -f $gazeService
  if ($LASTEXITCODE) { throw 'Colab gaze service failed to start.' }

  $proxy = "$colab ssh --proxy-mode -s $Session -i $key"
  $sshArgs = @('-i', "`"$key`"", '-o', "`"ProxyCommand=$proxy`"", '-o', 'StrictHostKeyChecking=accept-new',
    '-o', "UserKnownHostsFile=$(Join-Path $stateDir 'known_hosts')", '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-N', '-L', "127.0.0.1:${gazePort}:127.0.0.1:${remoteGazePort}", "root@$Session")
  $gazeTunnel = Start-Process -FilePath ssh -ArgumentList $sshArgs -WindowStyle Hidden -PassThru
  Set-Content -Path $gazePidFile -Value "$($gazeTunnel.Id) $Session" -Encoding ascii

  $health = $null
  for ($i = 0; $i -lt 30 -and -not $health; $i++) {
    Start-Sleep -Seconds 2
    if (-not (Get-Process -Id $gazeTunnel.Id -ErrorAction SilentlyContinue)) { break }
    try {
      $reply = Invoke-RestMethod -TimeoutSec 5 "http://127.0.0.1:$gazePort/health"
      if ($reply.status -eq 'ready' -and $reply.backend -eq 'colab_remote' -and $reply.device -eq 'cuda' -and $reply.model.id -eq 'webeyetrack-blazegaze-mpiifacegaze') { $health = $reply }
    } catch {}
  }
  if (-not $health) { throw 'Gaze tunnel opened but the expected CUDA /health response did not arrive.' }
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
    if ($gazeTunnel -and -not (Test-Path $gazePidFile)) { Stop-Process -Id $gazeTunnel.Id -Confirm:$false -ErrorAction SilentlyContinue }
    try { & $stopper -Session $Session }
    catch {
      if ($systemReady) { throw }
      Write-Warning "Automatic Colab cleanup failed: $($_.Exception.Message). Retry scripts\colab\stop-system.ps1 -Session $Session."
    }
  }
}
