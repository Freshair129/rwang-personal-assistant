---
version: "0.3.2b"
created_at: "2026-09-17T01:51:46+07:00,RWANG,2ea8a343acedfaa052c6430e9891b09328a3b883"
last_update: "2026-09-17T04:57:55+07:00,RWANG"
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

Current status: **UAT INCOMPLETE / EXECUTED LOCAL CHECKS PASSED WITH LIMITATIONS**.
The results below describe executed developer checks and selected browser flows.
They do not establish complete functional coverage or user acceptance.
Nineteen defects were found during independent review and recorded in the
[gate RCA](../.brain/rca/2026-09-17-productivity-gate.md). Worker completion alone
does not satisfy this gate.

| Gate | Status | Evidence |
|---|---|---|
| Shared API and storage contract | PASS | Strict nested Insights contract, revision/idempotency rules, host-only routes reviewed against PRD |
| Domain and persistence tests | PASS | `pnpm test:planner`: domain suite; injected clocks, failed writes, restart, corrupted state, historical plans, constraints and metrics |
| HTTP, permissions and privacy | PASS | `pnpm test:planner`: real HTTP contract/security suite, including body limit 413 and nonlocal rejection |
| Frontend and source syntax | PASS | `pnpm check`; `git diff --check` |
| Existing security/persona/document regressions | PASS_WITH_LIMITATIONS | `pnpm test:security`; static/TLS symlink cases skipped because this Windows environment cannot create symlinks; persona catalog covers 45 scenarios without model execution |
| Packaged resource integrity and desktop contracts | PASS | `pnpm desktop:stage` then `pnpm test:desktop-contract`, including package manifest, model-selector layout, migration, health, sidecar, Tauri and media parity checks; final UI was restaged and package/layout/planner checks rerun; staged browser repeated the preview-cancellation flow |
| Rust desktop host / source build | PASS | `cargo fmt --check`; `cargo check` default and autostart; `cargo test` 12 passed; `pnpm exec tauri build --no-bundle` produced local `src-tauri/target/release/rwang.exe` |
| Browser flow and accessibility | PASS_WITH_LIMITATIONS | Isolated fixture; tasks/drafts/focus/coaching/insights, accepted replacement → manual edit, locked busy block → rebuild, empty plan → apply → reload, preview cancellation, keyboard arrows and 320/768/1440 layout verified; native zoom/full screen reader not run |
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

## UAT coverage audit — 2026-09-17 04:17 ICT

This audit compared the approved acceptance criteria, the prior browser execution
record, and the actual assertions in `tests/planner-domain.mjs` and
`tests/planner.mjs`. It did not rerun tests. Current HEAD is
`88db86cf8ebcb89c5a8984847b3458eef096ea53`; the three application hashes below
still match the tested candidate. This does not certify every file in that commit.

`VERIFIED_CASES` means only the named cases have execution evidence. `PARTIAL`
means some required branches are still unverified. `NOT_RUN` is an evidence gap,
not a confirmed product defect. There is no completed UAT case inventory or
product-owner acceptance, so no coverage percentage or all-features-pass claim
is justified.

| Area / requirement | Verified evidence | Remaining UAT evidence | Status |
|---|---|---|---|
| Task lifecycle / FR-001–002 | Browser creation, checklist, complete/reopen/archive, two-item draft review/save and retained edits; automated restart persistence | All editable fields/validation paths through UI; archive handshake for a future-planned task through UI | PARTIAL |
| Task Assistant / FR-001 | Actual Thai generation using qwen3.5:9b; malformed JSON/tool-call fixtures rejected without task writes | Offline/timeout/oversized response through UI while manual task/plan/focus still work | PARTIAL |
| Day plans / FR-003–006 | Auto/manual preview/apply, no-write preview, stale revision rejection, overlap/missing-duration fixtures, deadline feasibility, capacity exhaustion and impossible-deadline warning, locked busy rebuild, accepted-plan replacement, empty plan, date-change cancellation | Zone changes with existing plans; user review of all conflict messages | PARTIAL |
| What-if / FR-007 | Future-day start-late through browser; past/ongoing busy protection in domain regression; tired-energy preview, future locked-meeting skip/apply, and preview cancellation by date change were exercised with persisted-result checks | Broader date/deadline combinations remain | PARTIAL |
| Focus/coaching / FR-008–009 | Browser start/pause/resume/finish/auto-finish, opt-in and real five-minute idle/dismiss/suppression; injected gap/restart/clock/write-failure regressions; two tabs mirrored one running session and the second start control stayed disabled | Real background/suspend/reopen behavior through the target desktop host | PARTIAL |
| Insights / FR-010–012 | Nested values, zero/null display, hourly/weekly UI, selected reference date; golden midnight/streak/history/insufficient-threshold fixtures; direct golden fixture produced a positive 09:00–10:00 recommendation and nonzero previous-week comparison; browser stats rendered `Pacific/Kiritimati` (`GMT+14`) | Partial-week golden case remains; broader selected-zone boundary matrix | PARTIAL |
| Search / FR-013 | Browser title search and initial empty HTTP search; notes/title search, project-label search, combined status+search, and archived checkbox were exercised | Invariant metrics through UI | PARTIAL |
| Security/persistence | Host/nonlocal/paired/origin/body-limit/privacy HTTP cases; malformed state, idempotency, write-failure and restart checks | Planner/model XSS payload rendered in browser; real simultaneous edits; two OS symlink cases skipped | PARTIAL |
| Desktop/PWA/accessibility | Staging/hash/import/contracts and native source build; source-server browser flows, keyboard arrows and 320/768/1440 reflow; staged sidecar health/state and packaged-browser preference save were exercised | Native window lifecycle, PWA cache upgrade/reopen, native 200% zoom, full screen-reader operation; clean-machine install is a separate release gate | PARTIAL |

