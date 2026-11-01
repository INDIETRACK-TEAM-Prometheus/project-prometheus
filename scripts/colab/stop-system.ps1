# Closes both local SSH forwards and stops the Colab VM owned by start-system.ps1.
param([string]$Session)
$ErrorActionPreference = 'Stop'
$colab = Join-Path $env:USERPROFILE '.local\bin\colab.exe'
$stateDir = Join-Path $env:LOCALAPPDATA 'Prometheus\colab'
$activeSessionFile = Join-Path $stateDir 'system-session.txt'
$tunnels = @(
  @{ Path = (Join-Path $stateDir 'gaze-tunnel.pid'); Forward = '127.0.0.1:49191:127.0.0.1:8766' },
  @{ Path = (Join-Path $stateDir 'tunnel.pid'); Forward = '127.0.0.1:49190:127.0.0.1:8765' }
)
$env:PYTHONIOENCODING = 'utf-8'

$savedSession = if (Test-Path $activeSessionFile) { (Get-Content $activeSessionFile -Raw).Trim() } else { $null }
if (-not $Session) { $Session = $savedSession }
if (-not $Session) { throw 'No managed system session was found. Pass -Session only when recovering a start-system.ps1 run.' }
if ($savedSession -and $savedSession -ne $Session) { throw "Managed session is [$savedSession], not [$Session]." }
$managedTunnelFiles = @($tunnels | Where-Object { Test-Path $_.Path })
if (-not $savedSession -and -not $managedTunnelFiles.Count) { throw 'No managed system state was found; refusing to stop an untracked Colab VM.' }

foreach ($tunnel in $managedTunnelFiles) {
  $parts = (Get-Content $tunnel.Path -Raw).Trim() -split '\s+'
  if ($parts.Count -lt 2 -or $parts[0] -notmatch '^\d+$' -or $parts[1] -ne $Session) {
    throw "Invalid or mismatched tunnel state in $($tunnel.Path); inspect it before retrying cleanup."
  }
  $process = Get-Process -Id ([int]$parts[0]) -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -eq 'ssh') {
    $details = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)" -ErrorAction SilentlyContinue
    if (-not $details -or $details.CommandLine -notlike "*$($tunnel.Forward)*") {
      throw "PID $($process.Id) is ssh but does not match the recorded forward; leaving it untouched."
    }
    Stop-Process -Id $process.Id -Confirm:$false
    Wait-Process -Id $process.Id -Timeout 10 -ErrorAction SilentlyContinue
  }
  Remove-Item $tunnel.Path -Confirm:$false
}

if (-not (Test-Path $colab)) { throw "Cannot stop Colab VM: colab CLI not found at $colab." }
$sessions = (& $colab sessions 2>&1 | Out-String)
if ($LASTEXITCODE) { throw 'Could not inspect Colab sessions after closing the local tunnels.' }
if ($sessions -match [regex]::Escape("[$Session]")) {
  & $colab stop -s $Session
  if ($LASTEXITCODE) { throw "Colab failed to stop session [$Session]. Retry scripts\colab\stop-system.ps1 -Session $Session." }
}
$sessions = (& $colab sessions 2>&1 | Out-String)
if ($LASTEXITCODE) { throw 'Could not verify that the Colab VM stopped.' }
if ($sessions -match [regex]::Escape("[$Session]")) { throw "Colab still reports session [$Session] as active." }

if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 49190, 49191 -ErrorAction SilentlyContinue)
  if ($listeners.Count) { throw 'A listener remains on local port 49190 or 49191 after stopping the VM.' }
}
if (Test-Path $activeSessionFile) { Remove-Item $activeSessionFile -Confirm:$false }
Write-Output "stopped: Colab session [$Session], depth and gaze tunnels closed"
