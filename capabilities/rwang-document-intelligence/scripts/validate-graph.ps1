<#
.SYNOPSIS
    RWANG Core graph validator - contract validation + exact-set reconciliation
    (CR-2026-08-20-01 A2 §2.2, §2.9; SPEC-5DRIVEN-01 A2 §2.3).

.DESCRIPTION
    Validates a generated .doc-graph.json projection against the Entity Registry,
    Edge Contracts, node manifests, adapter discovery output, and traceability
    projection. Emits RWG-* findings as JSON and exits non-zero when any finding
    blocks publication.

    Inputs under -Root:
      docs/registry/entity-types.yaml         entity TYPE registration
      docs/registry/entities/**/*.yaml|.json  entity instance registrations
      docs/registry/edge-contracts/*.yaml     versioned contract definitions
      docs/**/manifest.yaml                   node manifests (outgoing assertions)
      docs/.doc-graph.json                    generated projection under test
      discovery.json                          adapter discovery output (F set):
                                              { "entities": [ { "id": "..." } ] }
      traceability.json                       traceability projection (T set):
                                              { "requirements": [ "req:..." ] }

    Set semantics: R (registry) = F (discovery) = G (graph) = T (traceability),
    compared by stable ID for governed entity types only. Glob patterns and
    counts are never used as truth.

.PARAMETER Root
    Project root containing docs/ and discovery.json.

.PARAMETER Mode
    validate (default) - run all checks, emit findings JSON.
    hash               - print computed semantic hashes per contract (used to
                         stamp fixtures and to re-approve contracts).

.PARAMETER GovernedTypes
    Entity types subject to registry closure and exact-set checks.
    code_file/test/document/section are exempt by default (code registers
    implicitly through validated annotations, CR §2.3.2).
#>

param(
    [Parameter(Mandatory = $true)][string]$Root,
    [ValidateSet("validate", "hash")][string]$Mode = "validate",
    [string[]]$GovernedTypes = @("domain", "feature", "requirement", "diagram", "test_spec", "release")
)

$ErrorActionPreference = "Stop"

# --- Canonical ontology (Core-owned; adapters may not extend) -----------------

$CanonicalPredicates = @(
    "specifies", "defines", "contains", "implements", "designs", "tests",
    "verifies", "depends_on", "references", "exposes", "persists_to",
    "contradicts", "guides", "visualized_by", "verified_by", "refines",
    "supersedes", "applies_to"
)

$NodeTypes = @(
    "document", "section", "requirement", "domain", "feature", "code_file",
    "component", "test", "test_spec", "diagram", "api_endpoint", "db_table",
    "release"
)

$PrefixToType = @{
    "doc" = "document"; "sec" = "section"; "req" = "requirement"
    "code" = "code_file"; "comp" = "component"; "test" = "test"
    "api" = "api_endpoint"; "db" = "db_table"; "dom" = "domain"
    "feat" = "feature"; "diag" = "diagram"; "testspec" = "test_spec"
    "rel" = "release"
}

# --- Minimal YAML subset parser ------------------------------------------------
# Supports: nested maps (2-space indent), lists of scalars/maps ("- "), inline
# arrays [a, b], inline empty map {}, full-line and trailing "#" comments.

function Get-YamlIndent([string]$Line) {
    return $Line.Length - $Line.TrimStart(' ').Length
}

function Strip-YamlScalar([string]$Value) {
    $v = $Value.Trim()
    if ($v.StartsWith('"') -and $v.EndsWith('"') -and $v.Length -ge 2) { return $v.Substring(1, $v.Length - 2) }
    if ($v.StartsWith("'") -and $v.EndsWith("'") -and $v.Length -ge 2) { return $v.Substring(1, $v.Length - 2) }
    return $v
}

function Parse-YamlInlineArray([string]$Value) {
    $inner = $Value.Trim().TrimStart('[').TrimEnd(']').Trim()
    if ($inner -eq '') { return @() }
    return @(($inner -split ',') | ForEach-Object { Strip-YamlScalar $_ } | Where-Object { $_ -ne '' })
}

