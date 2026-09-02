---
name: doc-architect
description: Analyze a project's signals (team size, tech stack, compliance needs, AI/ML presence) and recommend the optimal documentation structure. Creates templates, scaffolds doc directories, establishes requirement ID schemes, and generates the Entity Registry, Edge Contract manifest, and view-profile declaration. Use when starting a new project, auditing existing doc structure, or migrating to SWE-standard documentation.
version: 1.1.0
---

# RWANG / doc-architect — Document Structure Decision Engine

Analyze a project and recommend the optimal documentation structure following SWE standards (IEEE 29148-2018, IEEE 1016-2009, ISO/IEC 42001).

## When This Skill Activates

- User asks to set up project documentation
- User asks "what doc structure should I use?"
- User asks to create a PRD, SDD, or project docs from scratch
- User mentions document architecture, doc templates, or doc scaffolding
- A new project needs documentation standards established

## Process

```
SCAN → SCORE → RECOMMEND → CONFIRM → SCAFFOLD
```

### Phase 1: Project Signal Scan

Gather these signals automatically by reading the project:

| Signal | How to Detect | Weight |
|--------|---------------|--------|
| **Team size** | Ask user or check CONTRIBUTING.md / .github/CODEOWNERS | High |
| **Codebase scale** | Count files: `find . -name '*.ts' -o -name '*.py' -o -name '*.go' \| wc -l` | Medium |
| **Tech stack** | Read package.json, requirements.txt, go.mod, Cargo.toml, etc. | High |
| **Compliance needs** | Look for HIPAA, SOC2, GDPR, PCI references in existing docs | Critical |
| **AI/ML presence** | Check for model files, training scripts, `torch`/`tensorflow`/`transformers` in deps | High |
| **Microservices** | Count docker-compose services, k8s manifests, separate package.json files | Medium |
| **Data pipelines** | Look for Airflow DAGs, dbt models, Spark jobs, ETL scripts | Medium |
| **Existing docs** | Scan `docs/` directory structure and content | High |
| **Git history maturity** | `git log --oneline \| wc -l` — new vs mature project | Low |
| **CI/CD setup** | Check .github/workflows, .gitlab-ci.yml, Jenkinsfile | Low |

### Phase 2: Template Scoring

Score each template 0-100 based on signal match:

#### Available Templates

| ID | Template | Best For |
|----|----------|----------|
| `startup-mvp` | **Startup MVP** | ≤3 people, <50 files, no compliance, ship fast |
| `3layer-appendix` | **3-Layer + Appendix** | 4-15 people, moderate complexity, optional AI/ML |
| `ieee-full` | **IEEE Full Split** | 15+ people, formal governance, separate PRD/SDD/STP |
| `aiml-project` | **AI/ML Project** | Any size with significant AI/ML (model cards, ethics, data pipeline) |
| `regulated` | **Regulated Industry** | HIPAA/SOC2/PCI/FDA compliance required |
| `microservices` | **Microservices** | 3+ independent services, per-service docs + system-level |
| `data-pipeline` | **Data Pipeline** | ETL-heavy, data warehouse, analytics platform |
| `custom` | **Custom** | User defines from scratch |

#### Scoring Rules

```
score = 0

# Team size match
if template.ideal_team_range includes actual_team_size:
    score += 25
elif within 2x of range:
    score += 15

# Complexity match
if template.complexity_level matches codebase_scale:
    score += 20

# Tech stack alignment
for each stack_signal in project:
    if template.covers(stack_signal):
        score += 10  # up to 30

# Compliance (critical — wrong choice = rework)
if project.needs_compliance and not template.has_compliance_sections:
    score = max(score - 40, 0)  # heavy penalty
if template.has_compliance_sections and not project.needs_compliance:
    score -= 10  # slight over-engineering penalty

# AI/ML presence
if project.has_ai and template.has_ai_sections:
    score += 15
if project.has_ai and not template.has_ai_sections:
    score -= 20  # missing critical sections
```

