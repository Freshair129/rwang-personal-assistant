---
version: "0.1.2b"
created_at: "2026-09-17T01:55:11+07:00,RWANG,2ea8a343acedfaa052c6430e9891b09328a3b883"
last_update: "2026-09-17T03:05:36+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "personal-productivity"
  scope: "planner host API and domain module"
  artifact_type: "contract"
---

# RWANG Planner Contract

This contract implements RWP-FR-001 through RWP-FR-013 from
`docs/PRD-RWANG-PRODUCTIVITY.md`. Calendar sync (RWP-FR-014) is excluded.
The current product version remains `0.5.0`.

The planner is local-first and host-only. `server.mjs` retains its existing
host, origin, JSON, and authorization guards; `rwang.mjs` adds a second guard
requiring `isLocal(req)` for every planner read and write. Planner data never
appears in `/api/status`, `/api/events`, public snapshots, remote routes, or
Assistant prompts by default.

## Domain API

`createPlanner(options)` returns a promise of a planner instance. The module
is side-effect free until the instance is created, and a bad/missing state file
is reported by the planner without making unrelated RWANG features fail.

Required options:

```js
createPlanner({ dataDir, ollamaUrl, defaultModel, timeZone })
```

Test and integration options:

```js
{
  now: () => new Date(),                 // wall clock, injectable
  monotonicNow: () => number,            // monotonic milliseconds, injectable
  draftTransport: async (request) => ({  // structured draft transport
    output: object | string,
  }),
  writeFile, rename, readFile, lstat, realpath, mkdir,
  randomId: () => string,
  heartbeatGapMs: 45_000,
  draftTimeoutMs: 120_000,
  draftMaxOutputBytes: 64 * 1024,
}
```

The returned instance exposes these methods. Mutation methods return the new
durable snapshot and increment `revision` only after an atomic write succeeds.

```js
await planner.getState()
await planner.createTask(input, { baseRevision, operationId })
await planner.updateTask(id, input, { baseRevision, operationId })
await planner.completeTask(id, { baseRevision, operationId })
await planner.reopenTask(id, { baseRevision, operationId })
await planner.archiveTask(id, { baseRevision, operationId })
await planner.searchTasks({ query, status, archived })
await planner.createDraft({ prompt, model, selectedContext, timeZone })
await planner.previewPlan(input)
await planner.applyPlan(preview, { baseRevision, operationId })
await planner.updatePreferences(input, { baseRevision, operationId })
await planner.startFocus(input, { baseRevision, operationId })
await planner.pauseFocus(input, { baseRevision, operationId })
await planner.resumeFocus(input, { baseRevision, operationId })
await planner.finishFocus(input, { baseRevision, operationId })
await planner.heartbeatFocus(input)
await planner.getInsights(input)
await planner.close()
```

All dates in persisted state are ISO UTC instants except explicit local dates
(`YYYY-MM-DD`) and `timeZone` fields. A date-only deadline remains date-only.
The planner validates stored state strictly (schema version, bounded values,
IDs, dates, blocks, intervals, and cross-entity invariants). Unsupported or
corrupt state fails closed with `STATE_CORRUPT` or `STATE_UNSUPPORTED` and is
never replaced by defaults.

## Persisted state

