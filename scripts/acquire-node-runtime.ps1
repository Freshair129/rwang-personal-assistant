[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$ReplaceExisting,
    [string]$ArchivePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# Keep hashing deterministic when the script is launched from Node with
# Windows PowerShell's module auto-loading disabled.
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop

# The runtime destination is intentionally fixed.  Keeping acquisition and
# staging under known repository paths prevents a release job from writing a
# downloaded executable into an arbitrary profile or workspace directory.
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$specPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "node-runtime.json"))
$runtimeParent = [IO.Path]::GetFullPath((Join-Path $repoRoot "desktop\runtime"))
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $runtimeParent "node"))

function Normalize-PathString([string]$Path) {
    return ([IO.Path]::GetFullPath($Path)).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Assert-NotReparse([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing reparse point in runtime acquisition path: $Path"
    }
}

function Assert-ExistingFile([string]$Path, [string]$Label) {
    $candidate = Normalize-PathString $Path
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "$Label is missing: $candidate"
    }
    Assert-NotReparse $candidate
    return $candidate
}

function Assert-ChildOfRuntimeParent([string]$Path) {
    $candidate = Normalize-PathString $Path
    $parent = Normalize-PathString $runtimeParent
    if (-not $candidate.StartsWith("$parent\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing temporary acquisition path outside desktop/runtime: $candidate"
    }
    return $candidate
}

function Resolve-InputPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $null
    }
    if ([IO.Path]::IsPathRooted($Value)) {
        return Normalize-PathString $Value
    }
    return Normalize-PathString (Join-Path $repoRoot $Value)
}

function Assert-Sha256([string]$Path, [string]$Expected, [string]$Label) {
    if ($Expected -notmatch '^[0-9a-fA-F]{64}$') {
        throw "$Label expected SHA-256 is not a 64-character hexadecimal value"
    }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected.ToLowerInvariant()) {
        throw "$Label SHA-256 mismatch: expected $($Expected.ToLowerInvariant()), got $actual"
    }
    return $actual
}

try {
    $spec = Get-Content -LiteralPath $specPath -Raw | ConvertFrom-Json
    foreach ($property in @("version", "platform", "archive", "url", "shasumsUrl", "archiveSha256", "nodeSha256", "license")) {
        if (-not $spec.$property) {
            throw "Node runtime specification is missing '$property': $specPath"
        }
    }
    if ([string]$spec.platform -ne "win-x64") {
        throw "This Windows desktop slice requires the win-x64 Node runtime"
    }
    if ([string]$spec.version -notmatch '^v24\.\d+\.\d+$') {
        throw "Node runtime specification must pin an exact Node 24 release"
    }
    if ([string]$spec.url -notmatch '^https://nodejs\.org/dist/[^/]+/node-v24\.\d+\.\d+-win-x64\.zip$') {
        throw "Node runtime URL must point to the official nodejs.org win-x64 archive"
    }
    if ([string]$spec.shasumsUrl -notmatch '^https://nodejs\.org/dist/[^/]+/SHASUMS256\.txt$') {
        throw "Node runtime SHASUMS URL must point to nodejs.org"
    }
    if ([string]$spec.archiveSha256 -notmatch '^[0-9a-fA-F]{64}$' -or [string]$spec.nodeSha256 -notmatch '^[0-9a-fA-F]{64}$') {
        throw "Node runtime specification contains an invalid SHA-256 value"
    }

    $archive = Resolve-InputPath $ArchivePath
    $downloadedArchive = $false
    $runId = [guid]::NewGuid().ToString("N")
    $extractRoot = Assert-ChildOfRuntimeParent (Join-Path $runtimeParent (".node-extract-" + $runId))
    $downloadRoot = Assert-ChildOfRuntimeParent (Join-Path $runtimeParent (".node-download-" + $runId))
    $downloadedPath = Join-Path $downloadRoot ([string]$spec.archive)

    Write-Host "RWANG official Node runtime acquisition plan"
    Write-Host "  version: $($spec.version)"
    Write-Host "  archive: $($spec.archive)"
    Write-Host "  destination: desktop/runtime/node"
    Write-Host "  archive SHA-256: $($spec.archiveSha256)"
    Write-Host "  node.exe SHA-256: $($spec.nodeSha256)"

    if ($DryRun) {
        if ($archive) {
            $archive = Assert-ExistingFile $archive "Node archive"
            [void](Assert-Sha256 -Path $archive -Expected ([string]$spec.archiveSha256) -Label "Node archive")
            Write-Host "DRY RUN: supplied archive matches the pinned official SHA-256"
        } else {
            Write-Host "DRY RUN: no download or runtime files were written"
        }
        exit 0
    }

    if (-not (Test-Path -LiteralPath $runtimeParent -PathType Container)) {
        New-Item -ItemType Directory -Path $runtimeParent -Force | Out-Null
    }
    Assert-NotReparse $runtimeParent

    try {
        if (-not $archive) {
            New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
            Assert-NotReparse $downloadRoot
            Write-Host "Downloading official Node archive from $($spec.url)"
            Invoke-WebRequest -UseBasicParsing -Uri ([string]$spec.url) -OutFile $downloadedPath
            $archive = $downloadedPath
            $downloadedArchive = $true
        }

        $archive = Assert-ExistingFile $archive "Node archive"
        [void](Assert-Sha256 -Path $archive -Expected ([string]$spec.archiveSha256) -Label "Node archive")

        New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
        Assert-NotReparse $extractRoot
        Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot -Force

        $archiveDirectory = Join-Path $extractRoot ([IO.Path]::GetFileNameWithoutExtension([string]$spec.archive))
        $extractedNode = Assert-ExistingFile (Join-Path $archiveDirectory "node.exe") "extracted Node executable"
        $extractedLicense = Assert-ExistingFile (Join-Path $archiveDirectory ([string]$spec.license)) "extracted Node LICENSE"
        [void](Assert-Sha256 -Path $extractedNode -Expected ([string]$spec.nodeSha256) -Label "Node executable")

        $versionOutput = (& $extractedNode --version 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $versionOutput -ne ([string]$spec.version)) {
            throw "Extracted Node version mismatch: expected $($spec.version), got $versionOutput"
        }

        if (-not (Test-Path -LiteralPath $runtimeRoot -PathType Container)) {
            New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
        }
        Assert-NotReparse $runtimeRoot
        $destinationNode = Join-Path $runtimeRoot "node.exe"
        if ((Test-Path -LiteralPath $destinationNode -PathType Leaf) -and -not $ReplaceExisting) {
            throw "desktop/runtime/node/node.exe already exists; pass -ReplaceExisting to replace that exact file"
        }
        Copy-Item -LiteralPath $extractedNode -Destination $destinationNode -Force
        Copy-Item -LiteralPath $extractedLicense -Destination (Join-Path $runtimeRoot "LICENSE") -Force
        Assert-NotReparse $destinationNode
        Assert-NotReparse (Join-Path $runtimeRoot "LICENSE")
        Write-Host "Acquired and verified official Node runtime at desktop/runtime/node"
    } finally {
        if (Test-Path -LiteralPath $extractRoot) {
            Assert-ChildOfRuntimeParent $extractRoot | ForEach-Object { Remove-Item -LiteralPath $_ -Recurse -Force }
        }
        if ($downloadedArchive -and (Test-Path -LiteralPath $downloadRoot)) {
            Assert-ChildOfRuntimeParent $downloadRoot | ForEach-Object { Remove-Item -LiteralPath $_ -Recurse -Force }
        }
    }
} catch {
    Write-Error $_
    exit 1
}