function Parse-YamlScalarOrInline([string]$Value) {
    $v = $Value.Trim()
    if ($v -match '^\[.*\]$') { return Parse-YamlInlineArray $v }
    if ($v -eq '{}') { return [ordered]@{} }
    if ($v -eq 'null' -or $v -eq '~') { return $null }
    return Strip-YamlScalar $v
}

function Parse-YamlMap {
    param([string[]]$Lines, [ref]$Index, [int]$Indent)
    $map = [ordered]@{}
    while ($Index.Value -lt $Lines.Count) {
        $line = $Lines[$Index.Value]
        $ind = Get-YamlIndent $line
        if ($ind -lt $Indent) { break }
        if ($ind -gt $Indent) { throw "YAML parse error (unexpected indent): $line" }
        $trim = $line.Trim()
        if ($trim.StartsWith('- ')) { break }
        if ($trim -match '^(?<key>[A-Za-z0-9_.-]+):\s*(?<val>.*)$') {
            $key = $Matches['key']
            $val = $Matches['val']
            $Index.Value++
            if ($val.Trim() -eq '') {
                # nested block, list, or empty
                if ($Index.Value -lt $Lines.Count) {
                    $next = $Lines[$Index.Value]
                    $nextInd = Get-YamlIndent $next
                    if ($nextInd -gt $Indent) {
                        if ($next.Trim().StartsWith('- ')) {
                            $map[$key] = Parse-YamlList -Lines $Lines -Index $Index -Indent $nextInd
                        } else {
                            $map[$key] = Parse-YamlMap -Lines $Lines -Index $Index -Indent $nextInd
                        }
                        continue
                    }
                }
                $map[$key] = $null
            } else {
                $map[$key] = Parse-YamlScalarOrInline $val
            }
        } else {
            throw "YAML parse error (expected key): $line"
        }
    }
    return $map
}

function Parse-YamlList {
    param([string[]]$Lines, [ref]$Index, [int]$Indent)
    $list = @()
    while ($Index.Value -lt $Lines.Count) {
        $line = $Lines[$Index.Value]
        $ind = Get-YamlIndent $line
        if ($ind -lt $Indent) { break }
        $trim = $line.Trim()
        if ($ind -eq $Indent -and $trim.StartsWith('- ')) {
            $content = $trim.Substring(2)
            $Index.Value++
            if ($content -match '^(?<key>[A-Za-z0-9_.-]+):\s*(?<val>.*)$') {
                # map item: first key inline, continuation keys at Indent+2
                $item = [ordered]@{}
                if ($Matches['val'].Trim() -eq '') {
                    $item[$Matches['key']] = $null
                } else {
                    $item[$Matches['key']] = Parse-YamlScalarOrInline $Matches['val']
                }
                if ($Index.Value -lt $Lines.Count) {
                    $next = $Lines[$Index.Value]
                    if ((Get-YamlIndent $next) -eq ($Indent + 2) -and -not $next.Trim().StartsWith('- ')) {
                        $rest = Parse-YamlMap -Lines $Lines -Index $Index -Indent ($Indent + 2)
                        foreach ($k in $rest.Keys) { $item[$k] = $rest[$k] }
                    }
                }
                $list += , $item
            } else {
                $list += Parse-YamlScalarOrInline $content
            }
        } else {
            break
        }
    }
    return , $list
}

function ConvertFrom-SimpleYaml {
    param([string[]]$RawLines)
    $clean = @()
    foreach ($l in $RawLines) {
        $noComment = $l -replace '\s+#.*$', ''
        if ($noComment.Trim() -eq '' -or $noComment.Trim().StartsWith('#')) { continue }
        $clean += $noComment.TrimEnd()
    }
    if ($clean.Count -eq 0) { return [ordered]@{} }
    $idx = [ref]0
    return Parse-YamlMap -Lines $clean -Index $idx -Indent 0
}

function Get-DataFile {
    param([string]$FilePath)
    if ($FilePath -match '\.json$') {
        return (Get-Content -LiteralPath $FilePath -Raw | ConvertFrom-Json)
    }
    return ConvertFrom-SimpleYaml -RawLines (Get-Content -LiteralPath $FilePath)
}

# --- Canonical JSON + semantic hash (SPEC §2.3) --------------------------------

