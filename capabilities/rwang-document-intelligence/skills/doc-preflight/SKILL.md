---
name: doc-preflight
description: Run a comprehensive health check on project documentation — detect missing sections, internal contradictions, stale references, broken doc-code links, requirement coverage gaps, uncontracted graph edges, unregistered entities, unversioned semantic changes, and graph/registry drift. Use before releases, after major changes, or as a periodic documentation audit.
version: 1.1.0
---

# RWANG / doc-preflight — Document Health Check

Scan all project documentation for completeness, contradictions, staleness, and coverage gaps.

## When This Skill Activates

- User asks to "check docs", "verify documentation", "doc health check"
- User asks "are my docs complete?", "any contradictions?", "is anything stale?"
- Before a release or milestone
- After importing or refactoring documentation
- User runs `/rwang:doc-preflight`

## Trust Hierarchy (profile-owned)

When contradictions are found, resolve them using the **active profile's declared hierarchy** (`trust_hierarchy` in the profile manifest — see `references/profile-schema.json`). The hierarchy is a profile declaration, not a Core constant.

**Default** (when no profile declares otherwise):

```
Code (source of truth) > SDD (design intent) > PRD (business requirements)
```

**Rationale for the default**: Code is what actually runs. SDD is what was designed. PRD is what was requested. If they disagree, the downstream artifact is more "true" because it reflects what was actually built/designed.

A diagram-first or test-first profile (e.g. `5-driven-domain` during pre-implementation phases) MAY declare a different order such as `Test Spec > Diagram > Spec > Code`. Always name the winning source in findings.

## Pre-flight Checks

Run all checks in order. Each check produces findings with severity:

| Severity | Meaning | Action |
|----------|---------|--------|
| 🔴 **CRITICAL** | Blocks release / causes harm | Must fix before proceeding |
| 🟠 **WARNING** | Inconsistency or gap | Should fix soon |
| 🟡 **INFO** | Minor improvement | Fix when convenient |
| ⚪ **PASS** | Check passed | No action needed |

### Check 1: Document Existence & Structure

Verify required documents exist based on the project's template (read from `docs/.doc-graph.json` or detect from directory structure).

**For 3-Layer + Appendix**:
```
Required:
  ✅/❌ docs/PRD-SDD-v*.md (or equivalent main document)
  ✅/❌ docs/appendices/ directory
  ✅/❌ docs/ARCHITECTURE.md (or ADRs)
  ✅/❌ CLAUDE.md or equivalent AI guide

Recommended:
  ✅/❌ docs/CONTRIBUTING.md
  ✅/❌ docs/api/README.md
  ✅/❌ README.md (project root)
  ✅/❌ .editorconfig
```

**Severity**: Missing required = 🔴, missing recommended = 🟡

### Check 2: Document Control Completeness

For each document, verify:

```
✅/❌ Has version number
✅/❌ Has last-updated date
✅/❌ Has author(s)
✅/❌ Has status (Draft/Review/Approved/Deprecated)
✅/❌ Has version history table
✅/❌ Has referenced standards (if applicable)
```

**Severity**: Missing version/date = 🟠, missing author = 🟡

### Check 3: Section Completeness

Scan each document for expected sections based on its type.

**PRD sections** (Layer 1):
```
✅/❌ Executive Summary
✅/❌ Scope & Boundaries
✅/❌ Stakeholders / Personas
✅/❌ Use Cases (at least 3)
✅/❌ Functional Requirements (with FR-xxx IDs)
✅/❌ Non-Functional Requirements (with NFR-xxx IDs)
✅/❌ Business Rules
✅/❌ Acceptance Criteria
```

**SDD sections** (Layer 2):
```
✅/❌ Architecture Overview (with diagram)
✅/❌ Tech Stack
✅/❌ Component Design
✅/❌ API Design
✅/❌ Database Design
✅/❌ Security Architecture
✅/❌ Infrastructure & Deployment
✅/❌ Error Handling Strategy
✅/❌ Testing Strategy
✅/❌ Observability
```

