import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPlanner, makeDefaultState } from "../planner.mjs";

async function temporaryDirectory(prefix = "rwang-planner-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function basicCrudAndIdempotency() {
  const dataDir = await temporaryDirectory("rwang-planner-crud-");
  try {
    const planner = await createPlanner({ dataDir, timeZone: "Asia/Bangkok", randomId: () => "fixture-id" });
    const initial = await planner.getState();
    assert.equal(initial.revision, 0);
    assert.deepEqual(initial.tasks, []);
    const created = await planner.createTask({
      title: "เขียนรายงาน",
      notes: "ตรวจหลักฐานก่อนส่ง",
      priority: 1,
      estimatedMinutes: 45,
      energyDemand: 4,
      category: "งาน",
      checklist: [{ text: "ตรวจตัวเลข", done: false }],
    }, { baseRevision: 0, operationId: "crud-create" });
    const duplicate = await planner.createTask({
      title: "เขียนรายงาน",
      notes: "ตรวจหลักฐานก่อนส่ง",
      priority: 1,
      estimatedMinutes: 45,
      energyDemand: 4,
      category: "งาน",
      checklist: [{ text: "ตรวจตัวเลข", done: false }],
    }, { baseRevision: 0, operationId: "crud-create" });
    assert.deepEqual(duplicate, created, "retry must return the durable original result");
    const task = created.state.tasks[0];
    assert.equal(task.id, "task-fixture-id");
    const updated = await planner.updateTask(task.id, {
      title: "เขียนรายงานฉบับตรวจแล้ว",
      checklist: [{ id: task.checklist[0].id, text: "ตรวจตัวเลข", done: true }],
    }, { baseRevision: created.state.revision });
    const completed = await planner.completeTask(task.id, { baseRevision: updated.state.revision });
    assert.equal(completed.state.tasks[0].status, "completed");
    assert.ok(completed.state.tasks[0].completedAt);
    const reopened = await planner.reopenTask(task.id, { baseRevision: completed.state.revision });
    assert.equal(reopened.state.tasks[0].status, "todo");
    assert.equal(reopened.state.tasks[0].completedAt, null);
    const archived = await planner.archiveTask(task.id, { baseRevision: reopened.state.revision });
    assert.ok(archived.state.tasks[0].archivedAt);
    assert.equal((await planner.getState()).tasks[0].archivedAt !== null, true);
    assert.equal("operations" in (await planner.getState()), false, "idempotency ledger is internal");
    await planner.close();

    const reopenedPlanner = await createPlanner({ dataDir, timeZone: "Asia/Bangkok" });
    const persisted = await reopenedPlanner.getState();
    assert.equal(persisted.tasks[0].title, "เขียนรายงานฉบับตรวจแล้ว");
    await reopenedPlanner.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function draftValidation() {
  const dataDir = await temporaryDirectory("rwang-planner-draft-");
  try {
    let request;
    const planner = await createPlanner({
      dataDir,
      timeZone: "Asia/Bangkok",
      defaultModel: "qwen3.5:9b",
      draftTransport: async (value) => {
        request = value;
        return { output: JSON.stringify({
          title: "แผนเปิดตัว",
          notes: "ร่างจากผู้ใช้",
          tasks: [{ title: "ตรวจ release gate", priority: 1, estimatedMinutes: 30, energyDemand: 4, checklist: [{ text: "ตรวจ CI", done: false }] }],
          warnings: [],
        }) };
      },
    });
    const draft = await planner.createDraft({ prompt: "ช่วยแตกงานเปิดตัว", selectedContext: { title: "งานหลัก", secret: "must-not-be-forwarded" } });
    assert.equal(draft.model, "qwen3.5:9b");
    assert.equal(draft.tasks[0].title, "ตรวจ release gate");
    assert.equal(request.context.title, "งานหลัก");
    assert.equal("secret" in request.context, false);
    assert.equal((await planner.getState()).revision, 0, "draft is preview-only");
    await planner.close();

    const invalidPlanner = await createPlanner({
      dataDir,
      timeZone: "Asia/Bangkok",
      defaultModel: "qwen3.5:9b",
      draftTransport: async () => ({ output: { tasks: [], tool_calls: [{ name: "shell" }] } }),
    });
    await assert.rejects(invalidPlanner.createDraft({ prompt: "ทำงาน" }), (error) => error.code === "DRAFT_TOOL_FORBIDDEN");
    await invalidPlanner.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function deterministicPlanningAndStaleApply() {
  const dataDir = await temporaryDirectory("rwang-planner-plan-");
  try {
    const planner = await createPlanner({ dataDir, timeZone: "UTC", now: () => new Date("2026-09-17T01:00:00.000Z") });
    let state = await planner.getState();
    let result = await planner.createTask({ title: "งานมีเวลา", estimatedMinutes: 60, priority: 1, category: "build" }, { baseRevision: state.revision });
    state = result.state;
    result = await planner.createTask({ title: "งานไม่มี estimate", priority: 2, category: "docs" }, { baseRevision: state.revision });
    state = result.state;
    const taskWithTime = state.tasks[0];
    const preview = await planner.previewPlan({ date: "2026-09-19", timeZone: "UTC", mode: "auto", availability: [{ start: "09:00", end: "10:30" }] });
    assert.equal(preview.blocks.length, 1);
    assert.ok(preview.unscheduled.some((item) => item.reason === "MISSING_DURATION"));
    assert.equal(preview.conflicts.some((item) => item.code === "PLAN_OVERLAP"), false);
    const applied = await planner.applyPlan(preview, { baseRevision: preview.baseRevision, operationId: "plan-apply" });
    assert.equal(applied.state.dayPlans.filter((plan) => plan.accepted).length, 1);
    await assert.rejects(
      planner.applyPlan(preview, { baseRevision: preview.baseRevision, operationId: "plan-apply-stale" }),
      (error) => error.code === "REVISION_CONFLICT",
    );
    await assert.rejects(planner.previewPlan({
      date: "2026-09-20",
      timeZone: "UTC",
      mode: "manual",
      blocks: [
        { id: "one", kind: "task", taskId: taskWithTime.id, start: "09:00", end: "10:00" },
        { id: "two", kind: "break", start: "09:30", end: "10:15" },
      ],
    }), (error) => error.code === "PLAN_OVERLAP");
    await planner.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function planningConstraintBoundaries() {
  const dataDir = await temporaryDirectory("rwang-planner-constraints-");
  try {
    const planner = await createPlanner({
      dataDir,
      timeZone: "UTC",
      now: () => new Date("2026-09-18T08:00:00.000Z"),
    });
    let state = await planner.getState();
    const created = await planner.createTask({
      title: "งานมี deadline",
      estimatedMinutes: 30,
      energyDemand: 5,
      deadline: { kind: "instant", at: "2026-09-19T10:00:00.000Z" },
    }, { baseRevision: state.revision });
    state = created.state;
    const deadlinePreview = await planner.previewPlan({
      date: "2026-09-19",
      timeZone: "UTC",
      mode: "auto",
      availability: [
        { start: "09:00", end: "12:00" },
        { start: "13:00", end: "17:00" },
      ],
    });
    const deadlineBlock = deadlinePreview.blocks.find((block) => block.taskId === state.tasks[0].id);
    assert.equal(deadlineBlock.start, "2026-09-19T09:00:00.000Z", "deadline feasibility must outrank energy fit");
    assert.equal(deadlinePreview.conflicts.some((item) => item.code === "DEADLINE_CONFLICT"), false);

    const busyPreview = await planner.previewPlan({
      date: "2026-09-18",
      timeZone: "UTC",
      mode: "manual",
      availability: [{ start: "09:00", end: "17:00" }],
      blocks: [{ id: "ongoing-meeting", kind: "busy", start: "07:00", end: "09:00" }],
    });
    const busyApplied = await planner.applyPlan(busyPreview, { baseRevision: state.revision, operationId: "ongoing-meeting-apply" });
    state = busyApplied.state;
    const skipPast = await planner.previewPlan({
      date: "2026-09-18",
      timeZone: "UTC",
      mode: "what-if",
      availability: [{ start: "09:00", end: "17:00" }],
      blocks: busyPreview.blocks,
      whatIf: { type: "skip-meeting", blockId: "ongoing-meeting", unlock: true },
    });
    assert.equal(skipPast.blocks.some((block) => block.id === "ongoing-meeting"), true, "skip-meeting cannot unlock a past or ongoing busy block");

    const latePreview = await planner.previewPlan({
      date: "2026-09-19",
      timeZone: "UTC",
      mode: "auto",
      availability: [{ start: "09:00", end: "17:00" }],
      whatIf: { type: "start-late", minutes: 60 },
    });
    const lateBlock = latePreview.blocks.find((block) => block.taskId === state.tasks[0].id);
    assert.equal(lateBlock.start, "2026-09-19T10:00:00.000Z", "future what-if delay must shift the selected day's work baseline");
    await planner.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function historicalPlansSurviveTaskLifecycle() {
  const dataDir = await temporaryDirectory("rwang-planner-history-");
  let wallMs = Date.parse("2026-09-17T08:00:00.000Z");
  try {
    const planner = await createPlanner({ dataDir, timeZone: "UTC", now: () => new Date(wallMs) });
    const initial = await planner.getState();
    const created = await planner.createTask({ title: "งานในอดีต", estimatedMinutes: 30 }, { baseRevision: initial.revision });
    const taskId = created.state.tasks[0].id;
    const preview = await planner.previewPlan({
      date: "2026-09-17",
      timeZone: "UTC",
      mode: "manual",
      availability: [{ start: "09:00", end: "10:00" }],
      blocks: [{ id: "historical-block", kind: "task", taskId, start: "09:00", end: "09:30" }],
    });
    const applied = await planner.applyPlan(preview, { baseRevision: created.state.revision, operationId: "history-plan-apply" });
    wallMs = Date.parse("2026-09-18T08:00:00.000Z");
    const completed = await planner.completeTask(taskId, { baseRevision: applied.state.revision });
    const oldPlan = completed.state.dayPlans.find((plan) => plan.accepted);
    const review = await planner.previewPlan({
      date: oldPlan.date,
      timeZone: oldPlan.timeZone,
      mode: "manual",
      availability: oldPlan.availability,
      blocks: oldPlan.blocks,
    });
    assert.equal(review.conflicts.some((item) => item.code === "TASK_NOT_ELIGIBLE"), false, "completed historical blocks remain reviewable");
    const archived = await planner.archiveTask(taskId, { baseRevision: completed.state.revision });
    assert.equal(archived.state.tasks[0].archivedAt !== null, true);
    assert.equal(archived.state.dayPlans.find((plan) => plan.id === oldPlan.id).blocks.length, 1, "archiving keeps historical plan references");
    await planner.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function focusContinuityAndRestartRecovery() {
  const dataDir = await temporaryDirectory("rwang-planner-focus-");
  let wallMs = Date.parse("2026-09-18T01:00:00.000Z");
  let monotonicMs = 1000;
  let failRename = false;
  try {
    const planner = await createPlanner({
      dataDir,
      timeZone: "UTC",
      now: () => new Date(wallMs),
      monotonicNow: () => monotonicMs,
      rename: async (...args) => {
        if (failRename) {
          const error = new Error("simulated rename failure");
          error.code = "EACCES";
          throw error;
        }
        return (await import("node:fs/promises")).rename(...args);
      },
    });
    let state = await planner.getState();
    const started = await planner.startFocus({ targetMinutes: 10 }, { baseRevision: state.revision, operationId: "focus-start" });
    const sessionId = started.state.focusSessions[0].id;
    state = started.state;
    wallMs += 15_000;
    monotonicMs += 15_000;
    const heartbeat = await planner.heartbeatFocus({ sessionId, sequence: 1 });
    assert.equal(heartbeat.focusSessions[0].state, "running");
    const duplicateHeartbeat = await planner.heartbeatFocus({ sessionId, sequence: 1 });
    assert.equal(duplicateHeartbeat.focusSessions[0].lastHeartbeatSequence, 1);
    wallMs += 50_000;
    monotonicMs += 50_000;
    failRename = true;
    await assert.rejects(planner.getState(), (error) => error.code === "PERSISTENCE_FAILED");
    const failedSnapshot = JSON.parse(await readFile(path.join(dataDir, "planner-state.json"), "utf8"));
    assert.equal(failedSnapshot.focusSessions[0].state, "running", "failed recovery must leave disk authoritative");
    failRename = false;
    const recovered = await planner.getState();
    assert.equal(recovered.focusSessions[0].state, "interrupted");
    const durableSnapshot = JSON.parse(await readFile(path.join(dataDir, "planner-state.json"), "utf8"));
    assert.equal(durableSnapshot.focusSessions[0].state, "interrupted");
    const resumed = await planner.resumeFocus({ sessionId }, { baseRevision: recovered.revision });
    wallMs += 30_000;
    monotonicMs += 30_000;
    const finished = await planner.finishFocus({ sessionId, reason: "done" }, { baseRevision: resumed.state.revision, operationId: "focus-finish" });
    const duplicateFinish = await planner.finishFocus({ sessionId, reason: "done" }, { baseRevision: resumed.state.revision, operationId: "focus-finish" });
    assert.deepEqual(duplicateFinish, finished);
    assert.equal(finished.state.focusSessions[0].state, "finished");
    const minutes = finished.state.focusSessions[0].activeIntervals.reduce((sum, interval) => sum + (Date.parse(interval.end) - Date.parse(interval.start)) / 60_000, 0);
    assert.equal(minutes, 0.75, "the unconfirmed heartbeat gap is excluded while resumed activity is counted");
    await planner.close();

    const afterRestart = await createPlanner({ dataDir, timeZone: "UTC", now: () => new Date(wallMs), monotonicNow: () => 0 });
    assert.equal((await afterRestart.getState()).focusSessions[0].state, "finished");
    await afterRestart.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function focusMonotonicBoundsAndReplay() {
  const dataDir = await temporaryDirectory("rwang-planner-focus-clock-");
  let wallMs = Date.parse("2026-09-18T01:00:00.000Z");
  let monotonicMs = 1000;
  try {
    const planner = await createPlanner({
      dataDir,
      timeZone: "UTC",
      now: () => new Date(wallMs),
      monotonicNow: () => monotonicMs,
    });
    const before = await planner.getState();
    const started = await planner.startFocus(
      { targetMinutes: 25 },
      { baseRevision: before.revision, operationId: "focus-clock-start" },
    );
    const sessionId = started.state.focusSessions[0].id;
    const startedRevision = started.state.revision;

    // A wall-clock jump must not turn the 15-second monotonic interval into
    // an hour of confirmed focus time.
    wallMs += 60 * 60_000;
    monotonicMs += 15_000;
    await planner.heartbeatFocus({ sessionId, sequence: 1 });
    const paused = await planner.pauseFocus(
      { sessionId },
      { baseRevision: startedRevision, operationId: "focus-clock-pause" },
    );
    const intervalMinutes = paused.state.focusSessions[0].activeIntervals.reduce(
      (sum, interval) => sum + (Date.parse(interval.end) - Date.parse(interval.start)) / 60_000,
      0,
    );
    assert.equal(intervalMinutes, 0.25, "focus closure must be bounded by monotonic elapsed time");
    const replay = await planner.pauseFocus(
      { sessionId },
      { baseRevision: startedRevision, operationId: "focus-clock-pause" },
    );
    assert.deepEqual(replay, paused, "pause retry must return its durable result before stale revision checks");
    await planner.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function focusRestartUsesPersistedMonotonicDuration() {
  const dataDir = await temporaryDirectory("rwang-planner-focus-restart-clock-");
  let wallMs = Date.parse("2026-09-18T01:00:00.000Z");
  let monotonicMs = 1000;
  try {
    const planner = await createPlanner({
      dataDir,
      timeZone: "UTC",
      now: () => new Date(wallMs),
      monotonicNow: () => monotonicMs,
    });
    const started = await planner.startFocus({ targetMinutes: 25 }, { baseRevision: 0, operationId: "focus-restart-start" });
    const sessionId = started.state.focusSessions[0].id;
    wallMs += 60 * 60_000;
    monotonicMs += 15_000;
    await planner.heartbeatFocus({ sessionId, sequence: 1 });
    await planner.close();

    const restarted = await createPlanner({
      dataDir,
      timeZone: "UTC",
      now: () => new Date(wallMs),
      monotonicNow: () => 0,
    });
    const recovered = await restarted.getState();
    assert.equal(recovered.focusSessions[0].state, "interrupted");
    const intervalMinutes = recovered.focusSessions[0].activeIntervals.reduce(
      (sum, interval) => sum + (Date.parse(interval.end) - Date.parse(interval.start)) / 60_000,
      0,
    );
    assert.equal(intervalMinutes, 0.25, "restart recovery must use the persisted monotonic duration");
    await restarted.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function corruptStateFailsClosed() {
  const dataDir = await temporaryDirectory("rwang-planner-corrupt-");
  try {
    const stateFile = path.join(dataDir, "planner-state.json");
    await writeFile(stateFile, JSON.stringify({ schemaVersion: 999, revision: 0 }), "utf8");
    const planner = await createPlanner({ dataDir, timeZone: "UTC" });
    assert.equal(planner.status().available, false);
    await assert.rejects(planner.getState(), (error) => error.code === "STATE_UNSUPPORTED");
    assert.equal(await readFile(stateFile, "utf8"), JSON.stringify({ schemaVersion: 999, revision: 0 }));
    await planner.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function insightsBoundaries() {
  const dataDir = await temporaryDirectory("rwang-planner-insights-");
  let wallMs = Date.parse("2026-09-17T23:59:30.000Z");
  let monotonicMs = 1000;
  try {
    const planner = await createPlanner({ dataDir, timeZone: "UTC", now: () => new Date(wallMs), monotonicNow: () => monotonicMs });
    let state = await planner.getState();
    const taskResult = await planner.createTask({ title: "งานสถิติ", estimatedMinutes: 1 }, { baseRevision: state.revision });
    state = taskResult.state;
    const started = await planner.startFocus({ taskId: state.tasks[0].id, targetMinutes: 1 }, { baseRevision: state.revision, operationId: "insight-start" });
    const id = started.state.focusSessions[0].id;
    wallMs += 30_000;
    monotonicMs += 30_000;
    await planner.heartbeatFocus({ sessionId: id, sequence: 1 });
    wallMs += 30_000;
    monotonicMs += 30_000;
    await planner.heartbeatFocus({ sessionId: id, sequence: 2 });
    const insights = await planner.getInsights({ from: "2026-09-17", to: "2026-09-18", timeZone: "UTC" });
    assert.equal(insights.metrics.focusTime.confirmedMinutes, 1);
    assert.equal(insights.metrics.hourlyRhythm.find((item) => item.hour === 23).minutes, 0.5);
    assert.equal(insights.metrics.hourlyRhythm.find((item) => item.hour === 0).minutes, 0.5);
    assert.equal(insights.sampleSize.distinctSessionDays, 2, "cross-midnight sessions contribute to both visible local dates");
    assert.equal(insights.metrics.planCompletion.percent, null);
    assert.equal(insights.metrics.planCompletion.reason, "ยังไม่มีงานในแผน");
    assert.equal(insights.metrics.weeklyProgress.previousMinutes, 0);
    assert.equal(insights.metrics.weeklyProgress.changePercent, null);
    assert.equal(insights.timeZone, "UTC");
    assert.equal(insights.sourceIds.sessionIds.length, 1);
    await planner.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function finishedSession(id, start, minutes) {
  const end = new Date(Date.parse(start) + minutes * 60_000).toISOString();
  return {
    id,
    taskId: null,
    state: "finished",
    targetMinutes: minutes,
    timeZone: "UTC",
    activeIntervals: [{ start, end }],
    currentStartedAt: null,
    currentStartedMono: null,
    lastHeartbeatAt: end,
    lastHeartbeatMono: null,
    lastHeartbeatSequence: 1,
    startedAt: start,
    pausedAt: null,
    endedAt: end,
    endReason: "target-reached",
    revision: 0,
  };
}

async function insightsRecommendationThresholdAndHistory() {
  const thresholdDir = await temporaryDirectory("rwang-planner-insight-threshold-");
  try {
    const state = makeDefaultState("UTC");
    state.focusSessions = [
      finishedSession("focus-threshold-1", "2026-09-10T09:00:00.000Z", 1),
      finishedSession("focus-threshold-2", "2026-09-10T09:02:00.000Z", 1),
      finishedSession("focus-threshold-3", "2026-09-10T09:04:00.000Z", 1),
      finishedSession("focus-threshold-4", "2026-09-11T10:00:00.000Z", 1),
      finishedSession("focus-threshold-5", "2026-09-12T10:00:00.000Z", 1),
    ];
    await writeFile(path.join(thresholdDir, "planner-state.json"), JSON.stringify(state), "utf8");
    const planner = await createPlanner({ dataDir: thresholdDir, timeZone: "UTC", now: () => new Date("2026-09-12T12:00:00.000Z") });
    const insights = await planner.getInsights({ from: "2026-09-10", to: "2026-09-16", timeZone: "UTC" });
    assert.equal(insights.sampleSize.sessions, 5);
    assert.equal(insights.sampleSize.distinctSessionDays, 3);
    assert.equal(insights.metrics.hourlyRhythm.find((item) => item.hour === 9).sampleDays, 1);
    assert.equal(insights.metrics.recommendation, null, "recommendation must require three sample days in the chosen hour");
    await planner.close();
  } finally {
    await rm(thresholdDir, { recursive: true, force: true });
  }

  const streakDir = await temporaryDirectory("rwang-planner-insight-streak-");
  try {
    const state = makeDefaultState("UTC");
    state.focusSessions = [
      finishedSession("focus-streak-1", "2026-09-14T09:00:00.000Z", 5),
      finishedSession("focus-streak-2", "2026-09-15T09:00:00.000Z", 5),
      finishedSession("focus-streak-3", "2026-09-16T09:00:00.000Z", 5),
    ];
    await writeFile(path.join(streakDir, "planner-state.json"), JSON.stringify(state), "utf8");
    const planner = await createPlanner({ dataDir: streakDir, timeZone: "UTC", now: () => new Date("2026-09-16T12:00:00.000Z") });
    const insights = await planner.getInsights({ from: "2026-09-16", to: "2026-09-16", timeZone: "UTC" });
    assert.equal(insights.metrics.focusTime.confirmedMinutes, 5);
    assert.equal(insights.metrics.focusStreak.days, 3, "streak must use history outside the chart range");
    assert.deepEqual(insights.sourceIds.sessionIds, ["focus-streak-1", "focus-streak-2", "focus-streak-3"], "historical metric contributors must remain provenance-visible");
    await planner.close();
  } finally {
    await rm(streakDir, { recursive: true, force: true });
  }
}

await basicCrudAndIdempotency();
await draftValidation();
await deterministicPlanningAndStaleApply();
await planningConstraintBoundaries();
await historicalPlansSurviveTaskLifecycle();
await focusContinuityAndRestartRecovery();
await focusMonotonicBoundsAndReplay();
await focusRestartUsesPersistedMonotonicDuration();
await corruptStateFailsClosed();
await insightsBoundaries();
await insightsRecommendationThresholdAndHistory();
console.log("RWANG planner domain tests passed");
