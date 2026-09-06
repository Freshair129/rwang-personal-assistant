# Changelog

All notable changes to the RWANG plugin. Versions follow semver; the
`version` field in `.claude-plugin/plugin.json` is the update signal for
marketplace installs.

## [1.4.0] — 2026-09-06

`@tested` reads in both directions, and the scanner says which one it read.

### Added
- **`@tested <ID>, …` on a test file** — "this test verifies these requirements" — alongside the
  existing `@tested <file>` on a source file — "this code is verified by that test". Both assert the
  same `verified_by` relation; they differ only in which end the annotated file is. A project
  maintains its traceability from one side or the other, and the grammar previously understood only
  one of them, so every repository that annotates its tests scanned as having no annotations at all.
  Annotating from the test side is often the more durable choice: the assertion and the claim it
  verifies sit in one file, so deleting the test takes its claim with it.
- **`form` on every structured annotation** — `test-ref`, `requirement`, or `section`. It describes
  what the payload *is*, not which keyword introduced it, which is the distinction a consumer needs:
  `@designs` already took either a section or an id, and `@tested` now takes either a path or ids.
  Switching on the keyword alone meant re-parsing the value to find out what you were holding.
- Tests: both `@tested` forms, `form` classification across `@req` / `@designs` / `@tested`, and a
  payload that is neither a path nor an id being refused. The cross-scanner parity check covers the
  new form.

### Changed
- `scan-annotations.sh` accepts the same two payloads, so the two halves still agree. Verified on a
  real repository: `src/` 80 annotations / 76 ids and `tests/` 69 / 70, identical from both scanners
  — the test tree had read as **0 annotations** in both before this.
- Docs: the annotation table in `skills/doc-graph`, the examples in `README`, the `@tested` check in
  `skills/doc-preflight`, and the `@tested` description in `references/doc-graph-schema.json`.

## [1.3.1] — 2026-09-06

Scanner correctness. `scan-annotations` is the only thing that turns a comment into a graph edge, so
everything it silently drops is a link that never existed as far as every downstream skill is
concerned. None of these failures were reported — each one produced a smaller, confident report.

### Fixed
- **Namespaced ids are captured whole.** `ZPP-FR-009`, `RAG-GR-004`, `TAX-NFR-001`: a project that
  prefixes its ids does so precisely because its `FR-009` is not the flat `FR-009`. The `.sh` scanner
  matched the flat id *inside* the namespaced one and reported `FR-009` — not a lost prefix, a
  different requirement asserted with full confidence. The `.ps1` scanner dropped such ids entirely.
  Both now accept `NS-KIND-nnn`, and `AI-AGT-001` / `AI-ETH-001` fall out of the same branch.
- **The skip list matches directories, not substrings** (`.ps1`). It was compared against the whole
  path, so `build` swallowed `builder.ts`, `dist` swallowed `distance.ts`, and `venv` swallowed
  anything below a folder whose name merely contained the letters. Those files reported nothing and
  were never listed as skipped.
- **One unrecognised id no longer discards its neighbours** (`.ps1`). `@spec FR-093, ADR-058` lost
  `FR-093` too, because `ADR` is not an enumerated kind and the pattern had to consume the whole
  line. The annotation was never flagged as malformed — it simply vanished.
- **A UTF-8 BOM no longer hides the first line** (`.sh`). Windows editors and
  `Set-Content -Encoding utf8` write one, and every `^`-anchored pattern failed on line 1 — which is
  where a file-level annotation goes. `Get-Content` strips it, so the two scanners disagreed by one
  line per file and neither looked wrong on its own machine.
- **An annotation-free tree is an empty report, not a crash** (`.sh`). Under `set -euo pipefail` the
  grep that matched nothing ended the script before it printed anything; the count it would have
  printed was a doubled zero, since `grep -c .` both prints `0` and exits non-zero.

