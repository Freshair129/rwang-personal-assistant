---
name: exec-plan
description: Compose a machine-executable Execution Plan (PlanEnvelope JSON) from a gap analysis, roadmap, or implementation plan — structured into workstreams with one of the seven execution modes each (SOFTWARE_SPRINT, DATA_MIGRATION, B2B_SALES, B2C_CAMPAIGN, PRODUCT_LAUNCH, OPERATIONS, BUSINESS_EXPANSION), validated against the target system's mode catalog, and importable into a Zuri-compatible UI for interactive tracking.
version: 1.0.0
---

# RWANG / exec-plan — Execution Plan Composer

Turn analysis into a plan a system can **run**, not just a document a human reads. Output is a `PlanEnvelope` JSON that passes the target's dry-run/import and renders as interactive workstreams, containers, items, milestones, and gates in the UI.

## When This Skill Activates

- User asks to "create an execution plan", "build a PlanEnvelope", "make this plan importable/interactive"
- After a gap analysis or `/rwang:implementation-plan` produces work that needs machine-executable structure
- User runs `/rwang:exec-plan`
- Target project uses Zuri Project Manager or any system with an execution-mode catalog

## Core Concepts

### Execution mode belongs to a Workstream

A plan MAY mix modes, but each workstream declares exactly one. The mode is a **contract**: it fixes the progress strategy, allowed container subtypes, item subtypes, and metric evidence keys. Never mix vocabulary across modes — unknown cross-mode vocabulary is rejected by the target.

| executionMode | Strategy | Containers | Items | Typical use |
|---|---|---|---|---|
| `SOFTWARE_SPRINT` | TASK_WEIGHT | SPRINT, EPIC, RELEASE | TASK, BUG | dev work, gap-fix engineering |
| `DATA_MIGRATION` | RECORD_VALIDATION | MIGRATION_STAGE, MIGRATION_BATCH | DATASET, VALIDATION, RECONCILIATION | data/registry migration |
| `B2B_SALES` | WEIGHTED_PIPELINE | SALES_PIPELINE, SALES_STAGE | ACCOUNT, DEAL, ACTIVITY | sales pipelines |
| `B2C_CAMPAIGN` | KPI_ATTAINMENT | CAMPAIGN, CAMPAIGN_WAVE, CHANNEL | CREATIVE, AUDIENCE, EXPERIMENT | marketing campaigns |
| `PRODUCT_LAUNCH` | MILESTONE_READINESS | LAUNCH_PHASE | DELIVERABLE | launches, releases-as-events |
| `OPERATIONS` | SLA_SCORE | OPS_PERIOD, OPS_PROCESS | CHECKLIST_ITEM, ISSUE, SLA | run/maintain work |
| `BUSINESS_EXPANSION` | EXPANSION_READINESS | EXPANSION_INITIATIVE, EXPANSION_SITE | SETUP_ACTION, APPROVAL | new site/market setup |

Full machine catalog: `references/execution-modes/zuri-v2.catalog.json`.

### Catalog resolution — target wins

The vendored `zuri-v2` catalog is a **default**. Before composing:

1. If the target project has its own registry (Zuri: `docs/EXECUTION-MODES.md`, `src/lib/validation/enums.js`, `contracts/plan-envelope.schema.json`), read it and use IT as the catalog. Report any divergence from the vendored catalog — never silently prefer the vendored copy.
2. Never invent an execution mode, subtype, or metric key. A need for new vocabulary is a change proposal to the target project, not a plan-side workaround.

## Process

### Step 1: Intake

Collect the work source: gap-analysis findings, roadmap phases, `/rwang:implementation-plan` output, or user goals. For each unit of work note: what kind of work it is (dev / data / sales / campaign / launch / ops / expansion), its evidence of done, and dependencies.

### Step 2: Partition into workstreams by mode

Group work by **how its progress is measured**, not by team:

- Fix-the-code work → `SOFTWARE_SPRINT` (weight per task; bugs as BUG)
- Move-the-data work → `DATA_MIGRATION` (records processed/validated/reconciled)
- Readiness-gated launches → `PRODUCT_LAUNCH` (DELIVERABLE readiness + gates)
- Recurring run work → `OPERATIONS` (SLA/checklist)
- Revenue pipelines → `B2B_SALES` / `B2C_CAMPAIGN`
- New market/site setup → `BUSINESS_EXPANSION`

One workstream = one mode = one progress strategy. If a group needs two strategies, it is two workstreams.

### Step 3: Compose the PlanEnvelope

Target `schemaVersion: "1.2"` unless the target only supports lower. Required at 1.2:

