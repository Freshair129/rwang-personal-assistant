const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TAB_NAMES = ["today", "tasks", "focus", "insights"];
const PERIODS = ["morning", "afternoon", "evening"];
const HEARTBEAT_MS = 15_000;
const STATE_REFRESH_MS = 15_000;
const COACH_IDLE_MS = 5 * 60_000;

function clean(value) {
  return String(value ?? "").replace(CONTROL_CHARS, "").trim();
}

function numberOrNull(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max, fallback = min) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function makeOperationId(prefix = "planner") {
  try {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  } catch {}
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function todayInZone(timeZone = "Asia/Bangkok", date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const result = `${values.year}-${values.month}-${values.day}`;
    return DATE_RE.test(result) ? result : new Date().toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function shiftDate(dateValue, amount, timeZone = "Asia/Bangkok") {
  const parts = String(dateValue || todayInZone(timeZone)).split("-").map(Number);
  const date = new Date(Date.UTC(parts[0], (parts[1] || 1) - 1, parts[2] || 1));
  date.setUTCDate(date.getUTCDate() + Number(amount || 0));
  return date.toISOString().slice(0, 10);
}

function displayDate(dateValue, timeZone = "Asia/Bangkok") {
  if (!DATE_RE.test(String(dateValue || ""))) return "—";
  const date = new Date(`${dateValue}T12:00:00Z`);
  try {
    return new Intl.DateTimeFormat("th-TH", { timeZone, dateStyle: "medium", weekday: "short" }).format(date);
  } catch {
    return dateValue;
  }
}

function timeZoneLabel(timeZone) {
  const value = clean(timeZone);
  if (!value) return "ยังไม่ระบุเขตเวลา";
  try {
    const label = new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "short" }).formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value;
    return label ? `${value} · ${label}` : value;
  } catch {
    return value;
  }
}

function parseTimeMinutes(value) {
  const match = String(value || "").match(TIME_RE);
  if (!match) return null;
  const [hour, minute] = String(value).split(":").map(Number);
  return hour * 60 + minute;
}

function formatMinutes(value, missing = "—") {
  const number = numberOrNull(value);
  if (number == null) return missing;
  const rounded = Math.max(0, Math.round(number));
  if (rounded < 60) return `${rounded} นาที`;
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  return minutes ? `${hours} ชม. ${minutes} นาที` : `${hours} ชม.`;
}

function formatClock(seconds, fallback = "00:00") {
  const value = numberOrNull(seconds);
  if (value == null) return fallback;
  const total = Math.max(0, Math.round(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatInstant(value, timeZone = "Asia/Bangkok") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("th-TH", { timeZone, dateStyle: "short", timeStyle: "short" }).format(date);
  } catch {
    return date.toLocaleString("th-TH");
  }
}

function formatTimeInZone(value, timeZone = "Asia/Bangkok") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("th-TH", { timeZone, hour: "2-digit", minute: "2-digit" }).format(date);
  } catch {
    return date.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
  }
}

function localDateTimeToUtc(dateValue, timeValue, timeZone = "Asia/Bangkok") {
  if (!DATE_RE.test(String(dateValue || "")) || !TIME_RE.test(String(timeValue || ""))) return "";
  const [year, month, day] = dateValue.split("-").map(Number);
  const [hour, minute] = timeValue.split(":").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const zonedGuess = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
    return new Date(guess - (zonedGuess - guess)).toISOString();
  } catch {
    return new Date(guess).toISOString();
  }
}

function timeFromInstant(value, timeZone = "Asia/Bangkok") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