### Changed
- `.sh` now requires a comment prefix for structured annotations and the ids-only form for
  unstructured ones, matching `.ps1`. It had been counting `const s = "@req FR-999"` as an
  annotation and any line merely containing an id as a reference.
- `.sh` validates the `@tested` payload as a test-file reference, as `.ps1` always has.

### Added
- Tests: namespaced ids captured whole and never truncated, skip-list-word filenames scanned,
  mixed known/unknown id lists, an empty tree, and a **cross-scanner parity check** — the two halves
  of one tool must agree on the same tree, or a graph built on Windows differs from the same graph
  built on Linux and neither is locally wrong.

## [1.3.0] — 2026-08-20

New skill package: **exec-plan** — machine-executable Execution Plans.

### Added
- `skills/exec-plan`: compose a `PlanEnvelope` JSON from a gap analysis / roadmap / implementation plan; workstreams typed by one of **7 execution modes** (SOFTWARE_SPRINT, DATA_MIGRATION, B2B_SALES, B2C_CAMPAIGN, PRODUCT_LAUNCH, OPERATIONS, BUSINESS_EXPANSION), each fixing its progress strategy, container/item subtypes, and metric evidence keys. Output imports into a Zuri-compatible UI for interactive tracking; traceability hooks link items back to the RWANG doc graph (`identityRefs.reqIds`, `externalRefs`).
- `references/execution-modes/zuri-v2.catalog.json`: vendored mode catalog (from Zuri EXECUTION-MODES.md / FR-069 / FR-070); **target project's own registry always wins**.
- `scripts/validate-plan.ps1`: plan preflight with `PLN-101..108` findings (unknown mode, contract mismatch, foreign subtype/metric key, code integrity, schemaVersion 1.2 requirements, dependency validity).
- Tests: 13 mutation cases; the golden fixture is verified VALID against Zuri's real `contracts/plan-envelope.schema.json` (ajv).

### Rules carried over from the graph core
- Closed vocabulary (never invent modes/subtypes/keys), target dry-run is the final authority, no fabricated metrics, stable idempotency keys.

## [1.2.0] — 2026-08-20

Implements SPEC-5DRIVEN-01 Revision A4: **name-only filename mode** — filenames carry only the human name (`queue_management.md`); identity travels in-file and binds through the Registry.

### Added
- Profile field `filename_convention: id-prefixed | name-only` (default `id-prefixed`; the `5-driven-domain` reference profile now uses `name-only`).
- In-file identity declarations: frontmatter `id: FEAT-a01` for `.md`, `%% @id FEAT-a01:sequence` for `.mmd` — scanner support in both `.ps1` (strict, frontmatter-only) and `.sh`.
- Registry entry `label` field: the display name (`queue_management`) is data, never identity — labels rename freely, IDs never change.
- Validator `RWG-109 IDENTITY_BINDING_MISMATCH`: a discovered entity whose path disagrees with the Registry's `canonical_path` for that ID fails loudly instead of silently rebinding.
- Feature-scoped diagram/test-spec ID convention for name-only projects (`diag:FEAT-a01:sequence`) — path changes never churn identity.
- Tests: 23 validator cases + doc-id frontmatter scanner cases.

### Clarified
- `FEAT-a01` reads as *[type]-[domain-letter][running no]* ("feature 01 under domain a") — the letter is a human mnemonic only; authoritative membership is `parent_domain_id`.

## [1.1.1] — 2026-08-20

Implements SPEC-5DRIVEN-01 Revision A3 (rename/alias/prefix-collision rules), driven by the BikeOps migration's `DOM-01--` → `DOM-a--` folder-rename proposal.

