import { createHash, randomUUID } from "node:crypto";
import {
  lstat as fsLstat,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  realpath as fsRealpath,
  rename as fsRename,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const STATE_FILE = "planner-state.json";
const STATE_TEMP_FILE = "planner-state.tmp";
const MAX_TASKS = 1000;
const MAX_DAY_PLANS = 500;
const MAX_FOCUS_SESSIONS = 5000;
const MAX_OPERATIONS = 200;
const OPERATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CHECKLIST = 100;
const MAX_BLOCKS = 500;
const MAX_AVAILABILITY = 24;
const MAX_ENERGY_WINDOWS = 12;
const MAX_QUERY = 200;
const DEFAULT_HEARTBEAT_GAP_MS = 45_000;
const DEFAULT_DRAFT_TIMEOUT_MS = 120_000;
const DEFAULT_DRAFT_MAX_OUTPUT_BYTES = 64 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TASK_STATUSES = new Set(["todo", "in-progress", "completed"]);
const BLOCK_KINDS = new Set(["task", "break", "busy"]);
const FOCUS_STATES = new Set(["idle", "running", "paused", "interrupted", "finished"]);
const PLAN_MODES = new Set(["manual", "auto", "what-if"]);
const WHAT_IF_TYPES = new Set(["start-late", "skip-meeting", "tired", "archive-task"]);

const DEFAULT_ENERGY_WINDOWS = Object.freeze([
  { period: "morning", start: "08:00", end: "12:00", level: 4 },
  { period: "afternoon", start: "12:00", end: "17:00", level: 3 },
  { period: "evening", start: "17:00", end: "21:00", level: 2 },
]);

export class PlannerError extends Error {
  constructor(message, code = "VALIDATION_ERROR", httpStatus = 400, details = undefined) {
    super(message);
    this.name = "PlannerError";
    this.code = code;
    this.httpStatus = httpStatus;
    if (details !== undefined) this.details = details;
  }
}

function fail(message, code = "VALIDATION_ERROR", httpStatus = 400, details) {
  throw new PlannerError(message, code, httpStatus, details);
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clone(value) {
  return structuredClone(value);
}

function text(value, max, { required = false } = {}) {
  if (typeof value !== "string") {
    if (required) fail("ข้อความต้องเป็น string", "VALIDATION_ERROR");
    return "";
  }
  const result = value.trim();
  if (result.length > max) fail(`ข้อความยาวเกิน ${max} ตัวอักษร`, "LIMIT_EXCEEDED");
  if (required && !result) fail("ต้องระบุข้อความ", "VALIDATION_ERROR");
  return result;
}

function boundedArray(value, max, label) {
  if (!Array.isArray(value)) fail(`${label} ต้องเป็น array`, "VALIDATION_ERROR");
  if (value.length > max) fail(`${label} มีจำนวนเกิน ${max}`, "LIMIT_EXCEEDED");
  return value;
}

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${label} ต้องอยู่ระหว่าง ${min} ถึง ${max}`, "VALIDATION_ERROR");
  }
  return value;
}

function finiteNumber(value, min, max, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(`${label} ต้องอยู่ระหว่าง ${min} ถึง ${max}`, "VALIDATION_ERROR");
  }
  return value;
}

function idValue(value, label = "id") {
  if (typeof value !== "string" || !ID_RE.test(value)) fail(`${label} ไม่ถูกต้อง`, "VALIDATION_ERROR");
  return value;
}

function operationIdValue(value, { required = false } = {}) {
  if (value == null || value === "") {
    if (required) fail("ต้องระบุ operationId", "OPERATION_REQUIRED");
    return null;
  }
  if (typeof value !== "string" || !OPERATION_ID_RE.test(value)) fail("operationId ไม่ถูกต้อง", "VALIDATION_ERROR");
  return value;
}

function validDate(value, label = "date") {
  if (typeof value !== "string" || !DATE_RE.test(value)) fail(`${label} ต้องเป็น YYYY-MM-DD`, "VALIDATION_ERROR");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${label} ไม่ใช่วันที่จริง`, "VALIDATION_ERROR");
  }
  return value;
}

function validTime(value, label = "time") {
  if (typeof value !== "string" || !TIME_RE.test(value)) fail(`${label} ต้องเป็น HH:MM`, "VALIDATION_ERROR");
  return value;
}