```ts
type PlannerState = {
  schemaVersion: 1,
  revision: number,
  preferences: Preferences,
  tasks: Task[],
  dayPlans: DayPlan[],
  focusSessions: FocusSession[],
  operations: Operation[],
}

type Preferences = {
  timeZone: string,                         // IANA zone
  workingHours: { start: "HH:MM", end: "HH:MM" },
  energyWindows: Array<{
    period: "morning" | "afternoon" | "evening",
    start: "HH:MM", end: "HH:MM", level: 1 | 2 | 3 | 4 | 5,
  }>,
  dailyFocusTargetMinutes: number,          // 1..1440
  remindersEnabled: boolean,
}

type Task = {
  id: string,
  title: string,                            // 1..240 chars
  notes: string,                            // <=4000 chars
  deadline: null | { kind: "date", date: "YYYY-MM-DD" }
             | { kind: "instant", at: string },
  priority: 1 | 2 | 3 | 4 | 5,
  estimatedMinutes: null | number,          // 1..1440
  energyDemand: 1 | 2 | 3 | 4 | 5,
  category: string,
  project: string,
  checklist: Array<{ id: string, text: string, done: boolean }>,
  status: "todo" | "in-progress" | "completed",
  createdAt: string,
  updatedAt: string,
  completedAt: null | string,
  archivedAt: null | string,
}

type DayPlan = {
  id: string,
  date: "YYYY-MM-DD",
  timeZone: string,
  availability: Array<{ start: "HH:MM", end: "HH:MM" }>,
  blocks: Array<{
    id: string,
    kind: "task" | "break" | "busy",
    taskId: null | string,
    start: string,                          // ISO UTC instant
    end: string,                            // ISO UTC instant, end > start
    locked: boolean,
    reason: string,
  }>,
  accepted: boolean,
  createdAt: string,
  updatedAt: string,
  lastOptimizedAt: null | string,
  revision: number,
}

type FocusSession = {
  id: string,
  taskId: null | string,
  state: "idle" | "running" | "paused" | "interrupted" | "finished",
  targetMinutes: number,
  timeZone: string,
  activeIntervals: Array<{ start: string, end: string }>,
  currentStartedAt: null | string,
  currentStartedMono: null | number,
  currentElapsedMs: null | number,       // monotonic confirmed duration of current segment
  lastHeartbeatAt: null | string,
  lastHeartbeatMono: null | number,
  lastHeartbeatSequence: number,
  startedAt: string,
  pausedAt: null | string,
  endedAt: null | string,
  endReason: null | string,
  revision: number,
}

type Operation = {
  operationId: string,
  action: "task/create" | "task/update" | "task/complete" | "task/reopen"
          | "task/archive" | "plan/apply" | "focus/start" | "focus/pause"
          | "focus/resume" | "focus/finish" | "preferences",
  requestHash: string,
  result: object,
  createdAt: string,
}
```

`operations` is an internal idempotency ledger. It is persisted with the
snapshot and omitted from every public state response. At most 200 records are
retained; old records may be evicted after 24 hours. Reusing an operation ID
with a different action or request hash returns `OPERATION_CONFLICT` and never
mutates state. A retry with the same action and hash returns the original
result after a restart as well as in the same process.

The state file is `${dataDir}/planner-state.json`; its temporary sibling is
`planner-state.tmp`. Both paths must be regular files contained by the
canonical `dataDir`, which must itself be a regular directory. Writes are
serialized and use write-then-atomic-rename. On a write error the old snapshot
and revision remain authoritative.

## HTTP API

The routes are under `/api/rwang/planner/` and accept JSON POST bodies only.
`baseRevision` is required for all edits except focus heartbeats. `operationId`
is required for retryable `start`, `finish`, and `apply` actions and is accepted
for all mutations. Operation IDs are bounded strings and idempotent within the
retained operation result set.

Success envelopes:

```json
{ "ok": true, "state": { "schemaVersion": 1, "revision": 2, "...": "..." } }
{ "ok": true, "preview": { "baseRevision": 2, "mode": "auto", "...": "..." } }
{ "ok": true, "draft": { "title": "...", "tasks": [], "warnings": [] } }
{ "ok": true, "insights": { "range": {}, "referenceDate": "2026-09-17", "timeZone": "Asia/Bangkok", "...": "..." } }
```

Error envelope:

```json
{ "ok": false, "error": "safe human-readable message", "code": "ERROR_CODE" }
```

