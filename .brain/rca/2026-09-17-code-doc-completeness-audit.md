---
version: "0.1.0b"
created_at: "2026-09-17T01:08:14+07:00,RWANG,2ea8a343acedfaa052c6430e9891b09328a3b883"
last_update: "2026-09-17T01:14:00+07:00,RWANG"
status: "draft"
superseded_by: null
attributes:
  domain: "code-documentation-alignment"
  scope: "RWANG current checkout completeness audit"
  doc_type: "complexity-rule"
  artifact_type: "RCA-audit-report"
  language: "th-TH"
  complexity: "C-2"
  audit_risk: "LOW"
  proposed_remediation_risk: "MEDIUM"
  baseline_commit: "2ea8a343acedfaa052c6430e9891b09328a3b883"
  product_version: "0.5.0"
---

# Code / documentation completeness audit

ตรวจ checkout `2ea8a343acedfaa052c6430e9891b09328a3b883` เมื่อ 2026-09-17
โดยเริ่มจาก working tree ที่สะอาด ผลคือ **PARTIAL ALIGNMENT**: implementation
หลักมีอยู่และ local automated gates ที่รันผ่านหลังแยก sandbox limitation แต่ยัง
ยืนยันความสมบูรณ์ตามเอกสารทั้งหมดไม่ได้ พบ scanner coverage defects สองจุด
และเอกสาร provenance ล้าสมัยหนึ่งกลุ่ม ไม่พบหลักฐานจากการตรวจครั้งนี้ที่เพียงพอ
สำหรับประกาศ Desktop Stable หรือ production release

การตรวจ baseline ในรายงานนี้ไม่แก้ application code, tests, vendor pin,
เอกสารต้นทาง หรือ release configuration และไม่ commit/publish/deploy

## Scope and success criteria

- Parent contracts: README, `docs/PRD-RWANG-PERSONA.md`, `docs/desktop-dag.md`.
- Peer contracts: desktop release/staging, native Spotlight boundary, media parity,
  desktop README, Document Intelligence SOURCE/NOTICE และ prior RCA ใน repository.
- ตรวจ implementation, tests, workflow definitions และ staged runtime ที่มีอยู่.
- แยก defect, documented limitation, missing evidence และ environment failure.
- ไม่ใช้จำนวน tests ที่ผ่านเป็นเปอร์เซ็นต์ feature completeness.
- Upstream skill/playbook files เป็น bundled product data ไม่ได้เปิดใช้ workflow
  ของ skills หรือมอบหมายงานให้ subagents ในการตรวจนี้.

## Findings and root causes

### F-01 [P2] Annotation scanner ไม่ตรวจ backend และ tests ที่ใช้ .mjs

