[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$ReplaceExisting,
    [string]$NodePath,
    [string]$NodeLicensePath,
    [string]$NodeSha256,
    [string]$NodeArchivePath,
    [string]$NodeArchiveSha256,
    [string]$NodeMetadataPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
# Windows PowerShell launched by a Node child process may have module
# auto-loading disabled. Import the built-in utility module explicitly so the
# SHA-256 verification path is identical in local tests and CI.
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop

# This script has one output location by design. Do not add a general
# destination parameter: a release build must not accidentally copy resources
# into a source checkout, a user profile, or an installer work directory.
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$nodeMetadataDefaultPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "node-runtime.json"))
$stageRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "desktop\stage"))
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $stageRoot "rwang"))

function Normalize-PathString([string]$Path) {
    return ([IO.Path]::GetFullPath($Path)).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Assert-StagingPath([string]$Path, [switch]$AllowStageRoot) {
    $candidate = Normalize-PathString $Path
    $root = Normalize-PathString $stageRoot
    $isRoot = $candidate.Equals($root, [StringComparison]::OrdinalIgnoreCase)
    $isChild = $candidate.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)
    if (-not (($AllowStageRoot -and $isRoot) -or $isChild)) {
        throw "Refusing path outside the exact desktop/stage tree: $candidate"
    }
    return $candidate
}

function Assert-NotReparse([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing reparse point in a release input/output: $Path"
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

function Assert-ExistingDirectory([string]$Path, [string]$Label) {
    $candidate = Normalize-PathString $Path
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
        throw "$Label is missing: $candidate"
    }
    Assert-NotReparse $candidate
    return $candidate
}

function Remove-ExactStagingTree([string]$Path) {
    $candidate = Assert-StagingPath $Path
    if ($candidate.Equals((Normalize-PathString $stageRoot), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove desktop/stage itself"
    }
    if (Test-Path -LiteralPath $candidate) {
        Assert-NotReparse $candidate
        Remove-Item -LiteralPath $candidate -Recurse -Force
    }
}

function Copy-PhysicalTree([string]$Source, [string]$Destination) {
    $sourceRoot = Assert-ExistingDirectory $Source "source directory"
    $destinationRoot = Assert-StagingPath $Destination
    if (-not (Test-Path -LiteralPath $destinationRoot)) {
        New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
    }
    Assert-NotReparse $destinationRoot

    foreach ($item in @(Get-ChildItem -LiteralPath $sourceRoot -Force)) {
        Assert-NotReparse $item.FullName
        $target = Join-Path $destinationRoot $item.Name
        if ($item.PSIsContainer) {
            Copy-PhysicalTree $item.FullName $target
        } else {
            Copy-Item -LiteralPath $item.FullName -Destination $target -Force
            Assert-NotReparse $target
        }
    }
}

function Copy-PhysicalFile([string]$Source, [string]$Destination) {
    $sourceFile = Assert-ExistingFile $Source "source file"
    $destinationFile = Assert-StagingPath $Destination
    $destinationParent = Split-Path -Parent $destinationFile
    if (-not (Test-Path -LiteralPath $destinationParent)) {
        New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    }
    Assert-NotReparse $destinationParent
    Copy-Item -LiteralPath $sourceFile -Destination $destinationFile -Force
    Assert-NotReparse $destinationFile
}

function Remove-PnpmInstallMetadata([string]$NodeModulesRoot) {
    $root = Assert-StagingPath $NodeModulesRoot
    [void](Assert-ExistingDirectory $root "pnpm production tree")

    # These files/directories are install-time metadata or command shims. They
    # are not used by Node module resolution at runtime and may contain the
    # absolute temporary build path. Remove only the exact reviewed entries.
    foreach ($relativePath in @(
            ".modules.yaml",
            ".package-map.json",
            ".pnpm-workspace-state-v1.json"
        )) {
        $candidate = Assert-StagingPath (Join-Path $root $relativePath)
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            Assert-NotReparse $candidate
            Remove-Item -LiteralPath $candidate -Force
        }
    }

    $binDirectory = Assert-StagingPath (Join-Path $root ".bin")
    if (Test-Path -LiteralPath $binDirectory -PathType Container) {
        Remove-ExactStagingTree $binDirectory
    }

    $pnpmDirectory = Assert-StagingPath (Join-Path $root ".pnpm")
    $pnpmLock = Assert-StagingPath (Join-Path $pnpmDirectory "lock.yaml")
    if (Test-Path -LiteralPath $pnpmLock -PathType Leaf) {
        Assert-NotReparse $pnpmLock
        Remove-Item -LiteralPath $pnpmLock -Force
    }
    if (Test-Path -LiteralPath $pnpmDirectory -PathType Container) {
        Assert-NotReparse $pnpmDirectory
        if (@(Get-ChildItem -LiteralPath $pnpmDirectory -Force).Count -eq 0) {
            Remove-ExactStagingTree $pnpmDirectory
        }
    }
}

function Resolve-OptionalInputPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $null
    }
    if ([IO.Path]::IsPathRooted($Value)) {
        return Normalize-PathString $Value
    }
    return Normalize-PathString (Join-Path $repoRoot $Value)
}

