$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $appDir '.env'
$bundledNode = 'C:\Users\pc\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$systemNode = Get-Command node -ErrorAction SilentlyContinue

$systemNodeMajor = 0
if ($systemNode) {
  try {
    $systemNodeMajor = [int]((& $systemNode.Source --version).TrimStart('v').Split('.')[0])
  } catch {}
}

if ($systemNode -and $systemNodeMajor -ge 22) {
  $nodeExe = $systemNode.Source
} elseif (Test-Path -LiteralPath $bundledNode) {
  $nodeExe = $bundledNode
} else {
  throw 'ไม่พบ Node.js 22+ สำหรับเปิด RWANG Local Assistant'
}

$rwangEnv = @{}
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in Get-Content -LiteralPath $envFile) {
    $value = $line.Trim()
    if (-not $value -or $value.StartsWith('#') -or -not $value.Contains('=')) { continue }
    $name, $content = $value.Split('=', 2)
    $rwangEnv[$name.Trim()] = $content.Trim().Trim('"').Trim("'")
  }
}

$port = if ($rwangEnv.OLLAMA_CENTER_PORT) { [int]$rwangEnv.OLLAMA_CENTER_PORT } else { 4173 }
$nativeTls = [bool]($rwangEnv.RWANG_TLS_PFX_FILE -or ($rwangEnv.RWANG_TLS_CERT_FILE -and $rwangEnv.RWANG_TLS_KEY_FILE))
$localOrigin = if ($nativeTls) { "https://localhost:$port" } else { "http://127.0.0.1:$port" }
$healthUrl = "$localOrigin/api/status"

$isRunning = $false
try {
  $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
  $isRunning = $health.rwang.identity.name -eq 'RWANG'
} catch {}

if (-not $isRunning) {
  $serverFile = Join-Path $appDir 'server.mjs'
  $stdoutFile = Join-Path $appDir 'rwang.stdout.log'
  $stderrFile = Join-Path $appDir 'rwang.stderr.log'
  $nodeArgs = @('--env-file-if-exists=.env', $serverFile)
  Start-Process -FilePath $nodeExe -ArgumentList $nodeArgs -WorkingDirectory $appDir -WindowStyle Hidden -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile

  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    try {
      $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
      $isRunning = $health.rwang.identity.name -eq 'RWANG'
      if ($isRunning) { break }
    } catch {}
  }
}

if (-not $isRunning) {
  throw 'RWANG เริ่มทำงานไม่สำเร็จ กรุณาตรวจ rwang.stderr.log'
}

Start-Process "$localOrigin/"