function Get-CanonicalJson {
    param($Value)
    if ($null -eq $Value) { return "null" }
    if ($Value -is [bool]) { if ($Value) { return "true" } else { return "false" } }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double]) {
        return $Value.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [string]) { return ($Value | ConvertTo-Json -Compress) }
    if ($Value -is [System.Collections.IDictionary]) {
        $parts = @()
        foreach ($k in ($Value.Keys | Sort-Object)) {
            $parts += ('"' + $k + '":' + (Get-CanonicalJson $Value[$k]))
        }
        return '{' + ($parts -join ',') + '}'
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $parts = @()
        foreach ($item in $Value) { $parts += (Get-CanonicalJson $item) }
        return '[' + ($parts -join ',') + ']'
    }
    # PSCustomObject fallback
    $parts = @()
    foreach ($p in ($Value.PSObject.Properties.Name | Sort-Object)) {
        $parts += ('"' + $p + '":' + (Get-CanonicalJson $Value.$p))
    }
    return '{' + ($parts -join ',') + '}'
}

function Get-ContractSemanticHash {
    param($Contract)
    # Normalization: drop non-semantic fields (labels, provenance, the stored
    # hash itself), lower-case predicate/type names, sort keys, SHA-256.
    $norm = [ordered]@{}
    foreach ($k in $Contract.Keys) {
        if ($k -in @('labels', 'provenance', 'semantic_hash')) { continue }
        $norm[$k] = $Contract[$k]
    }
    if ($norm.Contains('predicate') -and $norm['predicate'] -is [string]) { $norm['predicate'] = $norm['predicate'].ToLowerInvariant() }
    foreach ($tk in @('from_type', 'to_type')) {
        if ($norm.Contains($tk) -and $norm[$tk] -is [System.Collections.IEnumerable] -and -not ($norm[$tk] -is [string])) {
            $norm[$tk] = @($norm[$tk] | ForEach-Object { ([string]$_).ToLowerInvariant() })
        }
    }
    $canonical = Get-CanonicalJson $norm
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($canonical)
        $hash = ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
    } finally {
        $sha.Dispose()
    }
    return "sha256:$hash"
}

# --- Load inputs ----------------------------------------------------------------

$rootPath = (Resolve-Path $Root).Path
$registryDir = Join-Path $rootPath "docs\registry"
$entityDir = Join-Path $registryDir "entities"
$contractDir = Join-Path $registryDir "edge-contracts"
$graphPath = Join-Path $rootPath "docs\.doc-graph.json"
$discoveryPath = Join-Path $rootPath "discovery.json"
$traceabilityPath = Join-Path $rootPath "traceability.json"
$entityTypesPath = Join-Path $registryDir "entity-types.yaml"

$findings = New-Object System.Collections.ArrayList
function Add-Finding([string]$Code, [string]$Message) {
    [void]$findings.Add(@{ code = $Code; message = $Message })
}

# Contracts
$contracts = @{}
if (Test-Path $contractDir) {
    foreach ($f in (Get-ChildItem -Path $contractDir -File | Where-Object { $_.Name -match '\.(yaml|yml|json)$' })) {
        $c = Get-DataFile $f.FullName
        $contracts[[string]$c['contract_id']] = $c
    }
}

if ($Mode -eq "hash") {
    $out = [ordered]@{}
    foreach ($cid in ($contracts.Keys | Sort-Object)) {
        $out[$cid] = Get-ContractSemanticHash $contracts[$cid]
    }
    $out | ConvertTo-Json
    exit 0
}

# Entity types
$registeredTypes = @()
if (Test-Path $entityTypesPath) {
    $et = Get-DataFile $entityTypesPath
    $registeredTypes = @($et['types'])
}

