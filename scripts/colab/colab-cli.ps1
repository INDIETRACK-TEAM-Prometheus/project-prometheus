function Get-PrometheusColabVersionResult {
  param([Parameter(Mandatory)][string]$Executable)

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Executable
  $startInfo.Arguments = 'version'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw "Could not run colab CLI at $Executable." }
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  [pscustomobject]@{ ExitCode = $process.ExitCode; Output = "$stdout`n$stderr" }
}

function Resolve-PrometheusColabCLI {
  [CmdletBinding()]
  param(
    [string[]]$Candidates,
    [scriptblock]$VersionProbe = { param($Executable) Get-PrometheusColabVersionResult -Executable $Executable }
  )

  if (-not $Candidates) {
    if (-not $env:USERPROFILE) { throw 'USERPROFILE is not set; cannot locate the Colab CLI.' }
    $Candidates = @(
      (Join-Path $env:USERPROFILE '.prometheus\bin\colab.exe'),
      (Join-Path $env:USERPROFILE '.local\bin\colab.exe')
    )
  }

  foreach ($candidate in $Candidates) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try { $version = & $VersionProbe $candidate }
    catch { continue }
    if ($version.ExitCode -eq 0 -and [string]$version.Output -match '(?<!\d)0\.7\.5(?!\d)') {
      return $candidate
    }
  }

  throw 'The pinned google-colab-cli 0.7.5 was not found or failed its version check. Run scripts\colab\setup-colab.ps1.'
}

function New-PrometheusColabProxyOption {
  param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$Session,
    [Parameter(Mandatory)][string]$IdentityFile
  )

  $command = '"{0}" ssh --proxy-mode -s {1} -i "{2}"' -f $Executable, $Session, $IdentityFile
  '"ProxyCommand={0}"' -f $command.Replace('"', '\"')
}
