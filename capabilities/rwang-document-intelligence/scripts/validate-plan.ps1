<#
.SYNOPSIS
    RWANG Execution Plan validator - checks a PlanEnvelope JSON against an
    execution-mode catalog before it is handed to the target system's dry-run.

.DESCRIPTION
    Companion to the rwang:exec-plan skill. Validates the closed vocabulary
    (modes, subtypes, metric keys), code integrity, and schemaVersion 1.2
    requirements. This is a PRE-FLIGHT check - the target system's own
    validator/dry-run (e.g. Zuri PlanEnvelope Zod validation) remains the
    final authority.

    Finding codes:
      PLN-101 UNKNOWN_MODE            executionMode not in the catalog
      PLN-102 CONTRACT_MISMATCH       progressStrategy / executionModeId /
                                      executionContractId disagree with catalog
      PLN-103 INVALID_CONTAINER_SUBTYPE
      PLN-104 INVALID_ITEM_SUBTYPE
      PLN-105 UNKNOWN_METRIC_KEY      metric key foreign to the workstream's mode
      PLN-106 CODE_INTEGRITY          duplicate codes / unresolved parentCode or
                                      containerCode
      PLN-107 MISSING_V12_FIELDS      schemaVersion 1.2 requirements absent
      PLN-108 DEPENDENCY_INVALID      unknown dependency type or unresolved refs

.PARAMETER PlanPath
    Path to the PlanEnvelope JSON file.

.PARAMETER CatalogPath
    Execution-mode catalog (default: references/execution-modes/zuri-v2.catalog.json
    next to this plugin). Always regenerate from the target project's registry
    when one exists - the target wins.
#>

param(
    [Parameter(Mandatory = $true)][string]$PlanPath,
    [string]$CatalogPath = ""
)

$ErrorActionPreference = "Stop"

if ($CatalogPath -eq "") {
    $CatalogPath = Join-Path (Split-Path -Parent $PSScriptRoot) "references\execution-modes\zuri-v2.catalog.json"
}

$catalog = Get-Content -LiteralPath $CatalogPath -Raw | ConvertFrom-Json
$plan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json

$modesByAlias = @{}
foreach ($m in $catalog.modes) { $modesByAlias[[string]$m.executionMode] = $m }
$dependencyTypes = @($catalog.envelope.dependency_types)

$findings = New-Object System.Collections.ArrayList
function Add-Finding([string]$Code, [string]$Message) {
    [void]$findings.Add(@{ code = $Code; message = $Message })
}

# --- Envelope basics ---------------------------------------------------------

$schemaVersion = [string]$plan.schemaVersion
if (@($catalog.envelope.schema_versions) -notcontains $schemaVersion) {
    Add-Finding "PLN-107" "MISSING_V12_FIELDS: schemaVersion '$schemaVersion' is not one of $(@($catalog.envelope.schema_versions) -join ', ')"
}
if ($null -eq $plan.project -or [string]$plan.project.code -eq '' -or [string]$plan.project.name -eq '') {
    Add-Finding "PLN-106" "CODE_INTEGRITY: project.code and project.name are required"
}
if ($null -eq $plan.workstreams -or @($plan.workstreams).Count -eq 0) {
    Add-Finding "PLN-106" "CODE_INTEGRITY: at least one workstream is required"
}

$isV12 = ($schemaVersion -eq "1.2")
if ($isV12) {
    if ($null -eq $plan.trace -or [string]$plan.trace.correlationId -eq '' -or [string]$plan.trace.idempotencyKey -eq '') {
        Add-Finding "PLN-107" "MISSING_V12_FIELDS: schemaVersion 1.2 requires trace.correlationId and trace.idempotencyKey"
    }
    if ($null -eq $plan.domainBinding -or [string]$plan.domainBinding.primaryDomainId -eq '' -or $null -eq $plan.domainBinding.technicalOwnerDomainId) {
        Add-Finding "PLN-107" "MISSING_V12_FIELDS: schemaVersion 1.2 requires domainBinding (primaryDomainId, supportingDomainIds, technicalOwnerDomainId)"
    }
    if ($null -eq $plan.identityRefs) {
        Add-Finding "PLN-107" "MISSING_V12_FIELDS: schemaVersion 1.2 requires identityRefs"
    }
}

# --- Workstreams -------------------------------------------------------------

$allCodes = @{}   # code -> kind, for dependency resolution
function Register-Code([string]$Code, [string]$Kind, [string]$Context) {
    if ($Code -eq '') { return }
    if ($allCodes.ContainsKey($Code)) {
        Add-Finding "PLN-106" "CODE_INTEGRITY: code '$Code' ($Kind in $Context) duplicates an existing $($allCodes[$Code])"
    } else {
        $allCodes[$Code] = $Kind
    }
}

