---
version: "0.2.2b"
created_at: "2026-09-17T02:11:00+07:00,RWANG,2ea8a343acedfaa052c6430e9891b09328a3b883"
last_update: "2026-09-17T04:57:55+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "personal-productivity"
  scope: "independent P1-P3 implementation gate"
  language: "en"
  complexity: "C-3"
  change_risk: "HIGH"
---

# Productivity gate RCA

These findings were found during implementation, before worker acceptance.
The approved PRD already requires the intended behavior; correcting these defects
does not expand feature scope. Root reproduced them with isolated temporary data
and injected clocks/filesystem failures; no user state was used.

## G-01: An automatic preview cannot be applied

**Symptom:** Create an estimated task, generate an automatic plan, then apply the
returned preview. Apply rejects the server's own preview with `VALIDATION_ERROR`.

**Evidence:** Root probe created a 30-minute task at revision 0, generated a preview
for 2026-09-19 in Asia/Bangkok, and called `applyPlan` at revision 1. Output:
`AUTO_APPLY_ERROR VALIDATION_ERROR taskIds ต้องเป็น array`.

**Root cause:** `normalizePlanRequest` emits `taskIds: null` when selection is omitted,
then rejects this value when `applyPlan` revalidates the normalized preview request.
The input normalizer is inconsistent with its own canonical output.

**Why the issue escaped detection:** This was an initial code drop before domain
and end-to-end tests were completed. Preview-only success cannot prove apply works.

**Proposed prevention:** Round-trip the exact returned preview through apply with
omitted optional fields, then verify the persisted plan and restart it. Keep the
null/omitted contract consistent; do not change tests to always supply task IDs.

**Status:** FIXED; verification evidence is listed in the closure table.

## G-18: Saving preferences rejects the default evening energy window

**Symptom:** From the browser, changing the IANA time zone and saving the
preferences fails with `energy window ต้องมี end มากกว่า start`, even though the
default working hours are valid.

**Evidence:** In the isolated UAT fixture, saving `Pacific/Kiritimati` with
working hours `09:00–17:00` returned the error and left the persisted time zone
at `Asia/Bangkok`. The browser payload builder maps the evening window to
`17:00–17:00` when the workday ends at 17:00.

**Root cause:** `savePreferences` derives the evening energy-window end from
the working-hours end without preserving the existing evening window or
enforcing a strictly later end. The default working-hours boundary therefore
creates an invalid zero-length evening window.

**Why the issue escaped detection:** Existing preference tests covered valid
stored windows and timezone-aware metrics, but did not submit the browser's
default `09:00–17:00` form payload after changing the time zone.

**Proposed prevention:** Keep the evening window end after its fixed 17:00
start; preserve the stored end when the working day ends at or before 17:00.
Exercise the browser save flow with both the default boundary and a non-UTC
zone, then verify the persisted preference and metrics zone.

**Status:** FIXED; browser and packaged-sidecar UAT reruns are recorded in the
closure table.

## G-19: Cancelling a preview leaves stale review state on a new date

**Symptom:** After a preview contains reasons, unscheduled tasks, or conflicts,
changing the selected date clears the apply button and shows `ยังไม่มี preview`
but leaves the previous date's review lists and success status visible.

**Evidence:** In the isolated browser fixture, an automatic preview with a
deadline conflict was created for 2026-09-17. Changing the date to 2026-09-18
rendered no timeline and disabled apply, while the old reasons and
`ช่วงเวลาที่วางเลย deadline` remained in the review regions.
The source and staged browser reruns after the correction showed empty review
fallbacks, the default `ยืนยันแผน` label, disabled Apply, and the neutral status
`เปลี่ยนวันแล้ว · สร้าง preview ใหม่เพื่อดูผล`.

**Root cause:** `renderPreview` returned immediately when `model.preview` was
null, before clearing `plannerReasonsList`, `plannerUnscheduledList`, and
`plannerConflictsList`. Date changes intentionally set the preview to null, so
the old child nodes survived the rerender; the date handlers also left the last
preview notification in `plannerStatus`.

**Why the issue escaped detection:** Earlier checks verified stale apply was
blocked and that apply cleared the preview, but did not inspect the review
regions or status after cancelling by changing date or mode.

**Proposed prevention:** Clear all review lists and reset the review controls
whenever preview state is null; reset the status when a date change cancels the
preview, then exercise preview → date change in both source and staged browsers.

**Status:** FIXED; source and staged browser reruns are recorded in the gate
report and closure table.

## G-02: Failed focus persistence leaks an uncommitted state

