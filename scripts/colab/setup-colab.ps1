# Installs the pinned CLI in stable per-user paths. This does not authenticate or start a GPU session.
$ErrorActionPreference = 'Stop'
if (-not $env:USERPROFILE) { throw 'USERPROFILE is not set; cannot choose stable Colab CLI paths.' }
$toolRoot = Join-Path $env:USERPROFILE '.prometheus'
$env:UV_TOOL_DIR = Join-Path $toolRoot 'uv-tools'
$env:UV_TOOL_BIN_DIR = Join-Path $toolRoot 'bin'
New-Item -ItemType Directory -Force $env:UV_TOOL_DIR, $env:UV_TOOL_BIN_DIR | Out-Null

$uv = Get-Command uv -CommandType Application -ErrorAction SilentlyContinue
if (-not $uv) { throw 'uv is required. Install uv, open a new PowerShell window, then rerun this script.' }

# Keep native stderr visible without letting PowerShell treat it as a terminating error.
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  $installOutput = @(& $uv.Path tool install --force --python 3.12 'google-colab-cli==0.7.5' 2>&1)
  $installExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousErrorActionPreference
}
$installOutput | ForEach-Object { Write-Host $_ }
if ($installExitCode -ne 0) { throw "uv tool install failed with exit code $installExitCode." }

. (Join-Path $PSScriptRoot 'colab-cli.ps1')
$cli = Resolve-PrometheusColabCLI -Candidates @((Join-Path $env:UV_TOOL_BIN_DIR 'colab.exe'))
Write-Output "Installed google-colab-cli 0.7.5 at $cli"
Write-Output 'This installed the CLI only; it did not authenticate or start a Colab GPU session.'
