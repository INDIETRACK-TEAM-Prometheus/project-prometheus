# Starts the Depth Anything GPU worker on a Colab session and tunnels it to 127.0.0.1:<LocalPort>.
# Depth inference receives virtual scene frames; combined starts can also forward gaze traffic to its own service.
# The Colab VM is billed to the signed-in Google account until stop-depth.ps1 runs.
param(
  [string]$Session = 'prom-depth',
  [ValidateSet('T4', 'L4', 'G4', 'A100', 'H100')][string]$Gpu = 'T4',
  [int]$LocalPort = 49190,
  [int]$AdditionalLocalPort = 0,
  [int]$AdditionalRemotePort = 0
)
# Native tools write warnings to stderr; failures are judged by exit codes, not stderr.
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'colab-cli.ps1')
$colab = Resolve-PrometheusColabCLI
$stateDir = Join-Path $env:LOCALAPPDATA 'Prometheus\colab'
$key = Join-Path $stateDir 'id_ed25519'
$pidFile = Join-Path $stateDir 'tunnel.pid'
$tunnelStderr = Join-Path $stateDir 'depth-tunnel.stderr.log'
$serviceRunner = Join-Path $PSScriptRoot 'run-colab-service.py'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$env:PYTHONIOENCODING = 'utf-8'

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
if (-not (Test-Path $serviceRunner)) { throw "Colab service runner not found: $serviceRunner" }
$null | & $colab upload -s $Session (Join-Path $PSScriptRoot 'depth_service.py') '/content/prometheus-depth/app/depth_service.py'
if ($LASTEXITCODE) { throw 'upload of depth_service.py failed' }
& $colab exec -s $Session --timeout 900 --env 'PROMETHEUS_COLAB_SERVICE_PATH=/content/prometheus-depth/app/depth_service.py' --env 'PROMETHEUS_COLAB_SERVICE_NAME=depth' -f $serviceRunner
if ($LASTEXITCODE) { throw 'remote depth service failed to start' }

$proxyOption = New-PrometheusColabProxyOption -Executable $colab -Session $Session -IdentityFile $key
# Start-Process joins arguments with spaces, so values containing spaces are quoted explicitly.
$sshArgs = @('-i', "`"$key`"", '-o', $proxyOption, '-o', 'StrictHostKeyChecking=accept-new', '-o', "UserKnownHostsFile=$(Join-Path $stateDir 'known_hosts')",
  '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-E', "`"$tunnelStderr`"", '-N')
$sshArgs += Get-PrometheusColabForwardArguments -LocalPort $LocalPort -RemotePort 8765 -AdditionalLocalPort $AdditionalLocalPort -AdditionalRemotePort $AdditionalRemotePort
$sshArgs += "root@$Session"
if (Test-Path $tunnelStderr) { Remove-Item -LiteralPath $tunnelStderr -Force }
$tunnel = Start-Process -FilePath ssh -ArgumentList $sshArgs -WindowStyle Hidden -PassThru
Set-Content -Path $pidFile -Value "$($tunnel.Id) $Session" -Encoding ascii

$health = $null
$lastHealthFailure = 'no /health response received'
for ($i = 0; $i -lt 30 -and -not $health; $i++) {
  Start-Sleep -Seconds 2
  if (-not (Get-Process -Id $tunnel.Id -ErrorAction SilentlyContinue)) { break }
  try {
    $reply = Invoke-RestMethod -TimeoutSec 5 "http://127.0.0.1:$LocalPort/health"
    if ($reply.type -eq 'ready' -and $reply.status -eq 'ready' -and $reply.backend -eq 'colab_remote' -and $reply.device -eq 'cuda' -and $reply.model.device -eq 'cuda' -and $reply.model.id -eq 'depth-anything/Depth-Anything-V2-Metric-Hypersim-Small') { $health = $reply }
    else { $lastHealthFailure = 'HTTP health mismatch: status={0}, backend={1}, device={2}, model={3}' -f $reply.status, $reply.backend, $reply.device, $reply.model.id }
  } catch { $lastHealthFailure = $_.Exception.GetType().Name }
}
if (-not $health) {
  $tunnel.Refresh()
  $sshState = if ($tunnel.HasExited) { "exited with code $($tunnel.ExitCode)" } else { 'still running' }
  $sshReason = 'no SSH error reported'
  if (Test-Path $tunnelStderr) {
    foreach ($line in Get-Content -LiteralPath $tunnelStderr -ErrorAction SilentlyContinue) {
      if ($line -match 'Address already in use') { $sshReason = 'a local forward port is already in use'; break }
      if ($line -match 'Already-active SSH session|HTTP 429') { $sshReason = 'Colab rejected a concurrent SSH session'; break }
      if ($line -match 'HTTP 401|Authentication failed') { $sshReason = 'Colab SSH authentication failed'; break }
      if ($line -match 'HTTP 403|Forbidden') { $sshReason = 'Colab denied the SSH proxy request'; break }
      if ($line -match 'HTTP 404|Endpoint not found') { $sshReason = 'the Colab runtime does not expose its SSH endpoint'; break }
      if ($line -match 'Connection refused|Connection timed out|WebSocket connection failed') { $sshReason = 'Colab SSH proxy could not connect'; break }
    }
  }
  throw "tunnel /health did not answer ($lastHealthFailure; SSH $sshState; $sshReason). Run stop-depth.ps1 and retry."
}
$xformersNote = if ($health.accelerators.xformers) { "xformers $($health.accelerators.xformers)" } else { "xformers unavailable (plain PyTorch attention)" }
Write-Output ("ready: {0} on {1} ({2}), torch {3}, {4}" -f $health.model.id, $health.gpu, $health.device, $health.torchVersion, $xformersNote)
Write-Output "Before npm start, set:"
Write-Output "  `$env:PROMETHEUS_DEPTH_BACKEND = 'colab'"
Write-Output "  `$env:PROMETHEUS_DEPTH_REMOTE_URL = 'http://127.0.0.1:$LocalPort/'"
Write-Output "Stop with scripts\colab\stop-depth.ps1 when done (the VM bills until stopped)."