function Resolve-NodeExecutable {
    $explicit = Resolve-OptionalInputPath $NodePath
    $candidates = [Collections.Generic.List[string]]::new()
    if ($explicit) {
        $candidates.Add($explicit)
    } else {
        $bundled = Join-Path $repoRoot "desktop\runtime\node\node.exe"
        if (Test-Path -LiteralPath $bundled -PathType Leaf) {
            $candidates.Add($bundled)
        }
        $command = Get-Command node -ErrorAction SilentlyContinue
        if ($command -and $command.Source) {
            $candidates.Add([string]$command.Source)
        }
        if ($env:ProgramFiles) {
            $candidates.Add((Join-Path $env:ProgramFiles "nodejs\node.exe"))
        }
        if ($env:LOCALAPPDATA) {
            $candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe"))
        }
    }

    foreach ($candidate in $candidates) {
        if (-not $candidate) { continue }
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $resolved = Assert-ExistingFile $candidate "Node executable"
        if ([IO.Path]::GetExtension($resolved).ToLowerInvariant() -ne ".exe") {
            throw "Node runtime must be a Windows .exe: $resolved"
        }
        return $resolved
    }
    throw "Official/current Windows node.exe was not found; pass -NodePath or stage desktop/runtime/node/node.exe"
}

function Resolve-NodeLicense([string]$NodeExecutable) {
    $explicit = Resolve-OptionalInputPath $NodeLicensePath
    if ($explicit) {
        return Assert-ExistingFile $explicit "Node LICENSE"
    }

    $nodeDirectory = Split-Path -Parent $NodeExecutable
    $parentDirectory = Split-Path -Parent $nodeDirectory
    $candidates = @(
        (Join-Path $nodeDirectory "LICENSE"),
        (Join-Path $nodeDirectory "LICENSE.txt"),
        (Join-Path $parentDirectory "LICENSE"),
        (Join-Path $parentDirectory "LICENSE.txt"),
        (Join-Path $repoRoot "desktop\runtime\node\LICENSE"),
        (Join-Path $repoRoot "desktop\runtime\node\LICENSE.txt")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return Assert-ExistingFile $candidate "Node LICENSE"
        }
    }
    throw "Node LICENSE was not found beside the selected official runtime; pass -NodeLicensePath"
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

function Read-NodeMetadata {
    $explicit = Resolve-OptionalInputPath $NodeMetadataPath
    # A dry-run may validate an explicitly supplied executable/hash (the
    # package contract uses the installed Node executable as its fixture).
    # Real staging always requires the checked-in pinned specification below.
    if ($DryRun -and $NodeSha256 -and -not $explicit) {
        return $null
    }
    $candidate = if ($explicit) { $explicit } else { $nodeMetadataDefaultPath }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        if ($DryRun -and $NodeSha256) {
            return $null
        }
        throw "Pinned Node runtime metadata is missing: $candidate"
    }
    $metadataFile = Assert-ExistingFile $candidate "Node runtime metadata"
    $metadata = Get-Content -LiteralPath $metadataFile -Raw | ConvertFrom-Json
    foreach ($property in @("version", "platform", "archive", "url", "shasumsUrl", "archiveSha256", "nodeSha256", "license")) {
        if (-not $metadata.$property) {
            throw "Node runtime metadata is missing '$property': $metadataFile"
        }
    }
    if ([string]$metadata.platform -ne "win-x64" -or [string]$metadata.version -notmatch '^v24\.\d+\.\d+$') {
        throw "Node runtime metadata must describe an exact official Node 24 win-x64 archive"
    }
    if ([string]$metadata.url -notmatch '^https://nodejs\.org/dist/[^/]+/node-v24\.\d+\.\d+-win-x64\.zip$') {
        throw "Node runtime metadata URL must point to nodejs.org"
    }
    if ([string]$metadata.shasumsUrl -notmatch '^https://nodejs\.org/dist/[^/]+/SHASUMS256\.txt$') {
        throw "Node runtime metadata SHASUMS URL must point to nodejs.org"
    }
    if ([string]$metadata.license -ne "LICENSE") {
        throw "Node runtime metadata must acquire the official LICENSE file"
    }
    if ([string]$metadata.archiveSha256 -notmatch '^[0-9a-fA-F]{64}$' -or [string]$metadata.nodeSha256 -notmatch '^[0-9a-fA-F]{64}$') {
        throw "Node runtime metadata contains an invalid SHA-256 value"
    }
    return $metadata
}