**Symptom:** self-audit จบด้วย `passed` แต่ไม่สามารถค้น annotation ใน source
หลัก เช่น `server.mjs`, `rwang.mjs`, `document-intelligence.mjs` และ tests/*.mjs.

**Evidence:**

- `capabilities/rwang-document-intelligence/scripts/scan-annotations.ps1:37`
  กำหนด extension allowlist ที่มี `.js` แต่ไม่มี `.mjs`.
- บรรทัด 61 กำหนด test-reference grammar ที่ไม่รองรับ `.mjs` เช่นกัน.
- Temporary fixture 4 ไฟล์: `control.js` มี `// @req FR-001`, `backend.mjs`
  มี `// @req FR-002`, `persona.js` มี `// @req PER-001`, `test-link.js`
  มี `// @tested tests/persona-contract.mjs`.
- Scanner รายงาน files_scanned=3 และ annotation เดียวจาก control.js.
  backend.mjs ไม่ถูกสแกน และ test-link.js ไม่สร้าง test-reference annotation.
- Fixture อยู่ใน temporary directory และถูกลบหลังตรวจ ไม่เพิ่ม test code ใน repo.

**Root Cause:** source discovery และ test-reference regex ของ vendored scanner
ไม่ครอบคลุม ES module extension ที่ host repository นี้ใช้.

**Why escaped:** `tests/document-intelligence.mjs:190-195` ยืนยันว่า scanner
ทำงานสำเร็จและคืน filesScanned เป็น number แต่ไม่ได้ยืนยัน positive discovery
ของ `.mjs` source หรือ `.mjs` test reference.

**Proposed prevention:** เพิ่ม contract fixtures สำหรับ extension และ test link
ที่ host ใช้จริง ก่อนปรับ scanner ต้อง review local adaptation, SOURCE metadata,
normalized runtime SHA-256 และ integration tests ร่วมกัน ห้ามแก้ vendor file
โดยไม่อัปเดต integrity contract หรือปิด hash validation.

### F-02 [P2] Scanner ไม่รู้จัก Persona requirement IDs ใน PRD

**Symptom:** `PER-001` ถึง `PER-020` ไม่อยู่ใน grammar ของ annotation scanner.

**Evidence:** Persona PRD บรรทัด 146-165 ประกาศ requirement IDs เหล่านี้ แต่
scanner บรรทัด 60 รองรับ FR/NFR/SDD/SEC และกลุ่มอื่นโดยไม่มี standalone PER.
ใน fixture เดียวกับ F-01 ไฟล์ persona.js ถูกนับเป็นไฟล์ที่สแกน แต่ไม่คืน
`// @req PER-001` ขณะที่ `// @req FR-001` ใน control.js ถูกค้นพบ.

**Root Cause:** host requirement taxonomy กับ grammar ของ core pack ไม่ตรงกัน.

**Why escaped:** persona suites ตรวจ shared prompt และ policy catalog โดยตรง
แยกจาก annotation discovery; scanner tests ไม่ assert Persona ID discovery.
จึงเป็นช่องว่างด้าน traceability ไม่ใช่หลักฐานว่า persona prompt หายไป.

**Proposed prevention:** ระบุ host ID taxonomy ใน adapter contract และเพิ่ม
positive/negative discovery checks สำหรับ PER IDs โดยคงการกรอง prose/string
false positives เดิม การเปลี่ยน vendored scanner ต้องผ่าน integrity review
แบบเดียวกับ F-01.

### F-03 [P2] README และ NOTICE ระบุ release provenance คนละรุ่นกับ runtime

**Symptom / Evidence:**

| Surface | Current value |
|---|---|
| README.md:133 | v1.3.0 / 7354738094432fed22d6e00568315e1a1bd8fe15 |
| capabilities/rwang-document-intelligence/NOTICE.md:4-8 | v1.3.0, old commit, artifact SHA-256 4225e902d65ebffe9e9af945376c9b6b459f7bccc4c67a04dc80a6ad01d13432 |
| SOURCE.json:3-9 | v1.4.0 / 42ef41ffff3b62dcfd88ac28780d8f0d26b1c617 / d93209d15b3b154327bb04d7e15452465b3743441e81d6b21fd6ccb037bc217a |
| document-intelligence.mjs:14,39-46 and plugin manifest | v1.4.0, matching SOURCE.json |
| tests/document-intelligence.mjs:102-113 | asserts current v1.4.0 pin |

**Root Cause:** HEAD commit `2ea8a34` updates runtime/vendor/test pin in 14 files
but omits root README and vendoring NOTICE. Confirmed with `git show --stat HEAD`.

**Why escaped:** current pin assertions compare runtime and machine-readable
metadata but do not compare the release/commit/hash stated in README and NOTICE.

**Proposed prevention:** update human-readable provenance from verified SOURCE
and review it with every pin change. Any claim about the exact distribution
source or upstream licensing should retain provenance evidence; this audit
did not re-fetch upstream or establish new licensing facts.

## Completeness matrix

| Contract / feature | Code and evidence inspected | Assessment |
|---|---|---|
| Persona PER-001..020, NFR-001..006 | rwang.mjs shared prompt; public/index.html:138-140; styles.css:260,885; persona suites; product version in package/Tauri/Cargo | Static contract passes; actual model behavior NOT_RUN |
| Ollama chat, fallback and model operations | server.mjs routes; rwang.mjs ToolLoopAgent/native fallback; public/app.js handlers | Implementation present; live Ollama/model download E2E NOT_RUN |
| Human approval, HA, webhook and MCP trust | rwang.mjs approval creation/execution, integration fingerprint checks; security suites | Local automated checks pass; live integration/provider E2E NOT_RUN |
| Pairing, token/device scopes, remote lifecycle | rwang.mjs and remote.mjs; security-smoke and remote-security | Local automated checks pass; physical mobile/WebRTC session NOT_RUN |
| Scheduled prompt with explicit RUN | rwang.mjs:726-772 due/advance logic; public/app.js schedule UI | Implementation agrees with README; not autonomous external execution; live timing E2E NOT_RUN |
| Spotlight metadata, safe opening and native focus | spotlight.mjs; Rust spotlight_bridge; Node and Rust tests | Tested boundaries pass; no independent Rust index or extra IPC claimed |
| Document Intelligence bounded read-only adapter | document-intelligence.mjs; SOURCE; adapter tests | Adapter/integrity tests pass; F-01/F-02 prevent complete host annotation coverage; F-03 is doc drift |
| Desktop process/data/workspace and health | main.rs; entrypoint.mjs; migration, health, sidecar, backend and Rust tests | Local checks pass after sandbox isolation |
| Perception and media diagnostics | perception.js, remote-client.js, desktop-diagnostics.js; media-parity test | Static implementation checked; real camera/microphone/display/gesture/voice NOT_RUN |
| Deterministic staging and packaging | scripts, manifest, tauri.conf.json, workflow and desktop-package tests | Existing stage verified; fresh acquire/stage/build/installer NOT_RUN |
| Production/Stable gates | PRD:201-213; desktop-release:156-170; DAG Wave 4 | Manual per-model/clean-VM/signing evidence not established in this audit |

## Verification results from this run

Environment: Windows, Node **v24.19.0**, pnpm **11.19.0**, cargo **1.98.0**.
The documented portable/CI Node pin is **v24.20.0**; local Node suite results
must not be described as an exact pinned-toolchain or hosted-CI reproduction.

| Check | Result and boundary |
|---|---|
| pnpm check | PASS |
| pnpm test:security | PASS with two skipped backend symlink cases |
| Persona policy catalog | PASS, 45 scenarios; explicitly no model execution |
| pnpm test:desktop-contract | Initial command FAIL at desktop-health under sandbox; later files not reached by that chained command |
| desktop-package, model-selector-layout, legacy-data-migration | PASS before the aggregate stopped |
| desktop-health and sidecar-runtime | Both FAIL with sandbox INVALID_HOME_ROOT; unchanged tests PASS outside sandbox |
| tauri-contract and media-parity | Run separately after the aggregate stopped; PASS |
| backend-hardening outside sandbox | PASS; the same static/TLS symlink cases still SKIPPED |
| cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check | PASS |
| cargo test --offline --locked --manifest-path src-tauri/Cargo.toml | PASS: 8 unit + 2 icon + 2 Spotlight integration tests = 12 |
| cargo check --offline --locked --manifest-path src-tauri/Cargo.toml | PASS |
| cargo check --offline --locked --manifest-path src-tauri/Cargo.toml --features autostart | PASS |
| Existing runtime manifest SHA-256 recheck | PASS: all 2,419 listed files match; 0 mismatches |
| Selected stage versus checkout comparison | PASS: server, agent, document adapter, Spotlight, remote, public/app.js and SOURCE.json bytes match |
| git diff --check | PASS before report addition; checked again after report addition |

The runtime manifest result is for the existing stage, not a new installer.
The seven explicit checkout comparisons are not a claim that every staged file
was compared with a corresponding source file or that extra files were excluded.
Hosted CI, NSIS installation, signing, fresh Node acquisition, full release build,
clean Windows 10/11 lifecycle and physical-device tests were NOT_RUN.

## Environment RCA: INVALID_HOME_ROOT

**Symptom:** desktop-health and sidecar-runtime time out after lifecycle fatal
`INVALID_HOME_ROOT` in the managed sandbox.

**Evidence:** read-only Node `realpathSync.native` probe on `C:/Users/pc` returns
`EPERM`; `spotlight.mjs:208-225` fails closed if canonical home cannot be read.
Both unchanged tests pass outside the sandbox. This also agrees with the
repository RCA `.brain/rca/2026-09-02-desktop-health-sandbox-realpath.md`.

**Root Cause:** filesystem sandbox restriction, not a demonstrated product
regression. **Why escaped:** ordinary developer/CI execution differs from the
managed sandbox. **Prevention:** preserve canonical-root checks, diagnose EPERM
before changing code, and record sandbox and unrestricted outcomes separately.

## Self-audit result is not semantic completeness evidence

The current checkout self-audit returns parser/scan `passed`, filesScanned=54,
filesWithRefs=0, totalAnnotations=0, uniqueRequirementCount=0,
graph.available=false and graph.validation=null. No scan truncation was reported.

`document-intelligence.mjs:816-829` intentionally allows an absent graph and
reports that absence. No host `docs/.doc-graph.json` was available to validate.
This is a structural execution result; it does not establish requirement
coverage. F-01/F-02 additionally make the current discovery coverage incomplete.
The repository's direct persona tests still provide their separate static
evidence. Creating a complete graph or changing optional-graph semantics needs
its own agreed scope; it is not silently included in this audit.

## Original recommended order (applied below)

1. Review a narrow adapter/scanner specification for F-01/F-02, including
   exact extensions, requirement IDs, test references, negative cases,
   provenance and normalized hash updates. Risk: MEDIUM.
2. Correct F-03 with the current approved pin and add a provenance consistency
   check. Documentation correction risk: LOW; do not update the upstream pin.
3. Decide whether a complete host requirement graph is required and separately
   collect model, media and clean-machine release evidence.

The findings and matrix above describe the baseline checkout named in this
report. The following remediation was subsequently authorized by the user and
applied in the working tree; the original evidence is retained so the audit
does not rewrite its baseline conclusion.

## Remediation applied

- F-01: both scanners now include `.mjs` source files and `.mjs` test
  references.
- F-02: both scanners now recognize the Persona PRD `PER-xxx` identifiers.
- F-03: README and NOTICE now use the verified v1.4.0 tag, commit and artifact
  SHA-256 from `SOURCE.json`.
- `document-intelligence.mjs` now pins the updated SOURCE/scanner hashes and
  the shell scanner hash.
- `tests/document-intelligence.mjs` adds positive scanner fixtures for
  `.mjs`, `PER-001`, and `.mjs` test references, plus a README/NOTICE
  provenance consistency check.
- `pnpm desktop:stage` was rerun; the existing staged manifest still has
  2,419 files with zero SHA-256 mismatches and the staged SOURCE matches the
  checkout.

Post-remediation gates passed: `pnpm check`, `pnpm test:document-intelligence`,
`pnpm test:security`, `pnpm test:desktop-contract` outside the managed
filesystem sandbox, Rust fmt/check/test with and without `autostart`, and the
desktop package staging contract. The two backend symlink cases remain skipped
because symlink creation is unavailable on this host. Persona tests remain
static policy checks (45 scenarios; no model execution), and clean-machine,
signing, live provider, physical-device, and installer evidence remain
`NOT_RUN`.

## VERSION DIFF

| From | To | Change |
|---|---|---|
| No report | 0.1.0b draft | Add current-checkout audit, reproduced scanner gaps, provenance RCA and evidence boundaries |
| 0.1.0b draft | 0.1.1b draft | Record the authorized scanner/provenance remediation and post-remediation gates |
| Product 0.5.0 | Product 0.5.0 | Scanner/test/documentation alignment; no product version change |
| Core pack 1.4.0 | Core pack 1.4.0 | Host scanner adaptation only; no upstream vendor pin change |

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-17 | draft | Current code/doc completeness audit; remediation not implemented | Uncommitted report; audited 2ea8a343acedfaa052c6430e9891b09328a3b883 | RWANG |
| 0.1.1b | 2026-09-17 | draft | Authorized scanner coverage and provenance remediation; gates rerun | Uncommitted working tree; baseline 2ea8a343acedfaa052c6430e9891b09328a3b883 | RWANG |