**Symptom:** A read detects a heartbeat gap. The state write fails, but the next
successful read reports the session as interrupted while disk still says running.

**Evidence:** Injected wall clock 2026-09-18T01:00:00Z and monotonic clock 1000,
started focus, advanced both clocks 60 seconds, then injected rename `EACCES`.
First `getState()` returned `PERSISTENCE_FAILED`. After restoring rename, output:
`MEMORY_SESSION interrupted 2` and `DISK_SESSION running 2`.

**Root cause:** `reconcileForRead` calls `reconcileSession` on the live authoritative
state before cloning and persisting a candidate. A failed write leaves the live
object mutated, and subsequent reads no longer see a transition that needs saving.
Startup recovery also needs review because it currently catches persistence errors
while retaining the changed in-memory session.

**Why the issue escaped detection:** The in-progress implementation had not yet
tested read-triggered lifecycle transitions under filesystem failure. Ordinary
successful task saves do not exercise this path.

**Proposed prevention:** Reconcile a detached candidate, validate before writing,
and publish it only after atomic persistence succeeds. Fail closed or retry recovery
without claiming uncommitted state as durable. Test both read-time and restart-time
recovery failures and verify disk/memory/revision consistency.

**Status:** FIXED; verification evidence is listed in the closure table.

## G-03: Real reasoning model returns no JSON content

**Symptom:** The browser task-assistant flow rejects a Thai two-task request from
`qwen3.5:9b` with `Ollama draft ไม่ใช่ JSON ที่ถูกต้อง`.

**Evidence:** Root repeated the native request with the same model, JSON mode,
temperature 0.2 and `num_predict:1200`. Response metadata: HTTP 200, done true,
done_reason `length`, eval_count 1200, content length 0, reasoning length 4513.
Only lengths and metadata were inspected; the reasoning text was not exposed.
No additional task was persisted by the failed draft request.

**Root cause:** The transport allowed the reasoning model to exhaust its generation
budget before producing answer content. JSON mode alone does not reserve tokens
for the answer or enforce the complete task-field schema.

**Why the issue escaped detection:** Mock structured output and the installed model
list do not exercise the actual native model response.

**Proposed prevention:** Use compatible native generation options and a concrete
JSON schema, retain strict output validation, and test a real selected model.
Keep malformed/offline responses as explicit failures without fabricated fallback.

**Status:** FIXED; verification evidence is listed in the closure table.

## G-04: Insights UI reads the wrong response shape

**Symptom:** After a real one-minute focus session, the browser displayed
`[object Object]`, `NaN%`, zero minutes and no source records.

**Evidence:** The isolated HTTP API returned nested metrics such as
`focusTime.confirmedMinutes:1`, `tasksCompleted.count:0`, `focusStreak.days:0`,
plus `metrics.hourlyRhythm` and `sourceIds.sessionIds`. The initial UI failed to
map these values. After the first frontend correction, root reloaded and verified
1 minute, 0.8% target progress and a visible source session. Zero-hour chart labels
still said `undefined งาน`, and the weekly object still rendered an empty table.

**Root cause:** The UI adapter interpreted typed nested API objects as scalar
values and expected chart/source fields in different locations. A truthiness-based
chart fallback then treated a valid zero-minute value as another metric type.

**Why the issue escaped detection:** Syntax validation does not exercise wire-shape
mapping. The first UI drop had not completed a browser flow with persisted data.

**Proposed prevention:** Use the exact shared API contract, exercise both zero and
positive metric values in the browser, and trace displayed numbers to real source
records. Avoid heuristic compatibility paths for shapes the server does not emit.

**Status:** FIXED; verification evidence is listed in the closure table.

## G-05: HTTP body-limit status is changed by the planner adapter

**Symptom:** An oversized request gets HTTP 400 instead of the server reader's 413.

**Evidence:** Root ran `pnpm test:planner` outside the sandbox: domain tests passed,
then the real HTTP suite failed at its oversized-body assertion (400 versus 413).
The sandboxed attempt stopped earlier at the existing `INVALID_HOME_ROOT` boundary.

**Root cause:** `server.mjs` sets `error.status = 413`, while the new planner catch
reads only `error.httpStatus` and otherwise emits 400.

**Why the issue escaped detection:** Domain methods do not exercise the HTTP body
reader and its error adapter.

**Proposed prevention:** Preserve known HTTP error statuses and keep the real HTTP
413 assertion. Do not weaken the test to accept any client error.

**Status:** FIXED; verification evidence is listed in the closure table.