function Assert-NodeArchive([string]$Path, [string]$Expected) {
    if ([string]::IsNullOrWhiteSpace($Path) -xor [string]::IsNullOrWhiteSpace($Expected)) {
        throw "-NodeArchivePath and -NodeArchiveSha256 must be provided together"
    }
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }
    $archive = Resolve-OptionalInputPath $Path
    $archive = Assert-ExistingFile $archive "Node archive"
    return [ordered]@{
        path = $archive
        sha256 = Assert-Sha256 $archive $Expected "Node archive"
    }
}

function Assert-NodeProvenance([string]$NodeExecutable, $Metadata) {
    $expected = $NodeSha256
    if ([string]::IsNullOrWhiteSpace($expected) -and $Metadata) {
        $expected = [string]$Metadata.nodeSha256
    }
    if ([string]::IsNullOrWhiteSpace($expected)) {
        throw "Node executable verification requires -NodeSha256 or pinned scripts/node-runtime.json"
    }
    $nodeHash = Assert-Sha256 $NodeExecutable $expected "Node executable"
    if ($Metadata -and $nodeHash -ne ([string]$Metadata.nodeSha256).ToLowerInvariant()) {
        throw "Selected Node executable does not match the pinned nodeSha256 in the runtime metadata"
    }
    return $nodeHash
}

function Get-NodeVersion([string]$NodeExecutable) {
    $output = (& $NodeExecutable --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $output -notmatch '^v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)') {
        throw "Unable to validate the selected Node runtime version"
    }
    $major = [int]$Matches.major
    if ($major -ne 24) {
        throw "Node 24 is required for the reproducible desktop runtime; selected runtime is $output"
    }
    return $output
}

