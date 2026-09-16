---
version: "0.2.0b"
created_at: "2026-09-17T01:51:46+07:00,RWANG,2ea8a343acedfaa052c6430e9891b09328a3b883"
last_update: "2026-09-17T03:05:36+07:00,RWANG"
status: "under review"
superseded_by: null
attributes:
  domain: "personal-productivity"
  scope: "P1-P3 implementation acceptance"
  language: "th-TH"
  complexity: "C-3"
  change_risk: "HIGH"
---

# Productivity implementation gate

User authorization: “สร้าง agent fleet (Luna max) ไปทำ คุณ เป็น gate รอตรวจ”.
Scope: [approved PRD P1–P3](PRD-RWANG-PRODUCTIVITY.md); Calendar Sync excluded.
Baseline: `2ea8a343acedfaa052c6430e9891b09328a3b883` plus existing uncommitted
Document Intelligence remediation. Root retains integration and acceptance ownership.

## Fleet and ownership

| Worker | Model / effort | Responsibility |
|---|---|---|
| planner_backend | gpt-5.6-luna / max | Domain, durable store, API, Ollama drafts, planner/focus/metrics, domain tests |
| planner_ui | gpt-5.6-luna / max | PLAN interface, shell integration, styles and service-worker assets |
| planner_verification | gpt-5.6-luna / max | Independent HTTP/security tests, package staging and CI wiring |
| root | Parent model | Shared contract review, independent inspection, browser/model validation and final gate |

## Acceptance evidence

Current status: **LOCAL GATES PASS_WITH_LIMITATIONS / FULL ACCEPTANCE PENDING**.
Seventeen defects were found during independent review and recorded in the
[gate RCA](../.brain/rca/2026-09-17-productivity-gate.md). Worker completion alone
does not satisfy this gate.

| Gate | Status | Evidence |
|---|---|---|
| Shared API and storage contract | PASS | Strict nested Insights contract, revision/idempotency rules, host-only routes reviewed against PRD |
| Domain and persistence tests | PASS | `pnpm test:planner`: domain suite; injected clocks, failed writes, restart, corrupted state, historical plans, constraints and metrics |
| HTTP, permissions and privacy | PASS | `pnpm test:planner`: real HTTP contract/security suite, including body limit 413 and nonlocal rejection |
| Frontend and source syntax | PASS | `pnpm check`; `git diff --check` |
| Existing security/persona/document regressions | PASS_WITH_LIMITATIONS | `pnpm test:security`; static/TLS symlink cases skipped because this Windows environment cannot create symlinks; persona catalog covers 45 scenarios without model execution |
| Packaged resource integrity and desktop contracts | PASS | `pnpm desktop:stage` then `pnpm test:desktop-contract`, including package manifest, model-selector layout, migration, health, sidecar, Tauri and media parity checks; final UI was restaged and package/layout/planner checks rerun |
| Rust desktop host / source build | PASS | `cargo fmt --check`; `cargo check` default and autostart; `cargo test` 12 passed; `pnpm exec tauri build --no-bundle` produced local `src-tauri/target/release/rwang.exe` |
| Browser flow and accessibility | PASS_WITH_LIMITATIONS | Isolated fixture; tasks/drafts/focus/coaching/insights, accepted replacement → manual edit, locked busy block → rebuild, empty plan → apply → reload, keyboard arrows and 320/768/1440 layout verified; native zoom/full screen reader not run |
| Real Ollama task draft | PASS | Actual Thai two-task generation, per-item edits/saves and retained drafts using `qwen3.5:9b`; malformed response created no tasks |
| Architecture and documentation review | PASS | New planner owns its local state; existing host/origin guards remain; no remote scopes, external calendar integration or fabricated scores added |
| Hosted CI / clean-machine / signed release | NOT_RUN | Separate evidence; no publication authorized in this task |

## Execution scope and limitations

- Tests ran locally on Windows, Node v24.19.0 and pnpm 11.19.0. Staging uses the
  pinned portable Node v24.20.0; production dependencies were reused from the
  lockfile. The pnpm update-metadata network warning did not prevent staging.
- HTTP/desktop tests needed elevation because the sandbox cannot inspect the
  configured Windows home boundary (`INVALID_HOME_ROOT`). Tests were not weakened.
- Root browser used a temporary data/workspace fixture and loopback port 54645.
  Real user tasks, configuration and files were not used as model input.
- Local Ollama model digest:
  `1bdc07fcb6394b54a1174a466d2606c169c68b0fdb92c678dddf12cc533bbd66`.
  This validates the tested Thai prompt/model, not every installed model.
- Focus was tested with real start/pause/resume/finish and one-minute auto-finish.
  Idle coaching stayed hidden immediately after opt-in, appeared after more than
  five idle minutes, dismissed correctly, and stayed hidden during running focus.
- Document widths matched client widths at 320 (305), 768 (753), and 1440 (1425)
  pixels. Browser console showed no warning/error during the tested flows.
- Native 200% zoom is **NOT_RUN**: the in-app browser exposes viewport control but
  the available zoom keyboard action did not change its measured zoom. Viewport
  reflow is not presented as native zoom evidence. Full screen-reader operation,
  installed-app/clean-machine acceptance and hosted CI remain separate checks.
- Seven protected files from the prior Document Intelligence remediation still
  match the SHA-256 values recorded before this fleet started. No commit, deploy,
  release-version bump, installer publication or real calendar operation occurred.
- The temporary browser tab was closed, its viewport override reset, and the
  fixture server stopped after validating executable, creation time, loopback
  listener and fixture identity. The user's existing RWANG server was not stopped.

## Gate rules

Reject lost updates, false save success, silent corrupt-state reset, duplicate focus
accounting, stale preview application, invalid scheduling, fake metrics, unreviewed
model output persistence and nonlocal planner access. Route defects back to the
owning worker with a reproducible trigger and require a regression test.

Keep unavailable model/device/hosted evidence distinct from passing fixture tests.
Keep product version 0.5.0 until an explicit release decision; implementation evidence
does not itself constitute deployment or installer acceptance.

## Final candidate identity

Source files below matched the staged runtime after the final UI correction.
The working tree remains uncommitted on baseline `2ea8a343acedfaa052c6430e9891b09328a3b883`.

| File | SHA-256 |
|---|---|
| `planner.mjs` | `fc640dc352896f0b1ad69945faf09ea3a108c2422f57545d2816741cbf2b99da` |
| `rwang.mjs` | `2df75753d674eb583389d7ed0c2e7b52e644d84afeb20ff936713961958c9560` |
| `public/planner.js` | `9f4f26d7908837cd2cf5ae8075c31bb772a859f1702ad57f4ad70eb2ab4701b1` |

No known functional defect remains from the 17 recorded findings after the
listed checks. This is bounded local evidence; full acceptance remains pending
for the explicitly unrun accessibility checks above.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.2.0b | 2026-09-17 | under review | Record local domain/HTTP/security/desktop/browser evidence, 17 corrected findings, candidate hashes and remaining accessibility/release evidence boundaries | UNCOMMITTED | RWANG |
| 0.1.0b | 2026-09-17 | under review | Register approved fleet, ownership and independent acceptance gates | UNCOMMITTED | RWANG |