foreach ($ws in @($plan.workstreams)) {
    $wsCode = [string]$ws.code
    Register-Code $wsCode "workstream" "plan"
    $mode = [string]$ws.executionMode

    if (-not $modesByAlias.ContainsKey($mode)) {
        Add-Finding "PLN-101" "UNKNOWN_MODE: workstream '$wsCode' uses executionMode '$mode' which is not in the catalog"
        continue
    }
    $cm = $modesByAlias[$mode]

    if ([string]$ws.progressStrategy -ne [string]$cm.progressStrategy) {
        Add-Finding "PLN-102" "CONTRACT_MISMATCH: workstream '$wsCode' ($mode) declares progressStrategy '$($ws.progressStrategy)' but the catalog requires '$($cm.progressStrategy)'"
    }
    if ($isV12) {
        if ([string]$ws.executionModeId -eq '' -or [string]$ws.executionContractId -eq '' -or [string]$ws.contractVersion -eq '') {
            Add-Finding "PLN-107" "MISSING_V12_FIELDS: workstream '$wsCode' requires executionModeId, executionContractId, contractVersion at schemaVersion 1.2"
        } else {
            if ([string]$ws.executionModeId -ne [string]$cm.executionModeId) {
                Add-Finding "PLN-102" "CONTRACT_MISMATCH: workstream '$wsCode' executionModeId '$($ws.executionModeId)' does not match catalog '$($cm.executionModeId)'"
            }
            if ([string]$ws.executionContractId -ne [string]$cm.executionContractId) {
                Add-Finding "PLN-102" "CONTRACT_MISMATCH: workstream '$wsCode' executionContractId '$($ws.executionContractId)' does not match catalog '$($cm.executionContractId)'"
            }
        }
    }

    # containers
    $containerCodes = @{}
    foreach ($c in @($ws.containers)) {
        $cCode = [string]$c.code
        Register-Code $cCode "container" $wsCode
        $containerCodes[$cCode] = $true
        if (@($cm.containerSubtypes) -notcontains [string]$c.subtype) {
            Add-Finding "PLN-103" "INVALID_CONTAINER_SUBTYPE: '$($c.subtype)' on container '$cCode' - $mode allows: $(@($cm.containerSubtypes) -join ', ')"
        }
    }
    foreach ($c in @($ws.containers)) {
        $parent = [string]$c.parentCode
        if ($parent -ne '' -and -not $containerCodes.ContainsKey($parent)) {
            Add-Finding "PLN-106" "CODE_INTEGRITY: container '$($c.code)' references unknown parentCode '$parent'"
        }
    }

    # items
    foreach ($it in @($ws.items)) {
        $iCode = [string]$it.code
        Register-Code $iCode "item" $wsCode
        if (@($cm.itemSubtypes) -notcontains [string]$it.subtype) {
            Add-Finding "PLN-104" "INVALID_ITEM_SUBTYPE: '$($it.subtype)' on item '$iCode' - $mode allows: $(@($cm.itemSubtypes) -join ', ')"
        }
        $ic = [string]$it.containerCode
        if ($ic -ne '' -and -not $containerCodes.ContainsKey($ic)) {
            Add-Finding "PLN-106" "CODE_INTEGRITY: item '$iCode' references unknown containerCode '$ic'"
        }
        if ($null -ne $it.metrics) {
            foreach ($mk in $it.metrics.PSObject.Properties.Name) {
                if (@($cm.metricKeys) -notcontains $mk) {
                    Add-Finding "PLN-105" "UNKNOWN_METRIC_KEY: '$mk' on item '$iCode' - $mode allows: $(@($cm.metricKeys) -join ', ')"
                }
            }
        }
    }

    foreach ($ms in @($ws.milestones)) { Register-Code ([string]$ms.code) "milestone" $wsCode }
    foreach ($g in @($ws.gates)) { Register-Code ([string]$g.code) "gate" $wsCode }
}

# --- Dependencies ------------------------------------------------------------

foreach ($dep in @($plan.dependencies)) {
    if ($dependencyTypes -notcontains [string]$dep.type) {
        Add-Finding "PLN-108" "DEPENDENCY_INVALID: type '$($dep.type)' - allowed: $($dependencyTypes -join ', ')"
    }
    foreach ($refName in @("sourceRef", "targetRef")) {
        $ref = [string]$dep.$refName
        if ($ref -ne '' -and -not $allCodes.ContainsKey($ref)) {
            Add-Finding "PLN-108" "DEPENDENCY_INVALID: $refName '$ref' does not resolve to any workstream/container/item/milestone/gate code"
        }
    }
}

# --- Report ------------------------------------------------------------------

$result = @{
    generated_by  = "rwang:validate-plan"
    plan          = (Resolve-Path $PlanPath).Path
    catalog       = (Resolve-Path $CatalogPath).Path
    ok            = ($findings.Count -eq 0)
    finding_count = $findings.Count
    findings      = @($findings)
}
$result | ConvertTo-Json -Depth 6

if ($findings.Count -gt 0) { exit 1 } else { exit 0 }
