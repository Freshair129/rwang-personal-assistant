param(
  [int]$Port = 4173,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$certDir = Join-Path $appDir 'certs'
$pfxFile = Join-Path $certDir 'rwang-server.pfx'
$caFile = Join-Path $certDir 'rwang-local-ca.cer'
$envFile = Join-Path $appDir '.env'
$thumbprintFile = Join-Path $certDir 'rwang-certificate-thumbprints.txt'

if ((Test-Path -LiteralPath $pfxFile) -and -not $Force) {
  throw 'พบใบรับรองเดิมแล้ว ใช้ -Force เฉพาะเมื่อต้องการออก CA และ certificate ชุดใหม่'
}

New-Item -ItemType Directory -Path $certDir -Force | Out-Null

function Remove-RecordedCertificate {
  param(
    [string]$Store,
    [string]$Thumbprint,
    [string]$ExpectedSubject
  )
  if ($Thumbprint -notmatch '^[A-Fa-f0-9]{40,64}$') { return }
  $certificatePath = "Cert:\CurrentUser\$Store\$($Thumbprint.ToUpperInvariant())"
  $certificate = Get-Item -LiteralPath $certificatePath -ErrorAction SilentlyContinue
  if ($certificate -and $certificate.Subject -eq $ExpectedSubject) {
    Remove-Item -LiteralPath $certificatePath -Force
  }
}

if ($Force -and (Test-Path -LiteralPath $thumbprintFile)) {
  $recorded = @{}
  foreach ($line in Get-Content -LiteralPath $thumbprintFile) {
    if ($line -match '^(ROOT|SERVER)=([A-Fa-f0-9]{40,64})$') {
      $recorded[$Matches[1]] = $Matches[2]
    }
  }
  Remove-RecordedCertificate -Store 'Root' -Thumbprint $recorded.ROOT -ExpectedSubject 'CN=RWANG Local CA'
  Remove-RecordedCertificate -Store 'My' -Thumbprint $recorded.ROOT -ExpectedSubject 'CN=RWANG Local CA'
  Remove-RecordedCertificate -Store 'My' -Thumbprint $recorded.SERVER -ExpectedSubject 'CN=RWANG Local Assistant'
}

$addresses = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
  Where-Object { $_.OperationalStatus -eq 'Up' } |
  ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
  ForEach-Object { $_.Address } |
  Where-Object {
    $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
    -not [System.Net.IPAddress]::IsLoopback($_) -and
    -not $_.ToString().StartsWith('169.254.')
  } |
  ForEach-Object { $_.ToString() } |
  Sort-Object -Unique

if (-not $addresses) {
  throw 'ไม่พบ IPv4 ของ LAN กรุณาเชื่อม Wi-Fi/LAN แล้วลองใหม่'
}

$primaryAddress = $addresses[0]
$dnsNames = @('localhost', $env:COMPUTERNAME, "$($env:COMPUTERNAME).local") |
  Where-Object { $_ } |
  Sort-Object -Unique
$sanParts = @($dnsNames | ForEach-Object { "DNS=$_" })
$sanParts += 'IPAddress=127.0.0.1'
$sanParts += $addresses | ForEach-Object { "IPAddress=$_" }
$sanExtension = '2.5.29.17={text}' + ($sanParts -join '&')

$root = $null
$serverCertificate = $null
try {
  $root = New-SelfSignedCertificate `
    -Type Custom `
    -Subject 'CN=RWANG Local CA' `
    -FriendlyName 'RWANG Local CA' `
    -KeyAlgorithm RSA `
    -KeyLength 4096 `
    -HashAlgorithm SHA256 `
    -KeyUsage CertSign, CRLSign, DigitalSignature `
    -KeyUsageProperty Sign `
    -KeyExportPolicy NonExportable `
    -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0') `
    -NotAfter (Get-Date).AddYears(5) `
    -CertStoreLocation 'Cert:\CurrentUser\My'

  $serverCertificate = New-SelfSignedCertificate `
    -Type Custom `
    -Subject 'CN=RWANG Local Assistant' `
    -FriendlyName 'RWANG Local HTTPS' `
    -Signer $root `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyUsage DigitalSignature, KeyEncipherment `
    -KeyUsageProperty All `
    -KeyExportPolicy Exportable `
    -TextExtension @(
      $sanExtension,
      '2.5.29.19={critical}{text}ca=0',
      '2.5.29.37={text}1.3.6.1.5.5.7.3.1'
    ) `
    -NotAfter (Get-Date).AddYears(2) `
    -CertStoreLocation 'Cert:\CurrentUser\My'

  $passwordBytes = New-Object byte[] 32
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($passwordBytes) } finally { $random.Dispose() }
  $passwordText = [Convert]::ToBase64String($passwordBytes)
  $password = ConvertTo-SecureString -String $passwordText -AsPlainText -Force
  Export-PfxCertificate -Cert $serverCertificate -FilePath $pfxFile -Password $password -Force | Out-Null
  Export-Certificate -Cert $root -FilePath $caFile -Force | Out-Null
  Import-Certificate -FilePath $caFile -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
} finally {
  if ($serverCertificate) {
    Remove-RecordedCertificate -Store 'My' -Thumbprint $serverCertificate.Thumbprint -ExpectedSubject 'CN=RWANG Local Assistant'
  }
  if ($root) {
    Remove-RecordedCertificate -Store 'My' -Thumbprint $root.Thumbprint -ExpectedSubject 'CN=RWANG Local CA'
  }
}

@(
  "ROOT=$($root.Thumbprint)"
  "SERVER=$($serverCertificate.Thumbprint)"
) | Set-Content -LiteralPath $thumbprintFile -Encoding UTF8

function Set-EnvValue {
  param([string]$Name, [string]$Value)
  $lines = if (Test-Path -LiteralPath $envFile) { @(Get-Content -LiteralPath $envFile) } else { @() }
  $pattern = '^\s*' + [Regex]::Escape($Name) + '\s*='
  $replaced = $false
  $updated = foreach ($line in $lines) {
    if ($line -match $pattern) {
      if (-not $replaced) { "$Name=$Value" }
      $replaced = $true
    } else {
      $line
    }
  }
  if (-not $replaced) { $updated += "$Name=$Value" }
  $updated | Set-Content -LiteralPath $envFile -Encoding UTF8
}

Set-EnvValue -Name 'OLLAMA_CENTER_PORT' -Value ([string]$Port)
Set-EnvValue -Name 'RWANG_HOST' -Value '0.0.0.0'
Set-EnvValue -Name 'RWANG_ALLOW_INSECURE_LAN' -Value '0'
Set-EnvValue -Name 'RWANG_TLS_CERT_FILE' -Value ''
Set-EnvValue -Name 'RWANG_TLS_KEY_FILE' -Value ''
Set-EnvValue -Name 'RWANG_TLS_PFX_FILE' -Value 'certs/rwang-server.pfx'
Set-EnvValue -Name 'RWANG_TLS_PASSPHRASE' -Value $passwordText
Set-EnvValue -Name 'RWANG_PUBLIC_ORIGIN' -Value "https://$primaryAddress`:$Port"
Set-EnvValue -Name 'RWANG_ALLOWED_HOSTS' -Value (($dnsNames | ForEach-Object { "$_`:$Port" }) -join ',')

Write-Host ''
Write-Host 'RWANG HTTPS พร้อมใช้งานบน Windows แล้ว' -ForegroundColor Green
Write-Host "Mobile URL: https://$primaryAddress`:$Port"
Write-Host "Mobile CA file: $caFile" -ForegroundColor Yellow
Write-Host 'ติดตั้งเฉพาะ rwang-local-ca.cer บนมือถือ แล้วเปิด Full Trust ตามระบบของมือถือ'
Write-Host 'ห้ามคัดลอก rwang-server.pfx หรือค่า RWANG_TLS_PASSPHRASE ไปยังมือถือ'
Write-Host 'ปิด RWANG instance เดิม แล้วเปิด Start RWANG.cmd ใหม่เพื่อใช้ HTTPS'
