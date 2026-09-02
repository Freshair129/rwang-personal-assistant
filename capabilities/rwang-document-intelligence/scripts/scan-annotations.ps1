<#
.SYNOPSIS
    RWANG Annotation Scanner - scans source files for @req, @spec, @designs, @tested annotations,
    plain requirement ID references (FR-xxx, NFR-xxx, SDD-xxx, etc.), Mermaid diagram
    annotations (%% @req / %% @spec / %% @diagram_type in .mmd files), and test-spec
    frontmatter (req/spec/test_type in .test.md files).

.DESCRIPTION
    Produces a JSON report of all doc-code links found in the project.
    Used by rwang:doc-graph to build the document graph (edge assertions flow
    through the Hybrid IR and are validated against the Entity Registry and
    Edge Contracts — this scanner only DISCOVERS claims, it never decides
    membership; see CR-2026-08-20-01 A2).

.PARAMETER Path
    Root directory to scan (default: current directory)

.PARAMETER Format
    Output format: "json" or "table" (default: json)

.PARAMETER IncludeUnstructured
    Also scan for plain requirement references like "# FR-001" (default: true)

.EXAMPLE
    .\scan-annotations.ps1 -Path "D:\GPIC" -Format table
#>

param(
    [string]$Path = ".",
    [string]$Format = "json",
    [bool]$IncludeUnstructured = $true
)

$ErrorActionPreference = "Stop"

# File extensions to scan
$Extensions = @("*.ts", "*.tsx", "*.js", "*.jsx", "*.py", "*.go", "*.java", "*.rs", "*.cs", "*.ps1")

# Directories to skip
$SkipDirs = @("node_modules", "__pycache__", ".venv", "venv", ".git", "dist", "build", ".next", "coverage")

# Structured annotations are source comments, never prose/string literals.
# Requirement/spec annotations carry registered requirement IDs; design can
# carry a section reference or requirement ID; test annotations carry a test
# file reference with an optional test selector.
$CommentPrefix = '^\s*(?:#|//|--|\*+)\s*'
# Flat IDs (FR-001) plus 5-driven namespaced IDs (FR-a01001, FEAT-a01)
$RequirementId = '(?:FR-[a-z]\d{5}|FEAT-[a-z]\d{2}|(?:FR|NFR|SDD|SEC|AI-AGT|AI-ETH|BR|AC|DR|IR)-\d{3})'
$TestReference = '[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|ps1)(?:::[A-Za-z0-9_\-]+)?'
$UnstructuredPattern = "$CommentPrefix(?<ids>$RequirementId(?:\s*,\s*$RequirementId)*)\s*$"

# Annotation patterns
$AnnotationPatterns = @{
    "req"     = "$CommentPrefix@req\s+(?<value>$RequirementId(?:\s*,\s*$RequirementId)*)(?:\s+.*)?$"
    "spec"    = "$CommentPrefix@spec\s+(?<value>$RequirementId(?:\s*,\s*$RequirementId)*)(?:\s+.*)?$"
    "designs" = "$CommentPrefix@designs\s+(?<value>(?:§\s*\d+(?:\.\d+)*|$RequirementId))(?:\s+.*)?$"
    "tested"  = "$CommentPrefix@tested\s+(?<value>$TestReference)(?:\s+.*)?$"
}

# Unstructured requirement ID pattern
$ReqIdPattern = "(?<![A-Za-z0-9_-])$RequirementId(?![A-Za-z0-9_-])"

function Get-FilesByFilter {
    param([string]$RootPath, [string[]]$Filters)

    $files = @()
    foreach ($ext in $Filters) {
        $found = Get-ChildItem -Path $RootPath -Filter $ext -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object {
                $skip = $false
                foreach ($dir in $SkipDirs) {
                    if ($_.FullName -match [regex]::Escape($dir)) {
                        $skip = $true
                        break
                    }
                }
                -not $skip
            }
        $files += $found
    }
    return $files
}

function Get-SourceFiles {
    param([string]$RootPath)

    $files = @()
    foreach ($ext in $Extensions) {
        $found = Get-ChildItem -Path $RootPath -Filter $ext -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object {
                $skip = $false
                foreach ($dir in $SkipDirs) {
                    if ($_.FullName -match [regex]::Escape($dir)) {
                        $skip = $true
                        break
                    }
                }
                -not $skip
            }
        $files += $found
    }
    return $files
}