**AI System sections** (Layer 3, if AI/ML project):
```
✅/❌ Agent Architecture
✅/❌ Individual Agent Specs (at least 1)
✅/❌ Model Lifecycle Management
✅/❌ Data Pipeline
✅/❌ AI Ethics & Governance
✅/❌ Prompt Engineering Guidelines
```

**Severity**: Missing critical section = 🟠, missing optional = 🟡

### Check 4: Requirement ID Coverage

Scan all documents and code for requirement IDs. Check:

```
1. All FR-xxx referenced in code have definitions in docs
2. All FR-xxx defined in docs are referenced somewhere in code
3. No duplicate IDs (FR-001 defined in two places)
4. No gaps in ID sequences (FR-001, FR-002, FR-004 — where's FR-003?)
5. Cross-reference consistency (FR-001 in PRD matches FR-001 in traceability matrix)
```

**How to scan code**:
```bash
# Find all requirement references in code
grep -rn "@req\|@spec\|FR-\|NFR-\|SDD-\|SEC-\|AI-AGT-\|AI-ETH-\|BR-\|AC-" \
  --include="*.ts" --include="*.tsx" --include="*.py" --include="*.go" \
  --include="*.java" --include="*.rs" \
  src/ app/ backend/ frontend/
```

**How to scan docs**:
```bash
grep -rn "FR-\|NFR-\|SDD-\|SEC-\|AI-AGT-\|AI-ETH-\|BR-\|AC-" docs/
```

**Severity**:
- Defined in docs but never in code = 🟠 (unimplemented requirement)
- Referenced in code but not in docs = 🔴 (undocumented requirement)
- Duplicate IDs = 🔴

### Check 5: Internal Contradictions

Look for contradictions within and across documents:

**Within a document**:
- Same requirement described differently in two sections
- Architecture diagram shows component X but component design section doesn't mention X
- NFR says "< 3s response time" in one place and "< 5s" in another

**Across documents**:
- PRD says feature A is required, SDD doesn't design for it
- SDD specifies PostgreSQL, deployment doc references MongoDB
- API spec has endpoint `/v1/users` but backend code has `/api/users`
- Frontend design system says color `#6D4AEF` but code uses `#7C5AFF`

**Detection strategy**:
1. Extract all named entities (technologies, endpoints, colors, sizes, timeouts)
2. Build a set of claims per entity
3. Flag when claims conflict

**Severity**: Technical contradictions = 🔴, style/naming contradictions = 🟠

### Check 6: Staleness Detection

Check for stale documentation by comparing doc claims against actual code:

```
For each doc claim:
  1. Find the code it references
  2. Check git log for that code file
  3. If code changed AFTER doc's last-updated date → STALE

Specific checks:
  - API endpoints in docs vs actual route definitions
  - Database schema in docs vs actual model definitions
  - Package versions in docs vs package.json/requirements.txt
  - Architecture diagrams vs actual directory structure
  - Config values in docs vs actual config files
```

**Severity**:
- Stale API docs = 🔴 (breaks consumers)
- Stale architecture diagram = 🟠
- Stale version numbers = 🟡

### Check 7: Broken Cross-References

Check all internal links and references:

```
✅/❌ Markdown links [text](path) — target exists?
✅/❌ Section references (§5.3) — section exists?
✅/❌ Requirement cross-refs (see FR-001) — ID exists?
✅/❌ Diagram references ("as shown in Figure 3") — figure exists?
✅/❌ Appendix references ("see Appendix B") — appendix exists?
```

**Severity**: Broken links = 🟠, broken section refs = 🟡

### Check 8: Doc-Code Symlink Health

If the project uses structured annotations (@req, @spec, @designs, @tested), check:

```
1. Annotations reference valid requirement IDs
2. @tested annotations resolve: a test reference names a file that exists; requirement IDs
   on a test file are registered
3. @designs annotations point to existing design doc sections
4. No orphaned annotations (referencing deleted requirements)
```

**Severity**: Invalid annotation refs = 🟠, orphaned = 🟡