function validIso(value, label = "timestamp", { nullable = false, state = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== "string" || !ISO_RE.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${label} ต้องเป็น ISO UTC timestamp`, state ? "STATE_CORRUPT" : "VALIDATION_ERROR", state ? 503 : 400);
  }
  return value;
}

function isoFrom(value, fallback = new Date()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? fallback);
  if (Number.isNaN(date.getTime())) fail("เวลาปัจจุบันไม่ถูกต้อง", "VALIDATION_ERROR");
  return date.toISOString();
}

function nowMs(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail("นาฬิกาไม่ถูกต้อง", "CLOCK_INVALID", 503);
  return date.getTime();
}

function dateTimeParts(instantMs, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const result = {};
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") result[part.type] = part.value;
  }
  return result;
}

function isTimeZone(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function validTimeZone(value, label = "timeZone") {
  if (!isTimeZone(value)) fail(`${label} ต้องเป็น IANA time zone`, "VALIDATION_ERROR");
  return value;
}

function localDateFromMs(instantMs, timeZone) {
  const parts = dateTimeParts(instantMs, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localWallMs(date, time, timeZone) {
  validDate(date);
  validTime(time);
  const [hour, minute] = time.split(":").map(Number);
  const desired = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour, minute, 0, 0);
  let guess = desired;
  for (let index = 0; index < 5; index += 1) {
    const parts = dateTimeParts(guess, timeZone);
    const rendered = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second), 0);
    guess = desired - (rendered - guess);
  }
  return guess;
}

function dayStartMs(date, timeZone) {
  return localWallMs(date, "00:00", timeZone);
}

function nextDate(date) {
  return new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10);
}

function addDays(date, amount) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function localTimeForMs(instantMs, timeZone) {
  const parts = dateTimeParts(instantMs, timeZone);
  return `${parts.hour}:${parts.minute}`;
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function requestHash(value) {
  return createHash("sha256").update(stable(value), "utf8").digest("hex");
}

function makeDefaultPreferences(timeZone) {
  return {
    timeZone: validTimeZone(timeZone || "Asia/Bangkok", "timeZone"),
    workingHours: { start: "09:00", end: "17:00" },
    energyWindows: clone(DEFAULT_ENERGY_WINDOWS),
    dailyFocusTargetMinutes: 120,
    remindersEnabled: false,
  };
}

function makeDefaultState(timeZone) {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    preferences: makeDefaultPreferences(timeZone),
    tasks: [],
    dayPlans: [],
    focusSessions: [],
    operations: [],
  };
}

function validateDeadline(deadline, { state = false } = {}) {
  if (deadline == null) return null;
  if (!isObject(deadline) || !["date", "instant"].includes(deadline.kind)) {
    fail("deadline ไม่ถูกต้อง", state ? "STATE_CORRUPT" : "VALIDATION_ERROR", state ? 503 : 400);
  }
  if (deadline.kind === "date") return { kind: "date", date: validDate(deadline.date, "deadline.date") };
  return { kind: "instant", at: validIso(deadline.at, "deadline.at") };
}

function validateChecklist(input, { state = false, generateId = () => `check-${randomUUID()}` } = {}) {
  const values = boundedArray(input, MAX_CHECKLIST, "checklist");
  return values.map((item) => {
    if (!isObject(item)) fail("checklist item ต้องเป็น object", state ? "STATE_CORRUPT" : "VALIDATION_ERROR", state ? 503 : 400);
    const result = {
      id: idValue(item.id ?? generateId(), "checklist.id"),
      text: text(item.text, 500, { required: true }),
      done: item.done === true,
    };
    return result;
  });
}

function validateTaskShape(task, { state = false } = {}) {
  const status = task?.status;
  const errorCode = state ? "STATE_CORRUPT" : "VALIDATION_ERROR";
  const errorStatus = state ? 503 : 400;
  if (!isObject(task)) fail("task ต้องเป็น object", errorCode, errorStatus);
  const id = idValue(task.id, "task.id");
  if (typeof task.title !== "string" || !task.title.trim() || task.title.length > 240) fail("task.title ไม่ถูกต้อง", errorCode, errorStatus);
  const notes = text(task.notes, 4000);
  const priority = integer(task.priority, 1, 5, "priority");
  const estimatedMinutes = task.estimatedMinutes == null ? null : integer(task.estimatedMinutes, 1, 1440, "estimatedMinutes");
  const energyDemand = integer(task.energyDemand, 1, 5, "energyDemand");
  if (!TASK_STATUSES.has(status)) fail("task.status ไม่ถูกต้อง", errorCode, errorStatus);
  if (typeof task.category !== "string" || task.category.length > 120) fail("task.category ไม่ถูกต้อง", errorCode, errorStatus);
  if (typeof task.project !== "string" || task.project.length > 120) fail("task.project ไม่ถูกต้อง", errorCode, errorStatus);
  const checklist = validateChecklist(task.checklist, { state });
  const createdAt = validIso(task.createdAt, "task.createdAt", { state });
  const updatedAt = validIso(task.updatedAt, "task.updatedAt", { state });
  const completedAt = validIso(task.completedAt, "task.completedAt", { nullable: true, state });
  const archivedAt = validIso(task.archivedAt, "task.archivedAt", { nullable: true, state });
  if (status === "completed" && !completedAt) fail("completed task ต้องมี completedAt", errorCode, errorStatus);
  if (status !== "completed" && completedAt) fail("งานที่ยังไม่เสร็จห้ามมี completedAt", errorCode, errorStatus);
  return {
    id,
    title: task.title.trim(),
    notes,
    deadline: validateDeadline(task.deadline, { state }),
    priority,
    estimatedMinutes,
    energyDemand,
    category: task.category.trim(),
    project: task.project.trim(),
    checklist,
    status,
    createdAt,
    updatedAt,
    completedAt,
    archivedAt,
  };
}

function validateAvailability(value, { state = false } = {}) {
  const errorCode = state ? "STATE_CORRUPT" : "VALIDATION_ERROR";
  const errorStatus = state ? 503 : 400;
  const values = boundedArray(value, MAX_AVAILABILITY, "availability");
  return values.map((entry) => {
    if (!isObject(entry)) fail("availability item ต้องเป็น object", errorCode, errorStatus);
    const start = validTime(entry.start, "availability.start");
    const end = validTime(entry.end, "availability.end");
    if (end <= start) fail("availability ต้องมี end มากกว่า start", errorCode, errorStatus);
    return { start, end };
  });
}

function validateBlockShape(block, { state = false } = {}) {
  const errorCode = state ? "STATE_CORRUPT" : "VALIDATION_ERROR";
  const errorStatus = state ? 503 : 400;
  if (!isObject(block)) fail("plan block ต้องเป็น object", errorCode, errorStatus);
  const id = idValue(block.id, "block.id");
  if (!BLOCK_KINDS.has(block.kind)) fail("block.kind ไม่ถูกต้อง", errorCode, errorStatus);
  const taskId = block.taskId == null ? null : idValue(block.taskId, "block.taskId");
  const start = validIso(block.start, "block.start", { state });
  const end = validIso(block.end, "block.end", { state });
  if (Date.parse(end) <= Date.parse(start)) fail("block ต้องมี end มากกว่า start", errorCode, errorStatus);
  if (Date.parse(end) - Date.parse(start) > 24 * 60 * 60 * 1000) fail("block ยาวเกินหนึ่งวัน", errorCode, errorStatus);
  if (block.kind === "task" && !taskId) fail("task block ต้องมี taskId", errorCode, errorStatus);
  if (block.kind !== "task" && taskId) fail("block ที่ไม่ใช่งานห้ามมี taskId", errorCode, errorStatus);
  if (typeof block.locked !== "boolean") fail("block.locked ไม่ถูกต้อง", errorCode, errorStatus);
  return { id, kind: block.kind, taskId, start, end, locked: block.locked, reason: text(block.reason, 500) };
}

function validateFocusInterval(interval, { state = false } = {}) {
  const errorCode = state ? "STATE_CORRUPT" : "VALIDATION_ERROR";
  const errorStatus = state ? 503 : 400;
  if (!isObject(interval)) fail("focus interval ต้องเป็น object", errorCode, errorStatus);
  const start = validIso(interval.start, "interval.start", { state });
  const end = validIso(interval.end, "interval.end", { state });
  if (Date.parse(end) <= Date.parse(start)) fail("focus interval ต้องมี end มากกว่า start", errorCode, errorStatus);
  if (Date.parse(end) - Date.parse(start) > 24 * 60 * 60 * 1000) fail("focus interval ยาวเกินหนึ่งวัน", errorCode, errorStatus);
  return { start, end };
}

function validatePreferencesShape(preferences, { state = false } = {}) {
  const errorCode = state ? "STATE_CORRUPT" : "VALIDATION_ERROR";
  const errorStatus = state ? 503 : 400;
  if (!isObject(preferences)) fail("preferences ต้องเป็น object", errorCode, errorStatus);
  const timeZone = validTimeZone(preferences.timeZone, "preferences.timeZone");
  if (!isObject(preferences.workingHours)) fail("workingHours ไม่ถูกต้อง", errorCode, errorStatus);
  const start = validTime(preferences.workingHours.start, "workingHours.start");
  const end = validTime(preferences.workingHours.end, "workingHours.end");
  if (end <= start) fail("workingHours ต้องมี end มากกว่า start", errorCode, errorStatus);
  const energyWindows = boundedArray(preferences.energyWindows, MAX_ENERGY_WINDOWS, "energyWindows").map((entry) => {
    if (!isObject(entry) || !["morning", "afternoon", "evening"].includes(entry.period)) fail("energy window ไม่ถูกต้อง", errorCode, errorStatus);
    const entryStart = validTime(entry.start, "energyWindow.start");
    const entryEnd = validTime(entry.end, "energyWindow.end");
    if (entryEnd <= entryStart) fail("energy window ต้องมี end มากกว่า start", errorCode, errorStatus);
    return { period: entry.period, start: entryStart, end: entryEnd, level: integer(entry.level, 1, 5, "energyWindow.level") };
  });
  return {
    timeZone,
    workingHours: { start, end },
    energyWindows,
    dailyFocusTargetMinutes: integer(preferences.dailyFocusTargetMinutes, 1, 1440, "dailyFocusTargetMinutes"),
    remindersEnabled: preferences.remindersEnabled === true,
  };
}

function validateStoredState(input) {
  if (!isObject(input)) fail("planner state ต้องเป็น object", "STATE_CORRUPT", 503);
  if (input.schemaVersion !== SCHEMA_VERSION) {
    const code = Number.isInteger(input.schemaVersion) && input.schemaVersion > SCHEMA_VERSION ? "STATE_UNSUPPORTED" : "STATE_CORRUPT";
    fail("planner state schema ไม่รองรับ", code, 503);
  }
  integer(input.revision, 0, Number.MAX_SAFE_INTEGER, "revision");
  validatePreferencesShape(input.preferences, { state: true });
  boundedArray(input.tasks, MAX_TASKS, "tasks");
  boundedArray(input.dayPlans, MAX_DAY_PLANS, "dayPlans");
  boundedArray(input.focusSessions, MAX_FOCUS_SESSIONS, "focusSessions");
  boundedArray(input.operations, MAX_OPERATIONS, "operations");
  const tasks = input.tasks.map((task) => validateTaskShape(task, { state: true }));
  const taskIds = new Set();
  for (const task of tasks) {
    if (taskIds.has(task.id)) fail("task id ซ้ำกัน", "STATE_CORRUPT", 503);
    taskIds.add(task.id);
  }
  const dayPlans = input.dayPlans.map((plan) => {
    if (!isObject(plan)) fail("dayPlan ต้องเป็น object", "STATE_CORRUPT", 503);
    const id = idValue(plan.id, "dayPlan.id");
    const date = validDate(plan.date, "dayPlan.date");
    const timeZone = validTimeZone(plan.timeZone, "dayPlan.timeZone");
    const availability = validateAvailability(plan.availability, { state: true });
    const blocks = boundedArray(plan.blocks, MAX_BLOCKS, "blocks").map((block) => validateBlockShape(block, { state: true }));
    const blockIds = new Set();
    for (const block of blocks) {
      if (blockIds.has(block.id)) fail("block id ซ้ำกัน", "STATE_CORRUPT", 503);
      blockIds.add(block.id);
      if (block.taskId && !taskIds.has(block.taskId)) fail("block อ้าง task ที่ไม่มีอยู่", "STATE_CORRUPT", 503);
      const task = block.taskId ? tasks.find((item) => item.id === block.taskId) : null;
      if (task && task.archivedAt && plan.accepted) fail("accepted plan มีงานที่เก็บถาวรแล้ว", "STATE_CORRUPT", 503);
    }
    const sorted = [...blocks].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    for (let index = 1; index < sorted.length; index += 1) {
      if (Date.parse(sorted[index].start) < Date.parse(sorted[index - 1].end)) fail("plan blocks ทับซ้อนกัน", "STATE_CORRUPT", 503);
    }
    return {
      id,
      date,
      timeZone,
      availability,
      blocks,
      accepted: plan.accepted === true,
      createdAt: validIso(plan.createdAt, "dayPlan.createdAt", { state: true }),
      updatedAt: validIso(plan.updatedAt, "dayPlan.updatedAt", { state: true }),
      lastOptimizedAt: validIso(plan.lastOptimizedAt, "dayPlan.lastOptimizedAt", { nullable: true, state: true }),
      revision: integer(plan.revision, 0, Number.MAX_SAFE_INTEGER, "dayPlan.revision"),
    };
  });
  const focusSessions = input.focusSessions.map((session) => {
    if (!isObject(session)) fail("focusSession ต้องเป็น object", "STATE_CORRUPT", 503);
    const id = idValue(session.id, "focusSession.id");
    const taskId = session.taskId == null ? null : idValue(session.taskId, "focusSession.taskId");
    if (taskId && !taskIds.has(taskId)) fail("focusSession อ้าง task ที่ไม่มีอยู่", "STATE_CORRUPT", 503);
    const state = session.state;
    if (!FOCUS_STATES.has(state)) fail("focusSession.state ไม่ถูกต้อง", "STATE_CORRUPT", 503);
    const activeIntervals = boundedArray(session.activeIntervals, 5000, "activeIntervals").map((item) => validateFocusInterval(item, { state: true }));
    const sorted = [...activeIntervals].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    for (let index = 1; index < sorted.length; index += 1) {
      if (Date.parse(sorted[index].start) < Date.parse(sorted[index - 1].end)) fail("focus intervals ทับซ้อนกัน", "STATE_CORRUPT", 503);
    }
    const currentStartedAt = validIso(session.currentStartedAt, "currentStartedAt", { nullable: true, state: true });
    const currentStartedMono = session.currentStartedMono == null ? null : finiteNumber(session.currentStartedMono, 0, Number.MAX_SAFE_INTEGER, "currentStartedMono");
    const currentElapsedMs = session.currentElapsedMs == null ? null : finiteNumber(session.currentElapsedMs, 0, 24 * 60 * 60 * 1000, "currentElapsedMs");
    const lastHeartbeatAt = validIso(session.lastHeartbeatAt, "lastHeartbeatAt", { nullable: true, state: true });
    const lastHeartbeatMono = session.lastHeartbeatMono == null ? null : finiteNumber(session.lastHeartbeatMono, 0, Number.MAX_SAFE_INTEGER, "lastHeartbeatMono");
    if (state === "running" && (!currentStartedAt || currentStartedMono == null || currentElapsedMs == null || !lastHeartbeatAt || lastHeartbeatMono == null)) fail("running focusSession ขาด continuity metadata", "STATE_CORRUPT", 503);
    if (state !== "running" && (currentStartedAt !== null || currentStartedMono !== null || currentElapsedMs !== null)) fail("focusSession ที่ไม่ running ห้ามมี active interval", "STATE_CORRUPT", 503);
    return {
      id,
      taskId,
      state,
      targetMinutes: integer(session.targetMinutes, 1, 1440, "targetMinutes"),
      timeZone: validTimeZone(session.timeZone, "focusSession.timeZone"),
      activeIntervals,
      currentStartedAt,
      currentStartedMono,
      currentElapsedMs,
      lastHeartbeatAt,
      lastHeartbeatMono,
      lastHeartbeatSequence: integer(session.lastHeartbeatSequence, 0, Number.MAX_SAFE_INTEGER, "lastHeartbeatSequence"),
      startedAt: validIso(session.startedAt, "focusSession.startedAt", { state: true }),
      pausedAt: validIso(session.pausedAt, "focusSession.pausedAt", { nullable: true, state: true }),
      endedAt: validIso(session.endedAt, "focusSession.endedAt", { nullable: true, state: true }),
      endReason: session.endReason == null ? null : text(session.endReason, 200),
      revision: integer(session.revision, 0, Number.MAX_SAFE_INTEGER, "focusSession.revision"),
    };
  });
  const running = focusSessions.filter((session) => session.state === "running");
  if (running.length > 1) fail("มี running focusSession มากกว่าหนึ่งรายการ", "STATE_CORRUPT", 503);
  const operations = input.operations.map((operation) => {
    if (!isObject(operation) || !operationIdValue(operation.operationId, { required: true })) fail("operation ledger ไม่ถูกต้อง", "STATE_CORRUPT", 503);
    if (typeof operation.action !== "string" || operation.action.length > 80) fail("operation action ไม่ถูกต้อง", "STATE_CORRUPT", 503);
    if (typeof operation.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(operation.requestHash)) fail("operation hash ไม่ถูกต้อง", "STATE_CORRUPT", 503);
    validIso(operation.createdAt, "operation.createdAt", { state: true });
    if (!isObject(operation.result)) fail("operation result ไม่ถูกต้อง", "STATE_CORRUPT", 503);
    return {
      operationId: operation.operationId,
      action: operation.action,
      requestHash: operation.requestHash,
      result: clone(operation.result),
      createdAt: operation.createdAt,
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: input.revision,
    preferences: validatePreferencesShape(input.preferences, { state: true }),
    tasks,
    dayPlans,
    focusSessions,
    operations,
  };
}

function publicState(state) {
  const result = clone(state);
  delete result.operations;
  return result;
}

function sourceIds(state) {
  return {
    taskIds: state.tasks.map((task) => task.id),
    planIds: state.dayPlans.map((plan) => plan.id),
    sessionIds: state.focusSessions.map((session) => session.id),
  };
}

async function resolveDataRoot(dataDir, ops) {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) fail("DATA_DIR ต้องเป็น absolute path", "INVALID_DATA_DIR", 503);
  const requested = path.resolve(dataDir);
  try {
    await ops.mkdir(requested, { recursive: true });
    const stats = await ops.lstat(requested);
    if (!stats.isDirectory() || stats.isSymbolicLink()) fail("DATA_DIR ต้องเป็น directory ปกติ", "INVALID_DATA_DIR", 503);
    const canonical = await ops.realpath(requested);
    const canonicalStats = await ops.lstat(canonical);
    if (!canonicalStats.isDirectory() || canonicalStats.isSymbolicLink()) fail("DATA_DIR ต้องเป็น directory ปกติ", "INVALID_DATA_DIR", 503);
    return canonical;
  } catch (error) {
    if (error instanceof PlannerError) throw error;
    fail("DATA_DIR ใช้งานไม่ได้", "INVALID_DATA_DIR", 503);
  }
}

async function safeStateFile(root, filename, ops, { allowMissing = true } = {}) {
  const requested = path.resolve(root, filename);
  const relative = path.relative(root, requested);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("planner state path ไม่ปลอดภัย", "STATE_CORRUPT", 503);
  let stats;
  try {
    stats = await ops.lstat(requested);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return requested;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) fail("planner state ต้องเป็น regular file", "STATE_CORRUPT", 503);
  const canonical = await ops.realpath(requested);
  const canonicalRelative = path.relative(root, canonical);
  if (!canonicalRelative || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) fail("planner state อยู่นอก DATA_DIR", "STATE_CORRUPT", 503);
  return requested;
}

function normalizeInputChecklist(input, generateId) {
  if (input == null) return [];
  return validateChecklist(input, { generateId });
}

function taskInput(input, { now, generateId, existing = null } = {}) {
  if (!isObject(input)) fail("task ต้องเป็น object", "VALIDATION_ERROR");
  const current = existing || {};
  const id = current.id || idValue(generateId(), "task.id");
  const title = text(input.title ?? current.title, 240, { required: true });
  const notes = text(input.notes ?? current.notes ?? "", 4000);
  const deadline = input.deadline === undefined ? (current.deadline ?? null) : validateDeadline(input.deadline);
  const priority = input.priority === undefined ? (current.priority ?? 3) : integer(input.priority, 1, 5, "priority");
  const estimatedMinutes = input.estimatedMinutes === undefined
    ? (current.estimatedMinutes ?? null)
    : (input.estimatedMinutes == null ? null : integer(input.estimatedMinutes, 1, 1440, "estimatedMinutes"));
  const energyDemand = input.energyDemand === undefined ? (current.energyDemand ?? 3) : integer(input.energyDemand, 1, 5, "energyDemand");
  const category = text(input.category ?? current.category ?? "", 120);
  const project = text(input.project ?? current.project ?? "", 120);
  const checklist = input.checklist === undefined
    ? clone(current.checklist || [])
    : normalizeInputChecklist(input.checklist, generateId);
  const status = input.status === undefined ? (current.status ?? "todo") : input.status;
  if (!TASK_STATUSES.has(status)) fail("task.status ไม่ถูกต้อง", "VALIDATION_ERROR");
  if (status === "completed" && !current.completedAt) fail("ใช้ complete action เพื่อเสร็จงาน", "VALIDATION_ERROR");
  const createdAt = current.createdAt || now;
  return {
    id,
    title,
    notes,
    deadline,
    priority,
    estimatedMinutes,
    energyDemand,
    category,
    project,
    checklist,
    status,
    createdAt,
    updatedAt: now,
    completedAt: current.completedAt ?? null,
    archivedAt: current.archivedAt ?? null,
  };
}

function validateOperationContext(context, { required = false } = {}) {
  if (!isObject(context)) fail("mutation context ไม่ถูกต้อง", "VALIDATION_ERROR");
  const operationId = operationIdValue(context.operationId, { required });
  if (context.baseRevision !== undefined && context.baseRevision !== null) integer(context.baseRevision, 0, Number.MAX_SAFE_INTEGER, "baseRevision");
  return { operationId, baseRevision: context.baseRevision ?? null };
}

function deadlineInstant(task, planDate, timeZone) {
  if (!task.deadline) return Number.POSITIVE_INFINITY;
  if (task.deadline.kind === "instant") return Date.parse(task.deadline.at);
  return dayStartMs(addDays(task.deadline.date, 1), timeZone) - 1;
}

function intervalDurationMinutes(interval) {
  return Math.max(0, (Date.parse(interval.end) - Date.parse(interval.start)) / 60000);
}

function sumFocusMinutes(session) {
  return session.activeIntervals.reduce((sum, interval) => sum + intervalDurationMinutes(interval), 0);
}

function latestAcceptedPlan(state, date, timeZone) {
  return state.dayPlans
    .filter((plan) => plan.accepted && plan.date === date && plan.timeZone === timeZone)
    .sort((a, b) => b.revision - a.revision || b.updatedAt.localeCompare(a.updatedAt))[0] || null;
}

function latestAcceptedAnyZone(state, date) {
  return state.dayPlans
    .filter((plan) => plan.accepted && plan.date === date)
    .sort((a, b) => b.revision - a.revision || b.updatedAt.localeCompare(a.updatedAt))[0] || null;
}

function blockIds(blocks) {
  return new Set(blocks.filter((block) => block.kind === "task" && block.taskId).map((block) => block.taskId));
}

function contextSwitchCount(blocks, tasksById) {
  const categories = blocks
    .filter((block) => block.kind === "task" && block.taskId && tasksById.has(block.taskId))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .map((block) => tasksById.get(block.taskId).category || tasksById.get(block.taskId).project || "");
  let count = 0;
  for (let index = 1; index < categories.length; index += 1) if (categories[index] !== categories[index - 1]) count += 1;
  return count;
}

function normalizeWhatIf(input) {
  if (input == null) return null;
  if (!isObject(input) || !WHAT_IF_TYPES.has(input.type)) fail("whatIf ไม่ถูกต้อง", "VALIDATION_ERROR");
  if (input.type === "start-late") return { type: "start-late", minutes: integer(input.minutes, 1, 1440, "whatIf.minutes") };
  if (input.type === "skip-meeting") {
    if (input.unlock !== true) fail("what-if skip-meeting ต้องยืนยัน unlock", "WHAT_IF_REQUIRES_UNLOCK", 409);
    return { type: "skip-meeting", blockId: idValue(input.blockId, "whatIf.blockId"), unlock: true };
  }
  if (input.type === "tired") return { type: "tired", energyLevel: integer(input.energyLevel, 1, 5, "whatIf.energyLevel") };
  return { type: "archive-task", taskId: idValue(input.taskId, "whatIf.taskId") };
}

function normalizePlanRequest(input, state) {
  if (!isObject(input)) fail("plan request ต้องเป็น object", "VALIDATION_ERROR");
  const date = validDate(input.date, "date");
  const timeZone = validTimeZone(input.timeZone || state.preferences.timeZone, "timeZone");
  const mode = input.mode || "auto";
  if (!PLAN_MODES.has(mode)) fail("plan mode ไม่ถูกต้อง", "VALIDATION_ERROR");
  const availability = input.availability === undefined
    ? [{ ...state.preferences.workingHours }]
    : validateAvailability(input.availability);
  const taskIds = input.taskIds == null ? null : boundedArray(input.taskIds, MAX_TASKS, "taskIds").map((id) => idValue(id, "taskIds"));
  if (taskIds && new Set(taskIds).size !== taskIds.length) fail("taskIds ซ้ำกัน", "VALIDATION_ERROR");
  let blocks = null;
  if (input.blocks != null) {
    const raw = boundedArray(input.blocks, MAX_BLOCKS, "blocks");
    blocks = raw.map((block, index) => {
      if (!isObject(block)) fail("block ต้องเป็น object", "VALIDATION_ERROR");
      const normalized = { ...block, id: block.id || `preview-block-${index + 1}` };
      const convert = (value, label) => {
        if (typeof value === "string" && ISO_RE.test(value)) return value;
        return isoAt(localWallMs(date, validTime(value, label), timeZone));
      };
      return {
        id: idValue(normalized.id, "block.id"),
        kind: normalized.kind,
        taskId: normalized.taskId ?? null,
        start: convert(normalized.start, "block.start"),
        end: convert(normalized.end, "block.end"),
        locked: normalized.locked === true,
        reason: text(normalized.reason, 500),
      };
    });
  }
  return {
    date,
    timeZone,
    mode,
    availability,
    blocks,
    whatIf: normalizeWhatIf(input.whatIf),
    taskIds,
  };
}

function localRangeForAvailability(date, timeZone, availability) {
  return availability.map((entry) => ({
    start: localWallMs(date, entry.start, timeZone),
    end: localWallMs(date, entry.end, timeZone),
  }));
}

function blockOverlap(left, right) {
  return Date.parse(left.start) < Date.parse(right.end) && Date.parse(right.start) < Date.parse(left.end);
}

function overlapsAny(block, blocks) {
  return blocks.some((other) => other.id !== block.id && blockOverlap(block, other));
}

function slotList(availability, occupied, minimumMs, floorMs) {
  const result = [];
  const ranges = [...availability].sort((a, b) => a.start - b.start);
  for (const range of ranges) {
    let cursor = Math.max(range.start, floorMs);
    const blockers = occupied
      .filter((block) => Date.parse(block.end) > cursor && Date.parse(block.start) < range.end)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    for (const blocker of blockers) {
      const start = Date.parse(blocker.start);
      const end = Date.parse(blocker.end);
      if (start > cursor && start - cursor >= minimumMs) result.push({ start: cursor, end: start });
      cursor = Math.max(cursor, end);
      if (cursor >= range.end) break;
    }
    if (cursor < range.end && range.end - cursor >= minimumMs) result.push({ start: cursor, end: range.end });
  }
  return result;
}

function energyAt(timeMs, date, timeZone, preferences) {
  const localDate = localDateFromMs(timeMs, timeZone);
  if (localDate !== date) return 0;
  const localTime = localTimeForMs(timeMs, timeZone);
  const entry = preferences.energyWindows.find((window) => window.start <= localTime && localTime < window.end);
  return entry?.level ?? 3;
}

function planReason(task, slot, date, timeZone, preferences) {
  const start = localTimeForMs(slot.start, timeZone);
  const end = localTimeForMs(slot.end, timeZone);
  const energy = energyAt(slot.start, date, timeZone, preferences);
  return `priority ${task.priority}, availability ${start}-${end}, energy fit ${energy}/${task.energyDemand}`;
}

function taskSort(tasks, planDate, timeZone) {
  return [...tasks].sort((a, b) => {
    const deadlineA = deadlineInstant(a, planDate, timeZone);
    const deadlineB = deadlineInstant(b, planDate, timeZone);
    if (deadlineA !== deadlineB) return deadlineA - deadlineB;
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.energyDemand !== b.energyDemand) return b.energyDemand - a.energyDemand;
    return a.id.localeCompare(b.id);
  });
}

function compareBlockSets(before, after) {
  const beforeByTask = new Map(before.filter((block) => block.kind === "task" && block.taskId).map((block) => [block.taskId, block]));
  const afterByTask = new Map(after.filter((block) => block.kind === "task" && block.taskId).map((block) => [block.taskId, block]));
  const added = [...afterByTask.keys()].filter((id) => !beforeByTask.has(id));
  const removed = [...beforeByTask.keys()].filter((id) => !afterByTask.has(id));
  const moved = [...afterByTask.keys()].filter((id) => beforeByTask.has(id)
    && (beforeByTask.get(id).start !== afterByTask.get(id).start || beforeByTask.get(id).end !== afterByTask.get(id).end));
  return { added, removed, moved };
}

function normalizedBlockForComparison(block) {
  return {
    id: block.id,
    kind: block.kind,
    taskId: block.taskId,
    start: block.start,
    end: block.end,
    locked: block.locked,
    reason: block.reason,
  };
}

function blocksEqual(left, right) {
  return stable(left.map(normalizedBlockForComparison)) === stable(right.map(normalizedBlockForComparison));
}

function intervalIntersectionMinutes(startMs, endMs, rangeStart, rangeEnd) {
  const start = Math.max(startMs, rangeStart);
  const end = Math.min(endMs, rangeEnd);
  return end > start ? (end - start) / 60000 : 0;
}

function walkMinuteSegments(startMs, endMs, callback) {
  let cursor = startMs;
  while (cursor < endMs) {
    const remainder = ((cursor % 60_000) + 60_000) % 60_000;
    const nextMinute = cursor + (remainder === 0 ? 60_000 : 60_000 - remainder);
    const segmentEnd = Math.min(endMs, nextMinute);
    callback(cursor, segmentEnd);
    cursor = segmentEnd;
  }
}

function mondayOf(date) {
  const value = new Date(`${date}T00:00:00.000Z`);
  const day = value.getUTCDay();
  const offset = day === 0 ? 6 : day - 1;
  value.setUTCDate(value.getUTCDate() - offset);
  return value.toISOString().slice(0, 10);
}

function operationRecord(state, operationId, action, hash, result, now) {
  const operations = state.operations.filter((entry) => now - Date.parse(entry.createdAt) <= OPERATION_TTL_MS);
  operations.push({ operationId, action, requestHash: hash, result: clone(result), createdAt: now.toISOString() });
  state.operations = operations.slice(-MAX_OPERATIONS);
}

function findOperation(state, operationId, action, hash) {
  if (!operationId) return null;
  const existing = state.operations.find((entry) => entry.operationId === operationId);
  if (!existing) return null;
  if (existing.action !== action || existing.requestHash !== hash) fail("operationId ถูกใช้กับคำขออื่นแล้ว", "OPERATION_CONFLICT", 409);
  return clone(existing.result);
}

function normalizeTaskForDraft(value) {
  if (!isObject(value)) fail("draft task ต้องเป็น object", "DRAFT_INVALID");
  const allowedKeys = new Set(["title", "notes", "deadline", "priority", "estimatedMinutes", "energyDemand", "category", "project", "checklist"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) fail("draft task มี field ที่ไม่อนุญาต", "DRAFT_INVALID");
  const deadline = value.deadline == null ? null : validateDeadline(value.deadline);
  const priority = value.priority === undefined ? 3 : normalizeDraftLevel(value.priority, "draft.priority", {
    urgent: 1,
    high: 2,
    medium: 3,
    normal: 3,
    low: 4,
    minimal: 5,
  });
  const energyDemand = value.energyDemand === undefined ? 3 : normalizeDraftLevel(value.energyDemand, "draft.energyDemand", {
    minimal: 1,
    low: 1,
    medium: 3,
    normal: 3,
    high: 5,
    urgent: 5,
  });
  return {
    title: text(value.title, 240, { required: true }),
    notes: text(value.notes, 4000),
    deadline,
    priority,
    estimatedMinutes: value.estimatedMinutes == null ? null : integer(value.estimatedMinutes, 1, 1440, "draft.estimatedMinutes"),
    energyDemand,
    category: text(value.category, 120),
    project: text(value.project, 120),
    checklist: boundedArray(value.checklist ?? [], MAX_CHECKLIST, "draft.checklist").map((item) => {
      if (!isObject(item) || Object.keys(item).some((key) => !["text", "done"].includes(key))) fail("draft checklist มี field ที่ไม่อนุญาต", "DRAFT_INVALID");
      return {
        text: text(item.text, 500, { required: true }),
        done: item.done === true,
      };
    }),
  };
}

function normalizeDraftLevel(value, label, labels) {
  if (typeof value === "string") {
    const mapped = labels[value.trim().toLowerCase()];
    if (mapped !== undefined) return mapped;
  }
  return integer(value, 1, 5, label);
}

function parseDraftOutput(output) {
  let value = output;
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value === "string") {
    const raw = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      value = JSON.parse(raw);
    } catch {
      fail("Ollama draft ไม่ใช่ JSON ที่ถูกต้อง", "DRAFT_INVALID");
    }
  }
  if (!isObject(value)) fail("Ollama draft ต้องเป็น object", "DRAFT_INVALID");
  if (Object.prototype.hasOwnProperty.call(value, "tool_calls") || Object.prototype.hasOwnProperty.call(value, "tools")) fail("draft ห้ามมี tool call", "DRAFT_TOOL_FORBIDDEN");
  const allowedKeys = new Set(["title", "notes", "tasks", "warnings"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) fail("draft มี field ที่ไม่อนุญาต", "DRAFT_INVALID");
  const tasks = boundedArray(value.tasks ?? [], MAX_CHECKLIST, "draft.tasks").map(normalizeTaskForDraft);
  if (!tasks.length && !String(value.title || value.notes || "").trim()) fail("draft ไม่มีเนื้อหางาน", "DRAFT_INVALID");
  return {
    title: text(value.title ?? "", 240),
    notes: text(value.notes ?? "", 4000),
    tasks,
    warnings: boundedArray(value.warnings ?? [], 20, "draft.warnings").map((warning) => text(warning, 400, { required: true })),
  };
}

function contextForDraft(value) {
  if (value == null) return null;
  if (!isObject(value)) fail("selectedContext ต้องเป็น object", "VALIDATION_ERROR");
  const allowed = {};
  for (const key of ["title", "notes", "category", "project", "deadline", "priority", "estimatedMinutes", "energyDemand"]) {
    if (value[key] !== undefined) allowed[key] = typeof value[key] === "string" ? text(value[key], 1000) : value[key];
  }
  return allowed;
}

async function defaultDraftTransport({ ollamaUrl, model, prompt, context, signal, maxOutputBytes }) {
  const response = await fetch(`${String(ollamaUrl || "http://127.0.0.1:11434").replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      stream: false,
      // Reasoning models can spend the entire bounded generation budget in a
      // hidden thinking field and return empty structured content. Drafts are
      // an extraction aid, so request the model's non-tool JSON channel.
      think: false,
      format: "json",
      options: { temperature: 0.2, num_predict: 1200 },
      messages: [{
        role: "user",
        content: [
          "ตอบเป็น JSON object เท่านั้นตาม schema: {title:string,notes:string,tasks:[{title,notes,deadline,priority,estimatedMinutes,energyDemand,category,project,checklist:[{text,done}]}],warnings:string[]}",
          "ห้ามเรียก tools ห้ามใส่ file path หรือ shell command และอย่าสร้าง action ใด ๆ",
          `ผู้ใช้ขอ: ${prompt}`,
          context ? `บริบทที่ผู้ใช้เลือก: ${JSON.stringify(context)}` : "",
        ].filter(Boolean).join("\n"),
      }],
    }),
  });
  if (!response.ok) fail(`Ollama ตอบ HTTP ${response.status}`, "DRAFT_UNAVAILABLE", 503);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxOutputBytes) fail("ผลลัพธ์จาก Ollama ใหญ่เกินกำหนด", "DRAFT_OUTPUT_LIMIT", 502);
  const chunks = [];
  let size = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > maxOutputBytes) {
          await reader.cancel().catch(() => {});
          fail("ผลลัพธ์จาก Ollama ใหญ่เกินกำหนด", "DRAFT_OUTPUT_LIMIT", 502);
        }
        chunks.push(Buffer.from(item.value));
      }
    } finally {
      reader.releaseLock?.();
    }
  } else {
    const fallback = Buffer.from(await response.arrayBuffer());
    if (fallback.length > maxOutputBytes) fail("ผลลัพธ์จาก Ollama ใหญ่เกินกำหนด", "DRAFT_OUTPUT_LIMIT", 502);
    chunks.push(fallback);
  }
  const bytes = Buffer.concat(chunks, size);
  let body;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("Ollama response ไม่ใช่ JSON", "DRAFT_INVALID", 502);
  }
  if (body?.message?.tool_calls || body?.tool_calls) fail("Ollama draft มี tool call", "DRAFT_TOOL_FORBIDDEN", 502);
  return { output: body?.message?.content ?? body?.response ?? body };
}