function Scan-File {
    param(
        [System.IO.FileInfo]$File,
        [string]$RootPath
    )

    $relativePath = $File.FullName.Substring($RootPath.Length).TrimStart('\', '/')
    $relativePath = $relativePath -replace '\\', '/'
    $lines = Get-Content $File.FullName -ErrorAction SilentlyContinue

    $annotations = @()
    $lineNum = 0

    foreach ($line in $lines) {
        $lineNum++

        # Check structured annotations
        foreach ($key in $AnnotationPatterns.Keys) {
            if ($line -match $AnnotationPatterns[$key]) {
                $value = $Matches["value"].Trim()
                $ids = ($value -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }

                $annotations += @{
                    file       = $relativePath
                    line       = $lineNum
                    type       = "structured"
                    annotation = "@$key"
                    ids        = $ids
                    raw        = $line.Trim()
                }
            }
        }

        # Check unstructured requirement references
        if ($IncludeUnstructured -and $line -match $UnstructuredPattern) {
            $reqMatches = [regex]::Matches($Matches["ids"], $ReqIdPattern)
            if ($reqMatches.Count -gt 0) {
                # Skip if this line already has a structured annotation
                $hasStructured = $false
                foreach ($key in $AnnotationPatterns.Keys) {
                    if ($line -match $AnnotationPatterns[$key]) {
                        $hasStructured = $true
                        break
                    }
                }

                if (-not $hasStructured) {
                    $ids = $reqMatches | ForEach-Object { $_.Value }
                    $annotations += @{
                        file       = $relativePath
                        line       = $lineNum
                        type       = "unstructured"
                        annotation = "comment"
                        ids        = @($ids)
                        raw        = $line.Trim()
                    }
                }
            }
        }
    }

    return $annotations
}

function Get-RelativePath {
    param([System.IO.FileInfo]$File, [string]$RootPath)
    $rel = $File.FullName.Substring($RootPath.Length).TrimStart('\', '/')
    return ($rel -replace '\\', '/')
}

function Scan-MermaidFile {
    # Mermaid diagram annotations: %% @req FR-a01001[, ...] / %% @spec FEAT-a01 / %% @diagram_type sequence
    param(
        [System.IO.FileInfo]$File,
        [string]$RootPath
    )

    $relativePath = Get-RelativePath -File $File -RootPath $RootPath
    $lines = Get-Content $File.FullName -ErrorAction SilentlyContinue

    $annotations = @()
    $lineNum = 0

    foreach ($line in $lines) {
        $lineNum++
        if ($line -match "^\s*%%\s*@(?<key>req|spec)\s+(?<value>$RequirementId(?:\s*,\s*$RequirementId)*)\s*$") {
            $ids = ($Matches["value"] -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
            $annotations += @{
                file       = $relativePath
                line       = $lineNum
                type       = "structured"
                annotation = "@$($Matches['key'])"
                ids        = @($ids)
                raw        = $line.Trim()
            }
        }
        elseif ($line -match '^\s*%%\s*@diagram_type\s+(?<value>sequence|state|component)\s*$') {
            $annotations += @{
                file       = $relativePath
                line       = $lineNum
                type       = "structured"
                annotation = "@diagram_type"
                ids        = @($Matches['value'])
                raw        = $line.Trim()
            }
        }
        elseif ($line -match '^\s*%%\s*@id\s+(?<value>[A-Za-z0-9:_.\-]+)\s*$') {
            # name-only filename mode: identity travels in-file (SPEC A4 2.1.1)
            $annotations += @{
                file       = $relativePath
                line       = $lineNum
                type       = "structured"
                annotation = "@id"
                ids        = @($Matches['value'])
                raw        = $line.Trim()
            }
        }
    }

    return $annotations
}

function Scan-DocIdFrontmatter {
    # name-only filename mode: any governed .md declares identity via
    # frontmatter `id: FEAT-a01` (SPEC A4 2.1.1). Frontmatter only - body
    # text is never scanned for ids.
    param(
        [System.IO.FileInfo]$File,
        [string]$RootPath
    )

    $relativePath = Get-RelativePath -File $File -RootPath $RootPath
    $lines = Get-Content $File.FullName -TotalCount 30 -ErrorAction SilentlyContinue

    $annotations = @()
    $inFrontmatter = $false
    $lineNum = 0

    foreach ($line in $lines) {
        $lineNum++
        if ($line -match '^---\s*$') {
            if (-not $inFrontmatter -and $lineNum -eq 1) { $inFrontmatter = $true; continue }
            if ($inFrontmatter) { break }
        }
        if (-not $inFrontmatter) { break }

        if ($line -match '^id\s*:\s*(?<value>[A-Za-z0-9:_.\-]+)\s*$') {
            $annotations += @{
                file       = $relativePath
                line       = $lineNum
                type       = "structured"
                annotation = "@id"
                ids        = @($Matches['value'])
                raw        = $line.Trim()
            }
        }
    }

    return $annotations
}

function Scan-TestSpecFile {
    # .test.md frontmatter: req: [FR-a01001, FR-a01002] / spec: FEAT-a01 / test_type: TDD
    param(
        [System.IO.FileInfo]$File,
        [string]$RootPath
    )

    $relativePath = Get-RelativePath -File $File -RootPath $RootPath
    $lines = Get-Content $File.FullName -ErrorAction SilentlyContinue

    $annotations = @()
    $inFrontmatter = $false
    $frontmatterDone = $false
    $lineNum = 0

    foreach ($line in $lines) {
        $lineNum++
        if ($frontmatterDone) { break }

        if ($line -match '^---\s*$') {
            if (-not $inFrontmatter -and $lineNum -eq 1) { $inFrontmatter = $true; continue }
            if ($inFrontmatter) { $frontmatterDone = $true; continue }
        }
        if (-not $inFrontmatter) { continue }

        if ($line -match '^id\s*:\s*(?<value>[A-Za-z0-9:_.\-]+)\s*$') {
            $annotations += @{
                file       = $relativePath
                line       = $lineNum
                type       = "structured"
                annotation = "@id"
                ids        = @($Matches['value'])
                raw        = $line.Trim()
            }
        }
        elseif ($line -match '^(?<key>req|spec)\s*:\s*(?<value>.+)$') {
            $rawValue = $Matches['value'].Trim().Trim('[', ']')
            $ids = @([regex]::Matches($rawValue, $RequirementId) | ForEach-Object { $_.Value })
            if ($ids.Count -gt 0) {
                $annotations += @{
                    file       = $relativePath
                    line       = $lineNum
                    type       = "structured"
                    annotation = "@$($Matches['key'])"
                    ids        = $ids
                    raw        = $line.Trim()
                }
            }
        }
        elseif ($line -match '^test_type\s*:\s*(?<value>.+)$') {
            $annotations += @{
                file       = $relativePath
                line       = $lineNum
                type       = "structured"
                annotation = "@test_type"
                ids        = @($Matches['value'].Trim())
                raw        = $line.Trim()
            }
        }
    }

    return $annotations
}

# Main execution
$resolvedPath = (Resolve-Path $Path).Path
$files = Get-SourceFiles -RootPath $resolvedPath
$mermaidFiles = Get-FilesByFilter -RootPath $resolvedPath -Filters @("*.mmd")
$testSpecFiles = Get-FilesByFilter -RootPath $resolvedPath -Filters @("*.test.md")
$docMdFiles = Get-FilesByFilter -RootPath $resolvedPath -Filters @("*.md") | Where-Object { $_.Name -notlike "*.test.md" }

$allAnnotations = @()
$fileCount = 0

foreach ($file in $files) {
    $result = Scan-File -File $file -RootPath $resolvedPath
    if ($result.Count -gt 0) {
        $allAnnotations += $result
        $fileCount++
    }
}

foreach ($file in $mermaidFiles) {
    $result = Scan-MermaidFile -File $file -RootPath $resolvedPath
    if ($result.Count -gt 0) {
        $allAnnotations += $result
        $fileCount++
    }
}

foreach ($file in $testSpecFiles) {
    $result = Scan-TestSpecFile -File $file -RootPath $resolvedPath
    if ($result.Count -gt 0) {
        $allAnnotations += $result
        $fileCount++
    }
}

foreach ($file in $docMdFiles) {
    $result = Scan-DocIdFrontmatter -File $file -RootPath $resolvedPath
    if ($result.Count -gt 0) {
        $allAnnotations += $result
        $fileCount++
    }
}

# Build summary
$structured = @($allAnnotations | Where-Object { $_.type -eq "structured" }).Count
$unstructured = @($allAnnotations | Where-Object { $_.type -eq "unstructured" }).Count

$allIds = @()
foreach ($ann in $allAnnotations) {
    $allIds += $ann.ids
}
$uniqueIds = ($allIds | Sort-Object -Unique)

$report = @{
    generated_by = "rwang:scan-annotations"
    generated_at = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    root_path    = $resolvedPath
    summary      = @{
        files_scanned       = ($files.Count + $mermaidFiles.Count + $testSpecFiles.Count)
        files_with_refs     = $fileCount
        structured_count    = $structured
        unstructured_count  = $unstructured
        total_annotations   = $allAnnotations.Count
        unique_req_ids      = $uniqueIds.Count
        unique_ids          = $uniqueIds
    }
    annotations  = $allAnnotations
}

if ($Format -eq "json") {
    $report | ConvertTo-Json -Depth 10
} else {
    Write-Host "`n=== RWANG Annotation Scan Report ===" -ForegroundColor Cyan
    Write-Host "Root: $resolvedPath"
    Write-Host "Files scanned: $($files.Count + $mermaidFiles.Count + $testSpecFiles.Count) (code: $($files.Count), .mmd: $($mermaidFiles.Count), .test.md: $($testSpecFiles.Count))"
    Write-Host "Files with references: $fileCount"
    Write-Host "Structured annotations (@req, @spec, etc.): $structured"
    Write-Host "Unstructured references (# FR-xxx): $unstructured"
    Write-Host "Unique requirement IDs: $($uniqueIds.Count)"
    Write-Host ""

    if ($allAnnotations.Count -gt 0) {
        Write-Host "--- Annotations ---" -ForegroundColor Yellow
        foreach ($ann in $allAnnotations) {
            $marker = if ($ann.type -eq "structured") { "[S]" } else { "[U]" }
            $idStr = $ann.ids -join ", "
            Write-Host "$marker $($ann.file):$($ann.line) - $idStr"
        }
    } else {
        Write-Host "No annotations found." -ForegroundColor Red
    }
}