### Added
- Validator: alias support in reconciliation — adapter inputs (discovery/traceability) may reference `aliases`; Core resolves them to primary IDs. The canonical graph must contain primary IDs only.
- Validator collision checks (all `RWG-106`): alias vs entity_id / alias vs alias, duplicate `canonical_path`, and **prefix-ambiguous IDs** in name-based namespaces (`dom:`, `feat:`, `req:`, `rel:`) — e.g. `dom:DOM-01` vs `dom:DOM-011`.
- Test suite: 4 new mutation cases (22 total) + scanner boundary test (`FR-001` never matches inside `FR-a01001`).

### Clarified (SPEC §2.1, A3)
- Folder renames change `canonical_path` only — stable IDs never derive from folder names; the domain letter in `FR-a01001` is naming convention, membership comes from `parent_domain_id`.
- Changing a stable ID is a migration: new entry aliases the old ID.

## [1.1.0] — 2026-08-20

Implements [CR-2026-08-20-01 (A2, approved)](docs/cr/CR-2026-08-20-01-diagram-test-and-5driven-traceability.md).

### Breaking — graph schema 2.0.0
- Node `id` pattern gains `dom:`, `feat:`, `diag:`, `testspec:`, `rel:` prefixes; requirement IDs are namespaced (`req:<ns>:<ID>`).
- New node types: `domain`, `feature`, `diagram`, `test_spec`, `release`.
- Edge predicate `stale` **removed** — staleness is `status: "stale"` on the semantic edge.
- Every edge now requires `contract_id`, `contract_version`, `semantic_hash`.
- Graph header requires `source_ref` + `provenance`; single writer (`rwang:doc-graph`).
- `implements` edges must originate from `code_file` nodes; generated artifacts are never evidence sources.
- Graphs written against schema 1.x are readable in explicit `legacy` mode only.

### Added
- Closed-world Entity Registry (`docs/registry/`): `entity-types.yaml`, entity entries with lifecycle status + provenance, versioned Edge Contracts.
- Normative schemas: `references/entity-registry-schema.json`, `edge-contract-schema.json`, `profile-schema.json`, `node-manifest-schema.json`.
- View profiles with explicit `required` / `optional` / `not_applicable` declarations; reference profiles in `references/profiles/` (`5-driven-domain`, `flat-prd-sdd`, `ieee-full`, `microservices`).
- Node manifests (outgoing edge assertions only; no upstream/downstream file pairs).
- New canonical predicates: `contains`, `defines`, `guides`, `visualized_by`, `verified_by`, `refines`, `supersedes` (dual-label, single edge), `applies_to` (release binding, profile-gated).
- Core validator `scripts/validate-graph.ps1`: contract validation + exact-set reconciliation (`RWG-101..108`, `RWG-201..209`), semantic-hash normalization (`-Mode hash`), no-VCS mode via content-digest `source_ref`.
- Acceptance fixture `tests/fixtures/mini-5driven/` + mutation suite `tests/validate-graph.tests.ps1` (18 cases).
- Scanner support for `.mmd` (`%% @req` / `%% @spec` / `%% @diagram_type`), `.test.md` frontmatter, and 5-driven IDs (`FR-a01001`, `FEAT-a01`) in both `.ps1` and `.sh`.
- `doc-preflight` Checks #11–#16; profile-owned trust hierarchy.

### Changed
- `doc-graph` skill: registry-first process, validate-then-project (Hybrid IR), exact-set reconciliation gate, manual edges must pass contract validation, incremental updates only when reconciled.
- `doc-architect` skill: generates Registry/Contracts/manifests before scaffolding; never writes the graph itself.
- Coverage stats are `{covered, total}` ID-set counts, never percentage strings.

## [1.0.2] — 2026-08

- Codex adapter (`.codex-plugin/plugin.json`) and `rwang-self-audit` skill.
- Annotation-grammar hardening in `scan-annotations.ps1` (comments only, prose rejected) + test suite.

## [1.0.0] — 2026-08

- Initial release: `doc-architect`, `doc-preflight`, `doc-graph`, `implementation-plan`, `subagent-driven` skills; drift-check hook; annotation scanners.
