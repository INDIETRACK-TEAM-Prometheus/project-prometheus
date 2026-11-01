$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'colab-cli.ps1')
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('prometheus-colab-cli-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
  $stable = Join-Path $testRoot 'stable\colab.exe'
  $legacy = Join-Path $testRoot 'legacy\colab.exe'
  New-Item -ItemType Directory -Force (Split-Path $stable), (Split-Path $legacy) | Out-Null
  Set-Content -LiteralPath $stable -Value 'stub' -NoNewline
  Set-Content -LiteralPath $legacy -Value 'stub' -NoNewline

  $probe = {
    param($Executable)
    if ($Executable -eq $stable) { return [pscustomobject]@{ ExitCode = 1; Output = '0.7.5' } }
    [pscustomobject]@{ ExitCode = 0; Output = 'Colab CLI 0.7.5' }
  }.GetNewClosure()
  $resolved = Resolve-PrometheusColabCLI -Candidates @($stable, $legacy) -VersionProbe $probe
  if ($resolved -ne $legacy) { throw "Resolver did not skip the failed stable candidate: $resolved" }

  $wrongVersionProbe = { param($Executable) [pscustomobject]@{ ExitCode = 0; Output = 'Colab CLI 0.8.0' } }
  try {
    Resolve-PrometheusColabCLI -Candidates @($stable, $legacy) -VersionProbe $wrongVersionProbe | Out-Null
    throw 'Resolver accepted a non-pinned version.'
  } catch {
    if ($_.Exception.Message -eq 'Resolver accepted a non-pinned version.') { throw }
    if ($_.Exception.Message -notmatch '0\.7\.5') { throw }
  }

  $proxy = New-PrometheusColabProxyOption -Executable 'C:\Users\A User\.prometheus\bin\colab.exe' -Session 'prometheus-test' -IdentityFile 'C:\Users\A User\.prometheus\colab\id_ed25519'
  if ($proxy -notmatch 'ProxyCommand=\\"C:\\Users\\A User\\.prometheus\\bin\\colab\.exe\\" ssh --proxy-mode -s prometheus-test -i \\"C:\\Users\\A User\\.prometheus\\colab\\id_ed25519\\"') {
    throw "ProxyCommand did not quote paths with spaces safely: $proxy"
  }
  $depthForward = @(Get-PrometheusColabForwardArguments -LocalPort 49190 -RemotePort 8765)
  if (($depthForward -join '|') -ne '-L|127.0.0.1:49190:127.0.0.1:8765') { throw "Unexpected depth forward arguments: $($depthForward -join '|')" }
  $combinedForward = @(Get-PrometheusColabForwardArguments -LocalPort 49190 -RemotePort 8765 -AdditionalLocalPort 49191 -AdditionalRemotePort 8766)
  if (($combinedForward -join '|') -ne '-L|127.0.0.1:49190:127.0.0.1:8765|-L|127.0.0.1:49191:127.0.0.1:8766') {
    throw "Combined forwards are not bound to the expected local and Colab ports: $($combinedForward -join '|')"
  }
  try {
    Get-PrometheusColabForwardArguments -LocalPort 49190 -RemotePort 8765 -AdditionalLocalPort 49191 | Out-Null
    throw 'Forward builder accepted an incomplete additional port mapping.'
  } catch {
    if ($_.Exception.Message -eq 'Forward builder accepted an incomplete additional port mapping.') { throw }
    if ($_.Exception.Message -notmatch 'specified together') { throw }
  }
  $combinedCommandLine = 'ssh -L 127.0.0.1:49190:127.0.0.1:8765 -L 127.0.0.1:49191:127.0.0.1:8766'
  if (-not (Test-PrometheusColabForwards -CommandLine $combinedCommandLine -Forwards @('127.0.0.1:49190:127.0.0.1:8765', '127.0.0.1:49191:127.0.0.1:8766'))) {
    throw 'Combined tunnel ownership check rejected its two managed forwards.'
  }
  if (Test-PrometheusColabForwards -CommandLine 'ssh -L 127.0.0.1:49190:127.0.0.1:8765' -Forwards @('127.0.0.1:49190:127.0.0.1:8765', '127.0.0.1:49191:127.0.0.1:8766')) {
    throw 'Combined tunnel ownership check accepted a missing gaze forward.'
  }

  Write-Output 'Colab CLI resolver, ProxyCommand and tunnel forward checks passed (no installation or session start performed).'
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force
}