### Check 9: Diagram Validation

For Mermaid diagrams in documentation:

```
✅/❌ Diagram syntax is valid (would render without errors)
✅/❌ Nodes in diagrams match entities described in text
✅/❌ State machines have all transitions documented
✅/❌ Sequence diagrams reference actual API endpoints
```

**Severity**: Invalid syntax = 🟠, mismatched entities = 🟡

### Check 10: Glossary Completeness

If a glossary exists:
```
1. All technical terms used in docs appear in glossary
2. No glossary entries are unused (dead definitions)
3. Acronyms are defined on first use in each document
```

**Severity**: Undefined terms = 🟡, unused definitions = ⚪

### Check 11: Visual Model Coverage (`visual-model-coverage`)

For every feature spec matching the **profile-configured complexity heuristics** (`check_config.visual_model_keywords` in the profile manifest — e.g. the `5-driven-domain` defaults `ws`, `emit`, `broadcast`, `buffer`, `timeout`, `session`; never hard-coded in Core), check that a corresponding `_sequence.mmd` or `_state.mmd` exists in `diagrams/`.

**Severity**: 🟠 WARNING
**Remediation**: Report the gap. Scaffold a boilerplate Mermaid file from `DIAGRAM_GUIDELINES.md` templates **only when the user explicitly authorizes document generation**.

### Check 12: Acceptance Test Coverage (`test-spec-coverage`)

For every requirement, check for at least one accepted verification source. The active profile decides (`check_config.verification_sources`) whether `.test.md` specs, automated tests, or both are required.

**Severity**: 🟠 WARNING
**Remediation**: Report the missing verification source; scaffold a test specification only when the user authorizes document generation.

### Check 13: Edge Contract Coverage (`edge-contract-coverage`)

Every graph edge has a registered contract, valid endpoint types, canonical predicate, matching `contract_version` and `semantic_hash`, and exactly one from-side assertion source. Applies equally to `source: manual` edges. `implements` edges originate from `code_file` nodes only; generated artifacts are never evidence sources.

**Severity**: 🔴 CRITICAL — maps to `RWG-201..204`, `RWG-206..209`
**Remediation**: Register or select the correct contract and fix the assertion source; never fall back to a direct node reference.

### Check 14: Entity Registry Closure (`entity-registry-closure`)

Every discovered or referenced entity is registered; every active registry entry has a valid source projection; every agent-actor registry mutation carries `approval_ref`.

**Severity**: 🔴 CRITICAL — maps to `RWG-101`, `RWG-102`, `RWG-107`
**Remediation**: Register the entity, or explicitly deprecate/remove the registry entry with provenance. Never auto-register.

### Check 15: Semantic-Diff Gate (`semantic-diff-gate`)

A breaking contract change (endpoint types, direction, predicate meaning, required fields, cardinality, ID namespace) has a new `contract_version` and migration evidence. Governed document changes carry a `doc_version` bump. Raw text similarity is not semantic validation.

**Severity**: 🔴 CRITICAL — maps to `RWG-205`, `RWG-108`
**Remediation**: Create a versioned contract migration / bump `doc_version`, or restore the previous approved state.

### Check 16: Graph Source Reconciliation (`graph-source-reconciliation`)

Registry, filesystem discovery, manifest assertions, graph nodes, and traceability outputs have equal stable-ID sets for the active profile's required views, and the graph header `source_ref` matches the current checkout (content-digest in no-VCS workspaces). Compare by ID sets, never by counts. Views declared `not_applicable` by the profile are excluded and reported as "declared absent" — which is distinct from empty coverage.

**Severity**: 🔴 CRITICAL — maps to `RWG-103..106`
**Remediation**: Regenerate projections from the merged checkout; report missing, orphaned, duplicate, or unregistered entities per ID.

**Execution note**: Checks #13–#16 are implemented by `scripts/validate-graph.ps1 -Root <project>` (JSON findings with `RWG-*` codes, non-zero exit on any finding) — run it instead of re-deriving the checks manually.

