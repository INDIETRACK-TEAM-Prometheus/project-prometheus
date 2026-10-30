param(
  [string]$OutputDirectory = (Join-Path $env:LOCALAPPDATA 'Prometheus\https')
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion -lt [version]'7.2') {
  throw 'PowerShell 7.2 or newer is required to export PEM files.'
}

$directory = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($directory) | Out-Null
$certPath = Join-Path $directory 'localhost-cert.pem'
$publicCertPath = Join-Path $directory 'localhost-cert.cer'
$keyPath = Join-Path $directory 'localhost-key.pem'
if ((Test-Path $certPath) -or (Test-Path $publicCertPath) -or (Test-Path $keyPath)) {
  throw "Certificate output already exists in $directory; move it aside before generating a replacement."
}

$certificate = $null
$rsa = $null
try {
  $rsa = [System.Security.Cryptography.RSA]::Create(3072)
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddDnsName('localhost')
  $san.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1'))
  [void]$request.CertificateExtensions.Add($san.Build())
  [void]$request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
  $keyUsage = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
  [void]$request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($keyUsage, $true))
  $eku = [System.Security.Cryptography.OidCollection]::new()
  [void]$eku.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
  [void]$request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $true))
  $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(30))
  [System.IO.File]::WriteAllText($certPath, $certificate.ExportCertificatePem(), [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllBytes($publicCertPath, $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
  [System.IO.File]::WriteAllText($keyPath, $rsa.ExportPkcs8PrivateKeyPem(), [System.Text.UTF8Encoding]::new($false))
  Write-Output "Certificate: $certPath"
  Write-Output "Trust import file: $publicCertPath"
  Write-Output "Private key: $keyPath"
} catch {
  Remove-Item -LiteralPath $certPath, $publicCertPath, $keyPath -Force -ErrorAction SilentlyContinue
  throw
} finally {
  if ($certificate) { $certificate.Dispose() }
  if ($rsa) { $rsa.Dispose() }
}