| Method | Path | Request body | Response |
|---|---|---|---|
| GET | `state` | none | `{ok,state}` |
| POST | `tasks` | `{action:"create",task,baseRevision,operationId}` or `{action:"update"\|"complete"\|"reopen"\|"archive",id,task?,baseRevision,operationId,archivePreviewId?}` | `{ok,state}` |
| POST | `draft` | `{prompt,model?,selectedContext?,timeZone?}` | `{ok,draft}` |
| POST | `plan/preview` | `{date,timeZone,mode:"manual"\|"auto"\|"what-if",availability?,blocks?,whatIf?,taskIds?}` | `{ok,preview}` |
| POST | `plan/apply` | `{preview,baseRevision,operationId}` | `{ok,state}` |
| POST | `focus` | `{action:"start"\|"pause"\|"resume"\|"finish"\|"heartbeat",sessionId?,taskId?,targetMinutes?,sequence?,reason?,baseRevision?,operationId?}` | `{ok,state}` |
| POST | `preferences` | `{preferences,baseRevision,operationId}` | `{ok,state}` |
| GET | `insights` | query `from=YYYY-MM-DD&to=YYYY-MM-DD&timeZone=IANA` | `{ok,insights}` |

If a task is archived while it has one or more future blocks in accepted plans,
the first archive request returns HTTP 409 with
`code:"ARCHIVE_REQUIRES_PREVIEW"` and a `preview` shaped like `PlanPreview`.
The preview includes `affectedPlanIds` and `affectedPlans`; every future task
placement must be reviewed and removed in the same confirmation. Historical
accepted plans remain in storage for provenance, but are marked non-current.
The client repeats the archive request with the returned `archivePreviewId`; the
task archive and all future-block removals are one atomic snapshot. Archiving a
task with no future block succeeds directly.

`GET state` and `GET insights` still require the local principal. A stale
`baseRevision` returns HTTP 409 with `code:"REVISION_CONFLICT"` and the current
revision. Validation failures return 400 (`VALIDATION_ERROR`); missing entity
returns 404 (`NOT_FOUND`); unavailable/corrupt storage returns 503
(`PLANNER_UNAVAILABLE`/`STATE_CORRUPT`); disallowed principal returns 403
(`LOCAL_ONLY`).

## Preview, What-if, and Draft types

```ts
type PlanPreview = {
  previewId: string,
  baseRevision: number,
  date: "YYYY-MM-DD",
  timeZone: string,
  mode: "manual" | "auto" | "what-if",
  availability: Array<{ start: "HH:MM", end: "HH:MM" }>,
  blocks: Array<DayPlan["blocks"][number]>,
  unscheduled: Array<{ taskId: string, reason: string }>,
  conflicts: Array<{ code: string, taskId?: string, blockId?: string, message: string }>,
  reasons: Array<{ taskId: string, rule: string, message: string }>,
  movedTaskIds: string[],
  contextSwitches: { before: number, after: number, reduced: number },
  changes: { added: string[], removed: string[], moved: string[] },
  whatIf: null | WhatIf,
  sourcePlanId: null | string,
  generatedAt: string,
  request: object,
}

// Archive responses add these fields to the same preview object:
type ArchivePlanPreview = PlanPreview & {
  affectedPlanIds: string[],
  affectedPlans: PlanPreview[],
}

type WhatIf =
  | { type: "start-late", minutes: number }
  | { type: "skip-meeting", blockId: string, unlock: true }
  | { type: "tired", energyLevel: 1 | 2 | 3 | 4 | 5 }
  | { type: "archive-task", taskId: string }
```

`request` is the normalized, bounded input used to create the preview. It is
included so `applyPlan` can recompute and compare constraints instead of
trusting client-edited blocks. `applyPlan` accepts either this full preview or
`previewId` from the in-memory preview cache; after restart, the full preview
must be supplied.

```ts
type Draft = {
  model: string,
  prompt: string,
  title: string,
  notes: string,
  tasks: Array<{
    title: string,
    notes: string,
    deadline: null | { kind: "date", date: "YYYY-MM-DD" }
             | { kind: "instant", at: string },
    priority: 1 | 2 | 3 | 4 | 5,
    estimatedMinutes: null | number,
    energyDemand: 1 | 2 | 3 | 4 | 5,
    category: string,
    project: string,
    checklist: Array<{ text: string, done: boolean }>,
  }>,
  warnings: string[],
  generatedAt: string,
}
```