## G-06: Time-bin attribution crosses a calendar boundary

**Symptom:** One minute spanning midnight is assigned entirely to hour 23.

**Evidence:** UTC session 2026-09-17 23:59:30 to 2026-09-18 00:00:30, target one
minute and heartbeats every 30 seconds. Root output was hour 23 = 1 minute,
with no hour 0 contribution, instead of 0.5 minute in each hour.

**Root cause:** Metrics advance in 60-second chunks relative to the interval start
and assign the entire chunk to the calendar bin at its start.

**Why the issue escaped detection:** The first midnight test started exactly on a
minute boundary, so its chunks happened to align with the day boundary.

**Proposed prevention:** Split intervals at actual calendar boundaries, including
partial minutes and selected-zone offsets, and add non-aligned boundary fixtures.

**Status:** FIXED; verification evidence is listed in the closure table.

## G-07: Energy preference overrides a feasible deadline

**Symptom:** Auto planning chooses an afternoon slot after the deadline although a
morning slot before the deadline is available.

**Evidence:** Fixed clock 2026-09-18 08:00 UTC; target day September 19; availability
09:00–12:00 and 13:00–17:00; morning energy 1, afternoon 5. A 30-minute task with
energy demand 5 and deadline 10:00 was placed at 13:00 with DEADLINE_CONFLICT.

**Root cause:** Task sorting considers deadline, but slot ranking prioritizes energy
fit without first preferring slots that meet that task's deadline.

**Why the issue escaped detection:** Sorting-order tests alone do not prove a valid
deadline is respected during slot selection.

**Proposed prevention:** Rank feasible deadline slots before energy/context fit;
warn only when no fitting slot can meet the deadline. Add the two-window fixture.

**Status:** FIXED; verification evidence is listed in the closure table.

## G-08: A future-day late-start simulation has no effect

**Symptom:** A 60-minute late-start scenario for a future workday still starts at 09:00.

**Evidence:** With current date September 18 and target day September 19,
availability 09:00–17:00 and `start-late` 60, root observed 09:00 rather than 10:00.

**Root cause:** The scheduling floor adds the delay to the current wall clock,
then compares it with midnight of the selected day. Future-day working hours are
not used as the scenario baseline.

**Why the issue escaped detection:** A same-day scenario near work start can hide
the wrong reference point.

**Proposed prevention:** Define the delay relative to the selected day's work start
(or an explicit user-selected start) and test both today and a future day.

**Status:** FIXED; verification evidence is listed in the closure table.

## G-09: Saving one AI task discards the remaining drafts

**Symptom:** A real Ollama response contains two draft tasks. Saving the first
creates one task and closes the editor, losing the second unsaved draft.

**Evidence:** Root generated Thai meeting-preparation tasks, edited the first
title to “รวบรวมคำถาม (ตรวจแล้ว)”, then saved. One new task appeared; the draft
editor disappeared and “ตรวจเอกสาร” was no longer available to review.

**Root cause:** `saveDraftTask` clears `model.draft` after every individual save.
It treats completion of one item as completion of the entire draft collection.

**Why the issue escaped detection:** The first manual flow saved only one draft
and did not verify that other items remained available.

**Proposed prevention:** Remove only the successfully saved item, retain all
remaining edits, and disable duplicate submission while saving. Verify a real
two-item generation through two separate reviewed saves.

**Status:** FIXED; verification evidence is listed in the closure table.

**Follow-up evidence:** Saving the first draft now retains the second. Switching
from an edited first draft to the second and back still reset the edited title.
The selection handler cleared the dirty marker without copying form values back
to the draft. The worker has added per-item editor retention for root retest.

## G-10: Priority labels and scheduling order disagree

**Symptom:** Selecting the UI's highest priority can give a task a lower scheduling
rank than selecting its lowest priority.

**Evidence:** `public/index.html` labels priority 1 “ต่ำ” and 5 “สูง”, while the
shared contract defines 1 highest and 5 lowest and the backend sorts ascending.

**Root cause:** The presentation and domain independently chose opposite numeric
conventions without an explicit shared mapping.

**Why the issue escaped detection:** Validating the numeric range alone does not
verify the meaning of those values across the UI/API boundary.

**Proposed prevention:** Use the contract's 1-highest convention consistently for
manual fields, AI extraction, and draft review; test scheduling order.

**Status:** FIXED; verification evidence is listed in the closure table.

## G-11: Forward wall-clock jumps inflate confirmed focus time

**Symptom:** Fifteen seconds of elapsed time can be recorded as 25 focus minutes.