## Output Format

### Summary Dashboard

```markdown
# 📋 RWANG Doc Pre-flight Report

**Project**: [name]
**Date**: [today]
**Documents scanned**: [count]
**Code files scanned**: [count]

## Summary

| Check | Status | Findings |
|-------|--------|----------|
| Document Existence | ✅ PASS | 8/8 required docs present |
| Document Control | 🟠 WARN | 2 docs missing version history |
| Section Completeness | 🟠 WARN | Layer 3 missing ethics section |
| Requirement Coverage | 🔴 CRIT | 5 FRs in code with no doc definition |
| Contradictions | ✅ PASS | No contradictions found |
| Staleness | 🟠 WARN | 3 docs stale (code changed after doc) |
| Cross-References | ✅ PASS | All links valid |
| Doc-Code Symlinks | 🟡 INFO | 0 structured annotations found |
| Diagrams | ✅ PASS | 13 diagrams valid |
| Glossary | 🟡 INFO | 4 terms used but not in glossary |
| Visual Model Coverage | 🟠 WARN | 2 complex features lack sequence/state diagrams |
| Test Spec Coverage | 🟠 WARN | 5 requirements have no verification source |
| Edge Contract Coverage | ✅ PASS | 387/387 edges contract-valid |
| Entity Registry Closure | 🔴 CRIT | 1 unregistered feature (RWG-101) |
| Semantic-Diff Gate | ✅ PASS | No unversioned breaking changes |
| Graph Source Reconciliation | 🔴 CRIT | Graph stale vs merged checkout (RWG-103) |

**Overall**: 🔴 **CRIT** — graph publication blocked until RWG findings are resolved

## Critical Findings (must fix)

### CRIT-1: Undocumented requirements in code
**Files**: `backend/app/api/generations.py:45`, `backend/app/ai/agents/orchestrator.py:88`
**IDs**: FR-014, FR-015, AI-AGT-005, AI-AGT-006, SDD-008
**Action**: Add these requirement definitions to PRD-SDD document

### CRIT-2: ...

## Warnings (should fix)

...

## Info (nice to fix)

...

## Recommended Next Steps

1. Run `rwang:doc-graph` to update the document graph
2. Add missing requirement definitions
3. Update stale documents
4. Add @req annotations to frontend code (currently 0)
```

### Machine-Readable Output

Also write findings to `docs/.preflight-report.json`:

```json
{
  "version": "1.0.0",
  "generated_by": "rwang:doc-preflight",
  "generated_at": "2026-08-08T00:00:00Z",
  "project": "GPIC",
  "summary": {
    "total_checks": 16,
    "passed": 5,
    "warnings": 3,
    "critical": 2,
    "info": 2
  },
  "findings": [
    {
      "id": "CRIT-1",
      "severity": "critical",
      "check": "requirement-coverage",
      "title": "Undocumented requirements in code",
      "details": "...",
      "files": ["backend/app/api/generations.py:45"],
      "requirement_ids": ["FR-014"],
      "action": "Add requirement definitions to PRD-SDD"
    }
  ]
}
```

## Important Rules

- **Always scan both docs AND code** — never just one side
- **Use git log for staleness** — don't guess, check actual commit dates
- **Report the trust hierarchy** — when contradictions are found, state which source wins under the *active profile's* declared hierarchy
- **RWG codes on critical findings** — checks 13–16 findings carry their `RWG-*` code (CR-2026-08-20-01 A2 §2.9) so remediation is deterministic
- **Sets, not counts** — reconciliation compares stable-ID sets; a hard-coded entity count is never a valid production check
- **"Declared absent" ≠ empty** — views the profile marks `not_applicable` are excluded from denominators and never rendered as coverage
- **Be specific** — "3 docs are stale" is useless; name the files and what changed
- **Suggest fixes** — every finding must have an actionable recommendation
- **Don't auto-fix contradictions** — report them and let the user decide (except when Code clearly wins per trust hierarchy)
- **Bilingual** — respond in the user's language; keep IDs and technical terms in English