# Registry entries (R)
$registryIds = @{}        # id -> entry file (duplicate detection)
$aliasMap = @{}           # alias id -> primary id (rename/equivalence support)
$canonicalPaths = @{}     # canonical_path -> entity id (path-collision detection)
$registryPathById = @{}   # id -> registered path (identity-binding check, RWG-109)
$registryEntries = @()
if (Test-Path $entityDir) {
    foreach ($f in (Get-ChildItem -Path $entityDir -Recurse -File | Where-Object { $_.Name -match '\.(yaml|yml|json)$' })) {
        $e = Get-DataFile $f.FullName
        $registryEntries += , @{ entry = $e; file = $f.FullName }
        $eid = [string]$e['entity_id']
        if ($registryIds.ContainsKey($eid)) {
            Add-Finding "RWG-106" "DUPLICATE_ENTITY_ID: '$eid' registered in both '$($registryIds[$eid])' and '$($f.FullName)'"
        } else {
            $registryIds[$eid] = $f.FullName
        }
        # canonical_path must be unique per entity
        $cpath = [string]$e['canonical_path']
        if ($cpath -ne '') {
            if ($canonicalPaths.ContainsKey($cpath) -and $canonicalPaths[$cpath] -ne $eid) {
                Add-Finding "RWG-106" "DUPLICATE_ENTITY_ID: canonical_path '$cpath' claimed by both '$($canonicalPaths[$cpath])' and '$eid'"
            } else {
                $canonicalPaths[$cpath] = $eid
            }
            $registryPathById[$eid] = $cpath
        }
        # aliases (rename/equivalence, CR A2 SS2.3.4): must not collide with any
        # entity_id or another alias
        if ($null -ne $e['aliases']) {
            foreach ($al in @($e['aliases'])) {
                $alias = [string]$al
                if ($alias -eq '') { continue }
                if ($registryIds.ContainsKey($alias)) {
                    Add-Finding "RWG-106" "DUPLICATE_ENTITY_ID: alias '$alias' of '$eid' collides with a registered entity_id"
                } elseif ($aliasMap.ContainsKey($alias) -and $aliasMap[$alias] -ne $eid) {
                    Add-Finding "RWG-106" "DUPLICATE_ENTITY_ID: alias '$alias' claimed by both '$($aliasMap[$alias])' and '$eid'"
                } else {
                    $aliasMap[$alias] = $eid
                }
            }
        }
        # type closure
        $etype = [string]$e['entity_type']
        if ($registeredTypes.Count -gt 0 -and ($registeredTypes -notcontains $etype)) {
            Add-Finding "RWG-101" "UNREGISTERED_ENTITY: entity type '$etype' of '$eid' is not registered in entity-types.yaml"
        }
        # provenance rule (RWG-107)
        $prov = $e['introduced_by']
        if ($null -ne $prov -and [string]$prov['actor_type'] -eq 'agent') {
            $approval = $prov['approval_ref']
            if ($null -eq $approval -or [string]$approval -eq '') {
                Add-Finding "RWG-107" "UNAPPROVED_AGENT_MUTATION: registry entry '$eid' was introduced by an agent without approval_ref"
            }
        }
        # nested registrations join R
        $nested = $e['nested']
        if ($null -ne $nested) {
            foreach ($nk in @('requirements', 'diagrams', 'test_specs')) {
                if ($nested.Contains($nk) -and $null -ne $nested[$nk]) {
                    foreach ($item in $nested[$nk]) {
                        $nid = [string]$item['id']
                        if ($registryIds.ContainsKey($nid)) {
                            Add-Finding "RWG-106" "DUPLICATE_ENTITY_ID: nested '$nid' already registered by '$($registryIds[$nid])'"
                        } else {
                            $registryIds[$nid] = $f.FullName
                            if ($null -ne $item['path'] -and [string]$item['path'] -ne '') {
                                $registryPathById[$nid] = [string]$item['path']
                            }
                        }
                    }
                }
            }
        }
    }
}

# Post-load registry consistency: late alias-vs-id collisions and
# prefix-ambiguous IDs in name-based namespaces (dom:, feat:, req:, rel:).
# Path-based namespaces (diag:, testspec:, code:) are exempt - file paths
# legitimately share prefixes.
foreach ($alias in @($aliasMap.Keys)) {
    if ($registryIds.ContainsKey($alias)) {
        Add-Finding "RWG-106" "DUPLICATE_ENTITY_ID: alias '$alias' (of '$($aliasMap[$alias])') collides with a registered entity_id"
    }
}
$prefixCheckIds = @($registryIds.Keys + $aliasMap.Keys | Where-Object { $_ -match '^(dom|feat|req|rel):' } | Sort-Object -Unique)
for ($i = 0; $i -lt $prefixCheckIds.Count; $i++) {
    for ($j = $i + 1; $j -lt $prefixCheckIds.Count; $j++) {
        $a = $prefixCheckIds[$i]; $b = $prefixCheckIds[$j]
        if ($b.StartsWith($a) -and $b.Length -gt $a.Length) {
            Add-Finding "RWG-106" "DUPLICATE_ENTITY_ID: prefix-ambiguous IDs - '$a' is a strict prefix of '$b'; parsers cannot disambiguate them with unbounded patterns. Rename one or separate the namespaces."
        }
    }
}