The draft endpoint sends only the user prompt and explicitly selected context
to Ollama. It accepts a JSON object from a bounded, timeout-limited native
`/api/chat` request; tool calls, file paths, shell commands, arbitrary action
fields, malformed dates, and invalid values are rejected. A draft is never
persisted until the user submits a normal task mutation.

```ts
type Insights = {
  range: { from: "YYYY-MM-DD", to: "YYYY-MM-DD" },
  referenceDate: "YYYY-MM-DD",
  timeZone: string,
  computedAt: string,
  sampleSize: { days: number, sessions: number, distinctSessionDays: number },
  sourceIds: { taskIds: string[], planIds: string[], sessionIds: string[] },
  metrics: {
    tasksToday: { total: number, completed: number, active: number }, // for referenceDate
    tasksCompleted: { count: number },
    planCompletion: { percent: null | number, numerator: number, denominator: number, reason?: string },
    focusTime: { confirmedMinutes: number },
    focusTargetProgress: { percent: null | number, confirmedMinutes: number, targetMinutes: number, reason?: string }, // referenceDate only
    focusStreak: { days: number },
    hourlyRhythm: Array<{ hour: number, minutes: number, sampleDays: number }>,
    weeklyProgress: { currentMinutes: number, previousMinutes: number, changePercent: null | number, reason?: string },
    changePercentage: { current: number, previous: number, percent: null | number, reason?: string },
    recommendation: null | { startHour: number, endHour: number, minutes: number, sampleDays: number, message: string },
  },
}
```

Counts and confirmed minutes with no records are zero. Undefined ratios use
`percent:null` and a reason. Recommendations require at least 7 days, 5
sessions, and 3 distinct session days; wording remains observational.

## Planning rules

Priority values are ordered `1` highest through `5` lowest; the default is `3`.
Manual and automatic previews pass through the same deterministic validator.
Hard constraints are availability, positive non-overlap, past time, locked/
busy/running blocks, and task status. Sorting is deadline, priority, energy
fit, context switch, then stable task ID. Tasks without an estimate are placed
in `unscheduled` with `MISSING_DURATION`; no estimate is silently invented.
No task is split automatically. Late placement is retained only with a
`DEADLINE_CONFLICT` warning. A what-if `skip-meeting` input must explicitly
identify and unlock a future busy block; past or ongoing busy blocks remain
protected. Applying a preview checks
its source revision and recomputes constraints; stale previews return 409.
Archiving a future-planned task produces an `ARCHIVE_REMOVAL` preview for every
affected accepted plan and removes all future blocks on apply while retaining
historical accepted plans.

## Focus and insights

The lifecycle is `idle -> running <-> paused -> finished`; continuity loss
transitions `running -> interrupted`. The server records UTC intervals using
wall and monotonic clocks. Heartbeats carry a session ID and strictly
increasing sequence; a gap over 45 seconds interrupts at the last accepted
heartbeat. Paused, post-restart, sleep, and unconfirmed gaps are excluded.
One running session is allowed per host. Finish is idempotent and never counts
an interval twice; reaching target caps confirmed active minutes at target.

Insights return `range`, `referenceDate`, `timeZone`, `computedAt`, `sampleSize`,
source IDs, and the defined metrics: tasks today, completed tasks, plan
completion, confirmed focus minutes, target progress, streak, hourly rhythm,
weekly progress, and change percentage. Session provenance includes
contributors to the selected range and any historical interval used by
streak, target, or weekly calculations; distinct sample days use clipped local
minute bins. Missing counts/times are zero. Undefined ratios are `null` with a
reason. Rhythm recommendations require at least 7 days, 5 sessions, and 3
distinct days, and use observational wording.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.2b | 2026-09-17 | beta | Gate-verified continuity duration, reference-date metrics, historical provenance and corrected creation metadata | UNCOMMITTED | RWANG |
| 0.1.1b | 2026-09-17 | beta | Exact preview, draft, insights, archive handshake, and restart-safe idempotency shapes | UNCOMMITTED | RWANG |
| 0.1.0b | 2026-09-17 | beta | Initial host-only planner domain/API contract for approved P1-P3 | UNCOMMITTED | RWANG |