function normalizeBlockInput(block, date, timeZone, index) {
  if (!isObject(block)) fail("block ต้องเป็น object", "VALIDATION_ERROR");
  const id = idValue(block.id || `preview-block-${index + 1}`, "block.id");
  const convert = (value, label) => {
    if (typeof value === "string" && ISO_RE.test(value)) return value;
    return isoAt(localWallMs(date, validTime(value, label), timeZone));
  };
  const normalized = {
    id,
    kind: block.kind,
    taskId: block.taskId ?? null,
    start: convert(block.start, "block.start"),
    end: convert(block.end, "block.end"),
    locked: block.locked === true,
    reason: text(block.reason, 500),
  };
  return validateBlockShape(normalized);
}

function ensureNoBlockOverlap(blocks) {
  const sorted = [...blocks].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (let index = 1; index < sorted.length; index += 1) {
    if (Date.parse(sorted[index].start) < Date.parse(sorted[index - 1].end)) fail("plan blocks ทับซ้อนกัน", "PLAN_OVERLAP");
  }
}

export async function createPlanner(options = {}) {
  const ops = {
    lstat: options.lstat || fsLstat,
    mkdir: options.mkdir || fsMkdir,
    readFile: options.readFile || fsReadFile,
    realpath: options.realpath || fsRealpath,
    rename: options.rename || fsRename,
    writeFile: options.writeFile || fsWriteFile,
  };
  const dataRoot = await resolveDataRoot(options.dataDir, ops);
  const stateFile = path.join(dataRoot, STATE_FILE);
  const tempFile = path.join(dataRoot, STATE_TEMP_FILE);
  const wallClock = options.now || (() => new Date());
  const monotonicClock = options.monotonicNow || (() => Number(process.hrtime.bigint() / 1_000_000n));
  const heartbeatGapMs = finiteNumber(options.heartbeatGapMs ?? DEFAULT_HEARTBEAT_GAP_MS, 1000, 10 * 60 * 1000, "heartbeatGapMs");
  const draftTimeoutMs = finiteNumber(options.draftTimeoutMs ?? DEFAULT_DRAFT_TIMEOUT_MS, 1000, 10 * 60 * 1000, "draftTimeoutMs");
  const draftMaxOutputBytes = integer(options.draftMaxOutputBytes ?? DEFAULT_DRAFT_MAX_OUTPUT_BYTES, 1024, 1024 * 1024, "draftMaxOutputBytes");
  const defaultTimeZone = validTimeZone(options.timeZone || "Asia/Bangkok", "timeZone");
  const randomId = options.randomId || (() => randomUUID());
  const draftTransport = options.draftTransport || ((request) => defaultDraftTransport({
    ...request,
    ollamaUrl: options.ollamaUrl,
    maxOutputBytes: draftMaxOutputBytes,
  }));
  let state = null;
  let unavailable = null;
  let mutationQueue = Promise.resolve();
  const previews = new Map();
  const allocatedIds = new Set();

  const makeId = (prefix) => {
    const base = `${prefix}-${String(randomId())}`;
    const candidate = ID_RE.test(base) ? base : `${prefix}-${randomUUID()}`;
    if (!allocatedIds.has(candidate)) {
      allocatedIds.add(candidate);
      return candidate;
    }
    const fallback = `${prefix}-${randomUUID()}`;
    allocatedIds.add(fallback);
    return fallback;
  };

  function seedAllocatedIds() {
    for (const task of state.tasks) {
      allocatedIds.add(task.id);
      for (const item of task.checklist) allocatedIds.add(item.id);
    }
    for (const plan of state.dayPlans) {
      allocatedIds.add(plan.id);
      for (const block of plan.blocks) allocatedIds.add(block.id);
    }
    for (const session of state.focusSessions) allocatedIds.add(session.id);
    for (const operation of state.operations) allocatedIds.add(operation.operationId);
  }

  async function loadState() {
    try {
      await safeStateFile(dataRoot, STATE_FILE, ops, { allowMissing: true });
      let raw;
      try {
        raw = await ops.readFile(stateFile, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") {
          state = makeDefaultState(defaultTimeZone);
          return;
        }
        throw error;
      }
      let parsed;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        fail("planner state JSON เสียหาย", "STATE_CORRUPT", 503);
      }
      state = validateStoredState(parsed);
    } catch (error) {
      unavailable = error instanceof PlannerError && ["STATE_CORRUPT", "STATE_UNSUPPORTED"].includes(error.code)
        ? error
        : new PlannerError("planner state ใช้งานไม่ได้", "STATE_CORRUPT", 503);
      state = null;
    }
  }

  async function atomicWrite(snapshot) {
    await safeStateFile(dataRoot, STATE_FILE, ops, { allowMissing: true });
    await safeStateFile(dataRoot, STATE_TEMP_FILE, ops, { allowMissing: true });
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    try {
      await ops.writeFile(tempFile, serialized, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error?.code === "EEXIST") {
        try {
          await ops.writeFile(tempFile, serialized, { encoding: "utf8", flag: "w" });
        } catch (retryError) {
          throw new PlannerError("บันทึก planner state ไม่สำเร็จ", "PERSISTENCE_FAILED", 503, { cause: retryError?.code });
        }
      } else {
        throw new PlannerError("บันทึก planner state ไม่สำเร็จ", "PERSISTENCE_FAILED", 503, { cause: error?.code });
      }
    }
    await safeStateFile(dataRoot, STATE_TEMP_FILE, ops, { allowMissing: false });
    try {
      await ops.rename(tempFile, stateFile);
    } catch (error) {
      throw new PlannerError("บันทึก planner state ไม่สำเร็จ", "PERSISTENCE_FAILED", 503, { cause: error?.code });
    }
    await safeStateFile(dataRoot, STATE_FILE, ops, { allowMissing: false });
  }

  function ensureAvailable() {
    if (unavailable || !state) {
      const error = unavailable || new PlannerError("planner ยังไม่พร้อม", "PLANNER_UNAVAILABLE", 503);
      throw error;
    }
  }

  function checkBaseRevision(baseRevision) {
    if (baseRevision == null) fail("ต้องระบุ baseRevision", "REVISION_REQUIRED");
    integer(baseRevision, 0, Number.MAX_SAFE_INTEGER, "baseRevision");
    if (baseRevision !== state.revision) {
      fail("ข้อมูล planner เปลี่ยนแล้ว กรุณาโหลดใหม่", "REVISION_CONFLICT", 409, { currentRevision: state.revision });
    }
  }

  async function saveCandidate(candidate, { bumpRevision = true } = {}) {
    const normalized = validateStoredState(candidate);
    if (bumpRevision) normalized.revision = state.revision + 1;
    else normalized.revision = state.revision;
    validateStoredState(normalized);
    await atomicWrite(normalized);
    state = normalized;
    unavailable = null;
  }

  function currentOperation(context, action, request) {
    const hash = requestHash(request);
    const operationId = context.operationId;
    const existing = findOperation(state, operationId, action, hash);
    return { hash, operationId, existing };
  }

  async function commitOperation(candidate, { action, operationId, hash, resultFactory }) {
    const normalized = validateStoredState(candidate);
    normalized.revision = state.revision + 1;
    const result = resultFactory(normalized);
    if (operationId) operationRecord(normalized, operationId, action, hash, result, new Date(nowMs(wallClock)));
    validateStoredState(normalized);
    await atomicWrite(normalized);
    state = validateStoredState(normalized);
    unavailable = null;
    return clone(result);
  }

  async function withMutation(work) {
    const result = mutationQueue.then(async () => {
      ensureAvailable();
      return work();
    });
    mutationQueue = result.catch(() => {});
    return result;
  }

  function publicResult(candidate) {
    return { state: publicState(candidate) };
  }

  function findTask(taskId) {
    const id = idValue(taskId, "taskId");
    const task = state.tasks.find((entry) => entry.id === id);
    if (!task) fail("ไม่พบ task", "NOT_FOUND", 404);
    return task;
  }

  function futureTaskBlocks(taskId) {
    const currentMs = nowMs(wallClock);
    return state.dayPlans
      .filter((plan) => plan.accepted)
      .flatMap((plan) => plan.blocks.map((block) => ({ plan, block })))
      .filter(({ block }) => block.kind === "task" && block.taskId === taskId && Date.parse(block.start) > currentMs);
  }

  function activeRunningSession() {
    return state.focusSessions.find((session) => session.state === "running") || null;
  }

  function closeCurrentInterval(session, endMs) {
    if (!session.currentStartedAt) return;
    const startMs = Date.parse(session.currentStartedAt);
    let safeEnd = Number.isFinite(endMs) ? endMs : startMs;
    if (Number.isFinite(session.currentElapsedMs)) {
      safeEnd = Math.min(safeEnd, startMs + Math.max(0, session.currentElapsedMs));
    }
    if (safeEnd <= startMs) {
      session.currentStartedAt = null;
      session.currentStartedMono = null;
      session.currentElapsedMs = null;
      return;
    }
    const remaining = Math.max(0, session.targetMinutes - sumFocusMinutes(session));
    safeEnd = Math.min(safeEnd, startMs + remaining * 60_000);
    if (safeEnd > startMs) session.activeIntervals.push({ start: isoAt(startMs), end: isoAt(safeEnd) });
    session.currentStartedAt = null;
    session.currentStartedMono = null;
    session.currentElapsedMs = null;
  }

  function currentIntervalEndMs(session, fallbackMs = Date.parse(session.currentStartedAt)) {
    const startMs = Date.parse(session.currentStartedAt);
    if (!Number.isFinite(startMs)) return fallbackMs;
    if (Number.isFinite(session.currentElapsedMs)) return startMs + Math.max(0, session.currentElapsedMs);
    return fallbackMs;
  }

  function reconcileSession(session, { persistNow = false, wallMs = null, monoMs = null } = {}) {
    if (session.state !== "running") return false;
    const wall = wallMs == null ? nowMs(wallClock) : wallMs;
    const mono = monoMs == null
      ? finiteNumber(Number(monotonicClock()), 0, Number.MAX_SAFE_INTEGER, "monotonicNow")
      : finiteNumber(Number(monoMs), 0, Number.MAX_SAFE_INTEGER, "monotonicNow");
    const lastMono = session.lastHeartbeatMono;
    const lastWall = session.lastHeartbeatAt ? Date.parse(session.lastHeartbeatAt) : null;
    const gap = lastMono == null ? heartbeatGapMs + 1 : mono - lastMono;
    const wallWentBack = lastWall != null && wall < lastWall;
    if (gap < 0 || gap > heartbeatGapMs || wallWentBack) {
      closeCurrentInterval(session, currentIntervalEndMs(session, Number.isFinite(lastWall) ? lastWall : wall));
      session.state = "interrupted";
      session.endedAt = Number.isFinite(lastWall) ? isoAt(lastWall) : isoAt(wall);
      session.endReason = gap < 0 || wallWentBack ? "clock-continuity-lost" : "heartbeat-gap";
      session.lastHeartbeatMono = null;
      session.currentStartedMono = null;
      session.currentElapsedMs = null;
      return true;
    }
    if (session.currentStartedMono != null && session.currentStartedAt) {
      const elapsed = Math.max(0, mono - session.currentStartedMono);
      session.currentElapsedMs = Math.min(elapsed, session.targetMinutes * 60_000);
      const confirmed = sumFocusMinutes(session) + elapsed / 60_000;
      if (confirmed >= session.targetMinutes) {
        const endAt = Date.parse(session.currentStartedAt) + Math.max(0, session.targetMinutes - sumFocusMinutes(session)) * 60_000;
        closeCurrentInterval(session, endAt);
        session.state = "finished";
        session.endedAt = isoAt(endAt);
        session.endReason = "target-reached";
        session.lastHeartbeatMono = null;
        return true;
      }
    }
    return persistNow;
  }

  function recoverRunningSessions(snapshot) {
    let changed = false;
    for (const session of snapshot.focusSessions) {
      if (session.state !== "running") continue;
      const lastWall = session.lastHeartbeatAt ? Date.parse(session.lastHeartbeatAt) : Date.parse(session.currentStartedAt);
      closeCurrentInterval(session, currentIntervalEndMs(session, Number.isFinite(lastWall) ? lastWall : nowMs(wallClock)));
      session.state = "interrupted";
      session.endedAt = Number.isFinite(lastWall) ? isoAt(lastWall) : isoFrom(wallClock());
      session.endReason = "sidecar-restarted";
      session.lastHeartbeatMono = null;
      session.currentStartedMono = null;
      session.currentElapsedMs = null;
      changed = true;
    }
    return changed;
  }

  async function reconcileForRead() {
    return withMutation(async () => {
      const candidate = clone(state);
      let changed = false;
      for (const session of candidate.focusSessions) changed = reconcileSession(session) || changed;
      if (changed) {
        await saveCandidate(candidate, { bumpRevision: true });
      }
      return publicState(state);
    });
  }

  function buildPreview(request) {
    const currentPlan = latestAcceptedPlan(state, request.date, request.timeZone) || latestAcceptedAnyZone(state, request.date);
    const oldBlocks = currentPlan ? clone(currentPlan.blocks) : [];
    const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
    let protectedBlocks = oldBlocks.filter((block) => {
      const runningTask = activeRunningSession()?.taskId;
      // Once a block has started it is immutable for planning purposes, even
      // while its end is still in the future. This preserves an active block
      // across an auto rebuild and mirrors the past-block rule.
      return Date.parse(block.start) <= nowMs(wallClock)
        || block.locked
        || block.kind === "busy"
        || (runningTask && block.taskId === runningTask);
    });
    let whatIf = request.whatIf;
    if (whatIf?.type === "skip-meeting") {
      const meeting = oldBlocks.find((block) => block.id === whatIf.blockId && block.kind === "busy");
      if (!meeting) fail("ไม่พบ busy block สำหรับ what-if", "NOT_FOUND", 404);
      // A what-if may unlock only a future meeting. Past or ongoing busy
      // blocks stay protected so simulation cannot rewrite history or the
      // current activity window.
      if (Date.parse(meeting.start) > nowMs(wallClock)) {
        protectedBlocks = protectedBlocks.filter((block) => block.id !== meeting.id);
      }
    }
    if (whatIf?.type === "archive-task") {
      const now = nowMs(wallClock);
      protectedBlocks = protectedBlocks.filter((block) => !(block.taskId === whatIf.taskId && Date.parse(block.start) > now));
    }
    const selectedIds = request.taskIds ? new Set(request.taskIds) : null;
    const existingMovable = oldBlocks.filter((block) => block.kind === "task" && !protectedBlocks.some((entry) => entry.id === block.id));
    let blocks = request.mode === "manual" && request.blocks
      ? request.blocks.map((block, index) => normalizeBlockInput(block, request.date, request.timeZone, index))
      : [...protectedBlocks];
    if (request.mode === "manual" && !request.blocks) blocks = [...protectedBlocks];
    if (request.mode !== "manual") {
      const keepExisting = existingMovable.filter((block) => selectedIds && !selectedIds.has(block.taskId));
      blocks = [...blocks, ...keepExisting];
    }
    const conflicts = [];
    if (request.mode === "manual") {
      const submittedIds = new Set();
      for (const block of blocks) {
        if (submittedIds.has(block.id)) fail("block id ซ้ำกัน", "VALIDATION_ERROR");
        submittedIds.add(block.id);
      }
      for (const protectedBlock of protectedBlocks) {
        const submitted = blocks.find((block) => block.id === protectedBlock.id);
        if (!submitted) {
          blocks.push(protectedBlock);
          continue;
        }
        if (!blocksEqual([submitted], [protectedBlock])) fail("manual plan ห้ามย้าย locked, busy, running หรือ past block", "PLAN_PROTECTED_BLOCK", 409);
      }
    }
    ensureNoBlockOverlap(blocks);
    const availability = localRangeForAvailability(request.date, request.timeZone, request.availability);
    const availabilityIso = request.availability;
    const isWithinAvailability = (block) => {
      if (block.kind === "busy" && !block.taskId) return true;
      return availability.some((range) => Date.parse(block.start) >= range.start && Date.parse(block.end) <= range.end);
    };
    for (const block of blocks) {
      if (!isWithinAvailability(block) && block.kind === "task") conflicts.push({ code: "OUTSIDE_AVAILABILITY", blockId: block.id, taskId: block.taskId, message: "task block อยู่นอกเวลาว่าง" });
      if (block.kind === "task" && Date.parse(block.start) < nowMs(wallClock)
        && !protectedBlocks.some((entry) => entry.id === block.id)) {
        conflicts.push({ code: "PAST_BLOCK", blockId: block.id, taskId: block.taskId, message: "ไม่สามารถเพิ่มหรือย้ายงานไปยังเวลาที่ผ่านไปแล้ว" });
      }
      if (block.taskId) {
        const task = tasksById.get(block.taskId);
        if (!task) fail("plan block อ้าง task ที่ไม่มีอยู่", "NOT_FOUND", 404);
        const historicalExact = request.mode === "manual"
          && currentPlan?.blocks.some((oldBlock) => oldBlock.id === block.id && blocksEqual([oldBlock], [block]));
        if ((task.archivedAt || task.status === "completed") && !historicalExact) {
          conflicts.push({ code: "TASK_NOT_ELIGIBLE", taskId: task.id, blockId: block.id, message: "งานเสร็จหรือเก็บถาวรแล้ว" });
        }
      }
    }
    if (conflicts.length && request.mode === "manual") fail("manual plan มีข้อขัดแย้ง", "PLAN_CONSTRAINT", 409, { conflicts });
    const eligible = state.tasks.filter((task) => !task.archivedAt
      && task.status !== "completed"
      && !(whatIf?.type === "archive-task" && task.id === whatIf.taskId)
      && whatIf?.type !== "archive-task"
      && (!selectedIds || selectedIds.has(task.id)));
    const scheduled = blockIds(blocks);
    const unscheduled = [];
    const reasons = [];
    const minLate = request.whatIf?.type === "start-late" ? request.whatIf.minutes * 60_000 : 0;
    const availabilityStart = availability.length
      ? Math.min(...availability.map((range) => range.start))
      : dayStartMs(request.date, request.timeZone);
    const floor = Math.max(nowMs(wallClock), availabilityStart + minLate);
    if (request.mode !== "manual") {
      for (const task of taskSort(eligible.filter((entry) => !scheduled.has(entry.id)), request.date, request.timeZone)) {
        if (task.estimatedMinutes == null) {
          unscheduled.push({ taskId: task.id, reason: "MISSING_DURATION" });
          continue;
        }
        const duration = task.estimatedMinutes * 60_000;
        const slots = slotList(availability, blocks, duration, floor);
        if (!slots.length) {
          unscheduled.push({ taskId: task.id, reason: "NO_CAPACITY" });
          continue;
        }
        const energyLimit = request.whatIf?.type === "tired" ? request.whatIf.energyLevel : 5;
        const due = deadlineInstant(task, request.date, request.timeZone);
        const ranked = slots.map((slot) => {
          const availableEnergy = Math.min(energyLimit, energyAt(slot.start, request.date, request.timeZone, state.preferences));
          const energyGap = Math.max(0, task.energyDemand - availableEnergy);
          const contextTask = blocks
            .filter((block) => block.kind === "task" && Date.parse(block.end) <= slot.start)
            .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))[0];
          const contextPenalty = contextTask && tasksById.get(contextTask.taskId)?.category !== task.category ? 1 : 0;
          const finishesByDeadline = slot.start + duration <= due;
          return {
            slot,
            // Deadline feasibility is a hard ordering tier. Energy/context
            // fit only chooses among slots that can meet the due instant.
            score: (finishesByDeadline ? 0 : 1_000_000_000_000_000)
              + energyGap * 100 + contextPenalty * 10 + slot.start / 1e12,
          };
        }).sort((a, b) => a.score - b.score);
        const chosen = ranked[0].slot;
        const block = {
          // Auto plans must be reproducible so apply can recompute the
          // preview and reject client edits. The task ID is already unique
          // within a plan, and the bounded suffix keeps the ID safe.
          id: `block-${task.id}`.slice(0, 120),
          kind: "task",
          taskId: task.id,
          start: isoAt(chosen.start),
          end: isoAt(chosen.start + duration),
          locked: false,
          reason: planReason(task, { start: chosen.start, end: chosen.start + duration }, request.date, request.timeZone, state.preferences),
        };
        if (Date.parse(block.end) > due) {
          conflicts.push({ code: "DEADLINE_CONFLICT", taskId: task.id, blockId: block.id, message: "ช่วงเวลาที่วางเลย deadline" });
        }
        blocks.push(block);
        scheduled.add(task.id);
        reasons.push({ taskId: task.id, rule: "deadline-priority-energy", message: block.reason });
      }
    }
    ensureNoBlockOverlap(blocks);
    const oldForComparison = oldBlocks;
    const changes = compareBlockSets(oldForComparison, blocks);
    const beforeSwitches = contextSwitchCount(oldForComparison, tasksById);
    const afterSwitches = contextSwitchCount(blocks, tasksById);
    const movedTaskIds = [...new Set(changes.moved)];
    for (const task of eligible) {
      if (!blocks.some((block) => block.taskId === task.id)) {
        if (!unscheduled.some((item) => item.taskId === task.id)) unscheduled.push({ taskId: task.id, reason: "NOT_PLACED" });
      }
    }
    return {
      previewId: makeId("preview"),
      baseRevision: state.revision,
      date: request.date,
      timeZone: request.timeZone,
      mode: request.mode,
      availability: availabilityIso,
      blocks: blocks.sort((a, b) => Date.parse(a.start) - Date.parse(b.start)),
      unscheduled,
      conflicts,
      reasons,
      movedTaskIds,
      contextSwitches: { before: beforeSwitches, after: afterSwitches, reduced: Math.max(0, beforeSwitches - afterSwitches) },
      changes,
      whatIf,
      sourcePlanId: currentPlan?.id || null,
      generatedAt: isoFrom(wallClock()),
      request: clone(request),
    };
  }

  async function getState() {
    return reconcileForRead();
  }

  async function createTask(input, context = {}) {
    return withMutation(async () => {
      const ctx = validateOperationContext(context);
      const request = { action: "create", task: input, baseRevision: ctx.baseRevision };
      const operation = currentOperation(ctx, "task/create", request);
      if (operation.existing) return operation.existing;
      checkBaseRevision(ctx.baseRevision);
      if (state.tasks.length >= MAX_TASKS) fail(`มีงานเกิน ${MAX_TASKS} รายการ`, "LIMIT_EXCEEDED");
      const timestamp = isoFrom(wallClock());
      const task = taskInput(input, { now: timestamp, generateId: () => makeId("task") });
      const candidate = clone(state);
      candidate.tasks.push(task);
      return commitOperation(candidate, { action: "task/create", operationId: ctx.operationId, hash: operation.hash, resultFactory: publicResult });
    });
  }

  async function updateTask(taskId, input, context = {}) {
    return withMutation(async () => {
      const ctx = validateOperationContext(context);
      const request = { action: "update", id: taskId, task: input, baseRevision: ctx.baseRevision };
      const operation = currentOperation(ctx, "task/update", request);
      if (operation.existing) return operation.existing;
      checkBaseRevision(ctx.baseRevision);
      const existing = findTask(taskId);
      if (existing.archivedAt) fail("แก้ไขงานที่เก็บถาวรไม่ได้", "ARCHIVED_TASK", 409);
      const candidate = clone(state);
      const index = candidate.tasks.findIndex((task) => task.id === existing.id);
      candidate.tasks[index] = taskInput(input, { now: isoFrom(wallClock()), generateId: () => makeId("check"), existing });
      if (candidate.tasks[index].status === "completed") fail("ใช้ complete action เพื่อเสร็จงาน", "VALIDATION_ERROR");
      return commitOperation(candidate, { action: "task/update", operationId: ctx.operationId, hash: operation.hash, resultFactory: publicResult });
    });
  }

  async function completeTask(taskId, context = {}) {
    return withMutation(async () => {
      const ctx = validateOperationContext(context);
      const request = { action: "complete", id: taskId, baseRevision: ctx.baseRevision };
      const operation = currentOperation(ctx, "task/complete", request);
      if (operation.existing) return operation.existing;
      checkBaseRevision(ctx.baseRevision);
      const existing = findTask(taskId);
      if (existing.archivedAt) fail("งานที่เก็บถาวรแล้วทำให้เสร็จไม่ได้", "ARCHIVED_TASK", 409);
      const candidate = clone(state);
      const task = candidate.tasks.find((entry) => entry.id === existing.id);
      const timestamp = isoFrom(wallClock());
      task.status = "completed";
      task.completedAt = timestamp;
      task.updatedAt = timestamp;
      return commitOperation(candidate, { action: "task/complete", operationId: ctx.operationId, hash: operation.hash, resultFactory: publicResult });
    });
  }

  async function reopenTask(taskId, context = {}) {
    return withMutation(async () => {
      const ctx = validateOperationContext(context);
      const request = { action: "reopen", id: taskId, baseRevision: ctx.baseRevision };
      const operation = currentOperation(ctx, "task/reopen", request);
      if (operation.existing) return operation.existing;
      checkBaseRevision(ctx.baseRevision);
      const existing = findTask(taskId);
      const candidate = clone(state);
      const task = candidate.tasks.find((entry) => entry.id === existing.id);
      task.status = "todo";
      task.completedAt = null;
      task.updatedAt = isoFrom(wallClock());
      return commitOperation(candidate, { action: "task/reopen", operationId: ctx.operationId, hash: operation.hash, resultFactory: publicResult });
    });
  }

  async function archiveTask(taskId, context = {}) {
    return withMutation(async () => {
      const ctx = validateOperationContext(context);
      const archivePreviewId = context.archivePreviewId || null;
      const request = { action: "archive", id: taskId, archivePreviewId, baseRevision: ctx.baseRevision };
      const operation = currentOperation(ctx, "task/archive", request);
      if (operation.existing) return operation.existing;
      checkBaseRevision(ctx.baseRevision);
      const existing = findTask(taskId);
      if (existing.archivedAt) return publicResult(state);
      const future = futureTaskBlocks(existing.id);
      let candidate = clone(state);
      if (future.length && !archivePreviewId) {
        const affectedPlans = [...new Map(future.map(({ plan }) => [plan.id, plan])).values()];
        const previewsForPlans = affectedPlans.map((plan) => buildPreview(normalizePlanRequest({
          date: plan.date,
          timeZone: plan.timeZone,
          mode: "what-if",
          blocks: plan.blocks,
          whatIf: { type: "archive-task", taskId: existing.id },
        }, state)));
        const preview = {
          ...previewsForPlans[0],
          affectedPlanIds: affectedPlans.map((plan) => plan.id),
          affectedPlans: previewsForPlans,
        };
        previews.set(preview.previewId, preview);
        fail("งานอยู่ในแผนอนาคต ต้องยืนยันการเอา block ออกก่อน", "ARCHIVE_REQUIRES_PREVIEW", 409, {
          preview,
          archivePreviewId: preview.previewId,
        });
      }
      if (future.length) {
        const preview = previews.get(archivePreviewId);
        if (!preview || preview.whatIf?.type !== "archive-task" || preview.whatIf.taskId !== existing.id) fail("archivePreviewId ไม่ถูกต้องหรือหมดอายุ", "ARCHIVE_PREVIEW_INVALID", 409);
        if (preview.baseRevision !== state.revision) fail("archive preview ล้าสมัย", "REVISION_CONFLICT", 409, { currentRevision: state.revision });
        const affectedPreviews = Array.isArray(preview.affectedPlans) && preview.affectedPlans.length
          ? preview.affectedPlans
          : [preview];
        for (const affected of affectedPreviews) {
          const recomputed = buildPreview(normalizePlanRequest(affected.request, state));
          if (!blocksEqual(recomputed.blocks, affected.blocks)) fail("archive preview เปลี่ยนแล้ว กรุณาสร้างใหม่", "ARCHIVE_PREVIEW_INVALID", 409);
          const oldPlan = latestAcceptedPlan(state, affected.date, affected.timeZone) || latestAcceptedAnyZone(state, affected.date);
          if (!oldPlan) fail("ไม่พบ accepted plan ที่ต้องแก้", "ARCHIVE_PREVIEW_INVALID", 409);
          for (const plan of candidate.dayPlans) if (plan.id === oldPlan.id) plan.accepted = false;
          candidate.dayPlans.push({
            ...clone(oldPlan),
            id: makeId("plan"),
            blocks: clone(affected.blocks),
            accepted: true,
            createdAt: isoFrom(wallClock()),
            updatedAt: isoFrom(wallClock()),
            lastOptimizedAt: null,
            revision: state.revision + 1,
          });
        }
      }
      const task = candidate.tasks.find((entry) => entry.id === existing.id);
      // A plan containing only past placements is historical once its task is
      // archived. Keep the blocks for provenance while making the plan
      // non-current so the persisted invariant remains strict.
      if (!future.length) {
        for (const plan of candidate.dayPlans) {
          if (plan.accepted && plan.blocks.some((block) => block.taskId === existing.id)) plan.accepted = false;
        }
      }
      task.archivedAt = isoFrom(wallClock());
      task.updatedAt = task.archivedAt;
      return commitOperation(candidate, { action: "task/archive", operationId: ctx.operationId, hash: operation.hash, resultFactory: publicResult });
    });
  }

  async function searchTasks(input = {}) {
    await mutationQueue;
    ensureAvailable();
    const query = text(input.query ?? "", MAX_QUERY).toLowerCase();
    const status = input.status == null ? null : (TASK_STATUSES.has(input.status) ? input.status : fail("status ไม่ถูกต้อง", "VALIDATION_ERROR"));
    const archived = input.archived == null ? null : input.archived === true;
    const values = state.tasks.filter((task) => {
      if (status && task.status !== status) return false;
      if (archived !== null && Boolean(task.archivedAt) !== archived) return false;
      if (!query) return true;
      return [task.title, task.notes, task.category, task.project, ...task.checklist.map((item) => item.text)]
        .join(" ").toLowerCase().includes(query);
    });
    return { revision: state.revision, tasks: clone(values) };
  }

  async function createDraft(input = {}) {
    await mutationQueue;
    ensureAvailable();
    const prompt = text(input.prompt, 4000, { required: true });
    const model = text(input.model || options.defaultModel || "", 2000, { required: true });
    const selectedContext = contextForDraft(input.selectedContext);
    const timeZone = validTimeZone(input.timeZone || state.preferences.timeZone, "timeZone");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), draftTimeoutMs);
    let transported;
    try {
      transported = await draftTransport({ model, prompt, context: selectedContext, timeZone, signal: controller.signal, maxOutputBytes: draftMaxOutputBytes });
    } catch (error) {
      if (error?.name === "AbortError") fail("Ollama draft หมดเวลา", "DRAFT_TIMEOUT", 504);
      if (error instanceof PlannerError) throw error;
      fail("Ollama draft ใช้งานไม่ได้", "DRAFT_UNAVAILABLE", 503);
    } finally {
      clearTimeout(timeout);
    }
    const parsed = parseDraftOutput(transported?.output ?? transported);
    return {
      model,
      prompt,
      title: parsed.title,
      notes: parsed.notes,
      tasks: parsed.tasks,
      warnings: parsed.warnings,
      generatedAt: isoFrom(wallClock()),
    };
  }

  async function previewPlan(input = {}) {
    await mutationQueue;
    ensureAvailable();
    const request = normalizePlanRequest(input, state);
    const preview = buildPreview(request);
    previews.set(preview.previewId, clone(preview));
    while (previews.size > 100) previews.delete(previews.keys().next().value);
    return preview;
  }

  async function applyPlan(input, context = {}) {
    return withMutation(async () => {
      const ctx = validateOperationContext(context, { required: true });
      const supplied = input?.preview || input;
      const previewId = input?.previewId || supplied?.previewId || null;
      const preview = previewId && previews.get(previewId) ? previews.get(previewId) : supplied;
      if (!isObject(preview)) fail("ต้องระบุ preview", "VALIDATION_ERROR");
      const request = preview.request || {
        date: preview.date,
        timeZone: preview.timeZone,
        mode: preview.mode,
        availability: preview.availability,
        blocks: preview.blocks,
        whatIf: preview.whatIf,
      };
      const operation = currentOperation(ctx, "plan/apply", { preview: request, baseRevision: ctx.baseRevision });
      if (operation.existing) return operation.existing;
      checkBaseRevision(ctx.baseRevision);
      if (preview.baseRevision !== state.revision) fail("plan preview ล้าสมัย", "REVISION_CONFLICT", 409, { currentRevision: state.revision });
      const recomputed = buildPreview(normalizePlanRequest(request, state));
      if (!blocksEqual(recomputed.blocks, preview.blocks)) fail("plan preview เปลี่ยนแล้ว กรุณาสร้างใหม่", "PREVIEW_INVALID", 409);
      const candidate = clone(state);
      const existing = latestAcceptedPlan(state, recomputed.date, recomputed.timeZone) || latestAcceptedAnyZone(state, recomputed.date);
      if (existing) {
        const prior = candidate.dayPlans.find((plan) => plan.id === existing.id);
        if (prior) prior.accepted = false;
      }
      candidate.dayPlans.push({
        id: makeId("plan"),
        date: recomputed.date,
        timeZone: recomputed.timeZone,
        availability: clone(recomputed.availability),
        blocks: clone(recomputed.blocks),
        accepted: true,
        createdAt: isoFrom(wallClock()),
        updatedAt: isoFrom(wallClock()),
        lastOptimizedAt: recomputed.mode === "auto" || recomputed.mode === "what-if" ? isoFrom(wallClock()) : null,
        revision: state.revision + 1,
      });
      return commitOperation(candidate, { action: "plan/apply", operationId: ctx.operationId, hash: operation.hash, resultFactory: publicResult });
    });
  }

  async function updatePreferences(input, context = {}) {
    return withMutation(async () => {
      const ctx = validateOperationContext(context);
      const operation = currentOperation(ctx, "preferences", { preferences: input, baseRevision: ctx.baseRevision });
      if (operation.existing) return operation.existing;
      checkBaseRevision(ctx.baseRevision);
      if (!isObject(input)) fail("preferences ต้องเป็น object", "VALIDATION_ERROR");
      const merged = {
        ...state.preferences,
        ...input,
        workingHours: { ...state.preferences.workingHours, ...(input.workingHours || {}) },
      };
      const candidate = clone(state);
      candidate.preferences = validatePreferencesShape(merged);
      return commitOperation(candidate, { action: "preferences", operationId: ctx.operationId, hash: operation.hash, resultFactory: publicResult });
    });
  }

  function prepareFocusInput(input = {}) {
    if (!isObject(input)) fail("focus input ต้องเป็น object", "VALIDATION_ERROR");
    const sessionId = input.sessionId == null ? null : idValue(input.sessionId, "sessionId");
    const taskId = input.taskId == null ? null : idValue(input.taskId, "taskId");
    if (taskId) {
      const task = findTask(taskId);
      if (task.archivedAt || task.status === "completed") fail("ไม่สามารถ focus งานที่เสร็จหรือเก็บถาวรแล้ว", "TASK_NOT_ELIGIBLE", 409);
    }
    const sequence = input.sequence == null ? null : integer(input.sequence, 1, Number.MAX_SAFE_INTEGER, "sequence");
    const targetMinutes = input.targetMinutes == null ? 25 : integer(input.targetMinutes, 1, 1440, "targetMinutes");
    return { sessionId, taskId, sequence, targetMinutes, reason: input.reason == null ? null : text(input.reason, 200) };
  }

  async function startFocus(input = {}, context = {}) {
    return withMutation(async () => {
      const ctx = validateOperationContext(context, { required: true });
      const values = prepareFocusInput(input);
      const operation = currentOperation(ctx, "focus/start", { input: values, baseRevision: ctx.baseRevision });
      if (operation.existing) return operation.existing;
      checkBaseRevision(ctx.baseRevision);
      if (activeRunningSession()) fail("มี focus session กำลังทำงานอยู่แล้ว", "FOCUS_ALREADY_RUNNING", 409);
      const now = nowMs(wallClock);
      const mono = finiteNumber(Number(monotonicClock()), 0, Number.MAX_SAFE_INTEGER, "monotonicNow");
      const candidate = clone(state);
      if (candidate.focusSessions.length >= MAX_FOCUS_SESSIONS) fail(`มี focus session เกิน ${MAX_FOCUS_SESSIONS} รายการ`, "LIMIT_EXCEEDED");
      const session = {
        id: values.sessionId || makeId("focus"),
        taskId: values.taskId,
        state: "running",
        targetMinutes: values.targetMinutes,
        timeZone: candidate.preferences.timeZone,
        activeIntervals: [],
        currentStartedAt: isoAt(now),
        currentStartedMono: mono,
        currentElapsedMs: 0,
        lastHeartbeatAt: isoAt(now),
        lastHeartbeatMono: mono,
        lastHeartbeatSequence: 0,
        startedAt: isoAt(now),
        pausedAt: null,
        endedAt: null,
        endReason: null,
        revision: state.revision + 1,
      };
      candidate.focusSessions.push(session);
      if (values.taskId) {
        const task = candidate.tasks.find((entry) => entry.id === values.taskId);
        if (task.status === "todo") {
          task.status = "in-progress";
          task.updatedAt = isoAt(now);
        }
      }
      return commitOperation(candidate, { action: "focus/start", operationId: ctx.operationId, hash: operation.hash, resultFactory: publicResult });
    });
  }

  function focusSession(id) {
    const session = state.focusSessions.find((entry) => entry.id === id);
    if (!session) fail("ไม่พบ focus session", "NOT_FOUND", 404);
    return session;
  }

  async function pauseFocus(input = {}, context = {}) {
    return withMutation(async () => {
      const ctx = validateOperationContext(context);
      const values = prepareFocusInput(input);
      const operation = currentOperation(ctx, "focus/pause", { input: values, baseRevision: ctx.baseRevision });
      if (operation.existing) return operation.existing;
      checkBaseRevision(ctx.baseRevision);
      const session = focusSession(values.sessionId);
      if (session.state !== "running") fail("pause ใช้ได้กับ running session เท่านั้น", "FOCUS_STATE", 409);
      const candidate = clone(state);
      const target = candidate.focusSessions.find((entry) => entry.id === session.id);
      reconcileSession(target);
      if (target.state === "interrupted" || target.state === "finished") {
        target.revision = state.revision + 1;
        return commitOperation(candidate, { action: "focus/pause", operationId: ctx.operationId, hash: operation.hash, resultFactory: publicResult });
      }
      closeCurrentInterval(target, currentIntervalEndMs(target, nowMs(wallClock)));
      target.state = "paused";
      target.pausedAt = isoFrom(wallClock());
      target.lastHeartbeatMono = null;
      target.revision = state.revision + 1;
      return commitOperation(candidate, { action: "focus/pause", operationId: ctx.operationId, hash: operation.hash, resultFactory: publicResult });
    });
  }

  async function resumeFocus(input = {}, context = {}) {
    return withMutation(async () => {
      const ctx = validateOperationContext(context);
      const values = prepareFocusInput(input);
      const operation = currentOperation(ctx, "focus/resume", { input: values, baseRevision: ctx.baseRevision });
      if (operation.existing) return operation.existing;
      checkBaseRevision(ctx.baseRevision);
      const session = focusSession(values.sessionId);
      if (!["paused", "interrupted"].includes(session.state)) fail("resume ใช้ได้กับ paused หรือ interrupted session เท่านั้น", "FOCUS_STATE", 409);
      if (activeRunningSession()) fail("มี focus session กำลังทำงานอยู่แล้ว", "FOCUS_ALREADY_RUNNING", 409);
      const candidate = clone(state);
      const target = candidate.focusSessions.find((entry) => entry.id === session.id);
      const now = nowMs(wallClock);
      const mono = finiteNumber(Number(monotonicClock()), 0, Number.MAX_SAFE_INTEGER, "monotonicNow");
      target.state = "running";
      target.currentStartedAt = isoAt(now);
      target.currentStartedMono = mono;
      target.currentElapsedMs = 0;
      target.lastHeartbeatAt = isoAt(now);
      target.lastHeartbeatMono = mono;
      target.pausedAt = null;
      target.endedAt = null;
      target.endReason = null;
      target.revision = state.revision + 1;
      return commitOperation(candidate, { action: "focus/resume", operationId: ctx.operationId, hash: operation.hash, resultFactory: publicResult });
    });
  }

  async function finishFocus(input = {}, context = {}) {
    return withMutation(async () => {
      const ctx = validateOperationContext(context, { required: true });
      const values = prepareFocusInput(input);
      const request = { input: values, baseRevision: ctx.baseRevision };
      const operation = currentOperation(ctx, "focus/finish", request);
      if (operation.existing) return operation.existing;
      checkBaseRevision(ctx.baseRevision);
      const session = focusSession(values.sessionId);
      if (session.state === "finished") {
        const candidate = clone(state);
        return commitOperation(candidate, { action: "focus/finish", operationId: ctx.operationId, hash: operation.hash, resultFactory: publicResult });
      }
      if (!["running", "paused", "interrupted"].includes(session.state)) fail("finish ใช้กับ session นี้ไม่ได้", "FOCUS_STATE", 409);
      const candidate = clone(state);
      const target = candidate.focusSessions.find((entry) => entry.id === session.id);
      if (target.state === "running") {
        reconcileSession(target);
        if (target.state === "running") closeCurrentInterval(target, currentIntervalEndMs(target, nowMs(wallClock)));
      }
      target.state = "finished";
      target.endedAt = target.endedAt || isoFrom(wallClock());
      target.endReason = target.endReason || values.reason || "user-finished";
      target.lastHeartbeatMono = null;
      target.revision = state.revision + 1;
      return commitOperation(candidate, { action: "focus/finish", operationId: ctx.operationId, hash: operation.hash, resultFactory: publicResult });
    });
  }

  async function heartbeatFocus(input = {}) {
    return withMutation(async () => {
      ensureAvailable();
      const values = prepareFocusInput(input);
      if (!values.sessionId || values.sequence == null) fail("heartbeat ต้องมี sessionId และ sequence", "VALIDATION_ERROR");
      const session = focusSession(values.sessionId);
      if (values.sequence <= session.lastHeartbeatSequence) return publicState(state);
      const candidate = clone(state);
      const target = candidate.focusSessions.find((entry) => entry.id === session.id);
      if (target.state !== "running") return publicState(state);
      const now = nowMs(wallClock);
      const mono = finiteNumber(Number(monotonicClock()), 0, Number.MAX_SAFE_INTEGER, "monotonicNow");
      const gap = target.lastHeartbeatMono == null ? Number.POSITIVE_INFINITY : mono - target.lastHeartbeatMono;
      target.lastHeartbeatSequence = values.sequence;
      if (gap < 0 || gap > heartbeatGapMs || (target.lastHeartbeatAt && now < Date.parse(target.lastHeartbeatAt))) {
        closeCurrentInterval(target, currentIntervalEndMs(target, Date.parse(target.lastHeartbeatAt)));
        target.state = "interrupted";
        target.endedAt = target.lastHeartbeatAt;
        target.endReason = gap < 0 ? "clock-continuity-lost" : "heartbeat-gap";
        target.currentStartedMono = null;
        target.currentElapsedMs = null;
        target.lastHeartbeatMono = null;
      } else {
        target.lastHeartbeatAt = isoAt(now);
        target.lastHeartbeatMono = mono;
        reconcileSession(target);
      }
      await saveCandidate(candidate, { bumpRevision: false });
      return publicState(state);
    });
  }

  function minutesInRange(session, startMs, endMs, timeZone) {
    return session.activeIntervals.reduce((sum, interval) => sum + intervalIntersectionMinutes(Date.parse(interval.start), Date.parse(interval.end), startMs, endMs), 0);
  }

  async function getInsights(input = {}) {
    const reconciled = await reconcileForRead();
    const currentState = reconciled;
    const timeZone = validTimeZone(input.timeZone || currentState.preferences.timeZone, "timeZone");
    const today = localDateFromMs(nowMs(wallClock), timeZone);
    const from = validDate(input.from || addDays(today, -6), "from");
    const to = validDate(input.to || today, "to");
    const referenceDate = validDate(input.referenceDate || to, "referenceDate");
    if (from > to) fail("ช่วงวันที่ไม่ถูกต้อง", "VALIDATION_ERROR");
    const startMs = dayStartMs(from, timeZone);
    const endMs = dayStartMs(addDays(to, 1), timeZone);
    const stateLike = { ...currentState, operations: [] };
    const plans = stateLike.dayPlans.filter((plan) => plan.accepted && plan.date >= from && plan.date <= to);
    const plan = latestAcceptedPlan(stateLike, referenceDate, timeZone) || latestAcceptedAnyZone(stateLike, referenceDate);
    const planTaskIds = plan ? [...blockIds(plan.blocks)] : [];
    const taskMap = new Map(stateLike.tasks.map((task) => [task.id, task]));
    const taskIds = new Set(stateLike.tasks.filter((task) => {
      const completed = task.completedAt && Date.parse(task.completedAt) >= startMs && Date.parse(task.completedAt) < endMs;
      return completed || planTaskIds.includes(task.id);
    }).map((task) => task.id));
    const completedCount = stateLike.tasks.filter((task) => task.status === "completed" && task.completedAt && Date.parse(task.completedAt) >= startMs && Date.parse(task.completedAt) < endMs).length;
    const planCompleted = planTaskIds.filter((id) => taskMap.get(id)?.status === "completed").length;
    const focusSessions = stateLike.focusSessions.filter((session) => session.activeIntervals.some((interval) => Date.parse(interval.end) > startMs && Date.parse(interval.start) < endMs));
    const focusMinutes = focusSessions.reduce((sum, session) => sum + minutesInRange(session, startMs, endMs, timeZone), 0);
    const referenceStartMs = dayStartMs(referenceDate, timeZone);
    const referenceEndMs = dayStartMs(addDays(referenceDate, 1), timeZone);
    const referenceFocusMinutes = stateLike.focusSessions.reduce((sum, session) => sum + minutesInRange(session, referenceStartMs, referenceEndMs, timeZone), 0);
    const dailyMinutes = new Map();
    const allDailyMinutes = new Map();
    const allDailySourceIds = new Map();
    const hourlyMinutes = Array.from({ length: 24 }, (_, hour) => ({ hour, minutes: 0, sampleDays: 0, _days: new Set() }));
    for (const session of stateLike.focusSessions) {
      for (const interval of session.activeIntervals) {
        const intervalStart = Date.parse(interval.start);
        const intervalEnd = Date.parse(interval.end);
        walkMinuteSegments(intervalStart, intervalEnd, (cursor, chunkEnd) => {
          const parts = dateTimeParts(cursor, timeZone);
          const date = `${parts.year}-${parts.month}-${parts.day}`;
          const minutes = (chunkEnd - cursor) / 60_000;
          allDailyMinutes.set(date, (allDailyMinutes.get(date) || 0) + minutes);
          if (!allDailySourceIds.has(date)) allDailySourceIds.set(date, new Set());
          allDailySourceIds.get(date).add(session.id);
          if (chunkEnd <= startMs || cursor >= endMs) return;
          const visibleStart = Math.max(cursor, startMs);
          const visibleEnd = Math.min(chunkEnd, endMs);
          const visibleMinutes = Math.max(0, (visibleEnd - visibleStart) / 60_000);
          dailyMinutes.set(date, (dailyMinutes.get(date) || 0) + visibleMinutes);
          const hour = Number(parts.hour);
          hourlyMinutes[hour].minutes += visibleMinutes;
          hourlyMinutes[hour]._days.add(date);
        });
      }
    }
    for (const item of hourlyMinutes) item.sampleDays = item._days.size;
    // Count only local dates with a visible clipped minute. A session that
    // starts before the requested range can still contribute to its first
    // visible date after midnight.
    const distinctSessionDays = dailyMinutes.size;
    let streak = 0;
    let streakDate = today;
    if ((allDailyMinutes.get(streakDate) || 0) < 5) streakDate = addDays(today, -1);
    const streakDates = [];
    while ((allDailyMinutes.get(streakDate) || 0) >= 5) {
      streak += 1;
      streakDates.push(streakDate);
      streakDate = addDays(streakDate, -1);
    }
    const daySpan = Math.max(1, Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000) + 1);
    const currentWeekStart = mondayOf(to);
    const elapsedDays = Math.max(1, Math.min(7, Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${currentWeekStart}T00:00:00.000Z`)) / 86_400_000) + 1));
    const previousWeekStart = addDays(currentWeekStart, -7);
    const currentWeekEnd = addDays(currentWeekStart, elapsedDays);
    const previousWeekEnd = addDays(previousWeekStart, elapsedDays);
    const weekMinutes = (weekStart, weekEnd) => stateLike.focusSessions.reduce((sum, session) => sum + minutesInRange(session, dayStartMs(weekStart, timeZone), dayStartMs(weekEnd, timeZone), timeZone), 0);
    const currentMinutes = weekMinutes(currentWeekStart, currentWeekEnd);
    const previousMinutes = weekMinutes(previousWeekStart, previousWeekEnd);
    const contributingSessionIds = new Set(focusSessions.map((session) => session.id));
    for (const session of stateLike.focusSessions) {
      if (minutesInRange(session, referenceStartMs, referenceEndMs, timeZone) > 0
        || minutesInRange(session, dayStartMs(currentWeekStart, timeZone), dayStartMs(currentWeekEnd, timeZone), timeZone) > 0
        || minutesInRange(session, dayStartMs(previousWeekStart, timeZone), dayStartMs(previousWeekEnd, timeZone), timeZone) > 0) {
        contributingSessionIds.add(session.id);
      }
    }
    for (const date of streakDates) {
      for (const sessionId of allDailySourceIds.get(date) || []) contributingSessionIds.add(sessionId);
    }
    const sourcePlanIds = new Set(plans.map((entry) => entry.id));
    if (plan) sourcePlanIds.add(plan.id);
    const change = (current, previous) => previous === 0 ? null : Math.round(((current - previous) / previous) * 10000) / 100;
    const topHour = [...hourlyMinutes].sort((a, b) => b.minutes - a.minutes || a.hour - b.hour)[0];
    const recommendation = focusSessions.length >= 5 && distinctSessionDays >= 3 && topHour.sampleDays >= 3 && daySpan >= 7 && topHour.minutes > 0
      ? {
          startHour: topHour.hour,
          endHour: (topHour.hour + 1) % 24,
          minutes: Math.round(topHour.minutes * 100) / 100,
          sampleDays: topHour.sampleDays,
          message: `คุณบันทึกเวลาโฟกัสช่วงนี้มากที่สุดในข้อมูลที่มี (${Math.round(topHour.minutes)} นาที จาก ${topHour.sampleDays} วัน)`,
        }
      : null;
    const previousRangeStart = dayStartMs(addDays(from, -daySpan), timeZone);
    const previousRangeEnd = startMs;
    const previousRangeMinutes = stateLike.focusSessions.reduce((sum, session) => sum + minutesInRange(session, previousRangeStart, previousRangeEnd, timeZone), 0);
    const target = currentState.preferences.dailyFocusTargetMinutes;
    const percent = target > 0 ? Math.min(100, Math.round((referenceFocusMinutes / target) * 10000) / 100) : null;
    return {
      range: { from, to },
      referenceDate,
      timeZone,
      computedAt: isoFrom(wallClock()),
      sampleSize: { days: daySpan, sessions: focusSessions.length, distinctSessionDays },
      sourceIds: {
        taskIds: [...taskIds],
        planIds: stateLike.dayPlans.filter((entry) => sourcePlanIds.has(entry.id)).map((entry) => entry.id),
        sessionIds: stateLike.focusSessions.filter((entry) => contributingSessionIds.has(entry.id)).map((entry) => entry.id),
      },
      metrics: {
        tasksToday: {
          total: planTaskIds.length,
          completed: planCompleted,
          active: Math.max(0, planTaskIds.length - planCompleted),
        },
        tasksCompleted: { count: completedCount },
        planCompletion: planTaskIds.length
          ? { percent: Math.round((planCompleted / planTaskIds.length) * 10000) / 100, numerator: planCompleted, denominator: planTaskIds.length }
          : { percent: null, numerator: 0, denominator: 0, reason: "ยังไม่มีงานในแผน" },
        focusTime: { confirmedMinutes: Math.round(focusMinutes * 100) / 100 },
        focusTargetProgress: { percent, confirmedMinutes: Math.round(referenceFocusMinutes * 100) / 100, targetMinutes: target, ...(percent === null ? { reason: "ยังไม่มีเป้าหมายโฟกัส" } : {}) },
        focusStreak: { days: streak },
        hourlyRhythm: hourlyMinutes.map(({ _days, ...item }) => ({ hour: item.hour, minutes: Math.round(item.minutes * 100) / 100, sampleDays: item.sampleDays })),
        weeklyProgress: {
          currentMinutes: Math.round(currentMinutes * 100) / 100,
          previousMinutes: Math.round(previousMinutes * 100) / 100,
          changePercent: change(currentMinutes, previousMinutes),
          ...(previousMinutes === 0 ? { reason: "ยังไม่มีฐานเปรียบเทียบ" } : {}),
        },
        changePercentage: {
          current: Math.round(focusMinutes * 100) / 100,
          previous: Math.round(previousRangeMinutes * 100) / 100,
          percent: change(focusMinutes, previousRangeMinutes),
          ...(previousRangeMinutes === 0 ? { reason: "ยังไม่มีฐานเปรียบเทียบ" } : {}),
        },
        recommendation,
      },
    };
  }

  async function close() {
    await mutationQueue.catch(() => {});
    previews.clear();
  }

  await loadState();
  if (state) seedAllocatedIds();

  return {
    getState,
    createTask,
    updateTask,
    completeTask,
    reopenTask,
    archiveTask,
    searchTasks,
    createDraft,
    previewPlan,
    applyPlan,
    updatePreferences,
    startFocus,
    pauseFocus,
    resumeFocus,
    finishFocus,
    heartbeatFocus,
    getInsights,
    close,
    status: () => ({ available: !unavailable && Boolean(state), code: unavailable?.code || null }),
  };
}

export {
  makeDefaultState,
  validateStoredState,
  localWallMs,
  localDateFromMs,
};
