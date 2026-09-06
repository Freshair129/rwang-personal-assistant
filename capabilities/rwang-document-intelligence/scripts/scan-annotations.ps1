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
$SkipDirs = @("node_modules", ".pnpm-store", "__pycache__", ".venv", "venv", ".git", "dist", "build", ".next", "coverage")

# Structured annotations are source comments, never prose/string literals.
# Requirement/spec annotations carry registered requirement IDs; design can
# carry a section reference or requirement ID; test annotations carry a test
# file reference with an optional test selector.
$CommentPrefix = '^\s*(?:#|//|--|\*+)\s*'
# Flat IDs (FR-001), 5-driven IDs (FR-a01001, FEAT-a01), and project-namespaced IDs
# (ZPP-FR-009, RAG-GR-004, TAX-NFR-001).
#
# The namespaced form is listed first, and it has to be: alternation is ordered, and a project that
# prefixes its ids is doing so precisely because its FR-009 is not the flat FR-009. Matching the
# flat alternative inside a namespaced id would not merely lose the prefix, it would assert the
# wrong requirement. AI-AGT-001 and AI-ETH-001 are matched by this branch too — same string, same
# result as the enumerated form they used to need.
#
# The kind segment is open (any 2-4 uppercase letters) only when a namespace precedes it. That is
# what keeps it safe: three dash-separated segments ending in exactly three digits is specific
# enough to be an id, while a bare two-letter kind would not be.
$NamespacedId = '[A-Z][A-Z0-9]{1,4}-[A-Z]{2,4}-\d{3}'
$RequirementId = "(?:$NamespacedId|FR-[a-z]\d{5}|FEAT-[a-z]\d{2}|(?:FR|NFR|SDD|SEC|AI-AGT|AI-ETH|BR|AC|DR|IR)-\d{3})"
$TestReference = '[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|ps1)(?:::[A-Za-z0-9_\-]+)?'
$UnstructuredPattern = "$CommentPrefix(?<ids>$RequirementId(?:\s*,\s*$RequirementId)*)\s*$"

# Annotation patterns
# The trailing group accepts a comma as well as whitespace. It used to require whitespace, which
# meant one unrecognised id in a list discarded the whole annotation: `@spec FR-093, ADR-058` lost
# FR-093 too, silently, because ADR is not an enumerated kind. Capturing what is recognised and
# ignoring the rest loses nothing a stricter read would have caught — the annotation was never
# reported as malformed, only dropped.
# @tested carries either of two payloads, and they run in opposite directions:
#
#   // @tested tests/queue.test.ts::creates   on a source file  — this code is verified by that test
#   // @tested FR-001, SDD-004                on a test file    — this test verifies those requirements
#
# Both assert the same verified_by relation; they differ in which end the annotated file is. A
# project annotates from whichever side it maintains, and a grammar that only understood the first
# form silently ignored every repository that annotates its tests. `form` below is what tells a
# consumer which end it is holding — read the payload, not the keyword.
$AnnotationPatterns = @{
    "req"     = "$CommentPrefix@req\s+(?<value>$RequirementId(?:\s*,\s*$RequirementId)*)(?:[\s,].*)?$"
    "spec"    = "$CommentPrefix@spec\s+(?<value>$RequirementId(?:\s*,\s*$RequirementId)*)(?:[\s,].*)?$"
    "designs" = "$CommentPrefix@designs\s+(?<value>(?:§\s*\d+(?:\.\d+)*|$RequirementId))(?:[\s,].*)?$"
    "tested"  = "$CommentPrefix@tested\s+(?<value>$TestReference|$RequirementId(?:\s*,\s*$RequirementId)*)(?:[\s,].*)?$"
}

# Unstructured requirement ID pattern
$ReqIdPattern = "(?<![A-Za-z0-9_-])$RequirementId(?![A-Za-z0-9_-])"

function Get-FilesByFilter {
    param([string]$RootPath, [string[]]$Filters)

    $files = @()
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($RootPath)

    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        try {
            $currentAttributes = [System.IO.File]::GetAttributes($current)
            if (($currentAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            $filePaths = @([System.IO.Directory]::EnumerateFiles($current))
            $directoryPaths = @([System.IO.Directory]::EnumerateDirectories($current))
        }
        catch {
            continue
        }

        foreach ($filePath in $filePaths) {
            $fileName = [System.IO.Path]::GetFileName($filePath)
            foreach ($filter in $Filters) {
                if ($fileName -like $filter) {
                    $files += [System.IO.FileInfo]::new($filePath)
                    break
                }
            }
        }

        foreach ($directoryPath in $directoryPaths) {
            $directoryName = [System.IO.Path]::GetFileName($directoryPath)
            if ($SkipDirs -contains $directoryName) { continue }
            try {
                $attributes = [System.IO.File]::GetAttributes($directoryPath)
                if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
                $pending.Push($directoryPath)
            }
            catch {
                continue
            }
        }
    }
    return $files
}

function Get-SourceFiles {
    param([string]$RootPath)
    return @(Get-FilesByFilter -RootPath $RootPath -Filters $Extensions)
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

                # What the payload IS, not which keyword introduced it. @designs takes a section or
                # an id; @tested takes a test reference or ids. A consumer that switches on the
                # keyword alone has to re-parse the value to find out what it got.
                $form = "requirement"
                if ($value -match "^$TestReference$") { $form = "test-ref" }
                elseif ($value -match '^§') { $form = "section" }

                $annotations += @{
                    file       = $relativePath
                    line       = $lineNum
                    type       = "structured"
                    annotation = "@$key"
                    form       = $form
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
$resolvedPath = [System.IO.Path]::GetFullPath($Path)
if (-not [System.IO.Directory]::Exists($resolvedPath)) {
    throw "Scan root does not exist or is not a directory"
}
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

exit 0