# Alias resolution: adapter-facing inputs (discovery, traceability) MAY
# reference aliases; the canonical graph itself MUST use primary IDs.
function Resolve-Alias([string]$Id) {
    if ($aliasMap.ContainsKey($Id)) { return $aliasMap[$Id] }
    return $Id
}

# Discovery (F)
$discoveryIds = @{}
if (Test-Path $discoveryPath) {
    $disc = Get-Content -LiteralPath $discoveryPath -Raw | ConvertFrom-Json
    foreach ($ent in $disc.entities) {
        $did = Resolve-Alias ([string]$ent.id)
        if ($discoveryIds.ContainsKey($did)) {
            Add-Finding "RWG-106" "DUPLICATE_ENTITY_ID: '$did' appears twice in discovery output (aliases resolve to the same entity)"
        }
        $discoveryIds[$did] = $true
        # Identity-binding check (RWG-109, name-only filename mode): a discovered
        # entity's path must match the path the Registry binds that ID to.
        $dpath = [string]$ent.path
        if ($dpath -ne '' -and $registryPathById.ContainsKey($did) -and $registryPathById[$did] -ne $dpath) {
            Add-Finding "RWG-109" "IDENTITY_BINDING_MISMATCH: '$did' discovered at '$dpath' but the Registry binds it to '$($registryPathById[$did])' - update canonical_path (rename) or fix the in-file id"
        }
    }
} else {
    Add-Finding "RWG-103" "GRAPH_STALE: discovery.json missing — cannot anchor the graph to a checkout"
}

# Graph (G)
if (-not (Test-Path $graphPath)) {
    Add-Finding "RWG-103" "GRAPH_STALE: docs/.doc-graph.json not found"
    $graph = $null
} else {
    $graph = Get-Content -LiteralPath $graphPath -Raw | ConvertFrom-Json
    if ([string]$graph.generated_by -ne 'rwang:doc-graph') {
        Add-Finding "RWG-104" "GRAPH_UNKNOWN_ENTITY: graph written by '$($graph.generated_by)' — single writer is rwang:doc-graph"
    }
    if ($null -eq $graph.source_ref -or [string]$graph.source_ref -eq '') {
        Add-Finding "RWG-103" "GRAPH_STALE: graph header has no source_ref — cannot verify it matches the current checkout"
    }
}

function Get-IdType([string]$Id) {
    $prefix = ($Id -split ':')[0]
    if ($PrefixToType.ContainsKey($prefix)) { return $PrefixToType[$prefix] }
    return $null
}

function Test-Governed([string]$Id) {
    $t = Get-IdType $Id
    return ($null -ne $t -and ($GovernedTypes -contains $t))
}

# --- Exact-set reconciliation (RWG-101..105) ------------------------------------

$rGoverned = @($registryIds.Keys | Where-Object { Test-Governed $_ })
$fGoverned = @($discoveryIds.Keys | Where-Object { Test-Governed $_ })

$graphNodeIds = @{}
if ($null -ne $graph) {
    foreach ($n in $graph.nodes) {
        $graphNodeIds[[string]$n.id] = [string]$n.type
        if ($NodeTypes -notcontains [string]$n.type) {
            Add-Finding "RWG-104" "GRAPH_UNKNOWN_ENTITY: node '$($n.id)' has unknown type '$($n.type)'"
        }
    }
}
$gGoverned = @($graphNodeIds.Keys | Where-Object { Test-Governed $_ })