**Evidence:** Root started a 25-minute session at UTC 01:00 with monotonic clock
1000, advanced wall time by one hour and monotonic time by 15 seconds, sent a
heartbeat, and paused. The persisted interval was 01:00–01:25 and insights returned
25 minutes. Actual monotonic elapsed time was 0.25 minute.

**Root cause:** Continuity validation checks backward wall movement and monotonic
gaps but accepts a forward wall jump. Interval closure uses the wall-clock delta,
which can exceed the monotonic duration and inflate accounting up to the target.

**Why the issue escaped detection:** Backward-clock and heartbeat-gap tests do not
exercise forward wall movement while monotonic time remains continuous.

**Proposed prevention:** Bound confirmation by monotonic elapsed time, detect clock
divergence, and keep heartbeat/read/pause/finish/restart accounting consistent.
Add a deterministic forward-jump regression with disk and insight assertions.

**Status:** FIXED; verification evidence is listed in the closure table.

## G-12: Pause/resume operation retries are not idempotent

**Symptom:** Retrying a successfully saved pause after a lost response returns a
revision conflict instead of the already-recorded result.

**Evidence:** Root repeated the same pause operation ID and original base revision
after successful persistence; output was `PAUSE_REPLAY REVISION_CONFLICT`.

**Root cause:** Pause and resume validate the current revision before looking up
the operation ledger, unlike task/start/finish mutations.

**Why the issue escaped detection:** Existing retry checks covered creation and
finish but not each lifecycle mutation.

**Proposed prevention:** Resolve exact operation retries before revision checks,
reject changed payload reuse, and verify both pause and resume across restart.

**Status:** FIXED; verification evidence is listed in the closure table.

## G-13: Historical task references prevent archive and manual review

**Symptom:** Archiving a completed task with a past accepted plan fails; reviewing
the unchanged historical plan in manual mode also fails.

**Evidence:** Root created and auto-planned a 30-minute task on September 18 at
09:00 UTC, advanced to September 19, and completed the task. Manual preview of
the identical past blocks returned `PLAN_CONSTRAINT / TASK_NOT_ELIGIBLE`.
Archiving returned `STATE_CORRUPT accepted plan มีงานที่เก็บถาวรแล้ว`.

**Root cause:** The stored-state validator bans archived task references in every
accepted plan, including historical plans. Manual eligibility checks likewise
apply new-placement restrictions to protected, unchanged historical blocks.

**Why the issue escaped detection:** Future-plan archive tests do not cover a task
whose plans are entirely historical or a mix of historical and future dates.

**Proposed prevention:** Preserve historical references, validate new placements
separately, and test archive/restart with both past and future accepted plans.

**Status:** FIXED; verification evidence is listed in the closure table.

## G-14: Idle coaching appears immediately and during focus

**Symptom:** Enabling reminders immediately reveals the idle message; starting a
focus session does not hide it.

**Evidence:** Root toggled coaching in the browser and observed
`visibleImmediately:true`, then started focus and observed
`visibleDuringRunning:true` alongside RUNNING 01:00.

**Root cause:** `renderCoaching` only checks enabled/dismissed and is called every
timer render. Its visibility rule bypasses the idle and running-session guards in
`checkCoaching`, so the periodic renderer defeats the intended suppression.

**Why the issue escaped detection:** Testing the idle polling guard in isolation
does not cover the independent timer rendering path.

**Proposed prevention:** Share one visibility predicate across rendering and
polling. Require opt-in, current page activity context, idle threshold, no running
session, and dismissal/cooldown checks. Avoid repeating live-region announcements.

**Status:** FIXED; verification evidence is listed in the closure table.

## G-15: Metric provenance omits historical contributors

**Symptom:** Streak and comparison values can use sessions absent from source IDs.

**Evidence:** `getInsights` calculates streak from all history and previous-week
minutes outside the selected range, but returns source IDs only for sessions
intersecting the selected chart range. The displayed metrics therefore cannot all
be traced through the returned source list.

**Root cause:** Source selection follows the chart filter instead of the union of
inputs to the displayed metrics. Distinct-day counting also uses interval starts
instead of the clipped calendar bins for the selected range.

**Why the issue escaped detection:** Golden metric values were checked without
checking which records contributed to each metric outside the chart window.

**Proposed prevention:** Return all contributing source IDs and derive sample days
from clipped bins; verify narrow-range queries with historical streak/comparison
contributors and a session spanning midnight.

**Status:** FIXED; verification evidence is listed in the closure table.

## G-16: Skip-meeting simulation can remove a past busy block

