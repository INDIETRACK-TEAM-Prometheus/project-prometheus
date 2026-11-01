# Closes the depth tunnel and releases the Colab VM started by start-depth.ps1.
param([string]$Session = 'prom-depth')
. (Join-Path $PSScriptRoot 'colab-cli.ps1')
$pidFile = Join-Path $env:LOCALAPPDATA 'Prometheus\colab\tunnel.pid'
$tunnelStderr = Join-Path $env:LOCALAPPDATA 'Prometheus\colab\depth-tunnel.stderr.log'
$env:PYTHONIOENCODING = 'utf-8'
if (Test-Path $pidFile) {
  $tunnelPid, $savedSession = (Get-Content $pidFile -Raw).Trim() -split ' '
  if ($savedSession) { $Session = $savedSession }
  $process = Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -eq 'ssh') { Stop-Process -Id $tunnelPid -Confirm:$false }
  Remove-Item $pidFile -Confirm:$false
}
$colab = Resolve-PrometheusColabCLI
& $colab stop -s $Session
& $colab sessions
try {
  Remove-Item -LiteralPath $tunnelStderr -Force -ErrorAction Stop
} catch {
  if (Test-Path $tunnelStderr) { Write-Warning 'The VM and tunnel are stopped, but the SSH diagnostic log is still in use.' }
}