function unwrap(payload, key) {
  return payload?.[key] ?? payload;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function taskTitle(task) {
  return clean(task?.title || task?.name || "งานไม่มีชื่อ");
}

function taskListFromState(state) {
  return asArray(state?.tasks);
}

function getDayPlan(state, date, timeZone = "") {
  const values = Array.isArray(state?.dayPlans)
    ? state.dayPlans
    : state?.dayPlans && typeof state.dayPlans === "object" ? Object.values(state.dayPlans).flatMap((value) => Array.isArray(value) ? value : [value]) : [];
  const accepted = values.filter((plan) => plan?.accepted && plan.date === date);
  const byRevision = (left, right) => Number(right?.revision || 0) - Number(left?.revision || 0)
    || clean(right?.updatedAt).localeCompare(clean(left?.updatedAt));
  return accepted.filter((plan) => !timeZone || plan.timeZone === timeZone).sort(byRevision)[0]
    || accepted.sort(byRevision)[0]
    || null;
}

function getFocusSessions(state) {
  return asArray(state?.focusSessions || state?.focus?.sessions);
}

function normalizePlannerState(payload) {
  const raw = unwrap(payload, "state") || {};
  return {
    ...raw,
    revision: Number.isFinite(Number(raw.revision)) ? Number(raw.revision) : 0,
    preferences: raw.preferences && typeof raw.preferences === "object" ? raw.preferences : {},
    tasks: asArray(raw.tasks),
    dayPlans: raw.dayPlans || [],
    focusSessions: asArray(raw.focusSessions || raw.focus?.sessions),
  };
}

function taskChecklistText(checklist) {
  return asArray(checklist).map((item) => clean(typeof item === "string" ? item : item?.text)).filter(Boolean).join("\n");
}

function normalizeDraft(raw) {
  const value = raw?.draft ?? raw ?? {};
  const tasks = asArray(value.tasks);
  const entries = tasks.length ? tasks : [value];
  return {
    raw: value,
    warnings: asArray(value.warnings).map(clean).filter(Boolean),
    tasks: entries.map((task) => ({
      ...task,
      title: clean(task?.title || task?.name),
      notes: clean(task?.notes || task?.description),
      priority: clamp(task?.priority, 1, 5, 3),
      estimatedMinutes: numberOrNull(task?.estimatedMinutes ?? task?.durationMinutes),
      energyDemand: clamp(task?.energyDemand, 1, 5, 3),
      checklist: asArray(task?.checklist).map((item) => clean(typeof item === "string" ? item : item?.text)).filter(Boolean),
    })),
  };
}

function normalizePreview(payload) {
  const value = payload?.preview ?? payload ?? {};
  return {
    ...value,
    baseRevision: Number.isFinite(Number(value.baseRevision)) ? Number(value.baseRevision) : null,
    blocks: asArray(value.blocks || value.plan?.blocks),
    unscheduled: asArray(value.unscheduled),
    conflicts: asArray(value.conflicts),
    reasons: asArray(value.reasons),
    diff: value.diff && typeof value.diff === "object" ? value.diff : value.changes && typeof value.changes === "object" ? value.changes : {},
  };
}

function normalizeInsights(payload) {
  const value = payload?.insights ?? payload ?? {};
  const metrics = value.metrics && typeof value.metrics === "object" ? value.metrics : {};
  const sourceValue = value.sourceIds;
  const sourceIds = Array.isArray(sourceValue)
    ? sourceValue
    : [
      ...asArray(sourceValue?.taskIds).map((id) => ({ type: "task", id })),
      ...asArray(sourceValue?.planIds).map((id) => ({ type: "plan", id })),
      ...asArray(sourceValue?.sessionIds).map((id) => ({ type: "session", id })),
    ];
  return {
    ...value,
    metrics,
    hourlyRhythm: asArray(value.hourlyRhythm || value.hourly || value.rhythm?.hourly || metrics.hourlyRhythm),
    weeklyProgress: value.weeklyProgress ?? value.weekly ?? metrics.weeklyProgress ?? [],
    sourceIds,
    sources: value.sources && !Array.isArray(value.sources) ? value.sources : {},
    sampleSize: value.sampleSize && typeof value.sampleSize === "object" ? value.sampleSize : value.sampleSize,
  };
}

function metricValue(metrics, names) {
  for (const name of names) {
    const path = String(name).split(".");
    const value = path.reduce((current, key) => current?.[key], metrics);
    if (value && typeof value === "object") {
      for (const property of ["value", "percent", "count", "confirmedMinutes", "days", "total", "changePercent"]) {
        if (Object.prototype.hasOwnProperty.call(value, property)) return value[property];
      }
    }
    if (value !== undefined) return value;
  }
  return undefined;
}

function metricReason(metrics, names, fallback = "") {
  for (const name of names) {
    const value = metrics?.[name];
    if (value && typeof value === "object" && value.reason) return clean(value.reason);
  }
  return fallback;
}

function blockKindLabel(kind) {
  return ({ task: "งาน", break: "พัก", busy: "ไม่ว่าง" })[kind] || clean(kind) || "บล็อก";
}

export function createPlannerController({ apiFetch, getStatus, getRwang, notify = () => {} } = {}) {
  if (typeof apiFetch !== "function") throw new TypeError("planner requires apiFetch");

  const model = {
    initialized: false,
    active: false,
    local: null,
    tab: "today",
    date: "",
    dateTouched: false,
    state: null,
    revision: null,
    preview: null,
    previewRevision: null,
    archivePending: null,
    manualBlocks: [],
    manualBlocksActive: false,
    draft: null,
    draftIndex: 0,
    insights: null,
    stateTimer: null,
    clockTimer: null,
    heartbeatTimer: null,
    coachTimer: null,
    focusSequence: 0,
    lastInteractionAt: Date.now(),
    coachDismissed: false,
    dirty: new Set(),
    busy: new Set(),
    channel: null,
    storageKey: "rwang.planner.sync",
  };

  function isLocal() {
    if (typeof getRwang === "function") {
      const rwang = getRwang();
      if (rwang?.access && typeof rwang.access.local === "boolean") return rwang.access.local;
    }
    return model.local === true;
  }

  function currentTimeZone() {
    return clean($("#plannerTimeZoneInput")?.value || model.state?.preferences?.timeZone || getRwang?.()?.scheduler?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Bangkok");
  }

  function isValidTimeZone(value) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format();
      return Boolean(value);
    } catch {
      return false;
    }
  }

  function setStatus(message, tone = "") {
    const output = $("#plannerStatus");
    if (!output) return;
    output.textContent = clean(message);
    output.className = `planner-status${tone ? ` ${tone}` : ""}`;
  }

  function notifyUser(message, tone = "") {
    setStatus(message, tone);
    try { notify(message); } catch {}
  }

  function setBusy(key, busy) {
    if (busy) model.busy.add(key);
    else model.busy.delete(key);
    for (const node of $$(`[data-planner-busy="${key}"]`)) node.disabled = busy;
  }

  function apiErrorMessage(error) {
    const payload = error?.payload || {};
    const code = clean(payload.code);
    if (code === "LOCAL_ONLY") return "PLAN ใช้ได้จากเครื่องหลักเท่านั้น";
    if (code === "REVISION_CONFLICT") return "ข้อมูลเปลี่ยนในอีกแท็บแล้ว · โหลดข้อมูลล่าสุดก่อนลองอีกครั้ง";
    if (code === "STATE_CORRUPT" || code === "STATE_UNSUPPORTED" || code === "PLANNER_UNAVAILABLE") return "ข้อมูลแผนอ่านไม่ได้ในขณะนี้ · ฟีเจอร์เดิมของ RWANG ยังใช้งานได้";
    return clean(payload.error || payload.message || error?.message || "เชื่อมต่อ planner ไม่สำเร็จ");
  }

  function handleApiError(error, context = "") {
    const message = context ? `${context}: ${apiErrorMessage(error)}` : apiErrorMessage(error);
    notifyUser(message, "error");
    return message;
  }

  async function plannerFetch(path, options = {}) {
    if (!isLocal()) throw new Error("PLAN ใช้ได้จากเครื่องหลักเท่านั้น");
    return apiFetch(`/api/rwang/planner/${path}`, { cache: "no-store", ...options });
  }

  function saveSyncSignal() {
    try {
      localStorage.setItem(model.storageKey, JSON.stringify({ revision: model.revision, at: Date.now() }));
    } catch {}
    try { model.channel?.postMessage({ type: "state-changed", revision: model.revision }); } catch {}
  }

  function markState(value) {
    const hadState = Boolean(model.state);
    const next = normalizePlannerState(value);
    model.state = next;
    model.revision = next.revision;
    const activeSession = getFocusSessions(next).find((session) => session?.state === "running");
    if (activeSession?.lastHeartbeatSequence != null) model.focusSequence = Math.max(model.focusSequence, Number(activeSession.lastHeartbeatSequence) || 0);
    if (!hadState && !model.dateTouched) {
      model.date = todayInZone(next.preferences?.timeZone || currentTimeZone());
      defaultInsightDates();
    } else if (!model.date) model.date = todayInZone(next.preferences?.timeZone || currentTimeZone());
    if (model.preview && model.previewRevision !== model.revision) {
      model.preview = { ...model.preview, stale: true };
      model.previewRevision = null;
    }
    renderAll();
    ensureHeartbeat();
  }

  async function loadState({ quiet = false } = {}) {
    if (!isLocal()) {
      model.local = false;
      renderHostState();
      return null;
    }
    setBusy("state", true);
    try {
      const result = await plannerFetch("state");
      markState(result);
      if (!model.date) model.date = todayInZone(currentTimeZone());
      if (!quiet) setStatus("โหลดข้อมูล PLAN ล่าสุดแล้ว");
      return model.state;
    } catch (error) {
      if (!quiet) handleApiError(error, "โหลด PLAN");
      return null;
    } finally {
      setBusy("state", false);
    }
  }

  function updateModelSelect(select, models) {
    if (!select) return;
    const names = asArray(models).map((item) => clean(typeof item === "string" ? item : item?.name || item?.model)).filter(Boolean);
    const previous = select.value;
    select.replaceChildren();
    select.add(new Option(names.length ? "เลือกโมเดลที่ติดตั้ง" : "ยังไม่มีโมเดลในเครื่อง", ""));
    for (const name of names) select.add(new Option(name, name));
    if (names.includes(previous)) select.value = previous;
    else if (names.length === 1) select.value = names[0];
  }

  function renderHostState() {
    const host = $("#plannerHostState");
    const nav = $('[data-view="plan"]');
    if (model.local === null) {
      if (host) host.textContent = "กำลังตรวจสอบเครื่องหลัก";
      if (nav) nav.hidden = true;
      return;
    }
    if (model.local === false) {
      if (host) host.textContent = "ใช้ได้บนเครื่องหลักเท่านั้น";
      host?.classList.add("blocked");
      if (nav) nav.hidden = true;
      return;
    }
    if (host) host.textContent = "บันทึกในเครื่องนี้";
    host?.classList.remove("blocked");
    if (nav) nav.hidden = false;
  }

  function setContext(status = getStatus?.()) {
    const rwang = getRwang?.() || status?.rwang || {};
    model.local = rwang?.access && typeof rwang.access.local === "boolean" ? rwang.access.local : null;
    renderHostState();
    const models = status?.installed || [];
    updateModelSelect($("#plannerDraftModel"), models);
    updateModelSelect($("#plannerModelSelect"), models);
    if (model.local === true && model.active && !model.state) void loadState({ quiet: true });
    if (model.local === false && location.hash === "#plan") setTimeout(() => window.dispatchEvent(new CustomEvent("rwang-plan-blocked")), 0);
  }

  function getSelectedPlan() {
    return getDayPlan(model.state, model.date, currentTimeZone()) || null;
  }

  function getAcceptedBlocks() {
    return asArray(getSelectedPlan()?.blocks);
  }

  function taskById(taskId) {
    return taskListFromState(model.state).find((task) => task?.id === taskId) || null;
  }

  function blockDescription(block) {
    if (block?.kind === "task") return taskTitle(taskById(block.taskId)) || "งานที่ไม่พบในรายการ";
    return clean(block?.reason) || blockKindLabel(block?.kind);
  }

  function renderRevision() {
    $("#plannerRevision").textContent = model.revision == null ? "—" : "พร้อม";
    const updated = getSelectedPlan()?.updatedAt || model.state?.updatedAt;
    $("#plannerLastUpdated").textContent = updated ? `อัปเดต ${formatInstant(updated, currentTimeZone())}` : "ข้อมูลล่าสุด";
  }

  function renderPreferences() {
    const preferences = model.state?.preferences || {};
    const hours = preferences.workingHours || {};
    const zone = model.dirty.has("preferences") ? currentTimeZone() : clean(preferences.timeZone || currentTimeZone());
    $("#plannerTimeZone").textContent = timeZoneLabel(zone);
    if (!model.dirty.has("preferences")) {
      $("#plannerTimeZoneInput").value = clean(preferences.timeZone || zone);
      $("#plannerWorkStart").value = TIME_RE.test(hours.start || "") ? hours.start : "09:00";
      $("#plannerWorkEnd").value = TIME_RE.test(hours.end || "") ? hours.end : "17:30";
      const windows = asArray(preferences.energyWindows);
      for (const period of PERIODS) {
        const item = windows.find((window) => window?.period === period);
        const target = $(`#plannerEnergy${period[0].toUpperCase()}${period.slice(1)}`);
        if (target) target.value = String(clamp(item?.level, 1, 5, 3));
      }
    }
    const plan = getSelectedPlan();
    const availability = asArray(plan?.availability);
    if (!model.dirty.has("availability")) {
      $("#plannerAvailabilityInput").value = availability.length
        ? availability.map((item) => `${clean(item.start)}-${clean(item.end)}`).join("\n")
        : hours.start && hours.end ? `${hours.start}-${hours.end}` : "";
    }
  }

  function parseAvailability() {
    const lines = String($("#plannerAvailabilityInput")?.value || "").split(/[\n,]+/).map((line) => line.trim()).filter(Boolean);
    const result = [];
    for (const line of lines) {
      const match = line.match(/^(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})$/);
      if (!match || parseTimeMinutes(match[1]) == null || parseTimeMinutes(match[2]) == null || parseTimeMinutes(match[2]) <= parseTimeMinutes(match[1])) continue;
      result.push({ start: match[1], end: match[2] });
    }
    return result;
  }

  function currentPreviewBlocks() {
    if (model.preview) return asArray(model.preview.blocks);
    if (model.manualBlocksActive) return model.manualBlocks;
    return getAcceptedBlocks();
  }

  function renderBusyBlockOptions() {
    const select = $("#plannerSkipBusyBlock");
    if (!select) return;
    const previous = select.value;
    const blocks = currentPreviewBlocks().filter((block) => block?.kind === "busy");
    select.replaceChildren(new Option("ไม่ข้าม busy block", ""));
    for (const block of blocks) {
      const start = timeFromInstant(block.start, currentTimeZone());
      const end = timeFromInstant(block.end, currentTimeZone());
      select.add(new Option(`${start}–${end} · ${blockDescription(block)}`, block.id));
    }
    if (blocks.some((block) => block.id === previous)) select.value = previous;
  }

  function localBlockFromPersisted(block) {
    return {
      ...block,
      id: clean(block?.id) || makeOperationId("block"),
      kind: ["task", "break", "busy"].includes(block?.kind) ? block.kind : "busy",
      taskId: block?.taskId || null,
      start: block?.start || "",
      end: block?.end || "",
      locked: Boolean(block?.locked),
      reason: clean(block?.reason),
    };
  }

  function renderSummary() {
    const plan = getSelectedPlan();
    const blocks = currentPreviewBlocks();
    const taskIds = [...new Set(blocks.filter((block) => block?.kind === "task" && block?.taskId).map((block) => block.taskId))];
    const completed = taskIds.filter((id) => taskById(id)?.status === "completed").length;
    $("#plannerTasksCount").textContent = String(taskIds.length);
    $("#plannerTasksCountNote").textContent = model.preview || model.manualBlocksActive
      ? "จากตัวอย่างที่กำลังดู"
      : plan?.accepted ? "จากแผนที่ยืนยันแล้ว" : "ยังไม่มีแผนที่ยืนยัน";
    $("#plannerCompletedCount").textContent = String(completed);
    $("#plannerCompletedCountNote").textContent = taskIds.length ? `จาก ${taskIds.length} งานในแผน` : "ยังไม่มีงานในแผน";
    const availability = asArray(plan?.availability).length ? plan.availability : parseAvailability();
    const available = availability.reduce((sum, item) => {
      const start = parseTimeMinutes(item?.start);
      const end = parseTimeMinutes(item?.end);
      return start != null && end != null && end > start ? sum + end - start : sum;
    }, 0);
    const occupied = blocks.reduce((sum, block) => {
      const start = new Date(block?.start).getTime();
      const end = new Date(block?.end).getTime();
      return Number.isFinite(start) && Number.isFinite(end) && end > start ? sum + (end - start) / 60_000 : sum;
    }, 0);
    $("#plannerFreeMinutes").textContent = availability.length ? formatMinutes(Math.max(0, available - occupied)) : "—";
    $("#plannerFreeMinutesNote").textContent = availability.length ? "เวลาว่างหลังหักบล็อกในตัวอย่าง" : "ยังไม่มีข้อมูลช่วงเวลาว่าง";
    $("#plannerOptimizedAt").textContent = plan?.lastOptimizedAt ? formatTimeInZone(plan.lastOptimizedAt, currentTimeZone()) : "—";
    $("#plannerOptimizedRevision").textContent = plan?.revision != null ? "บันทึกแผนแล้ว" : "ยังไม่มีการอัปเดตแผน";
  }

  function renderTaskOptions() {
    const activeTasks = taskListFromState(model.state).filter((task) => !task?.archivedAt && task?.status !== "completed");
    for (const selector of [$("#plannerBlockTask"), $("#plannerFocusTask")]) {
      if (!selector) continue;
      const previous = selector.value;
      const empty = selector.id === "plannerFocusTask" ? "ไม่ผูกกับงาน" : "เลือกงาน";
      selector.replaceChildren(new Option(empty, ""));
      for (const task of activeTasks) selector.add(new Option(taskTitle(task), task.id));
      if (activeTasks.some((task) => task.id === previous)) selector.value = previous;
    }
  }

  function renderBlocks() {
    const list = $("#plannerBlockList");
    if (!list) return;
    list.replaceChildren();
    renderBusyBlockOptions();
    const blocks = currentPreviewBlocks();
    if (!blocks.length) {
      list.append(emptyNode("ยังไม่มีบล็อกของวันที่เลือก"));
      $("#plannerPlanState").textContent = model.preview || model.manualBlocksActive
        ? "ตัวอย่างชั่วคราว"
        : getSelectedPlan()?.accepted ? "แผนยืนยันแล้ว" : "ยังไม่มีแผน";
      return;
    }
    $("#plannerPlanState").textContent = model.preview ? (model.preview.stale ? "preview ล้าสมัย" : "กำลังดู preview") : getSelectedPlan()?.accepted ? "แผนยืนยันแล้ว" : "ตัวอย่างชั่วคราว";
    const timezone = currentTimeZone();
    for (const block of blocks) {
      const row = document.createElement("article");
      row.className = `planner-block-row ${clean(block?.kind)}`;
      row.append(
        node("span", "planner-block-time", `${timeFromInstant(block?.start, timezone)}–${timeFromInstant(block?.end, timezone)}`),
        node("div", "planner-block-copy", blockDescription(block)),
        node("span", `planner-block-kind ${block?.locked ? "locked" : ""}`, `${blockKindLabel(block?.kind)}${block?.locked ? " · ล็อก" : ""}`),
      );
      if (model.manualBlocksActive && !model.preview) {
        const remove = button("ลบ", "planner-inline-button", { blockAction: "remove", blockId: block.id });
        remove.setAttribute("aria-label", `ลบบล็อก ${blockDescription(block)}`);
        row.append(remove);
      }
      list.append(row);
    }
  }

  function emptyNode(message) {
    return node("div", "planner-empty", message);
  }

  function node(tag, className = "", text = null) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = clean(text);
    return element;
  }

  function button(text, className = "", data = {}) {
    const element = node("button", className, text);
    element.type = "button";
    for (const [key, value] of Object.entries(data)) element.dataset[key] = String(value ?? "");
    return element;
  }

  function renderPreviewList(target, values, fallback, formatter = (value) => value) {
    target.replaceChildren();
    if (!values.length) {
      target.append(emptyNode(fallback));
      return;
    }
    for (const value of values) {
      const item = node("div", "planner-reason-item");
      item.append(node("span", "planner-reason-mark", "•"), node("p", "", formatter(value)));
      target.append(item);
    }
  }

  function renderPreview() {
    const revision = model.preview?.baseRevision;
    $("#plannerPreviewRevision").textContent = model.preview ? (model.preview.stale ? "ข้อมูลเปลี่ยนแล้ว · สร้างใหม่" : "อ้างอิงข้อมูลล่าสุด") : "ยังไม่มี preview";
    const diffNode = $("#plannerPreviewDiff");
    diffNode.replaceChildren();
    if (!model.preview) {
      diffNode.append(emptyNode("สร้าง preview เพื่อดูงานที่ย้ายและเวลาที่เปลี่ยน"));
      $("#plannerApplyButton").disabled = true;
      $("#plannerApplyButton").textContent = "ยืนยันแผน";
      renderPreviewList($("#plannerReasonsList"), [], "ยังไม่มีเหตุผลจากกติกา");
      renderPreviewList($("#plannerUnscheduledList"), [], "ไม่มีรายการ");
      renderPreviewList($("#plannerConflictsList"), [], "ยังไม่มีข้อขัดแย้ง");
      return;
    }
    if (model.preview.stale || model.previewRevision !== model.revision) {
      diffNode.append(node("p", "planner-preview-stale", "ข้อมูลเปลี่ยนแล้ว · สร้าง preview ใหม่ก่อนยืนยัน"));
      $("#plannerApplyButton").disabled = true;
    } else {
      const diff = model.preview.diff || {};
      const changeCount = (name, fallback = 0) => {
        const value = diff[name];
        if (Array.isArray(value)) return value.length;
        if (Number.isFinite(Number(value))) return Number(value);
        return fallback;
      };
      const values = [
        ["ย้ายงาน", changeCount("moved", model.preview.movedTaskIds?.length || 0)],
        ["เปลี่ยนเวลา", changeCount("moved", model.preview.movedTaskIds?.length || 0)],
        ["เพิ่มบล็อก", changeCount("added")],
        ["นำออก", changeCount("removed")],
        ["สลับหมวดลดลง", model.preview.contextSwitches?.reduced ?? "—"],
      ];
      const grid = node("div", "planner-diff-grid");
      for (const [label, value] of values) {
        const card = node("div", "planner-diff-item");
        card.append(node("span", "", label), node("strong", "", value == null ? "—" : String(value)));
        grid.append(card);
      }
      diffNode.append(grid);
      $("#plannerApplyButton").disabled = false;
    }
    $("#plannerApplyButton").textContent = model.archivePending ? "ยืนยันเก็บถาวร" : "ยืนยันแผน";
    const reasonValues = model.preview.reasons.length ? model.preview.reasons : model.preview.blocks.map((block) => block?.reason).filter(Boolean);
    renderPreviewList($("#plannerReasonsList"), reasonValues, "ยังไม่มีเหตุผลจากกติกา", (value) => clean(typeof value === "string" ? value : value?.reason || value?.message || "ใช้กติกาจัดลำดับงาน"));
    renderPreviewList($("#plannerUnscheduledList"), model.preview.unscheduled, "ไม่มีรายการ", (value) => {
      const task = taskById(value?.taskId || value?.id);
      const reason = clean(value?.reason || value?.code || "ไม่สามารถวางในเวลาที่มี");
      return `${task ? taskTitle(task) : clean(value?.title || value?.taskId || "งานที่เลือก")} · ${reason}`;
    });
    renderPreviewList($("#plannerConflictsList"), model.preview.conflicts, "ยังไม่มีข้อขัดแย้ง", (value) => clean(typeof value === "string" ? value : value?.message || value?.reason || value?.code || "พบข้อขัดแย้งของเวลา"));
  }

  function renderTaskForm(task = null) {
    const form = $("#plannerTaskForm");
    if (!form || task) {
      $("#plannerTaskFormTitle").textContent = task ? "แก้ไขงาน" : "เพิ่มงาน";
    }
    $("#plannerTaskId").value = task?.id || "";
    $("#plannerTaskTitle").value = taskTitle(task).replace("งานไม่มีชื่อ", "");
    $("#plannerTaskNotes").value = clean(task?.notes);
    $("#plannerTaskPriority").value = String(clamp(task?.priority, 1, 5, 3));
    $("#plannerTaskDuration").value = task?.estimatedMinutes == null ? "" : String(task.estimatedMinutes);
    $("#plannerTaskEnergy").value = String(clamp(task?.energyDemand, 1, 5, 3));
    $("#plannerTaskDeadline").value = task?.deadline?.kind === "date" ? clean(task.deadline.date) : "";
    $("#plannerTaskCategory").value = clean(task?.category);
    $("#plannerTaskProject").value = clean(task?.project);
    $("#plannerTaskChecklist").value = taskChecklistText(task?.checklist);
    $("#plannerTaskCancelEdit").hidden = !task;
    $("#plannerTaskFormTitle").textContent = task ? "แก้ไขงาน" : "เพิ่มงาน";
  }

  function buildTaskInput(prefix = "plannerTask") {
    const title = clean($(`#${prefix}Title`)?.value);
    const notes = clean($(`#${prefix}Notes`)?.value);
    const priority = clamp($(`#${prefix}Priority`)?.value, 1, 5, 3);
    const duration = numberOrNull($(`#${prefix}Duration`)?.value);
    const energyDemand = clamp($(`#${prefix}Energy`)?.value, 1, 5, 3);
    const deadlineDate = clean($(`#${prefix}Deadline`)?.value);
    const category = clean($(`#${prefix}Category`)?.value);
    const project = clean($(`#${prefix}Project`)?.value);
    const checklistField = $(`#${prefix}Checklist`);
    const existing = prefix === "plannerTask" ? taskById($("#plannerTaskId").value)?.checklist : [];
    const checklist = String(checklistField?.value || "").split("\n").map((text, index) => ({
      id: clean(existing?.[index]?.id) || makeOperationId("check"),
      text: clean(text),
      done: Boolean(existing?.[index]?.done),
    })).filter((item) => item.text);
    return {
      title,
      notes,
      priority,
      estimatedMinutes: duration == null ? null : clamp(duration, 1, 1440, 25),
      energyDemand,
      category,
      project,
      deadline: DATE_RE.test(deadlineDate) ? { kind: "date", date: deadlineDate } : null,
      checklist,
    };
  }

  async function mutateTask(action, taskId, task) {
    if (!model.state) return;
    const body = {
      action,
      baseRevision: model.revision,
      operationId: makeOperationId(`task-${action}`),
    };
    if (action === "create") body.task = task;
    else {
      body.id = taskId;
      if (task) body.task = task;
    }
    setBusy("task", true);
    try {
      const result = await plannerFetch("tasks", { method: "POST", body });
      if (result?.preview) {
        model.preview = normalizePreview(result);
        model.previewRevision = model.revision;
        model.archivePending = action === "archive" ? { taskId, archivePreviewId: clean(result.archivePreviewId || model.preview.archivePreviewId) } : null;
        selectTab("today");
        renderPreview();
        notifyUser("งานนี้อยู่ในแผนอนาคต · ตรวจ preview การนำบล็อกออกก่อนยืนยัน");
      } else {
        markState(result);
        model.manualBlocks = [];
        model.manualBlocksActive = false;
        model.preview = null;
        model.previewRevision = null;
        model.archivePending = null;
        saveSyncSignal();
        notifyUser(action === "create" ? "บันทึกงานแล้ว" : "อัปเดตงานแล้ว");
      }
      return result;
    } catch (error) {
      const archivePreview = error?.payload?.preview;
      if (action === "archive" && archivePreview) {
        model.preview = normalizePreview({ preview: archivePreview });
        model.previewRevision = model.revision;
        model.archivePending = { taskId, archivePreviewId: clean(error.payload.archivePreviewId || archivePreview.previewId) };
        selectTab("today");
        renderAll();
        notifyUser("งานนี้อยู่ในแผนอนาคต · ตรวจ preview การนำบล็อกออกก่อนยืนยัน", "warning");
        return error.payload;
      }
      handleApiError(error, "บันทึกงาน");
      if (error?.status === 409) await loadState({ quiet: true });
      return null;
    } finally {
      setBusy("task", false);
    }
  }

  function renderTasks() {
    const list = $("#plannerTaskList");
    if (!list) return;
    const query = clean($("#plannerTaskSearch")?.value).toLowerCase();
    const status = $("#plannerTaskStatusFilter")?.value || "";
    const showArchived = Boolean($("#plannerShowArchived")?.checked);
    const all = taskListFromState(model.state);
    const tasks = all.filter((task) => {
      if (!showArchived && task?.archivedAt) return false;
      if (status && task?.status !== status) return false;
      if (!query) return true;
      const haystack = [task?.title, task?.notes, task?.category, task?.project, ...asArray(task?.checklist).map((item) => item?.text)].map(clean).join(" ").toLowerCase();
      return haystack.includes(query);
    });
    $("#plannerTaskCount").textContent = `${tasks.length} งาน`;
    list.replaceChildren();
    if (!tasks.length) {
      list.append(emptyNode(all.length ? "ไม่พบงานตามตัวกรอง" : "ยังไม่มีงาน · เริ่มจากแบบฟอร์มด้านบน"));
      return;
    }
    for (const task of tasks) {
      const card = node("article", `planner-task-card status-${clean(task?.status)}${task?.archivedAt ? " archived" : ""}`);
      const head = node("div", "planner-task-card-head");
      const copy = node("div", "planner-task-copy");
      copy.append(node("h3", "", taskTitle(task)));
      const labels = node("div", "planner-task-labels");
      labels.append(node("span", `planner-priority p${clamp(task?.priority, 1, 5, 3)}`, `P${clamp(task?.priority, 1, 5, 3)}`));
      labels.append(node("span", "planner-status-label", ({ todo: "ยังไม่เริ่ม", "in-progress": "กำลังทำ", completed: "เสร็จแล้ว" })[task?.status] || clean(task?.status)));
      if (task?.archivedAt) labels.append(node("span", "planner-status-label archived", "เก็บถาวรแล้ว"));
      if (task?.category) labels.append(node("span", "planner-label", task.category));
      if (task?.project) labels.append(node("span", "planner-label", task.project));
      copy.append(labels);
      const actions = node("div", "planner-task-actions");
      const edit = button("แก้ไข", "planner-inline-button", { taskAction: "edit", taskId: task.id });
      edit.setAttribute("aria-label", `แก้ไข ${taskTitle(task)}`);
      actions.append(edit);
      if (task?.status === "completed") actions.append(button("เปิดใหม่", "planner-inline-button", { taskAction: "reopen", taskId: task.id }));
      else actions.append(button("เสร็จแล้ว", "planner-inline-button", { taskAction: "complete", taskId: task.id }));
      if (!task?.archivedAt) actions.append(button("เก็บถาวร", "planner-inline-button danger", { taskAction: "archive", taskId: task.id }));
      head.append(copy, actions);
      card.append(head);
      if (task?.notes) card.append(node("p", "planner-task-notes", task.notes));
      const meta = node("p", "planner-task-meta");
      meta.textContent = [task?.estimatedMinutes ? formatMinutes(task.estimatedMinutes) : "ยังไม่ระบุเวลา", task?.deadline?.kind === "date" ? `ส่ง ${task.deadline.date}` : task?.deadline?.kind === "instant" ? `ส่ง ${formatInstant(task.deadline.at, currentTimeZone())}` : "ไม่มี deadline", `ใช้พลัง ${clamp(task?.energyDemand, 1, 5, 3)}/5`].join(" · ");
      card.append(meta);
      const checklist = asArray(task?.checklist);
      if (checklist.length) {
        const listNode = node("div", "planner-checklist");
        for (const item of checklist) {
          const label = node("label", "planner-check-item");
          const input = document.createElement("input");
          input.type = "checkbox";
          input.checked = Boolean(item?.done);
          input.dataset.taskAction = "checklist";
          input.dataset.taskId = task.id;
          input.dataset.checkId = clean(item?.id);
          input.setAttribute("aria-label", `ทำ ${clean(item?.text)}`);
          label.append(input, node("span", item?.done ? "done" : "", item?.text));
          listNode.append(label);
        }
        card.append(listNode);
      }
      list.append(card);
    }
  }

  function captureDraftEditor() {
    const task = model.draft?.tasks?.[model.draftIndex];
    if (!task || !$("#plannerDraftTitleInput")) return;
    const deadline = clean($("#plannerDraftDeadline").value);
    const existingChecklist = asArray(task.checklist);
    const checklist = String($("#plannerDraftChecklist").value || "").split("\n").map((text, index) => ({
      text: clean(text),
      done: Boolean(existingChecklist[index]?.done),
    })).filter((item) => item.text);
    model.draft.tasks[model.draftIndex] = {
      ...task,
      title: clean($("#plannerDraftTitleInput").value),
      notes: clean($("#plannerDraftNotesInput").value),
      priority: clamp($("#plannerDraftPriority").value, 1, 5, 3),
      estimatedMinutes: numberOrNull($("#plannerDraftDuration").value),
      energyDemand: clamp($("#plannerDraftEnergy").value, 1, 5, 3),
      deadline: DATE_RE.test(deadline) ? { kind: "date", date: deadline } : null,
      category: clean($("#plannerDraftCategory").value),
      project: clean($("#plannerDraftProject").value),
      checklist,
    };
  }

  function renderDraftSelection({ force = false } = {}) {
    const editor = $("#plannerDraftEditor");
    if (!editor) return;
    const old = $("#plannerDraftItems", editor);
    old?.remove();
    if (!model.draft?.tasks?.length) {
      editor.hidden = true;
      $("#plannerDraftState").textContent = "ยังไม่มี draft";
      return;
    }
    const selector = node("div", "planner-draft-items");
    selector.id = "plannerDraftItems";
    selector.setAttribute("role", "group");
    selector.setAttribute("aria-label", "เลือก draft ที่ต้องการตรวจ");
    model.draft.tasks.forEach((task, index) => {
      const choice = button(`${index + 1}. ${taskTitle(task) || "draft ไม่มีชื่อ"}`, `planner-draft-choice${index === model.draftIndex ? " active" : ""}`, { draftIndex: index });
      choice.setAttribute("aria-pressed", String(index === model.draftIndex));
      selector.append(choice);
    });
    editor.prepend(selector);
    const task = model.draft.tasks[model.draftIndex] || model.draft.tasks[0];
    if (force || !model.dirty.has("draft")) {
      $("#plannerDraftTitleInput").value = taskTitle(task).replace("งานไม่มีชื่อ", "");
      $("#plannerDraftNotesInput").value = clean(task?.notes);
      $("#plannerDraftPriority").value = String(clamp(task?.priority, 1, 5, 3));
      $("#plannerDraftDuration").value = task?.estimatedMinutes == null ? "" : String(task.estimatedMinutes);
      $("#plannerDraftEnergy").value = String(clamp(task?.energyDemand, 1, 5, 3));
      $("#plannerDraftDeadline").value = task?.deadline?.kind === "date" ? clean(task.deadline.date) : "";
      $("#plannerDraftCategory").value = clean(task?.category);
      $("#plannerDraftProject").value = clean(task?.project);
      $("#plannerDraftChecklist").value = taskChecklistText(task?.checklist);
    }
    editor.hidden = false;
    $("#plannerDraftState").textContent = model.draft.tasks.length > 1 ? `${model.draft.tasks.length} draft · ตรวจแล้วบันทึกเอง` : "ตรวจแล้วบันทึกเอง";
    if (model.draft.warnings.length) setStatus(`คำเตือนจาก draft: ${model.draft.warnings.join(" · ")}`, "warning");
  }

  function buildWhatIf() {
    const late = clamp($("#plannerLateMinutes")?.value, 0, 720, 0);
    const energy = numberOrNull($("#plannerWhatIfEnergy")?.value);
    const busyId = clean($("#plannerSkipBusyBlock")?.value);
    if (busyId) return { type: "skip-meeting", blockId: busyId, unlock: true };
    if (late > 0) return { type: "start-late", minutes: late };
    if (energy != null) return { type: "tired", energyLevel: clamp(energy, 1, 5, 3) };
    return null;
  }

  function buildPreviewBody(mode = $("#plannerModeSelect")?.value || "manual") {
    const normalizedMode = ["manual", "auto", "what-if"].includes(mode) ? mode : "manual";
    const body = {
      date: model.date,
      timeZone: currentTimeZone(),
      mode: normalizedMode,
      availability: parseAvailability(),
      taskIds: taskListFromState(model.state).filter((task) => !task?.archivedAt && task?.status !== "completed").map((task) => task.id),
    };
    if (normalizedMode === "manual") body.blocks = currentPreviewBlocks().map(localBlockFromPersisted);
    if (normalizedMode === "what-if") {
      body.whatIf = buildWhatIf();
      body.blocks = currentPreviewBlocks().map(localBlockFromPersisted);
    }
    return body;
  }

  async function createPreview(mode = $("#plannerModeSelect")?.value || "manual") {
    if (!model.state) await loadState({ quiet: true });
    if (!model.state) return null;
    const body = buildPreviewBody(mode);
    if (!body.date || !body.timeZone) return null;
    if (!isValidTimeZone(body.timeZone)) {
      notifyUser("เขตเวลาไม่ถูกต้อง · ใช้ชื่อ IANA เช่น Asia/Bangkok", "error");
      return null;
    }
    setBusy("preview", true);
    try {
      const result = await plannerFetch("plan/preview", { method: "POST", body });
      model.preview = normalizePreview(result);
      model.previewRevision = model.revision;
      model.archivePending = null;
      model.preview.stale = model.preview.baseRevision != null && model.preview.baseRevision !== model.revision;
      renderAll();
      notifyUser(model.preview.stale ? "ข้อมูลเปลี่ยนแล้ว · สร้าง preview ใหม่อีกครั้ง" : "สร้าง preview แล้ว · ตรวจเหตุผลและข้อขัดแย้งก่อนยืนยัน");
      return model.preview;
    } catch (error) {
      handleApiError(error, "สร้าง preview");
      return null;
    } finally {
      setBusy("preview", false);
    }
  }

  async function applyPreview() {
    if (!model.preview || model.preview.stale || model.previewRevision !== model.revision) {
      notifyUser("preview ล้าสมัย · สร้างใหม่ก่อนยืนยัน", "warning");
      return;
    }
    setBusy("apply", true);
    const archiveApply = Boolean(model.archivePending);
    try {
      const result = archiveApply
        ? await plannerFetch("tasks", {
          method: "POST",
          body: {
            action: "archive",
            id: model.archivePending.taskId,
            archivePreviewId: model.archivePending.archivePreviewId,
            baseRevision: model.revision,
            operationId: makeOperationId("task-archive"),
          },
        })
        : await plannerFetch("plan/apply", {
          method: "POST",
          body: { preview: model.preview, baseRevision: model.revision, operationId: makeOperationId("plan-apply") },
        });
      markState(result);
      model.preview = null;
      model.previewRevision = null;
      model.manualBlocks = [];
      model.manualBlocksActive = false;
      model.archivePending = null;
      renderAll();
      saveSyncSignal();
      notifyUser(archiveApply ? "ยืนยันเก็บถาวรแล้ว" : "ยืนยันแผนแล้ว");
    } catch (error) {
      handleApiError(error, "ยืนยันแผน");
      if (error?.status === 409) await loadState({ quiet: true });
    } finally {
      setBusy("apply", false);
    }
  }

  function addManualBlock(event) {
    event.preventDefault();
    const kind = $("#plannerBlockKind").value;
    const start = $("#plannerBlockStart").value;
    const end = $("#plannerBlockEnd").value;
    const startMinutes = parseTimeMinutes(start);
    const endMinutes = parseTimeMinutes(end);
    if (startMinutes == null || endMinutes == null || endMinutes <= startMinutes) {
      notifyUser("ช่วงเวลาบล็อกไม่ถูกต้อง · เวลาจบต้องมากกว่าเวลาเริ่ม", "error");
      return;
    }
    const taskId = kind === "task" ? $("#plannerBlockTask").value || null : null;
    if (kind === "task" && !taskId) {
      notifyUser("เลือกงานก่อนเพิ่มบล็อกประเภทงาน", "error");
      return;
    }
    const reason = clean($("#plannerBlockLabel").value) || (kind === "break" ? "พัก" : kind === "busy" ? "ไม่ว่าง" : "วางงานเอง");
    if (!model.manualBlocksActive) {
      model.manualBlocks = getAcceptedBlocks().map(localBlockFromPersisted);
      model.manualBlocksActive = true;
    }
    model.manualBlocks.push({
      id: makeOperationId("manual-block"),
      kind,
      taskId,
      start: localDateTimeToUtc(model.date, start, currentTimeZone()),
      end: localDateTimeToUtc(model.date, end, currentTimeZone()),
      locked: Boolean($("#plannerBlockLocked").checked),
      reason,
    });
    model.preview = null;
    model.previewRevision = null;
    $("#plannerBlockForm").reset();
    $("#plannerBlockKind").value = "task";
    renderAll();
    notifyUser("เพิ่มบล็อกในตัวอย่างแล้ว · กดดูตัวอย่างแผนเพื่อใช้กติกาตรวจซ้ำ");
  }

  function removeManualBlock(id) {
    model.manualBlocksActive = true;
    model.manualBlocks = model.manualBlocks.filter((block) => block.id !== id);
    model.preview = null;
    model.previewRevision = null;
    renderAll();
  }

  async function savePreferences(event) {
    event.preventDefault();
    const timeZone = clean($("#plannerTimeZoneInput").value);
    if (!isValidTimeZone(timeZone)) {
      notifyUser("เขตเวลาไม่ถูกต้อง · ใช้ชื่อ IANA เช่น Asia/Bangkok", "error");
      return;
    }
    const start = $("#plannerWorkStart").value;
    const end = $("#plannerWorkEnd").value;
    if (parseTimeMinutes(start) == null || parseTimeMinutes(end) == null || parseTimeMinutes(end) <= parseTimeMinutes(start)) {
      notifyUser("เวลาทำงานไม่ถูกต้อง · เวลาจบต้องมากกว่าเวลาเริ่ม", "error");
      return;
    }
    const existing = model.state?.preferences || {};
    const existingEveningEnd = asArray(existing.energyWindows)
      .find((window) => window?.period === "evening")?.end;
    const defaultEveningEnd = parseTimeMinutes(end) > parseTimeMinutes("17:00")
      ? end
      : parseTimeMinutes(existingEveningEnd) > parseTimeMinutes("17:00")
        ? existingEveningEnd
        : "21:00";
    const energyWindows = PERIODS.map((period) => {
      const startByPeriod = period === "morning" ? start : period === "afternoon" ? "12:00" : "17:00";
      const endByPeriod = period === "morning" ? "12:00" : period === "afternoon" ? "17:00" : defaultEveningEnd;
      const target = $(`#plannerEnergy${period[0].toUpperCase()}${period.slice(1)}`);
      return { period, start: startByPeriod, end: endByPeriod, level: clamp(target?.value, 1, 5, 3) };
    });
    const preferences = {
      ...existing,
      timeZone,
      workingHours: { start, end },
      energyWindows,
      dailyFocusTargetMinutes: clamp(existing.dailyFocusTargetMinutes, 1, 1440, 25),
      remindersEnabled: Boolean(existing.remindersEnabled),
    };
    setBusy("preferences", true);
    try {
      const result = await plannerFetch("preferences", { method: "POST", body: { preferences, baseRevision: model.revision, operationId: makeOperationId("preferences") } });
      markState(result);
      model.dirty.delete("preferences");
      saveSyncSignal();
      notifyUser("บันทึกค่าตั้งต้นแล้ว");
    } catch (error) {
      handleApiError(error, "บันทึกค่าตั้งต้น");
      if (error?.status === 409) await loadState({ quiet: true });
    } finally {
      setBusy("preferences", false);
    }
  }

  function focusSession() {
    const sessions = getFocusSessions(model.state);
    return sessions.find((session) => ["running", "paused", "interrupted"].includes(session?.state)) || sessions.at(-1) || null;
  }

  function intervalSeconds(session) {
    return asArray(session?.activeIntervals).reduce((sum, interval) => {
      const start = new Date(interval?.start).getTime();
      const end = new Date(interval?.end).getTime();
      return Number.isFinite(start) && Number.isFinite(end) && end > start ? sum + (end - start) / 1000 : sum;
    }, 0);
  }

  function displayedFocusSeconds(session) {
    if (!session) return 0;
    let seconds = intervalSeconds(session);
    if (session.state === "running" && session.currentStartedAt) {
      const started = new Date(session.currentStartedAt).getTime();
      if (Number.isFinite(started)) seconds += Math.max(0, Date.now() - started) / 1000;
    }
    const cap = Number(session.targetMinutes) > 0 ? Number(session.targetMinutes) * 60 : Infinity;
    return Math.min(cap, seconds);
  }

  function renderFocus() {
    const session = focusSession();
    const target = Number(session?.targetMinutes || 25);
    if (!model.dirty.has("focus")) $("#plannerFocusTarget").value = String(clamp(target, 1, 1440, 25));
    const seconds = displayedFocusSeconds(session);
    $("#plannerFocusClock").textContent = formatClock(session ? Math.max(0, target * 60 - seconds) : target * 60);
    $("#plannerFocusClockNote").textContent = session?.state === "running" ? "กำลังนับช่วงเวลาที่บันทึกได้" : "เวลาที่บันทึกได้";
    $("#plannerFocusState").textContent = session?.state ? ({ running: "RUNNING", paused: "PAUSED", interrupted: "INTERRUPTED", finished: "FINISHED", idle: "IDLE" })[session.state] || clean(session.state).toUpperCase() : "IDLE";
    const progress = target > 0 ? Math.min(100, (seconds / (target * 60)) * 100) : 0;
    $("#plannerFocusProgressBar").style.width = `${progress}%`;
    const linkedTask = session?.taskId ? taskById(session.taskId) : null;
    $("#plannerFocusMessage").textContent = session?.state === "interrupted"
      ? "ช่วงต่อเนื่องขาดหาย · เลือกต่อใหม่เพื่อเริ่มช่วงที่บันทึกได้ใหม่ หรือจบเฉพาะเวลาที่บันทึกไว้"
      : session?.state === "running" ? `ผูกกับ ${linkedTask ? taskTitle(linkedTask) : "ช่วงทั่วไป"} · อัปเดตทุก 15 วินาที`
        : session?.state === "paused" ? "พักอยู่ · เวลาช่วงพักจะไม่ถูกนับ"
          : session?.state === "finished" ? "จบ session แล้ว · การจบ session ไม่ได้ทำให้งานเสร็จอัตโนมัติ"
            : "ยังไม่มี session ที่กำลังทำงาน";
    $("#plannerFocusStart").disabled = Boolean(session && ["running", "paused", "interrupted"].includes(session.state)) || model.busy.has("focus");
    $("#plannerFocusPause").disabled = session?.state !== "running" || model.busy.has("focus");
    $("#plannerFocusResume").disabled = !["paused", "interrupted"].includes(session?.state) || model.busy.has("focus");
    $("#plannerFocusFinish").disabled = !["running", "paused", "interrupted"].includes(session?.state) || model.busy.has("focus");
    renderFocusHistory();
    renderCoaching();
  }

  function renderFocusHistory() {
    const list = $("#plannerFocusHistory");
    const sessions = getFocusSessions(model.state).slice().reverse().slice(0, 12);
    $("#plannerFocusSessionCount").textContent = `${sessions.length} ช่วง`;
    list.replaceChildren();
    if (!sessions.length) {
      list.append(emptyNode("ยังไม่มีช่วงโฟกัสที่บันทึก"));
      return;
    }
    for (const session of sessions) {
      const row = node("article", "planner-session-row");
      const task = session?.taskId ? taskById(session.taskId) : null;
      const duration = intervalSeconds(session) / 60;
      row.append(
        node("div", "planner-session-copy", task ? taskTitle(task) : "โฟกัสทั่วไป"),
        node("span", "planner-session-time", formatMinutes(duration, "0 นาที")),
        node("span", `planner-session-state ${clean(session?.state)}`, clean(session?.state).toUpperCase()),
        node("small", "planner-session-date", formatInstant(session?.startedAt, session?.timeZone || currentTimeZone())),
      );
      list.append(row);
    }
  }

  function heartbeatKey(sessionId) {
    return `rwang.planner.heartbeat.${clean(sessionId)}`;
  }

  function nextHeartbeatSequence(sessionId) {
    let current = model.focusSequence;
    try { current = Math.max(current, Number(localStorage.getItem(heartbeatKey(sessionId)) || 0)); } catch {}
    current += 1;
    model.focusSequence = current;
    try { localStorage.setItem(heartbeatKey(sessionId), String(current)); } catch {}
    return current;
  }

  async function heartbeatFocus() {
    const session = focusSession();
    if (!session || session.state !== "running" || !isLocal() || model.busy.has("focus-heartbeat")) return;
    const sequence = nextHeartbeatSequence(session.id);
    setBusy("focus-heartbeat", true);
    try {
      const result = await plannerFetch("focus", { method: "POST", body: { action: "heartbeat", sessionId: session.id, sequence } });
      if (result?.state) markState(result);
      else if (result) markState(result);
    } catch (error) {
      if (error?.status === 409) await loadState({ quiet: true });
      else if (model.active) setStatus("อัปเดตช่วงโฟกัสไม่สำเร็จ · ช่วงที่ยืนยันไม่ได้จะไม่ถูกนับ", "warning");
    } finally {
      setBusy("focus-heartbeat", false);
    }
  }

  function ensureHeartbeat() {
    const running = focusSession()?.state === "running";
    if (running && !model.heartbeatTimer) model.heartbeatTimer = setInterval(() => void heartbeatFocus(), HEARTBEAT_MS);
    if (!running && model.heartbeatTimer) {
      clearInterval(model.heartbeatTimer);
      model.heartbeatTimer = null;
    }
    if (!model.clockTimer) model.clockTimer = setInterval(() => {
      if (model.tab === "focus") renderFocus();
      if (model.tab === "today") renderSummary();
    }, 1000);
  }

  async function mutateFocus(action) {
    const session = focusSession();
    if (action !== "start" && !session?.id) {
      notifyUser("ยังไม่มี session ให้ดำเนินการ", "warning");
      return;
    }
    const body = {
      action,
      baseRevision: model.revision,
      operationId: makeOperationId(`focus-${action}`),
    };
    if (action === "start") {
      body.taskId = $("#plannerFocusTask").value || null;
      body.targetMinutes = clamp($("#plannerFocusTarget").value, 1, 1440, 25);
    } else body.sessionId = session.id;
    setBusy("focus", true);
    try {
      const result = await plannerFetch("focus", { method: "POST", body });
      markState(result);
      model.dirty.delete("focus");
      saveSyncSignal();
      notifyUser(action === "start" ? "เริ่มช่วงโฟกัสแล้ว" : action === "pause" ? "พักช่วงโฟกัสแล้ว" : action === "resume" ? "ต่อช่วงโฟกัสแล้ว" : "จบ session แล้ว");
    } catch (error) {
      handleApiError(error, "โฟกัส");
      if (error?.status === 409) await loadState({ quiet: true });
    } finally {
      setBusy("focus", false);
      ensureHeartbeat();
    }
  }

  function renderCoaching() {
    const enabled = Boolean(model.state?.preferences?.remindersEnabled);
    const toggle = $("#plannerCoachToggle");
    if (toggle && !model.dirty.has("coaching")) toggle.checked = enabled;
    $("#plannerCoachingState").textContent = enabled ? "เปิดอยู่" : "ปิดอยู่";
    const idleEnough = Date.now() - model.lastInteractionAt >= COACH_IDLE_MS;
    const running = focusSession()?.state === "running";
    const eligible = enabled && model.active && model.tab === "focus" && idleEnough && !running && !model.coachDismissed;
    $("#plannerCoachMessage").hidden = !eligible;
  }

  async function saveCoaching(event) {
    const enabled = Boolean(event.currentTarget.checked);
    model.dirty.add("coaching");
    const existing = model.state?.preferences || {};
    setBusy("coaching", true);
    try {
      const result = await plannerFetch("preferences", {
        method: "POST",
        body: {
          preferences: { ...existing, remindersEnabled: enabled },
          baseRevision: model.revision,
          operationId: makeOperationId("coaching"),
        },
      });
      markState(result);
      model.dirty.delete("coaching");
      model.coachDismissed = false;
      saveSyncSignal();
      notifyUser(enabled ? "เปิดการเตือนในแอปแล้ว" : "ปิดการเตือนในแอปแล้ว");
    } catch (error) {
      handleApiError(error, "บันทึกการเตือน");
      event.currentTarget.checked = !enabled;
    } finally {
      setBusy("coaching", false);
    }
  }

  function noteInteraction(event) {
    if (!event.target.closest("#planView")) return;
    model.lastInteractionAt = Date.now();
    model.coachDismissed = false;
  }

  function checkCoaching() {
    renderCoaching();
  }

  function renderMetric(target, value, missing = "—") {
    if (!target) return;
    if (value == null || value === "") target.textContent = missing;
    else if (typeof value === "number" && Number.isFinite(value)) target.textContent = String(Math.round(value * 10) / 10);
    else target.textContent = clean(value);
  }

  function normalizeHourly() {
    return model.insights.hourlyRhythm.map((item, index) => ({
      hour: clean(item?.hour ?? item?.startHour ?? item?.label ?? String(index).padStart(2, "0")),
      minutes: numberOrNull(item?.confirmedMinutes ?? item?.minutes ?? item?.value) ?? 0,
      days: numberOrNull(item?.daysWithData ?? item?.sampleDays ?? item?.days) ?? 0,
    }));
  }

  function normalizeWeekly() {
    const value = model.insights.weeklyProgress;
    if (Array.isArray(value)) return value.map((item) => ({
      label: clean(item?.label || item?.week || item?.period || "สัปดาห์"),
      minutes: numberOrNull(item?.confirmedFocusMinutes ?? item?.focusMinutes ?? item?.minutes) ?? 0,
      completed: numberOrNull(item?.tasksCompleted ?? item?.completed),
    }));
    if (value && typeof value === "object") {
      const hasExactWeeklyMinutes = Object.prototype.hasOwnProperty.call(value, "currentMinutes")
        || Object.prototype.hasOwnProperty.call(value, "previousMinutes");
      if (hasExactWeeklyMinutes) return [
        { label: "สัปดาห์ก่อน", minutes: numberOrNull(value.previousMinutes) ?? 0, completed: null },
        { label: "สัปดาห์นี้", minutes: numberOrNull(value.currentMinutes) ?? 0, completed: null },
      ];
      return ["previous", "current"].filter((key) => value[key] != null).map((key) => ({
        label: key === "current" ? "สัปดาห์นี้" : "สัปดาห์ก่อน",
        minutes: numberOrNull(value[key]?.confirmedFocusMinutes ?? value[key]?.focusMinutes ?? value[key]?.minutes) ?? 0,
        completed: numberOrNull(value[key]?.tasksCompleted ?? value[key]?.completed),
      }));
    }
    return [];
  }

  function renderChart(target, rows, ariaLabel) {
    target.replaceChildren();
    target.setAttribute("aria-label", ariaLabel);
    if (!rows.length || rows.every((row) => !row.minutes && !row.completed)) {
      target.append(emptyNode("ยังไม่มีข้อมูลที่ยืนยันได้"));
      return;
    }
    const max = Math.max(1, ...rows.map((row) => Math.max(numberOrNull(row.minutes) ?? 0, numberOrNull(row.completed) ?? 0)));
    for (const row of rows) {
      const item = node("div", "planner-chart-row");
      const label = node("span", "planner-chart-label", row.label || row.hour);
      const track = node("span", "planner-chart-track");
      const bar = node("span", "planner-chart-bar");
      const rowValue = Math.max(numberOrNull(row.minutes) ?? 0, numberOrNull(row.completed) ?? 0);
      bar.style.width = `${Math.min(100, (rowValue / max) * 100)}%`;
      bar.setAttribute("aria-hidden", "true");
      track.append(bar);
      const isMinutesRow = row.hour != null || row.days != null || (row.minutes != null && row.completed == null);
      const value = isMinutesRow
        ? `${formatMinutes(row.minutes, "0 นาที")}${row.days != null ? ` · ${row.days} วัน` : ""}`
        : row.completed == null ? "ยังไม่มีข้อมูล" : `${row.completed} งาน`;
      item.append(label, track, node("strong", "planner-chart-value", value));
      target.append(item);
    }
  }

  function insightSourceRecords(data) {
    const source = data?.sources || {};
    const taskIds = new Set();
    const sessionIds = new Set();
    const taskRecords = [];
    const sessionRecords = [];
    const collect = (value, set, records) => {
      for (const item of asArray(value)) {
        if (item && typeof item === "object") {
          const id = clean(item.id || item.taskId || item.sessionId);
          if (id) set.add(id);
          records.push(item);
        } else {
          const id = clean(item);
          if (id) set.add(id);
        }
      }
    };
    collect(source.tasks || source.taskIds, taskIds, taskRecords);
    collect(source.sessions || source.sessionIds || source.focusSessions, sessionIds, sessionRecords);
    for (const item of data?.sourceIds || []) {
      if (item && typeof item === "object") {
        const type = clean(item.type || item.kind).toLowerCase();
        const id = clean(item.id || item.taskId || item.sessionId);
        if (type.includes("session") || type.includes("focus")) sessionIds.add(id);
        else if (type.includes("task")) taskIds.add(id);
      } else {
        const id = clean(item);
        if (id) {
          if (getFocusSessions(model.state).some((session) => session.id === id)) sessionIds.add(id);
          else taskIds.add(id);
        }
      }
    }
    const tasks = taskListFromState(model.state).filter((task) => taskIds.has(task?.id));
    const sessions = getFocusSessions(model.state).filter((session) => sessionIds.has(session?.id));
    return {
      tasks: [...tasks, ...taskRecords.filter((item) => item?.title && !tasks.some((task) => task.id === item.id))],
      sessions: [...sessions, ...sessionRecords.filter((item) => item?.startedAt && !sessions.some((session) => session.id === item.id))],
      taskCount: taskIds.size,
      sessionCount: sessionIds.size,
    };
  }

  function renderInsightSources(data) {
    const records = insightSourceRecords(data);
    const taskTarget = $("#plannerInsightTaskSources");
    const sessionTarget = $("#plannerSessionSources");
    taskTarget.replaceChildren();
    sessionTarget.replaceChildren();
    if (!records.tasks.length) taskTarget.append(emptyNode(records.taskCount ? "ไม่พบรายละเอียดงานต้นทางในข้อมูลที่โหลด" : "ยังไม่มีรายการต้นทาง"));
    else for (const task of records.tasks.slice(0, 20)) {
      const item = node("div", "planner-source-item");
      item.append(node("strong", "", taskTitle(task)), node("small", "", `${clean(task.status || "งาน")} · ${task?.estimatedMinutes ? formatMinutes(task.estimatedMinutes) : "ยังไม่ระบุเวลา"}`));
      taskTarget.append(item);
    }
    if (!records.sessions.length) sessionTarget.append(emptyNode(records.sessionCount ? "ไม่พบรายละเอียดช่วงโฟกัสต้นทางในข้อมูลที่โหลด" : "ยังไม่มีรายการต้นทาง"));
    else for (const session of records.sessions.slice(0, 20)) {
      const item = node("div", "planner-source-item");
      const title = session.taskId ? taskTitle(taskById(session.taskId)) : "โฟกัสทั่วไป";
      item.append(node("strong", "", title), node("small", "", `${formatMinutes(intervalSeconds(session) / 60, "0 นาที")} · ${formatInstant(session.startedAt, session.timeZone || currentTimeZone())}`));
      sessionTarget.append(item);
    }
  }

  function renderInsights() {
    const data = model.insights;
    if (!data) return;
    const metrics = data.metrics || {};
    const tasksToday = metricValue(metrics, ["tasksToday.total", "tasks_today.total", "tasksToday"]);
    const tasksCompleted = metricValue(metrics, ["tasksCompleted.count", "tasks_completed.count", "tasksCompleted"]);
    const planCompletion = metricValue(metrics, ["planCompletion.percent", "plan_completion.percent", "planCompletion"]);
    const focusMinutes = metricValue(metrics, ["focusTime.confirmedMinutes", "confirmedFocusMinutes", "focusMinutes"]);
    const targetProgress = metricValue(metrics, ["focusTargetProgress.percent", "targetProgress", "focusTargetProgress"]);
    const streak = metricValue(metrics, ["focusStreak.days", "streak", "focusStreakDays"]);
    renderMetric($("#plannerInsightTasksToday"), tasksToday, "0");
    renderMetric($("#plannerInsightTasksCompleted"), tasksCompleted, "0");
    renderMetric($("#plannerInsightPlanCompletion"), planCompletion == null ? null : `${Math.round(Number(planCompletion) * 10) / 10}%`);
    renderMetric($("#plannerInsightFocusMinutes"), focusMinutes == null ? null : formatMinutes(focusMinutes, "0 นาที"));
    renderMetric($("#plannerInsightTargetProgress"), targetProgress == null ? null : `${Math.round(Number(targetProgress) * 10) / 10}%`);
    renderMetric($("#plannerInsightStreak"), streak == null ? null : `${Math.round(Number(streak))} วัน`);
    $("#plannerInsightPlanCompletionNote").textContent = metricReason(metrics, ["planCompletion", "plan_completion"], planCompletion == null ? "ยังไม่มีงานในแผน" : "งานเสร็จ / งานในแผน");
    const tasksTodayDate = data.referenceDate || metrics.tasksToday?.date || metrics.tasksToday?.day || data.tasksTodayDate || data.range?.from || data.range?.start;
    $("#plannerInsightTasksTodayNote").textContent = tasksTodayDate ? `แผนวันที่ ${clean(tasksTodayDate)}` : "ช่วงที่เลือก";
    $("#plannerInsightTasksCompletedNote").textContent = metricReason(metrics, ["tasksCompleted", "tasks_completed"], "นับจากงานที่ทำเสร็จในช่วง · เปิดงานใหม่จะปรับยอดช่วงนั้น");
    $("#plannerInsightFocusMinutesNote").textContent = "รวมช่วงเวลาที่บันทึกได้";
    $("#plannerInsightTargetProgressNote").textContent = metricReason(metrics, ["targetProgress", "focusTargetProgress"], "เป้าหมายโฟกัสรายวัน");
    $("#plannerInsightStreakNote").textContent = metricReason(metrics, ["streak", "focusStreak", "focusStreakDays"], "อย่างน้อย 5 นาทีต่อวัน");
    const zone = clean(data.timeZone || data.zone || currentTimeZone());
    $("#plannerInsightsZone").textContent = timeZoneLabel(zone);
    const computed = data.computedAt ? `คำนวณ ${formatInstant(data.computedAt, zone)}` : "ยังไม่ระบุเวลาคำนวณ";
    const range = data.range ? `${clean(data.range.from || data.range.start || "")} → ${clean(data.range.to || data.range.end || "")}` : "ช่วงที่เลือก";
    $("#plannerInsightsMeta").textContent = `${range} · ${zone} · ${computed}`;
    const sampleLabels = { days: "วันในช่วง", sessions: "ช่วงโฟกัส", distinctSessionDays: "วันที่มีโฟกัส" };
    const sample = typeof data.sampleSize === "object" ? Object.entries(data.sampleSize).map(([key, value]) => `${sampleLabels[key] || "ตัวอย่าง"} ${clean(value)}`).join(" · ") : data.sampleSize == null ? "0 ตัวอย่างที่ระบุ" : `${data.sampleSize} ตัวอย่าง`;
    $("#plannerInsightsSamples").textContent = sample;
    const sources = data.sourceIds.length ? `แหล่งข้อมูล ${data.sourceIds.length} รายการ` : "ยังไม่มีรายการต้นทางจากข้อมูลชุดนี้";
    $("#plannerInsightsProvenance").textContent = `${clean(data.provenance || "คำนวณจากแผนงาน, วันที่เสร็จ และช่วงโฟกัสที่บันทึกได้")} · ${sources}`;
    renderInsightSources(data);
    const hourly = normalizeHourly();
    renderChart($("#plannerHourlyChart"), hourly, "กราฟเวลาโฟกัสรายชั่วโมง");
    const hourlyTable = $("#plannerHourlyTable");
    hourlyTable.replaceChildren();
    if (!hourly.length) hourlyTable.append(node("tr", "", "ยังไม่มีข้อมูล"));
    else for (const row of hourly) {
      const tr = document.createElement("tr");
      tr.append(node("td", "", row.hour), node("td", "", formatMinutes(row.minutes, "0 นาที")), node("td", "", String(row.days)));
      hourlyTable.append(tr);
    }
    const weekly = normalizeWeekly();
    renderChart($("#plannerWeeklyChart"), weekly, "กราฟความคืบหน้ารายสัปดาห์");
    const weeklyTable = $("#plannerWeeklyTable");
    weeklyTable.replaceChildren();
    if (!weekly.length) weeklyTable.append(node("tr", "", "ยังไม่มีข้อมูล"));
    else for (const row of weekly) {
      const tr = document.createElement("tr");
      tr.append(node("td", "", row.label), node("td", "", formatMinutes(row.minutes, "0 นาที")));
      weeklyTable.append(tr);
    }
    const change = metricValue(metrics, ["weeklyProgress.changePercent", "changePercentage.percent", "changePercent"]);
    $("#plannerWeeklyChange").textContent = change == null ? "ยังไม่มีฐานเปรียบเทียบ" : `${Number(change) > 0 ? "+" : ""}${Math.round(Number(change) * 10) / 10}%`;
  }

  async function loadInsights(event) {
    event?.preventDefault();
    if (!isLocal()) return;
    const from = clean($("#plannerInsightsFrom")?.value);
    const to = clean($("#plannerInsightsTo")?.value);
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
      notifyUser("ช่วงวันที่สถิติไม่ถูกต้อง", "error");
      return;
    }
    setBusy("insights", true);
    try {
      const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&timeZone=${encodeURIComponent(currentTimeZone())}`;
      const result = await plannerFetch(`insights?${query}`);
      model.insights = normalizeInsights(result);
      renderInsights();
      setStatus("คำนวณสถิติตามช่วงวันที่เลือกแล้ว");
    } catch (error) {
      handleApiError(error, "โหลดสถิติ");
    } finally {
      setBusy("insights", false);
    }
  }

  function defaultInsightDates() {
    const zone = currentTimeZone();
    const to = todayInZone(zone);
    $("#plannerInsightsFrom").value = shiftDate(to, -6, zone);
    $("#plannerInsightsTo").value = to;
  }

  function selectTab(tab, { focus = false } = {}) {
    const target = TAB_NAMES.includes(tab) ? tab : "today";
    model.tab = target;
    for (const name of TAB_NAMES) {
      const buttonNode = $(`[data-planner-tab="${name}"]`);
      const panel = $(`#plannerPanel${name[0].toUpperCase()}${name.slice(1)}`);
      const active = name === target;
      buttonNode?.classList.toggle("active", active);
      buttonNode?.setAttribute("aria-selected", String(active));
      if (panel) {
        panel.hidden = !active;
        panel.classList.toggle("active", active);
      }
    }
    if (focus) $(`[data-planner-tab="${target}"]`)?.focus();
    if (target === "insights") {
      if (!$("#plannerInsightsFrom").value) defaultInsightDates();
      if (!model.insights) void loadInsights();
    }
    if (target === "focus") renderFocus();
  }

  function handleTabKey(event) {
    if (!event.target.matches("[data-planner-tab]")) return;
    const index = TAB_NAMES.indexOf(event.target.dataset.plannerTab);
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      selectTab(TAB_NAMES[(index + 1) % TAB_NAMES.length], { focus: true });
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      selectTab(TAB_NAMES[(index - 1 + TAB_NAMES.length) % TAB_NAMES.length], { focus: true });
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      selectTab(event.key === "Home" ? TAB_NAMES[0] : TAB_NAMES.at(-1), { focus: true });
    }
  }

  function bindEvents() {
    $("#plannerTabs").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-planner-tab]")?.dataset.plannerTab;
      if (tab) selectTab(tab);
    });
    $("#plannerTabs").addEventListener("keydown", handleTabKey);
    $("#plannerPrevDate").addEventListener("click", () => changeDate(-1));
    $("#plannerNextDate").addEventListener("click", () => changeDate(1));
    $("#plannerTodayButton").addEventListener("click", () => { model.dateTouched = true; model.date = todayInZone(currentTimeZone()); resetPreviewForDateChange(); });
    $("#plannerDateInput").addEventListener("change", (event) => { if (DATE_RE.test(event.currentTarget.value)) { model.dateTouched = true; model.date = event.currentTarget.value; resetPreviewForDateChange(); } });
    $("#plannerModeSelect").addEventListener("change", (event) => { if (event.currentTarget.value === "what-if") $("#plannerWhatIfWarning").hidden = false; else $("#plannerWhatIfWarning").hidden = true; });
    $("#plannerPreviewButton").addEventListener("click", () => void createPreview());
    $("#plannerRebuildButton").addEventListener("click", () => { $("#plannerModeSelect").value = "auto"; void createPreview("auto"); });
    $("#plannerApplyButton").addEventListener("click", () => void applyPreview());
    $("#plannerWhatIfButton").addEventListener("click", () => { $("#plannerModeSelect").value = "what-if"; $("#plannerWhatIfWarning").hidden = false; void createPreview("what-if"); });
    $("#plannerPreferencesForm").addEventListener("submit", savePreferences);
    for (const id of ["plannerTimeZoneInput", "plannerWorkStart", "plannerWorkEnd", "plannerEnergyMorning", "plannerEnergyAfternoon", "plannerEnergyEvening"]) $(`#${id}`).addEventListener("input", () => model.dirty.add("preferences"));
    $("#plannerAvailabilityInput").addEventListener("input", () => model.dirty.add("availability"));
    $("#plannerBlockForm").addEventListener("submit", addManualBlock);
    $("#plannerBlockList").addEventListener("click", (event) => {
      const remove = event.target.closest('[data-block-action="remove"]');
      if (remove) removeManualBlock(remove.dataset.blockId);
    });
    $("#plannerTaskForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const task = buildTaskInput();
      if (!task.title) { notifyUser("ใส่ชื่องานก่อนบันทึก", "error"); return; }
      const id = $("#plannerTaskId").value;
      const result = await mutateTask(id ? "update" : "create", id, task);
      if (result?.state || (!result?.preview && result)) {
        renderTaskForm();
        model.dirty.delete("task");
      }
    });
    $("#plannerTaskReset").addEventListener("click", () => { renderTaskForm(); model.dirty.delete("task"); });
    $("#plannerTaskCancelEdit").addEventListener("click", () => { renderTaskForm(); model.dirty.delete("task"); });
    for (const field of $$("#plannerTaskForm input, #plannerTaskForm textarea, #plannerTaskForm select")) field.addEventListener("input", () => model.dirty.add("task"));
    $("#plannerTaskList").addEventListener("click", (event) => void handleTaskListClick(event));
    $("#plannerTaskList").addEventListener("change", (event) => void handleTaskListChange(event));
    $("#plannerTaskSearch").addEventListener("input", renderTasks);
    $("#plannerTaskStatusFilter").addEventListener("change", renderTasks);
    $("#plannerShowArchived").addEventListener("change", renderTasks);
    $("#plannerDraftForm").addEventListener("submit", (event) => void createDraft(event));
    $("#plannerDraftEditor").addEventListener("click", (event) => {
      const choice = event.target.closest("[data-draft-index]");
      if (choice) {
        captureDraftEditor();
        model.draftIndex = Number(choice.dataset.draftIndex);
        model.dirty.add("draft");
        renderDraftSelection({ force: true });
        return;
      }
      if (event.target.closest("#plannerDraftDiscard")) { model.draft = null; model.dirty.delete("draft"); renderDraftSelection(); }
    });
    $("#plannerDraftEditor").addEventListener("submit", (event) => void saveDraftTask(event));
    const draftEditor = $("#plannerDraftEditor");
    for (const field of draftEditor ? $$("input, textarea, select", draftEditor) : []) field.addEventListener("input", () => model.dirty.add("draft"));
    $("#plannerFocusTask").addEventListener("change", () => model.dirty.add("focus"));
    $("#plannerFocusTarget").addEventListener("input", () => model.dirty.add("focus"));
    $("#plannerFocusStart").addEventListener("click", () => void mutateFocus("start"));
    $("#plannerFocusPause").addEventListener("click", () => void mutateFocus("pause"));
    $("#plannerFocusResume").addEventListener("click", () => void mutateFocus("resume"));
    $("#plannerFocusFinish").addEventListener("click", () => void mutateFocus("finish"));
    $("#plannerCoachToggle").addEventListener("change", saveCoaching);
    $("#plannerCoachDismiss").addEventListener("click", () => { model.coachDismissed = true; $("#plannerCoachMessage").hidden = true; });
    $("#plannerInsightsForm").addEventListener("submit", (event) => void loadInsights(event));
    document.addEventListener("pointerdown", noteInteraction, { passive: true });
    document.addEventListener("keydown", noteInteraction);
    window.addEventListener("storage", (event) => {
      if (event.key !== model.storageKey || !model.active || !isLocal()) return;
      void loadState({ quiet: true });
    });
    try {
      if ("BroadcastChannel" in window) {
        model.channel = new BroadcastChannel("rwang-planner");
        model.channel.addEventListener("message", (event) => {
          if (event.data?.type === "state-changed" && model.active && isLocal()) void loadState({ quiet: true });
        });
      }
    } catch {}
  }

  async function handleTaskListClick(event) {
    const buttonNode = event.target.closest("[data-task-action]");
    if (!buttonNode || buttonNode.matches("input")) return;
    const task = taskById(buttonNode.dataset.taskId);
    if (!task) return;
    const action = buttonNode.dataset.taskAction;
    if (action === "edit") {
      selectTab("tasks");
      renderTaskForm(task);
      model.dirty.delete("task");
      $("#plannerTaskTitle").focus();
    } else if (["complete", "reopen", "archive"].includes(action)) {
      await mutateTask(action, task.id);
      renderTasks();
    }
  }

  async function handleTaskListChange(event) {
    const input = event.target.closest('input[data-task-action="checklist"]');
    if (!input) return;
    const task = taskById(input.dataset.taskId);
    if (!task) return;
    const checklist = asArray(task.checklist).map((item) => item?.id === input.dataset.checkId ? { ...item, done: input.checked } : item);
    await mutateTask("update", task.id, { checklist });
  }

  async function createDraft(event) {
    event.preventDefault();
    const prompt = clean($("#plannerDraftPrompt").value);
    if (!prompt) { notifyUser("ใส่ข้อความตั้งต้นก่อนสร้าง draft", "error"); return; }
    const submit = $("#plannerDraftSubmit");
    const previousLabel = submit.textContent;
    submit.disabled = true;
    submit.textContent = "กำลังสร้าง draft…";
    $("#plannerDraftState").textContent = "กำลังสร้าง…";
    setStatus("กำลังให้ Ollama ช่วยร่างงาน · รอผลลัพธ์ที่ตรวจสอบได้", "info");
    setBusy("draft", true);
    try {
      const result = await plannerFetch("draft", { method: "POST", body: { prompt, model: $("#plannerDraftModel").value || undefined, timeZone: currentTimeZone() } });
      model.draft = normalizeDraft(result);
      model.draftIndex = 0;
      model.dirty.delete("draft");
      renderDraftSelection();
      notifyUser(model.draft.tasks.length ? "สร้าง draft แล้ว · ตรวจแก้ก่อนบันทึก" : "โมเดลไม่ส่ง draft ที่ใช้ได้", model.draft.tasks.length ? "" : "warning");
    } catch (error) {
      handleApiError(error, "สร้าง draft");
      $("#plannerDraftState").textContent = "ยังไม่มี draft";
    } finally {
      setBusy("draft", false);
      submit.disabled = false;
      submit.textContent = previousLabel;
    }
  }

  async function saveDraftTask(event) {
    event.preventDefault();
    const title = clean($("#plannerDraftTitleInput").value);
    if (!title) { notifyUser("แก้ชื่อ draft ให้เรียบร้อยก่อนบันทึก", "error"); return; }
    const task = {
      title,
      notes: clean($("#plannerDraftNotesInput").value),
      priority: clamp($("#plannerDraftPriority").value, 1, 5, 3),
      estimatedMinutes: numberOrNull($("#plannerDraftDuration").value),
      energyDemand: clamp($("#plannerDraftEnergy").value, 1, 5, 3),
      category: clean($("#plannerDraftCategory").value),
      project: clean($("#plannerDraftProject").value),
      deadline: DATE_RE.test($("#plannerDraftDeadline").value) ? { kind: "date", date: $("#plannerDraftDeadline").value } : null,
      checklist: String($("#plannerDraftChecklist").value || "").split("\n").map((text) => ({ id: makeOperationId("draft-check"), text: clean(text), done: false })).filter((item) => item.text),
    };
    const result = await mutateTask("create", "", task);
    if (result?.state) {
      const savedIndex = Math.max(0, Math.min(model.draftIndex, model.draft.tasks.length - 1));
      const remaining = model.draft.tasks.filter((_, index) => index !== savedIndex);
      model.draft = remaining.length ? { ...model.draft, tasks: remaining } : null;
      model.draftIndex = remaining.length ? Math.min(savedIndex, remaining.length - 1) : 0;
      model.dirty.delete("draft");
      renderDraftSelection();
      $("#plannerDraftForm").reset();
      notifyUser(remaining.length ? "บันทึกงานแล้ว · ตรวจ draft ถัดไป" : "บันทึกงานแล้ว");
    }
  }

  function changeDate(amount) {
    model.dateTouched = true;
    model.date = shiftDate(model.date || todayInZone(currentTimeZone()), amount, currentTimeZone());
    resetPreviewForDateChange();
  }

  function resetPreviewForDateChange() {
    model.manualBlocks = [];
    model.manualBlocksActive = false;
    model.preview = null;
    model.previewRevision = null;
    model.archivePending = null;
    renderAll();
    setStatus("เปลี่ยนวันแล้ว · สร้าง preview ใหม่เพื่อดูผล");
  }

  function renderAll() {
    if (!model.initialized) return;
    renderHostState();
    if (!model.date) model.date = todayInZone(currentTimeZone());
    $("#plannerDateInput").value = model.date;
    renderRevision();
    renderPreferences();
    renderSummary();
    renderTaskOptions();
    renderBlocks();
    renderPreview();
    renderTasks();
    renderFocus();
    renderDraftSelection();
    if (model.insights) renderInsights();
  }

  function startStateRefresh() {
    if (model.stateTimer) return;
    model.stateTimer = setInterval(() => {
      if (model.active && isLocal() && !document.hidden) void loadState({ quiet: true });
    }, STATE_REFRESH_MS);
  }

  function stopStateRefresh() {
    if (!model.stateTimer) return;
    clearInterval(model.stateTimer);
    model.stateTimer = null;
  }

  async function activate() {
    model.active = true;
    renderHostState();
    if (!isLocal()) return;
    startStateRefresh();
    if (!model.state) await loadState({ quiet: true });
    ensureHeartbeat();
    if (model.tab === "insights" && !model.insights) void loadInsights();
  }

  function deactivate() {
    model.active = false;
    stopStateRefresh();
  }

  function destroy() {
    deactivate();
    if (model.clockTimer) clearInterval(model.clockTimer);
    if (model.heartbeatTimer) clearInterval(model.heartbeatTimer);
    if (model.coachTimer) clearInterval(model.coachTimer);
    model.channel?.close?.();
    document.removeEventListener("pointerdown", noteInteraction);
    document.removeEventListener("keydown", noteInteraction);
  }

  const controller = {
    init() {
      if (model.initialized) return controller;
      model.initialized = true;
      model.date = todayInZone(currentTimeZone());
      bindEvents();
      defaultInsightDates();
      model.coachTimer = setInterval(checkCoaching, 60_000);
      renderAll();
      return controller;
    },
    setContext,
    activate,
    deactivate,
    refresh: loadState,
    destroy,
    isLocal: () => model.local === true,
  };
  return controller;
}