**Symptom:** A what-if simulation removes a meeting that has already ended.

**Evidence:** Root accepted a locked busy block on September 17, 09:00–09:30 UTC,
advanced the clock to 10:00 and requested `skip-meeting` with explicit unlock.
The returned preview omitted the block (`PAST_BUSY_PRESERVED false`).

**Root cause:** The scenario removes the selected busy block from the protected
set without checking its start time, overriding the history protection rule.

**Why the issue escaped detection:** The initial skip-meeting case used a future
meeting and did not cross the start-time boundary.

**Proposed prevention:** Permit this scenario only for a future busy block and
retain past/ongoing blocks; add an explicit boundary regression.

**Status:** FIXED; verification evidence is listed in the closure table.

## G-17: UI reads a superseded plan after applying a replacement

**Symptom:** Applying a later-start plan succeeds, but Manual mode and a new busy
block use the earlier schedule.

**Evidence:** Root accepted an automatic September 19 plan starting 09:00 Bangkok,
then applied a +60-minute what-if. HTTP state revision 22 showed the accepted plan
starting 03:00 UTC (10:00 Bangkok). Adding a manual busy block displayed tasks at
09:00, 09:30 and 10:00 from the superseded plan.

**Root cause:** UI `getDayPlan` takes the first matching date without checking
`accepted`, timezone, or revision. The backend retains superseded plans, so the
first match is no longer authoritative. Related length-based block fallbacks
also treat an intentionally empty preview/manual edit as absence of a draft.

**Why the issue escaped detection:** Initial-plan creation tests do not create a
replacement revision and return to manual editing; empty-list tests were absent.

**Proposed prevention:** Select the latest accepted plan for the chosen zone and
track draft presence separately from block count. Verify replacement → manual
edit → apply and intentionally empty plans in the real browser.

**Status:** FIXED; verification evidence is listed in the closure table.

## Verification closure

The 19 findings below are tracked in the candidate identified in
[the gate report](../../docs/PRODUCTIVITY-GATE-REPORT.md). Their original
symptoms and root causes are retained above as the audit trail.

| Findings | Verification |
|---|---|
| G-01, G-05 | Combined domain/real HTTP suite; root browser auto preview/apply round trip |
| G-02 | Domain failure/restart regression and independent root injected-rename retest with disk/memory consistency |
| G-03 | Actual `qwen3.5:9b` Thai two-task generation, strict validation, manual saves; no raw reasoning displayed |
| G-04, G-10 | Browser scalar/zero/weekly metrics, selected-day labels and priority 2 scheduled ahead of priority 3 |
| G-06, G-07, G-08 | Domain midnight/deadline/future-delay regressions; browser future-day +60-minute what-if shifts 09:00 to 10:00 without writing until apply |
| G-09 | Browser saves first of two drafts and retains second; edits survive switching and both items can be saved independently |
| G-11, G-12 | Domain regressions; independent root clock jump retest records 0.25 minute and returns identical successful pause on retry |
| G-13 | Domain historical-plan completion/archive/restart regression |
| G-14 | Real browser observation: hidden immediately, visible after more than five idle minutes, hidden after dismissal and during focus |
| G-15 | Domain narrow-range history/provenance and clipped-day regressions; root reviewed source selection and real metrics |
| G-16 | Domain past/ongoing busy-block preservation regression |
| G-17 | Browser replacement plan → Manual retains 10:00; locked busy block survives rebuild; remove all blocks → preview/apply/reload stays empty; stale banner clears after apply |
| G-18 | Browser and packaged-sidecar save with `Pacific/Kiritimati` succeeds; persisted evening end remains `21:00` and insights use `GMT+14` |
| G-19 | Source and staged browser: deadline-conflict preview on 2026-09-17 → date 2026-09-18 clears timeline, all review lists, status and Apply state; revision remains unchanged |

The UI checks here do not claim native 200% zoom or full screen-reader operation.
Those unrun acceptance checks remain explicitly listed in the gate report.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.2.0b | 2026-09-17 | beta | Record 17 independently identified findings, root causes, corrections and verification closure | UNCOMMITTED | RWANG |
| 0.2.1b | 2026-09-17 | beta | Record timezone preference-save root cause found during UAT | UNCOMMITTED | RWANG |
| 0.2.2b | 2026-09-17 | beta | Fix and verify stale preview review state after date-change cancellation | UNCOMMITTED | RWANG |
| 0.1.0b | 2026-09-17 | under review | Record two root-reproduced gate failures and required regression paths | UNCOMMITTED | RWANG |