foreach ($id in $fGoverned) {
    if ($rGoverned -notcontains $id) {
        Add-Finding "RWG-101" "UNREGISTERED_ENTITY: '$id' discovered on the filesystem but has no registry entry"
    }
}
foreach ($id in $rGoverned) {
    if ($fGoverned -notcontains $id) {
        Add-Finding "RWG-102" "ORPHANED_REGISTRY_ENTRY: '$id' is registered but was not discovered on the filesystem"
    }
}
foreach ($id in $rGoverned) {
    if (($fGoverned -contains $id) -and ($gGoverned -notcontains $id)) {
        Add-Finding "RWG-103" "GRAPH_STALE: '$id' exists in registry and filesystem but is missing from the graph — regenerate from the merged checkout"
    }
}
foreach ($id in $gGoverned) {
    if ($rGoverned -notcontains $id) {
        Add-Finding "RWG-104" "GRAPH_UNKNOWN_ENTITY: graph node '$id' has no registry backing"
    }
}

# Traceability (T) — requirements set must equal graph requirements
if (Test-Path $traceabilityPath) {
    $trace = Get-Content -LiteralPath $traceabilityPath -Raw | ConvertFrom-Json
    $tReqs = @($trace.requirements | ForEach-Object { Resolve-Alias ([string]$_) })
    $gReqs = @($graphNodeIds.Keys | Where-Object { $graphNodeIds[$_] -eq 'requirement' })
    foreach ($id in $gReqs) {
        if ($tReqs -notcontains $id) {
            Add-Finding "RWG-105" "TRACE_SET_MISMATCH: requirement '$id' is in the graph but missing from the traceability projection"
        }
    }
    foreach ($id in $tReqs) {
        if ($gReqs -notcontains $id) {
            Add-Finding "RWG-105" "TRACE_SET_MISMATCH: requirement '$id' is in the traceability projection but not in the graph"
        }
    }
}

# --- Contract validation (RWG-201..206) ------------------------------------------

$contractHashes = @{}
foreach ($cid in $contracts.Keys) {
    $c = $contracts[$cid]
    $computed = Get-ContractSemanticHash $c
    $contractHashes[$cid] = $computed
    $stored = [string]$c['semantic_hash']
    if ($stored -ne $computed) {
        Add-Finding "RWG-205" "SEMANTIC_DIFF_UNVERSIONED: contract '$cid' content does not match its approved semantic_hash — create a new contract_version with migration evidence or restore the approved contract"
    }
    if ($CanonicalPredicates -notcontains [string]$c['predicate']) {
        Add-Finding "RWG-202" "UNKNOWN_PREDICATE: contract '$cid' declares non-canonical predicate '$($c['predicate'])'"
    }
}