- `trace.correlationId` + `trace.idempotencyKey` — generate stable values (e.g. `plan:<project-code>:<date>`); reuse the idempotencyKey on re-submission of the SAME plan, change it for a new plan.
- `domainBinding` — primary/supporting/technical-owner domain IDs from the target's domain registry (Zuri: FR-070). Ask the user if not derivable.
- `identityRefs` — **this is the RWANG traceability hook**: put requirement IDs in `reqIds`, verification IDs in `verifyIds`, and doc-graph node/edge IDs in `nodeIds`/`edgeIds` so the plan links back to the document graph.
- Every workstream carries `executionMode` + `executionModeId` + `executionContractId` + `contractVersion` from the catalog.

Structure rules:

- `code` values are stable slugs, unique across the whole plan (they become UI anchors and dependency refs).
- Items reference their container via `containerCode`; containers may nest via `parentCode` (same workstream only).
- `metrics` on an item may ONLY use the mode's metric keys; omit metrics until there is evidence to report (don't fabricate zeros).
- SOFTWARE_SPRINT items carry `weight` (and `plannedWeight` in metrics when known); B2B items may carry `probability` (0..1) and `numericValue`.
- Dependencies use `BLOCKS` / `REQUIRES` / `RELATES_TO` / `START_AFTER` / `FINISH_BEFORE` between registered codes.
- Link each item to its source evidence via `externalRefs` (e.g. `{"system": "rwang-doc-graph", "id": "req:dom:FR-a01001"}` or a finding ID from a gap analysis).

### Step 4: Self-validate before handing off

```powershell
.\scripts\validate-plan.ps1 -PlanPath <plan.json> [-CatalogPath <catalog.json>]
```

Fails with `PLN-1xx` codes on: unknown mode (101), contract/strategy mismatch (102), invalid container/item subtype (103/104), foreign metric key (105), duplicate/unresolved codes (106), missing 1.2 fields (107), invalid dependencies (108). Fix every finding — a plan that fails preflight will fail the target's dry-run.

### Step 5: Hand off to the target

The target system's validator is the final authority. For Zuri: submit the envelope through its plan import (dry-run first), then confirm the workstreams render and are interactive in the UI. Report the dry-run result verbatim; never mark the plan delivered on preflight alone.

### Step 6 (optional): Human-readable companion

Also emit a markdown summary (workstreams → containers → items with weights/dependencies) for review. The JSON is canonical; the markdown is a projection and says so in its header.

## Minimal example (two modes)

```json
{
  "schemaVersion": "1.2",
  "generatedBy": "rwang:exec-plan",
  "project": { "code": "GAP-CLOSE-2026Q3", "name": "Close spec-vs-code gaps" },
  "trace": { "correlationId": "plan:GAP-CLOSE-2026Q3:2026-08-20", "idempotencyKey": "plan:GAP-CLOSE-2026Q3:v1" },
  "domainBinding": { "primaryDomainId": "DOMAIN-PM", "supportingDomainIds": [], "technicalOwnerDomainId": "DOMAIN-PM" },
  "identityRefs": { "reqIds": ["FR-069", "FR-070"] },
  "workstreams": [
    {
      "code": "WS-DEV", "name": "Contract alignment fixes",
      "executionMode": "SOFTWARE_SPRINT", "executionModeId": "EXM-SOFTWARE-SPRINT",
      "executionContractId": "EXC-SOFTWARE-SPRINT-V1", "contractVersion": "1.0",
      "progressStrategy": "TASK_WEIGHT",
      "containers": [{ "code": "S1", "subtype": "SPRINT", "title": "Sprint 1" }],
      "items": [{ "code": "T1", "containerCode": "S1", "subtype": "TASK", "title": "Align enums.js with schema", "weight": 3, "externalRefs": [{ "system": "gap-analysis", "id": "F-01" }] }]
    },
    {
      "code": "WS-MIG", "name": "Registry backfill",
      "executionMode": "DATA_MIGRATION", "executionModeId": "EXM-DATA-MIGRATION",
      "executionContractId": "EXC-DATA-MIGRATION-V1", "contractVersion": "1.0",
      "progressStrategy": "RECORD_VALIDATION",
      "containers": [{ "code": "M1", "subtype": "MIGRATION_STAGE", "title": "Backfill stage" }],
      "items": [{ "code": "D1", "containerCode": "M1", "subtype": "DATASET", "title": "Legacy plans", "metrics": { "recordsTotal": 120 } }]
    }
  ],
  "dependencies": [{ "sourceRef": "WS-MIG", "targetRef": "WS-DEV", "type": "START_AFTER" }]
}
```

## Important Rules

- **Closed vocabulary** — modes/subtypes/metric keys come from the catalog; never invent, never borrow across modes
- **Target wins** — regenerate the catalog from the target project's registry when one exists; report divergence
- **Target dry-run is the finish line** — preflight passing is necessary, not sufficient
- **Traceability by default** — every item links to its source (requirement, finding, or graph node) via externalRefs/identityRefs
- **No fabricated evidence** — omit metrics with no data; never invent numbers to make the UI look green
- **Stable idempotency** — same plan resubmitted = same idempotencyKey; new plan = new key
- **Bilingual** — respond in the user's language; keep codes, modes, and JSON keys in English