### Phase 3: Recommendation

Present the top 2-3 templates with:

1. **Score** and **why** it scored that way
2. **What you get**: list the document sections/files
3. **What you miss**: gaps if choosing a simpler template
4. **Effort estimate**: how much work to fill in (hours/days)

Format:

```markdown
## 🏆 Recommended: 3-Layer + Appendix (Score: 87/100)

**Why**: 8-person team, Next.js + FastAPI + AI agents, no hard compliance.
This template covers AI agent architecture (Layer 3) without the overhead
of full IEEE split documents.

**You get**:
- Layer 1: PRD (exec summary, use cases, FRs, NFRs, business rules, ACs)
- Layer 2: SDD (architecture, API, DB, security, testing, deployment)
- Layer 3: AI System (agents, model lifecycle, data pipeline, ethics)
- Appendices A-F (API spec, DB schema, model cards, traceability, risks, glossary)

**You miss** (vs IEEE Full Split):
- Separate STP (Software Test Plan) document
- Formal change control board process
- Independent V&V sections

**Effort**: ~3-5 days for a team of 2 writing docs

---

## Runner-up: AI/ML Project (Score: 79/100)
...
```

### Phase 4: User Confirmation

Ask user to confirm choice. Accept:
- Direct selection ("ใช้แบบ 3-Layer" / "use 3-Layer")
- Modification ("3-Layer but add compliance sections")
- Custom combination ("Layer 1-2 from 3-Layer, Layer 3 from AI/ML")

When the project fits **3-Layer + Appendix** or **IEEE Full Split**, also offer: `Enable 5-Driven SDLC Structure (Diagrams + Test Specs + Domains)`.

**View profile declaration (required):** whatever template is chosen, the project declares a view profile (`5-driven-domain`, `flat-prd-sdd`, `ieee-full`, `microservices`, or project-specific — validated against `references/profile-schema.json`). Every profile explicitly lists `required`, `optional`, AND `not_applicable` views — a project that doesn't use Domain/Feature organization declares those views `not_applicable` rather than leaving them absent. The profile also declares its trust hierarchy and check heuristics.

### Phase 5: Scaffold

Once confirmed, create the full directory structure.

#### Requirement ID Scheme

Every template uses this universal ID scheme:

| Prefix | Category | Example |
|--------|----------|---------|
| `FR-xxx` | Functional Requirements | FR-001 Image Generation |
| `NFR-xxx` | Non-Functional Requirements | NFR-001 Latency < 3s |
| `SDD-xxx` | Software Design Decisions | SDD-001 Pipeline Architecture |
| `SEC-xxx` | Security Requirements | SEC-001 JWT Authentication |
| `AI-AGT-xxx` | AI Agent Specifications | AI-AGT-001 Prompt Enhancer |
| `AI-ETH-xxx` | AI Ethics & Governance | AI-ETH-001 Bias Monitoring |
| `BR-xxx` | Business Rules | BR-001 Max file size 100MB |
| `AC-xxx` | Acceptance Criteria | AC-001 A4 @300DPI = 2480×3508px |
| `DR-xxx` | Data Requirements | DR-001 User table schema |
| `IR-xxx` | Infrastructure Requirements | IR-001 GPU cluster config |

#### Directory Templates

**Startup MVP**:
```
docs/
├── PRD.md                    # Combined PRD + light SDD
├── API.md                    # API reference
├── ARCHITECTURE.md           # Key decisions (ADRs)
└── GLOSSARY.md
```

**3-Layer + Appendix**:
```
docs/
├── PRD-SDD-v1.0.md           # Main document (3 layers)
├── appendices/
│   ├── A-api-spec.md
│   ├── B-db-schema.md
│   ├── C-model-cards.md       # If AI/ML
│   ├── D-traceability.md
│   ├── E-risk-matrix.md
│   └── F-glossary.md
├── ARCHITECTURE.md            # ADRs
├── CONTRIBUTING.md
├── frontend-design-system.md  # If frontend
├── api/
│   └── README.md
└── .doc-graph.json            # Document graph (auto-generated)
```