if ($null -ne $graph) {
    $edgePairs = @{}
    foreach ($e in $graph.edges) {
        $eDesc = "$($e.from) -[$($e.type)]-> $($e.to)"

        if ($CanonicalPredicates -notcontains [string]$e.type) {
            Add-Finding "RWG-202" "UNKNOWN_PREDICATE: edge $eDesc uses a predicate outside the canonical set"
            continue
        }

        $cid = [string]$e.contract_id
        if ($null -eq $e.contract_id -or $cid -eq '') {
            Add-Finding "RWG-201" "UNCONTRACTED_EDGE: edge $eDesc has no contract_id"
            continue
        }
        if (-not $contracts.ContainsKey($cid)) {
            Add-Finding "RWG-201" "UNCONTRACTED_EDGE: edge $eDesc references unknown contract '$cid'"
            continue
        }
        $c = $contracts[$cid]

        if ([string]$c['predicate'] -ne [string]$e.type) {
            Add-Finding "RWG-202" "UNKNOWN_PREDICATE: edge $eDesc predicate does not match contract '$cid' ('$($c['predicate'])')"
        }

        # endpoint types (RWG-203) — includes the document-sourced `implements` false-green case
        $fromType = $graphNodeIds[[string]$e.from]
        $toType = $graphNodeIds[[string]$e.to]
        if ($null -eq $fromType -or $null -eq $toType) {
            Add-Finding "RWG-206" "DIRECT_NODE_REFERENCE: edge $eDesc references a node that does not exist in the graph"
        } else {
            if (@($c['from_type']) -notcontains $fromType) {
                Add-Finding "RWG-203" "INVALID_ENDPOINT_TYPE: edge $eDesc — from-node type '$fromType' not allowed by contract '$cid' (allowed: $(@($c['from_type']) -join ', '))"
            }
            if (@($c['to_type']) -notcontains $toType) {
                Add-Finding "RWG-203" "INVALID_ENDPOINT_TYPE: edge $eDesc — to-node type '$toType' not allowed by contract '$cid' (allowed: $(@($c['to_type']) -join ', '))"
            }
        }

        # version / hash (RWG-204)
        if ([string]$e.contract_version -ne [string]$c['contract_version']) {
            Add-Finding "RWG-204" "CONTRACT_VERSION_MISMATCH: edge $eDesc validated against '$($e.contract_version)' but contract '$cid' is '$($c['contract_version'])'"
        }
        if ([string]$e.semantic_hash -ne $contractHashes[$cid]) {
            Add-Finding "RWG-204" "CONTRACT_VERSION_MISMATCH: edge $eDesc semantic_hash does not match the normalized contract '$cid'"
        }

        # assertion source present (RWG-207)
        if ($null -eq $e.source -or [string]$e.source -eq '') {
            Add-Finding "RWG-207" "UNDECLARED_EDGE: edge $eDesc has no assertion source (annotation/frontmatter/manifest/scan/manual)"
        }

        # duplicated inverse edge (RWG-206): same predicate in both directions
        $key = "$($e.type)|$($e.from)|$($e.to)"
        $revKey = "$($e.type)|$($e.to)|$($e.from)"
        if ($edgePairs.ContainsKey($revKey)) {
            Add-Finding "RWG-206" "DIRECT_NODE_REFERENCE: edge $eDesc duplicates the inverse of an existing '$($e.type)' edge — inverse navigation is a query, never a second reverse edge"
        }
        if ($edgePairs.ContainsKey($key)) {
            Add-Finding "RWG-208" "DUPLICATE_ASSERTION: edge $eDesc appears more than once in the graph"
        }
        $edgePairs[$key] = $true
    }
}

# --- Manifest assertions (RWG-208, RWG-209) ---------------------------------------

$manifestAssertions = @{}
$docsDir = Join-Path $rootPath "docs"
if (Test-Path $docsDir) {
    foreach ($mf in (Get-ChildItem -Path $docsDir -Recurse -File -Filter "manifest.yaml" | Where-Object { $_.FullName -notmatch 'registry' })) {
        $m = Get-DataFile $mf.FullName
        $ownerId = [string]$m['entity_id']
        if ($null -ne $m['edges']) {
            foreach ($a in $m['edges']) {
                $pred = [string]$a['predicate']
                $to = [string]$a['to']
                $key = "$pred|$ownerId|$to"
                if ($manifestAssertions.ContainsKey($key)) {
                    Add-Finding "RWG-208" "DUPLICATE_ASSERTION: '$ownerId -[$pred]-> $to' asserted in both '$($manifestAssertions[$key])' and '$($mf.FullName)'"
                } else {
                    $manifestAssertions[$key] = $mf.FullName
                }
                $acid = [string]$a['contract_id']
                if (-not $contracts.ContainsKey($acid)) {
                    Add-Finding "RWG-209" "ASSERTION_CONTRACT_MISMATCH: manifest '$($mf.FullName)' asserts '$key' against unknown contract '$acid'"
                } elseif ([string]$a['contract_version'] -ne [string]$contracts[$acid]['contract_version']) {
                    Add-Finding "RWG-209" "ASSERTION_CONTRACT_MISMATCH: manifest '$($mf.FullName)' asserts '$key' at contract_version '$($a['contract_version'])' but contract '$acid' is '$($contracts[$acid]['contract_version'])'"
                }
            }
        }
    }
}

# --- Report ------------------------------------------------------------------------

$result = @{
    generated_by = "rwang:validate-graph"
    root         = $rootPath
    ok           = ($findings.Count -eq 0)
    finding_count = $findings.Count
    findings     = @($findings)
}
$result | ConvertTo-Json -Depth 6

if ($findings.Count -gt 0) { exit 1 } else { exit 0 }