The earlier wording that left only accessibility acceptance pending was too narrow.
The functional and packaged-host gaps above must also be executed and recorded
before full UAT can be accepted. Closing the 19 discovered defects is evidence
about those defects, not proof that every requested behavior has been exercised.

## UAT execution continuation — 2026-09-17 04:39–04:55 ICT

Root reran the missing browser and packaged-host cases that were safe to execute
with an isolated loopback fixture, including the final preview-cancellation
correction. The fixture contained only test tasks and was discarded after the
run; the user's existing RWANG process and data were not stopped or read.

| Case | Execution evidence | Result |
|---|---|---|
| What-if tired energy | On 2026-09-19, selected `เหนื่อยมาก` and generated a preview; the three task blocks moved earlier and the persisted revision stayed unchanged until apply | PASS for the exercised preview/no-write path |
| What-if skip future meeting | Selected the future locked `ประชุมทดสอบ gate` block; preview removed it while the note kept the real busy block protected, then apply persisted a new accepted plan with three task blocks and no busy block | PASS for the exercised future skip/apply path |
| Search/filter | UI returned one title/notes match, two project-label matches, one combined `เตรียม` + `กำลังทำ` match, and exposed the archived task only after the archive checkbox | PASS for exercised matches and filters |
| Focus two tabs | Two loopback tabs observed one shared running session; the second start control became disabled, and finishing in the first tab propagated `FINISHED` to both. API state ended with 5 sessions and 0 active sessions | PASS for duplicate-start prevention and cross-tab sync |
| Insights positive/history fixture | Temporary domain state with five current sessions across four days at 09:00 plus six previous-week minutes returned recommendation 09:00–10:00, 42 current minutes, 6 previous minutes, `+600%`, and six provenance IDs | PASS for this golden case; partial-week remains |
| Time-zone preference save | Source browser and staged packaged browser saved `Pacific/Kiritimati` with the default `09:00–17:00` workday; persisted evening window stayed `17:00–21:00`, and stats displayed `GMT+14` | PASS; closes G-18 |
| Packaged sidecar | Pinned portable Node v24.20.0 served `/api/health` as ready and planner state at revision 0; the packaged browser then saved the non-UTC preference successfully | PASS for portable sidecar plus browser integration |
| Preview cancellation | Source and staged browsers created the 2026-09-17 deadline-conflict preview, changed to 2026-09-18, and showed `ยังไม่มี preview`, empty reason/unscheduled/conflict fallbacks, default Apply label, disabled Apply and the date-change status; no planner revision write occurred | PASS; closes G-19 |

Regression commands after G-19: `pnpm check`, elevated `pnpm test:planner`,
elevated `pnpm test:security`, `pnpm desktop:stage`, and elevated
`pnpm test:desktop-contract` all passed. Security symlink cases remain skipped
because this Windows environment cannot create symlinks. A direct temporary
insights fixture also passed with the values above.

## Final candidate identity

Source files below matched the staged runtime after the final UI correction.
At the time of those executions, the candidate was uncommitted on baseline
`2ea8a343acedfaa052c6430e9891b09328a3b883`. The later coverage-audit revision is
recorded above.

| File | SHA-256 |
|---|---|
| `planner.mjs` | `fc640dc352896f0b1ad69945faf09ea3a108c2422f57545d2816741cbf2b99da` |
| `rwang.mjs` | `2df75753d674eb583389d7ed0c2e7b52e644d84afeb20ff936713961958c9560` |
| `public/planner.js` | `f56f3bbbf933687a7eb76d6dceb36efe823aefb31ecd7bb0762769af3a39e996` |

No unresolved defect remains among the 19 recorded findings after their listed
checks. Untested behavior remains unknown. Full acceptance is pending for both
the functional coverage gaps and the accessibility/packaged-host checks above.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.3.2b | 2026-09-17 | under review | Fix and verify preview-cancellation review state in source and staged browsers; keep remaining UAT gaps explicit | UNCOMMITTED | RWANG |
| 0.3.1b | 2026-09-17 | under review | Execute additional What-if, search, two-tab focus, insights, timezone-save and packaged-sidecar UAT; close G-18 and keep remaining acceptance gaps explicit | UNCOMMITTED | RWANG |
| 0.3.0b | 2026-09-17 | under review | Audit per-area UAT evidence; correct incomplete coverage claims and identify functional, packaged-host and accessibility cases still unrun | UNCOMMITTED | RWANG |
| 0.2.0b | 2026-09-17 | under review | Record local domain/HTTP/security/desktop/browser evidence, 17 corrected findings, candidate hashes and remaining accessibility/release evidence boundaries | UNCOMMITTED | RWANG |
| 0.1.0b | 2026-09-17 | under review | Register approved fleet, ownership and independent acceptance gates | UNCOMMITTED | RWANG |