function Get-RuntimeManifestFiles([string]$Root) {
    $rootPath = Normalize-PathString $Root
    $files = @(Get-ChildItem -LiteralPath $rootPath -File -Force -Recurse | Sort-Object FullName)
    $manifest = [Collections.Generic.List[object]]::new()
    foreach ($file in $files) {
        Assert-NotReparse $file.FullName
        # Use a prefix slice instead of Path.GetRelativePath so the script also
        # runs under inbox Windows PowerShell 5.1 (.NET Framework).
        $relative = $file.FullName.Substring(($rootPath + [IO.Path]::DirectorySeparatorChar).Length).Replace("\", "/")
        if ($relative -eq "runtime-manifest.json") { continue }
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $manifest.Add([ordered]@{
                path = $relative
                bytes = [int64]$file.Length
                sha256 = $hash
            })
    }
    return @($manifest)
}

function Assert-RequiredRuntime([string]$Root) {
    $requiredFiles = @(
        "entrypoint.mjs",
        "server.mjs",
        "rwang.mjs",
        "remote.mjs",
        "spotlight.mjs",
        "document-intelligence.mjs",
        "package.json",
        "runtime/node/node.exe",
        "runtime/node/LICENSE",
        "runtime/node/node-runtime.json",
        "public/index.html",
        "public/app.js",
        "public/perception.js",
        "public/remote-client.js",
        "public/service-worker.js",
        "public/vendor/tasks-vision.mjs",
        "capabilities/rwang-document-intelligence/SOURCE.json"
    )
    foreach ($relative in $requiredFiles) {
        $candidate = Join-Path $Root ($relative -replace "/", "\")
        [void](Assert-ExistingFile $candidate "required staged file")
    }
    [void](Assert-ExistingDirectory (Join-Path $Root "public") "staged public directory")
    [void](Assert-ExistingDirectory (Join-Path $Root "node_modules") "staged production dependency tree")
    [void](Assert-ExistingDirectory (Join-Path $Root "capabilities") "staged capabilities directory")

    foreach ($forbiddenMetadata in @(
            "node_modules/.bin",
            "node_modules/.modules.yaml",
            "node_modules/.package-map.json",
            "node_modules/.pnpm-workspace-state-v1.json",
            "node_modules/.pnpm/lock.yaml"
        )) {
        if (Test-Path -LiteralPath (Join-Path $Root ($forbiddenMetadata -replace "/", "\"))) {
            throw "Staged runtime contains pnpm install-only metadata: $forbiddenMetadata"
        }
    }

    $reparse = @(Get-ChildItem -LiteralPath $Root -Force -Recurse | Where-Object {
            ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
        })
    if ($reparse.Count -gt 0) {
        throw "Staged runtime contains $($reparse.Count) reparse point(s); refusing external pnpm junctions"
    }
}

function Write-RuntimeManifest([string]$Root, [string]$NodeVersion, [string]$PackageVersion, [string]$NodeSha256, $NodeArchive) {
    $entries = Get-RuntimeManifestFiles $Root
    $payload = [ordered]@{
        schema = 1
        product = "RWANG"
        packageVersion = $PackageVersion
        nodeVersion = $NodeVersion
        nodeSha256 = $NodeSha256
        nodeArchiveSha256 = if ($NodeArchive) { [string]$NodeArchive.sha256 } else { $null }
        dependencyMode = "pnpm-prod-hoisted-materialized"
        files = $entries
    }
    $json = $payload | ConvertTo-Json -Depth 8
    $manifestPath = Join-Path $Root "runtime-manifest.json"
    [IO.File]::WriteAllText($manifestPath, $json, [Text.UTF8Encoding]::new($false))
    Assert-NotReparse $manifestPath
    return $manifestPath
}

function Read-PackageMetadata {
    $packagePath = Assert-ExistingFile (Join-Path $repoRoot "package.json") "package manifest"
    $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    if (-not $package.name -or -not $package.version -or -not $package.dependencies) {
        throw "package.json must define name, version, and dependencies"
    }
    return $package
}

function Write-RuntimePackage([string]$Root, $SourcePackage) {
    # Keep only fields Node needs at runtime. In particular, do not ship the
    # Tauri CLI or other devDependencies in the sidecar resource tree.
    $runtimePackage = [ordered]@{
        name = [string]$SourcePackage.name
        version = [string]$SourcePackage.version
        private = $true
        type = if ($SourcePackage.type) { [string]$SourcePackage.type } else { "module" }
        engines = $SourcePackage.engines
        dependencies = $SourcePackage.dependencies
    }
    $packagePath = Join-Path $Root "package.json"
    $json = $runtimePackage | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($packagePath, $json, [Text.UTF8Encoding]::new($false))
    Assert-NotReparse $packagePath
}

try {
    $sourcePackage = Read-PackageMetadata
    $nodeExecutable = Resolve-NodeExecutable
    $nodeLicense = Resolve-NodeLicense $nodeExecutable
    $nodeMetadata = Read-NodeMetadata
    $nodeArchive = Assert-NodeArchive $NodeArchivePath $NodeArchiveSha256
    if (-not $nodeArchive -and $nodeMetadata) {
        # The acquisition helper already verified the official archive before
        # placing node.exe beside this specification. Preserve that pinned
        # archive digest in the staged provenance manifest.
        $nodeArchive = [ordered]@{ sha256 = [string]$nodeMetadata.archiveSha256 }
    }
    $nodeSha256Actual = Assert-NodeProvenance $nodeExecutable $nodeMetadata
    $nodeVersion = Get-NodeVersion $nodeExecutable
    $nodeMetadataFile = Resolve-OptionalInputPath $NodeMetadataPath
    if (-not $nodeMetadataFile) {
        $nodeMetadataFile = $nodeMetadataDefaultPath
    }

    $sourceFiles = [ordered]@{
        "desktop/runtime/entrypoint.mjs" = "entrypoint.mjs"
        "server.mjs" = "server.mjs"
        "rwang.mjs" = "rwang.mjs"
        "remote.mjs" = "remote.mjs"
        "spotlight.mjs" = "spotlight.mjs"
        "document-intelligence.mjs" = "document-intelligence.mjs"
    }
    $sourceDirectories = [ordered]@{
        "public" = "public"
        "capabilities" = "capabilities"
    }

    Write-Host "RWANG desktop runtime plan"
    Write-Host "  output: desktop/stage/rwang"
    Write-Host "  node: $nodeVersion"
    Write-Host "  node SHA-256: $nodeSha256Actual"
    if ($nodeArchive) {
        Write-Host "  archive SHA-256: $($nodeArchive.sha256)"
    }
    Write-Host "  dependencies: pnpm --config.enable-global-virtual-store=false install --prod --frozen-lockfile --ignore-scripts --node-linker=hoisted"
    Write-Host "  materialize: reparse points/junctions rejected"
    Write-Host "  replace existing: $ReplaceExisting"

    if ($DryRun) {
        foreach ($source in $sourceFiles.Keys) {
            [void](Assert-ExistingFile (Join-Path $repoRoot ($source -replace "/", "\")) "backend source")
        }
        foreach ($source in $sourceDirectories.Keys) {
            [void](Assert-ExistingDirectory (Join-Path $repoRoot ($source -replace "/", "\")) "resource source")
        }
        Write-Host "DRY RUN: no files were written under desktop/stage"
        exit 0
    }

    if (-not (Test-Path -LiteralPath $stageRoot)) {
        New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
    }
    Assert-NotReparse $stageRoot
    $workRoot = Assert-StagingPath (Join-Path $stageRoot (".rwang-build-" + [guid]::NewGuid().ToString("N")))
    New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
    Assert-NotReparse $workRoot

    try {
        foreach ($source in $sourceFiles.Keys) {
            $input = Join-Path $repoRoot ($source -replace "/", "\")
            $output = Join-Path $workRoot $sourceFiles[$source]
            Copy-PhysicalFile $input $output
        }
        foreach ($source in $sourceDirectories.Keys) {
            $input = Join-Path $repoRoot ($source -replace "/", "\")
            $output = Join-Path $workRoot $sourceDirectories[$source]
            Copy-PhysicalTree $input $output
        }
        Copy-PhysicalFile $nodeExecutable (Join-Path $workRoot "runtime/node/node.exe")
        Copy-PhysicalFile $nodeLicense (Join-Path $workRoot "runtime/node/LICENSE")
        Copy-PhysicalFile $nodeMetadataFile (Join-Path $workRoot "runtime/node/node-runtime.json")

        # Install from the lockfile in an isolated directory using pnpm's
        # hoisted linker, then reject any junction/symlink before copying the
        # resulting production tree into the release work tree.
        $dependencyWorkspace = Join-Path $workRoot ".dependency-install"
        New-Item -ItemType Directory -Path $dependencyWorkspace -Force | Out-Null
        Copy-PhysicalFile (Join-Path $repoRoot "package.json") (Join-Path $dependencyWorkspace "package.json")
        Copy-PhysicalFile (Join-Path $repoRoot "pnpm-lock.yaml") (Join-Path $dependencyWorkspace "pnpm-lock.yaml")
        & pnpm --config.enable-global-virtual-store=false install --prod --frozen-lockfile --ignore-scripts --node-linker=hoisted --dir $dependencyWorkspace
        if ($LASTEXITCODE -ne 0) {
            throw "pnpm production install failed with exit code $LASTEXITCODE"
        }
        [void](Assert-ExistingDirectory (Join-Path $dependencyWorkspace "node_modules") "pnpm production tree")
        $pnpmReparse = @(Get-ChildItem -LiteralPath (Join-Path $dependencyWorkspace "node_modules") -Force -Recurse | Where-Object {
                ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
            })
        if ($pnpmReparse.Count -gt 0) {
            throw "pnpm production tree contains $($pnpmReparse.Count) reparse point(s); refusing external junctions"
        }
        Remove-PnpmInstallMetadata (Join-Path $dependencyWorkspace "node_modules")
        Copy-PhysicalTree (Join-Path $dependencyWorkspace "node_modules") (Join-Path $workRoot "node_modules")
        Remove-ExactStagingTree $dependencyWorkspace
        Write-RuntimePackage $workRoot $sourcePackage

        Assert-RequiredRuntime $workRoot
        [void](Write-RuntimeManifest $workRoot $nodeVersion ([string]$sourcePackage.version) $nodeSha256Actual $nodeArchive)
        Assert-RequiredRuntime $workRoot

        if (Test-Path -LiteralPath $runtimeRoot) {
            if (-not $ReplaceExisting) {
                throw "desktop/stage/rwang already exists; pass -ReplaceExisting to replace that exact tree"
            }
            Remove-ExactStagingTree $runtimeRoot
        }
        Move-Item -LiteralPath $workRoot -Destination $runtimeRoot
        Write-Host "Staged Desktop Alpha runtime at desktop/stage/rwang"
    } catch {
        if (Test-Path -LiteralPath $workRoot) {
            Remove-ExactStagingTree $workRoot
        }
        throw
    }
} catch {
    Write-Error $_
    exit 1
}