**IEEE Full Split**:
```
docs/
├── SRS/                       # Software Requirements Specification
│   ├── SRS-v1.0.md
│   └── requirements/
│       ├── functional.md
│       ├── non-functional.md
│       └── interfaces.md
├── SDD/                       # Software Design Document
│   ├── SDD-v1.0.md
│   └── components/
├── STP/                       # Software Test Plan
│   ├── STP-v1.0.md
│   └── test-cases/
├── SAD/                       # Software Architecture Document
│   └── SAD-v1.0.md
├── OCD/                       # Operational Concept Document
│   └── OCD-v1.0.md
├── appendices/
├── ARCHITECTURE.md
└── .doc-graph.json
```

**AI/ML Project**:
```
docs/
├── PRD-SDD-v1.0.md
├── ai-system/
│   ├── agent-architecture.md
│   ├── model-cards/
│   │   └── TEMPLATE.md
│   ├── data-pipeline.md
│   ├── prompt-engineering.md
│   ├── ethics-governance.md
│   └── model-lifecycle.md
├── appendices/
├── ARCHITECTURE.md
└── .doc-graph.json
```

#### Document Control Block

Every generated document starts with:

```markdown
# [Document Title]

| Field | Value |
|-------|-------|
| **Version** | 1.0.0 |
| **Status** | Draft |
| **Author** | [auto-detect from git config] |
| **Created** | [today's date] |
| **Last Updated** | [today's date] |
| **Approved By** | — |

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | [date] | [author] | Initial creation via RWANG doc-architect |

## Referenced Standards

- IEEE 29148-2018 (Requirements Engineering)
- IEEE 1016-2009 (Software Design Description)
[+ ISO/IEC 42001 if AI/ML template selected]
```

### Phase 5.5: Generate Registry & Contracts (before scaffolding documents)

Before writing project documents, generate the governance layer (validated against the schemas in `references/`):

```
docs/registry/
├── entity-types.yaml        # closed enum of entity types + ID namespaces for this project
├── entities/
│   ├── domains/             # one entry per Domain (if the profile uses the Domain view)
│   ├── features/            # one entry per Feature (parent_domain_id required)
│   └── releases/            # if the profile enables the Release view
└── edge-contracts/          # versioned contracts for every predicate the profile uses
    └── <predicate>@1.0.0.yaml
```

Plus a node `manifest.yaml` per Domain/Feature directory (outgoing edge assertions only — never upstream/downstream file pairs; schema: `references/node-manifest-schema.json`).

Every entry carries `introduced_by` provenance; when this skill runs as an agent, registry writes REQUIRE an `approval_ref` (the user's confirmed template/profile choice recorded in Phase 4).

### Phase 6: Initialize Doc Graph

The graph has a **single writer**: `rwang:doc-graph` (schema 2.0.0 rejects other writers). Do not write `.doc-graph.json` from this skill — after scaffolding, invoke `rwang:doc-graph` to generate the initial projection (it will stamp `source_ref`, provenance, contract-backed edges, and run exact-set reconciliation).

## Output

1. Created directory structure with template documents
2. Initialized requirement ID counters
3. Initialized `docs/.doc-graph.json`
4. Summary of what was created and next steps
5. Suggest running `rwang:doc-preflight` to verify completeness

## Important Rules

- **Never skip the scoring step** — even if the user says "just use X", show why X is or isn't a good fit
- **Registry before documents** — generate `docs/registry/` and the profile declaration before scaffolding docs; the graph is a projection of the registry, initialized via `rwang:doc-graph` (single writer), never written here
- **Always include Document Control blocks** — no document without metadata
- **Bilingual support** — if user writes in Thai, respond in Thai; keep technical terms in English
- **Adapt to existing docs** — if docs/ already has content, merge rather than overwrite
