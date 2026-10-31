$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtimeHome = Join-Path $repoRoot '.asset-tmp\depth-runtime'
$tempRoot = Join-Path $runtimeHome 'temp'
$sourceCommit = 'a561b849ebae10a6f5ef49e26c83cbbcd36c71bf'
$sourceShort = $sourceCommit.Substring(0, 7)
$checkpointName = 'depth_anything_v2_metric_hypersim_vits.pth'
$checkpointSha256 = 'b782898d8a3e8be1f639de33837ed85e9b4b73e40f8f5e5cd99067588d722545'
$python = Join-Path $runtimeHome 'venv312\Scripts\python.exe'

New-Item -ItemType Directory -Force $runtimeHome, $tempRoot | Out-Null
$env:TEMP = $tempRoot
$env:TMP = $tempRoot

if (-not (Test-Path -LiteralPath $python)) {
    $pythonCommand = Get-Command python -ErrorAction Stop
    $pythonVersion = & $pythonCommand.Source -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
    if ($pythonVersion -ne '3.12') { throw "Python 3.12 is required for this pinned Windows environment; found $pythonVersion." }
    & $pythonCommand.Source -m venv (Join-Path $runtimeHome 'venv312')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated Python environment.' }
}
& $python -m pip --version *> $null
if ($LASTEXITCODE -ne 0) { throw "The isolated environment is incomplete: $python" }

& $python -m pip install --disable-pip-version-check --index-url https://pypi.org/simple --extra-index-url https://download.pytorch.org/whl/cpu -r (Join-Path $PSScriptRoot 'requirements-cpu.txt')
if ($LASTEXITCODE -ne 0) { throw 'Pinned CPU runtime installation failed.' }

$sourceRoot = Join-Path $runtimeHome 'source'
$sourceMetric = Join-Path $sourceRoot 'metric_depth'
$sourceReady = Join-Path $sourceMetric 'depth_anything_v2\dpt.py'
if (-not (Test-Path -LiteralPath $sourceReady)) {
    $archive = Join-Path $runtimeHome "Depth-Anything-V2-$sourceShort.zip"
    $extractRoot = Join-Path $runtimeHome "source-extract-$sourceShort"
    $archiveUrl = "https://github.com/DepthAnything/Depth-Anything-V2/archive/$sourceCommit.zip"
    & curl.exe --fail --location --silent --show-error --retry 2 --connect-timeout 20 --max-time 300 --output $archive $archiveUrl
    if ($LASTEXITCODE -ne 0) { throw 'Could not download the pinned official source archive.' }
    Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot -Force
    $upstream = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
    if (-not $upstream) { throw 'Official Depth Anything V2 source archive is empty.' }
    New-Item -ItemType Directory -Force $sourceRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $upstream.FullName 'metric_depth') -Destination $sourceRoot -Recurse
    Copy-Item -LiteralPath (Join-Path $upstream.FullName 'LICENSE') -Destination (Join-Path $sourceRoot 'LICENSE')
    Set-Content -LiteralPath (Join-Path $sourceRoot 'source-commit.txt') -Value $sourceCommit -NoNewline -Encoding ascii
}
$commitFile = Join-Path $sourceRoot 'source-commit.txt'
$installedCommit = if (Test-Path -LiteralPath $commitFile) { (Get-Content -LiteralPath $commitFile -Raw).Trim() } else { '' }
if (-not (Test-Path -LiteralPath $sourceReady) -or $installedCommit -ne $sourceCommit) {
    throw 'Official Depth Anything V2 source is missing or does not match the pinned commit.'
}

$checkpointDir = Join-Path $runtimeHome 'checkpoints'
$checkpointPath = Join-Path $checkpointDir $checkpointName
New-Item -ItemType Directory -Force $checkpointDir | Out-Null
if (-not (Test-Path -LiteralPath $checkpointPath)) {
    & curl.exe --fail --location --silent --show-error --retry 2 --connect-timeout 20 --max-time 300 --output $checkpointPath "https://huggingface.co/depth-anything/Depth-Anything-V2-Metric-Hypersim-Small/resolve/main/$checkpointName"
    if ($LASTEXITCODE -ne 0) { throw 'Could not download the pinned official checkpoint.' }
}
$actualHash = (Get-FileHash -LiteralPath $checkpointPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $checkpointSha256) { throw "Checkpoint SHA-256 mismatch: $actualHash" }

& $python -c 'import sys, cv2, numpy, PIL, torch, torchvision; print(sys.version.split()[0], torch.__version__, torchvision.__version__, numpy.__version__, cv2.__version__, PIL.__version__)'
if ($LASTEXITCODE -ne 0) { throw 'Pinned runtime import check failed.' }
Write-Output "Depth Anything V2 Metric Hypersim Small is installed in $runtimeHome"
Write-Output "checkpoint_sha256=$actualHash"
Write-Output "source_commit=$sourceCommit"

