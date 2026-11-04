# Closes the GPU host tunnel opened by start-ssh-host.ps1 and stops the workers on the host.
param([Parameter(Mandatory)][string]$HostName)
$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'Prometheus\gpu-host'
$key = Join-Path $stateDir 'id_ed25519'
$tunnelFile = Join-Path $stateDir 'tunnel.pid'
$sshOptions = @('-i', $key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=10')

if (Test-Path $tunnelFile) {
  $parts = (Get-Content $tunnelFile -Raw).Trim() -split '\s+'
  if ($parts.Count -ge 2 -and $parts[0] -match '^\d+$') {
    $HostName = $parts[1]
    $process = Get-Process -Id ([int]$parts[0]) -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq 'ssh') { Stop-Process -Id $process.Id -Confirm:$false }
  }
  Remove-Item $tunnelFile -Confirm:$false
}
& ssh @sshOptions $HostName 'bash ~/prometheus-gpu/host-service.sh stop'
if ($LASTEXITCODE) { Write-Warning "Could not reach $HostName to stop the workers; they keep the host GPU busy until stopped there." }
else { Write-Output "stopped: GPU host workers on $HostName, tunnel closed" }
