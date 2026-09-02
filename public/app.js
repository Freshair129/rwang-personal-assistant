import { createPerceptionController } from "./perception.js";
import { createRemoteController } from "./remote-client.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const STORAGE_WAKE = "rwang.wake-mode";
const STORAGE_AUTO_SPEAK = "rwang.auto-speak";
const STORAGE_PERCEPTION_THRESHOLD = "rwang.perception-threshold";
const STORAGE_PRESENCE_REQUIRED = "rwang.presence-required";
const CORE_CLASSES = ["listening", "thinking", "speaking", "error"];

const state = {
  accessToken: "",
  status: null,
  rwang: null,
  chatHistory: [],
  chatController: null,
  chatBusy: false,
  eventSource: null,
  recognition: null,
  voiceMode: null,
  recognitionStarting: false,
  recognitionRestartTimer: null,
  wakeResume: false,
  deferredInstall: null,
  toastTimer: null,
  perception: null,
  perceptionState: null,
  remote: null,
  remoteState: null,
  pairingCode: "",
  pairingExpiresAt: "",
  lastFace: null,
  lastVoiceprint: null,
  faceVerifyBusy: false,
};

class ApiError extends Error {
  constructor(message, status = 0, payload = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

function readStorage(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeStorage(key, value) {
  try {
    if (value === "" || value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {}
}

function scrubLegacyAccessToken() {
  const url = new URL(window.location.href);
  const hadLegacyQuery = url.searchParams.has("token") || url.searchParams.has("accessToken");
  url.searchParams.delete("token");
  url.searchParams.delete("accessToken");
  writeStorage("rwang.access-token", "");
  if (hadLegacyQuery) {
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
}

function authHeaders(extra = {}) {
  const headers = new Headers(extra);
  if (state.accessToken) headers.set("x-rwang-token", state.accessToken);
  return headers;
}

async function apiFetch(path, options = {}) {
  const request = { ...options, headers: authHeaders(options.headers) };
  if (request.body && typeof request.body !== "string") {
    request.headers.set("content-type", "application/json");
    request.body = JSON.stringify(request.body);
  }
  const response = await fetch(path, request);
  const contentType = response.headers.get("content-type") || "";
  let payload = null;
  if (contentType.includes("json")) {
    payload = await response.json().catch(() => null);
  } else {
    payload = await response.text().catch(() => "");
  }
  if (!response.ok) {
    const message = payload?.error || payload?.message || (typeof payload === "string" && payload) || `HTTP ${response.status}`;
    throw new ApiError(message, response.status, payload);
  }
  return payload;
}

function showToast(message, duration = 3200) {
  const toast = $("#toast");
  toast.textContent = String(message || "");
  toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), duration);
}

function setCore(mode = "standby", label, sub) {
  const core = $("#micButton");
  core.classList.remove(...CORE_CLASSES);
  if (CORE_CLASSES.includes(mode)) core.classList.add(mode);
  const names = {
    standby: "STANDBY",
    listening: "LISTENING",
    thinking: "THINKING",
    speaking: "SPEAKING",
    error: "CHECK VOICE",
  };
  $("#coreState").textContent = names[mode] || String(mode).toUpperCase();
  $("#micLabel").textContent = label || {
    standby: "แตะวงแหวนเพื่อพูด",
    listening: "กำลังฟัง...",
    thinking: "อาหวังกำลังคิด...",
    speaking: "อาหวังกำลังตอบ...",
    error: "ไม่สามารถเปิดไมค์ได้",
  }[mode];
  if (sub) $("#coreSub").textContent = sub;
  $("#composerMic").classList.toggle("active", mode === "listening");
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / 1024 ** index;
  return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatSpeed(value) {
  return Number(value || 0) > 0 ? `${formatBytes(value)}/s` : "—";
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
}

function shortName(model = "") {
  const tail = String(model).split("/").at(-1) || String(model);
  return tail.length > 66 ? `${tail.slice(0, 63)}…` : tail;
}

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function createButton(text, className = "", data = {}) {
  const button = createElement("button", className, text);
  button.type = "button";
  for (const [key, value] of Object.entries(data)) button.dataset[key] = value;
  return button;
}

function setDot(node, tone) {
  node.className = "";
  if (tone) node.classList.add(tone);
}

function integrationTone(integration) {
  if (!integration?.enabled) return "";
  if (integration.state === "online") return "online";
  if (["unknown", "approval-required"].includes(integration.state)) return "warn";
  if (integration.state === "error") return "error";
  return integration.configured ? "warn" : "";
}

function renderHeader(status) {
  const connection = $("#connection");
  connection.classList.toggle("online", Boolean(status.online));
  connection.classList.toggle("offline", !status.online);
  $("#ollamaState").textContent = status.online ? "OLLAMA ONLINE" : "OLLAMA OFFLINE";
  $("#versionLabel").textContent = `OLLAMA ${status.version || "—"}`;
  $("#secureLabel").textContent = window.isSecureContext ? "SECURE LOCAL" : state.rwang?.access?.local ? "LOCAL" : "LAN HTTP";
}

function modelName(model) {
  return model?.name || model?.model || "";
}

function syncModelSelects(status) {
  const models = status.installed || [];
  const names = models.map(modelName).filter(Boolean);
  const signature = names.join("\n");
  const chatSelect = $("#modelSelect");
  const defaultSelect = $("#defaultModelInput");
  if (chatSelect.dataset.signature !== signature) {
    const previous = chatSelect.value;
    chatSelect.replaceChildren();
    if (!names.length) {
      const option = new Option("ยังไม่มีโมเดลในเครื่อง", "");
      chatSelect.add(option);
    } else {
      for (const name of names) chatSelect.add(new Option(shortName(name), name));
    }
    const preferred = [previous, state.rwang?.identity?.defaultModel, modelName(status.running?.[0]), names[0]].find((name) => names.includes(name));
    chatSelect.value = preferred || "";
    chatSelect.dataset.signature = signature;
  }
  if (defaultSelect.dataset.signature !== signature) {
    defaultSelect.replaceChildren(new Option("ใช้โมเดลที่เลือกในหน้าคุย", ""));
    for (const name of names) defaultSelect.add(new Option(shortName(name), name));
    defaultSelect.dataset.signature = signature;
  }
  if (!$("#settingsDialog").open) {
    defaultSelect.value = names.includes(state.rwang?.identity?.defaultModel) ? state.rwang.identity.defaultModel : "";
  }
}

function renderIntegrations(rwang) {
  const ha = rwang.homeAssistant || {};
  $("#haStatus").textContent = ha.state === "online"
    ? ha.message || "เชื่อมต่อแล้ว"
    : ha.enabled ? ha.message || (ha.configured ? "รอทดสอบ" : "ตั้งค่าไม่ครบ") : "ยังไม่เปิดใช้";
  setDot($("#haDot"), integrationTone(ha));

  const servers = rwang.mcpServers || [];
  const online = servers.filter((server) => server.state === "online").length;
  const needsTrust = servers.filter((server) => server.state === "approval-required").length;
  $("#mcpStatus").textContent = needsTrust
    ? `${needsTrust} server รอ Trust`
    : servers.length ? `${online}/${servers.length} servers online` : "0 servers";
  setDot($("#mcpDot"), needsTrust ? "warn" : online ? "online" : servers.some((server) => server.state === "error") ? "error" : "");

  const access = rwang.access || {};
  if (access.local) {
    $("#mobileStatus").textContent = access.lanUrls?.length ? `${access.lanUrls.length} LAN address พร้อมใช้` : "ไม่พบ LAN address";
    setDot($("#mobileDot"), access.lanUrls?.length ? "online" : "warn");
  } else {
    $("#mobileStatus").textContent = "เชื่อมต่อจาก Mobile แล้ว";
    setDot($("#mobileDot"), "online");
  }
}

function renderApprovals(approvals = []) {
  const visible = approvals.filter((item) => ["pending", "executing"].includes(item.status));
  const section = $("#approvalSection");
  section.hidden = visible.length === 0;
  $("#approvalCount").textContent = String(visible.length);
  const list = $("#approvalList");
  list.replaceChildren();
  for (const item of visible) {
    const card = createElement("article", `approval-card${item.risk === "high" ? " high" : ""}`);
    const copy = createElement("div");
    copy.append(createElement("strong", "", item.label || item.kind));
    copy.append(createElement("p", "", item.summary || "RWANG ขออนุมัติการทำงานนี้"));
    const actions = createElement("div", "approval-actions");
    const approve = createButton(item.status === "executing" ? "EXECUTING" : "APPROVE", "approve", { approvalId: item.id, decision: "approve" });
    const reject = createButton("REJECT", "", { approvalId: item.id, decision: "reject" });
    approve.disabled = item.status === "executing";
    reject.disabled = item.status === "executing";
    actions.append(approve, reject);
    card.append(copy, actions);
    if (item.payload != null) card.append(createElement("div", "approval-payload", JSON.stringify(item.payload)));
    list.append(card);
  }
}

function makeMobileUrl(rwang) {
  const access = rwang?.access || {};
  const base = access.lanUrls?.[0] || (access.local ? "" : `${location.protocol}//${location.host}`);
  if (!base) return "";
  const url = new URL(base);
  url.searchParams.delete("token");
  return url.toString();
}

function renderMobile(rwang) {
  const access = rwang?.access || {};
  const pairingExpired = state.pairingExpiresAt && Date.parse(state.pairingExpiresAt) <= Date.now();
  if (state.pairingCode && (pairingExpired || access.pairingActive === false)) {
    state.pairingCode = "";
    state.pairingExpiresAt = "";
  }
  const mobileUrl = makeMobileUrl(rwang);
  $("#mobileUrlOutput").value = mobileUrl || "ตั้งค่า trusted HTTPS ก่อนเปิดให้มือถือ";
  $("#mobileSecurityOutput").value = access.secureTransport
    ? "TRUSTED HTTPS · DEVICE-SCOPED COOKIE"
    : access.lanUrls?.length ? "INSECURE LAN DISABLED" : "LOOPBACK ONLY · SAFE DEFAULT";
  $("#pairingCodeOutput").value = state.pairingCode
    ? state.pairingCode.replace(/(.{4})/, "$1 ")
    : "";
  const localOnly = access.local === false;
  const pairingReady = !localOnly && access.secureTransport && Boolean(mobileUrl);
  $("#copyMobileUrl").disabled = !mobileUrl;
  $("#createPairCode").disabled = !pairingReady;
  $("#cancelPairCode").disabled = localOnly || (!state.pairingCode && !access.pairingActive);
  $("#rotateToken").disabled = localOnly;

  const list = $("#pairedDeviceList");
  list.replaceChildren();
  const devices = Array.isArray(access.devices) ? access.devices : [];
  if (!devices.length) {
    list.append(createElement("div", "connection-card", "ยังไม่มีอุปกรณ์ที่จับคู่"));
  } else {
    for (const device of devices) {
      const card = createElement("article", "connection-card");
      const copy = createElement("div");
      copy.append(createElement("strong", "", device.name || "Mobile device"));
      copy.append(createElement("p", "", `SCOPES · ${(device.scopes || []).join(", ")} · EXPIRES ${formatDateTime(device.expiresAt)}`));
      card.append(copy, createButton("REVOKE", "", { deviceAction: "revoke", deviceId: device.id }));
      list.append(card);
    }
  }
}

function renderMcpServers(servers = []) {
  const list = $("#mcpServerList");
  list.replaceChildren();
  if (!servers.length) {
    list.append(createElement("div", "connection-card", "ยังไม่มี MCP server · เพิ่มได้จากฟอร์มด้านล่าง"));
    return;
  }
  for (const server of servers) {
    const card = createElement("article", "connection-card");
    const copy = createElement("div");
    copy.append(createElement("strong", "", server.name));
    copy.append(createElement("p", "", `${String(server.transport || "http").toUpperCase()} · ${server.target || "ยังไม่กำหนด target"}`));
    if (server.tools?.length) copy.append(createElement("p", "", `TOOLS · ${server.tools.join(", ")}`));
    const status = createElement("span", `card-status ${server.state || "unknown"}`, server.message || server.state || "unknown");
    const actions = createElement("div", "card-actions");
    if (server.transport !== "stdio") actions.append(createButton("EDIT", "", { mcpAction: "edit", id: server.id }));
    actions.append(
      createButton("TEST", "", { mcpAction: "test", id: server.id }),
      createButton("TRUST CURRENT TOOLS", "", { mcpAction: "trust", id: server.id }),
      createButton("REMOVE", "", { mcpAction: "remove", id: server.id }),
    );
    card.append(copy, status, actions);
    list.append(card);
  }
}

function preferredAutoSpeak(rwang = state.rwang) {
  const stored = readStorage(STORAGE_AUTO_SPEAK);
  if (rwang?.access?.local === false && stored) return stored === "1";
  return rwang?.identity?.autoSpeak !== false;
}

function setLocalConfigurationMode(local) {
  for (const formId of ["assistantSettings", "perceptionSettings", "homeAssistantForm", "mcpForm", "webhookForm", "scheduleSettings", "scheduleForm"]) {
    for (const control of $$(`#${formId} input, #${formId} select, #${formId} textarea, #${formId} button`)) {
      control.disabled = !local;
      if (!local) control.title = "แก้การตั้งค่านี้ได้จากเครื่องหลักเท่านั้น";
      else control.removeAttribute("title");
    }
  }
  for (const button of $$("#mcpServerList button, #webhookList button")) {
    button.disabled = !local;
    if (!local) button.title = "จัดการ integration ได้จากเครื่องหลักเท่านั้น";
  }
  for (const button of $$("#skillInventory button, #scheduleList button[data-local-only='true']")) {
    button.disabled = !local;
    if (!local) button.title = "จัดการ loadout ได้จากเครื่องหลักเท่านั้น";
  }
  for (const input of $$('[data-perception-mode]')) input.disabled = !local;
  const remoteMode = state.remoteState?.mode || "idle";
  $("#startShareButton").disabled = !local || remoteMode !== "idle" || state.rwang?.features?.screenShare === false;
  $("#remoteEnableButton").disabled = !local
    || remoteMode !== "host"
    || state.remoteState?.allowRemoteControl
    || state.rwang?.features?.mobileRemote === false;
}

function skillById(id) {
  return state.rwang?.skills?.find((skill) => skill.id === id) || null;
}

function setEquipmentSlot(slotSelector, statusSelector, equipped, label) {
  const slot = $(slotSelector);
  const output = $(statusSelector);
  slot?.classList.toggle("equipped", Boolean(equipped));
  if (output) output.textContent = label;
}

function skillRune(name = "") {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : words[0]?.slice(0, 2) || "SK").toUpperCase();
}

function renderSkillInventory(skills = []) {
  const inventory = $("#skillInventory");
  inventory.replaceChildren();
  for (const skill of skills) {
    const card = createElement("article", `skill-item${skill.enabled ? " equipped" : ""}${!skill.configured ? " locked" : ""}`);
    card.dataset.skillId = skill.id;
    card.title = skill.description || skill.name;
    const rune = createElement("span", "skill-rune", skillRune(skill.name));
    rune.setAttribute("aria-hidden", "true");
    const copy = createElement("div");
    copy.append(
      createElement("strong", "", skill.name),
      createElement("small", "", `${skill.category || "SKILL"} · ${skill.enabled ? "EQUIPPED" : skill.configured ? "AVAILABLE" : "NEEDS CONFIG"} · LV${skill.level || 1}`),
    );
    const button = createButton(skill.enabled ? "ON" : "ADD", "", {
      skillAction: "toggle",
      skillId: skill.id,
      enabled: String(Boolean(skill.enabled)),
    });
    button.setAttribute("aria-label", `${skill.enabled ? "ถอด" : "ติดตั้ง"} ${skill.name}`);
    card.append(rune, copy, button);
    inventory.append(card);
  }
}

function formatScheduleDate(value, timeZone = "Asia/Bangkok") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { time: "—", next: "INVALID DATE" };
  const time = new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(date);
  const next = new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
  return { time, next };
}

function renderSchedules(schedules = [], scheduler = {}) {
  const list = $("#scheduleList");
  list.replaceChildren();
  const local = state.rwang?.access?.local !== false;
  const active = schedules.filter((schedule) => schedule.enabled).length;
  $("#scheduleCount").textContent = String(active);
  if (!schedules.length) {
    list.append(createElement("div", "connection-card", "ยังไม่มี routine · เพิ่ม prompt และเวลาจากฟอร์มด้านซ้าย"));
    return;
  }
  for (const schedule of schedules) {
    const when = formatScheduleDate(schedule.nextRunAt, scheduler.timeZone || "Asia/Bangkok");
    const card = createElement("article", `schedule-item${schedule.enabled ? " active" : ""}${schedule.due ? " due" : ""}`);
    card.dataset.scheduleId = schedule.id;
    const clock = createElement("span", "schedule-time");
    clock.append(createElement("b", "", schedule.due ? "DUE" : when.time), createElement("small", "", String(schedule.repeat || "once").toUpperCase()));
    const copy = createElement("div");
    copy.append(
      createElement("strong", "", schedule.name),
      createElement("p", "", schedule.prompt || "Prompt ถูกซ่อนบนอุปกรณ์ remote"),
      createElement("small", "", `${schedule.due ? "READY TO RUN" : `NEXT · ${when.next}`} · ${schedule.requiresApproval === false ? "STANDARD TOOL POLICY" : "APPROVAL GATE"}`),
    );
    const actions = createElement("div", "schedule-actions");
    if (schedule.due) {
      actions.append(
        createButton("RUN", "", { scheduleAction: "run", scheduleId: schedule.id }),
        createButton("+10M", "", { scheduleAction: "snooze", scheduleId: schedule.id }),
      );
    } else if (schedule.enabled) {
      actions.append(createButton("RUN", "", { scheduleAction: "run", scheduleId: schedule.id }));
    }
    const toggle = createButton(schedule.enabled ? "PAUSE" : "RESUME", "", { scheduleAction: "toggle", scheduleId: schedule.id, localOnly: "true" });
    toggle.dataset.enabled = String(Boolean(schedule.enabled));
    actions.append(toggle);
    if (local) {
      actions.append(
        createButton("EDIT", "", { scheduleAction: "edit", scheduleId: schedule.id, localOnly: "true" }),
        createButton("×", "", { scheduleAction: "remove", scheduleId: schedule.id, localOnly: "true" }),
      );
    }
    card.append(clock, copy, actions);
    list.append(card);
  }
}

function renderLoadout(rwang) {
  const loadout = rwang.loadout || {};
  const remoteSnapshot = state.status?.remote || {};
  const session = remoteSnapshot.sessions?.[0] || null;
  const remoteActive = Boolean(state.remoteState?.mode && state.remoteState.mode !== "idle");
  const activeSessionId = state.remoteState?.sessionId || session?.id || "";
  const features = rwang.features || {};
  const local = rwang.access?.local !== false;
  $("#loadoutIdentityState").textContent = local ? "LOCAL CORE ONLINE" : "MOBILE LINK ONLINE";
  $("#loadoutLevel").textContent = `LV.${String(loadout.level || 1).padStart(2, "0")}`;
  const levelFloor = Math.max(0, ((loadout.level || 1) - 1) * 250);
  const levelRange = Math.max(1, Number(loadout.nextLevelXp || 250) - levelFloor);
  const levelProgress = Math.max(0, Math.min(100, ((Number(loadout.xp || 0) - levelFloor) / levelRange) * 100));
  $("#loadoutXpBar").value = levelProgress;
  $("#loadoutXpBar").textContent = `${Math.round(levelProgress)}%`;
  const rankCaption = $("#loadoutXpBar + small");
  if (rankCaption) rankCaption.textContent = `${loadout.equipped || 0} / ${loadout.capacity || rwang.skills?.length || 0} SKILLS EQUIPPED`;
  $("#equippedCount").textContent = String(loadout.equipped || 0);

  const enrollments = state.perception?.listEnrollments?.() || { face: [], voice: [] };
  setEquipmentSlot("#gestureSlot", "#gestureSlotStatus", features.gesture && skillById("gesture_control")?.enabled, features.gesture ? "READY" : "OFF");
  setEquipmentSlot("#faceSlot", "#faceSlotStatus", features.faceRecognition && skillById("face_presence")?.enabled, enrollments.face?.length ? (state.lastFace?.verified ? "MATCH" : "READY") : "LEARN");
  setEquipmentSlot("#voiceIdSlot", "#voiceIdSlotStatus", features.voiceRecognition && skillById("voice_identity")?.enabled, enrollments.voice?.length ? (state.lastVoiceprint?.verified ? "MATCH" : "READY") : "LEARN");
  setEquipmentSlot("#screenShareSlot", "#screenShareSlotStatus", features.screenShare && skillById("screen_share")?.enabled, session || remoteActive ? "LIVE" : "IDLE");
  setEquipmentSlot("#mobileRemoteSlot", "#mobileRemoteSlotStatus", features.mobileRemote && skillById("mobile_remote")?.enabled, session?.allowRemoteControl || state.remoteState?.allowRemoteControl ? "LINKED" : "SAFE");
  setEquipmentSlot("#homeAssistantSlot", "#homeAssistantSlotStatus", rwang.homeAssistant?.state === "online", rwang.homeAssistant?.state === "online" ? "ONLINE" : rwang.homeAssistant?.configured ? "CHECK" : "CONFIG");
  setEquipmentSlot("#mcpAgentSlot", "#mcpAgentSlotStatus", rwang.mcpServers?.some((server) => server.state === "online"), rwang.mcpServers?.length ? "READY" : "EMPTY");
  setEquipmentSlot("#webhookSlot", "#webhookSlotStatus", rwang.webhooks?.some((hook) => hook.enabled), rwang.webhooks?.length ? "READY" : "EMPTY");

  $("#skillCount").textContent = String(rwang.skills?.filter((skill) => skill.enabled).length || 0);
  renderSkillInventory(rwang.skills || []);
  renderSchedules(rwang.schedules || [], rwang.scheduler || {});

  $("#shareViewerCount").textContent = String(session?.viewerCount || state.remoteState?.viewerCount || 0);
  if (!remoteActive) $("#shareStatus").textContent = session ? `Session ${session.id.slice(-8)} พร้อมรับผู้ชม` : "เลือกแอปหรือหน้าจอเพื่อเริ่มแชร์";
  $("#remotePairCode").textContent = activeSessionId ? activeSessionId.slice(-6).toUpperCase().split("").join(" ") : "— — — — — —";
  if (!remoteActive) $("#remoteStatus").textContent = session?.allowRemoteControl ? "CONTROL ENABLED" : session ? "VIEW ONLY" : "NOT PAIRED";

  if (!$("#settingsDialog").open) {
    $("#gestureEnabledInput").checked = features.gesture !== false;
    $("#faceEnabledInput").checked = features.faceRecognition !== false;
    $("#voiceIdEnabledInput").checked = features.voiceRecognition !== false;
    $("#schedulerEnabledInput").checked = rwang.scheduler?.enabled !== false;
    $("#scheduleTimeZoneInput").value = rwang.scheduler?.timeZone || "Asia/Bangkok";
    $("#missedScheduleInput").value = rwang.scheduler?.missedRun || "next";
    $("#scheduleGlobalApprovalInput").checked = rwang.scheduler?.requireApproval !== false;
  }
  for (const input of $$('[data-perception-mode]')) {
    const key = input.dataset.perceptionMode === "face" ? "faceRecognition" : input.dataset.perceptionMode === "voice" ? "voiceRecognition" : "gesture";
    input.checked = features[key] !== false;
  }
}

function renderWebhooks(webhooks = []) {
  const list = $("#webhookList");
  list.replaceChildren();
  if (!webhooks.length) {
    list.append(createElement("div", "connection-card", "ยังไม่มี IoT webhook · เพิ่ม endpoint ที่อนุญาตไว้ด้านล่าง"));
    return;
  }
  for (const hook of webhooks) {
    const card = createElement("article", "connection-card");
    const copy = createElement("div");
    copy.append(createElement("strong", "", hook.name));
    copy.append(createElement("p", "", `${hook.method} · ${hook.target}`));
    const status = createElement("span", `card-status ${hook.enabled ? "online" : ""}`, hook.enabled ? "ENABLED · APPROVAL REQUIRED" : "DISABLED");
    const actions = createElement("div", "card-actions");
    actions.append(
      createButton("EDIT", "", { webhookAction: "edit", id: hook.id }),
      createButton("REMOVE", "", { webhookAction: "remove", id: hook.id }),
    );
    card.append(copy, status, actions);
    list.append(card);
  }
}

function hydrateSettings(rwang = state.rwang) {
  if (!rwang) return;
  const identity = rwang.identity || {};
  $("#wakeWordInput").value = identity.wakeWord || "อาหวัง";
  $("#languageInput").value = identity.language || "th-TH";
  $("#defaultModelInput").value = identity.defaultModel || "";
  if (!$("#settingsDialog").open) $("#settingsAutoSpeak").checked = preferredAutoSpeak(rwang);
  const ha = rwang.homeAssistant || {};
  $("#haUrlInput").value = ha.baseUrl || "";
  $("#haTokenInput").value = "";
  $("#haEnabledInput").checked = Boolean(ha.enabled);
  const features = rwang.features || {};
  $("#gestureEnabledInput").checked = features.gesture !== false;
  $("#faceEnabledInput").checked = features.faceRecognition !== false;
  $("#voiceIdEnabledInput").checked = features.voiceRecognition !== false;
  $("#perceptionThresholdInput").value = readStorage(STORAGE_PERCEPTION_THRESHOLD) || "0.82";
  $("#presenceRequiredInput").checked = readStorage(STORAGE_PRESENCE_REQUIRED) !== "0";
  const scheduler = rwang.scheduler || {};
  $("#schedulerEnabledInput").checked = scheduler.enabled !== false;
  $("#scheduleTimeZoneInput").value = scheduler.timeZone || "Asia/Bangkok";
  $("#missedScheduleInput").value = scheduler.missedRun || "next";
  $("#scheduleGlobalApprovalInput").checked = scheduler.requireApproval !== false;
  renderMcpServers(rwang.mcpServers || []);
  renderWebhooks(rwang.webhooks || []);
  renderMobile(rwang);
  setLocalConfigurationMode(rwang.access?.local !== false);
}

function renderRwang(rwang) {
  state.rwang = rwang;
  const identity = rwang.identity || {};
  $("#wakeWordDisplay").textContent = identity.wakeWord || "อาหวัง";
  const autoSpeak = preferredAutoSpeak(rwang);
  $("#autoSpeakToggle").checked = autoSpeak;
  $("#settingsAutoSpeak").checked = autoSpeak;
  $("#coreSub").textContent = rwang.access?.local
    ? "RWANG พร้อมรับคำสั่งบนเครื่องนี้"
    : "เชื่อมต่อ RWANG ผ่านเครือข่ายส่วนตัว";
  renderIntegrations(rwang);
  renderApprovals(rwang.approvals || []);
  renderMobile(rwang);
  renderMcpServers(rwang.mcpServers || []);
  renderWebhooks(rwang.webhooks || []);
  renderLoadout(rwang);
  setLocalConfigurationMode(rwang.access?.local !== false);
  $("#footerStatus").textContent = rwang.access?.local
    ? "PRIVATE BY DEFAULT · HUMAN APPROVAL ENABLED"
    : "REMOTE AUTHENTICATED · HUMAN APPROVAL ENABLED";
}

function queueEntries(status) {
  const jobs = status.queueState?.jobs || [];
  const seen = new Set();
  const result = [];
  for (const preset of status.presets || []) {
    const job = jobs.find((item) => item.id === preset.id || item.name === preset.name);
    result.push({ preset, job });
    if (job) seen.add(job.id);
  }
  for (const job of jobs) {
    if (!seen.has(job.id)) result.push({ preset: null, job });
  }
  return result;
}

function renderModelQueue(status) {
  const list = $("#modelList");
  list.replaceChildren();
  const entries = queueEntries(status);
  if (!entries.length) {
    list.append(createElement("div", "model-row", "ยังไม่มีรายการดาวน์โหลด"));
    return;
  }
  entries.forEach(({ preset, job }, index) => {
    const model = job?.name || preset?.name || "";
    const installed = Boolean(preset?.installed) || (status.installed || []).some((item) => modelName(item) === model);
    const inferredStatus = installed ? "complete" : preset?.partial ? "paused" : "not-started";
    const statusName = job?.status || inferredStatus;
    const row = createElement("article", "model-row");
    const top = createElement("div", "model-top");
    const identity = createElement("div", "model-identity");
    identity.append(createElement("span", "model-index", String(index + 1).padStart(2, "0")));
    const name = createElement("div", "model-name");
    name.append(createElement("strong", "", job?.label || preset?.label || shortName(model)));
    name.append(createElement("small", "", preset?.role || model));
    identity.append(name);
    const controls = createElement("div", "model-status");
    controls.append(createElement("span", `status-pill ${statusName}`, statusName));
    if (["downloading", "retrying", "queued"].includes(statusName)) {
      controls.append(createButton("PAUSE", "row-action", { modelAction: "cancel", id: job?.id || "", model }));
    } else if (["failed", "paused"].includes(statusName)) {
      controls.append(createButton("RETRY", "row-action", { modelAction: "retry", model }));
    } else if (!installed) {
      controls.append(createButton("PULL", "row-action", { modelAction: "pull", model }));
    }
    top.append(identity, controls);
    const track = createElement("progress", "progress-track");
    track.max = 100;
    track.value = Math.max(0, Math.min(100, Number(job?.percent || (installed ? 100 : 0))));
    const meta = createElement("div", "model-meta");
    meta.append(
      createElement("span", "detail", job?.detail || (installed ? "พร้อมใช้งาน" : preset?.partial ? `พบ partial ${formatBytes(preset.partial.bytes)}` : "ยังไม่ดาวน์โหลด")),
      createElement("span", "", job ? `${Number(job.percent || 0).toFixed(1)}% · ${formatSpeed(job.speed)}` : installed ? "100%" : "—"),
    );
    row.append(top, track, meta);
    list.append(row);
  });
}

function renderActivity(queueState) {
  const log = $("#activityLog");
  log.replaceChildren();
  const entries = queueState?.log || [];
  if (!entries.length) {
    log.append(createElement("div", "log-item", "ยังไม่มีกิจกรรมในรอบนี้"));
    return;
  }
  for (const item of entries.slice(0, 80)) {
    const row = createElement("div", `log-item ${item.level || "info"}`);
    row.append(
      createElement("span", "log-time", formatTime(item.at)),
      createElement("span", "log-mark", "•"),
      createElement("span", "", item.message),
    );
    log.append(row);
  }
}

function renderInstalled(status) {
  const installed = status.installed || [];
  const running = new Set((status.running || []).map(modelName));
  $("#installedCount").textContent = `${installed.length} LOCAL`;
  const grid = $("#installedGrid");
  grid.replaceChildren();
  if (!installed.length) {
    grid.append(createElement("div", "installed-card", "ยังไม่มีโมเดลในเครื่อง · ใช้ช่อง OLLAMA COMMAND ด้านบนเพื่อดาวน์โหลด"));
    return;
  }
  for (const model of installed) {
    const nameValue = modelName(model);
    const card = createElement("article", "installed-card");
    const copy = createElement("div");
    copy.append(createElement("strong", "", shortName(nameValue)));
    copy.append(createElement("small", "", `${formatBytes(model.size)} · ${running.has(nameValue) ? "IN MEMORY" : "ON DISK"}`));
    const actions = createElement("div", "memory-actions");
    if (running.has(nameValue)) actions.append(createButton("UNLOAD", "", { memoryAction: "unload", model: nameValue }));
    else actions.append(createButton("LOAD", "", { memoryAction: "load", model: nameValue }));
    card.append(copy, actions);
    grid.append(card);
  }
}

function renderSystems(status) {
  $("#metricOllama").textContent = status.online ? "ONLINE" : "OFFLINE";
  $("#metricVersion").textContent = `VERSION ${status.version || "—"}`;
  $("#metricInstalled").textContent = String(status.installed?.length || 0);
  $("#metricRunning").textContent = String(status.running?.length || 0);
  $("#metricDisk").textContent = formatBytes(status.disk?.free);
  renderModelQueue(status);
  renderActivity(status.queueState);
  renderInstalled(status);
}

function renderStatus(status) {
  state.status = status;
  renderRwang(status.rwang || state.rwang || {});
  renderHeader(status);
  syncModelSelects(status);
  renderSystems(status);
}

async function refreshStatus({ silent = false } = {}) {
  try {
    const status = await apiFetch("/api/status");
    $("#accessGate").hidden = true;
    $("#accessError").textContent = "";
    renderStatus(status);
    connectEvents();
    return status;
  } catch (error) {
    if (error.status === 401) {
      $("#accessGate").hidden = false;
      $("#accessError").textContent = state.accessToken ? "Token ไม่ถูกต้องหรือถูกเปลี่ยนแล้ว" : "ต้องใช้ access token จากเครื่องหลัก";
      disconnectEvents();
      return null;
    }
    $("#connection").classList.add("offline");
    $("#ollamaState").textContent = "RWANG OFFLINE";
    if (!silent) showToast(`เชื่อมต่อ RWANG ไม่สำเร็จ: ${error.message}`);
    return null;
  }
}

function disconnectEvents() {
  state.eventSource?.abort?.();
  state.eventSource = null;
}

async function connectEvents() {
  if (state.eventSource || !state.status) return;
  const controller = new AbortController();
  state.eventSource = controller;
  try {
    const response = await fetch("/api/events", {
      headers: authHeaders({ accept: "text/event-stream" }),
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`Event stream HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!controller.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const packet = buffer.slice(0, boundary).replace(/\r/g, "");
        buffer = buffer.slice(boundary + 2);
        const data = packet.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          const queueState = JSON.parse(data);
          if (!state.status) continue;
          state.status.queueState = queueState;
          renderModelQueue(state.status);
          renderActivity(queueState);
        } catch {}
      }
    }
  } catch (error) {
    if (controller.signal.aborted) return;
  } finally {
    if (state.eventSource === controller) state.eventSource = null;
    if (!controller.signal.aborted && state.status) {
      setTimeout(() => {
        if (state.status && !state.eventSource) void connectEvents();
      }, 4000);
    }
  }
}

function makeWelcome() {
  const welcome = createElement("div", "chat-welcome");
  welcome.append(createElement("span", "welcome-mark", "R"));
  welcome.append(createElement("h2", "", "สวัสดีครับ ผมคือ RWANG"));
  welcome.append(createElement("p", "", "ผู้ช่วยส่วนตัวที่ทำงานผ่าน Ollama บนเครื่องของคุณ คุยภาษาไทย สั่งงานด้วยเสียง และต่อเครื่องมือผ่าน Home Assistant, Webhook หรือ MCP ได้"));
  welcome.append(createElement("small", "", "ข้อความและโมเดลอยู่ในระบบ local · การสั่งอุปกรณ์จริงต้องยืนยันก่อน"));
  return welcome;
}

function renderMessageText(container, text, streaming = false) {
  container.replaceChildren();
  const value = String(text || "");
  const blocks = value.split(new RegExp("\\n{2,}"));
  for (const block of blocks) {
    const paragraph = createElement("p", "", block || " ");
    container.append(paragraph);
  }
  if (streaming) container.append(createElement("span", "cursor"));
}

function appendMessage(role, text = "") {
  const messages = $("#chatMessages");
  $(".chat-welcome", messages)?.remove();
  const article = createElement("article", `message ${role}`);
  const avatar = createElement("div", "avatar", role === "user" ? "YOU" : "RW");
  const body = createElement("div", "message-body");
  body.append(createElement("div", "message-meta", `${role === "user" ? "YOU" : "RWANG"} · ${formatTime(new Date())}`));
  const content = createElement("div", "message-content");
  renderMessageText(content, text);
  body.append(content);
  article.append(avatar, body);
  messages.append(article);
  messages.scrollTop = messages.scrollHeight;
  return { article, body, content };
}

function appendTrace(message, traceText) {
  let trace = $(".tool-trace", message.body);
  if (!trace) {
    trace = createElement("div", "tool-trace");
    message.body.append(trace);
  }
  const line = createElement("div", "", traceText);
  trace.append(line);
  $("#chatMessages").scrollTop = $("#chatMessages").scrollHeight;
}

function currentModel() {
  return $("#modelSelect").value || state.rwang?.identity?.defaultModel || "";
}

async function sendPrompt(rawPrompt) {
  const prompt = String(rawPrompt || "").trim();
  if (!prompt || state.chatBusy) return;
  const model = currentModel();
  if (!model) {
    showToast("ยังไม่มีโมเดลพร้อมใช้ · ไปที่ SYSTEMS แล้วใช้ ollama run หรือ ollama pull ก่อน");
    switchView("systems");
    return;
  }

  const resumeWake = $("#wakeToggle").checked;
  stopRecognition({ keepWake: resumeWake });
  window.speechSynthesis?.cancel();
  state.chatBusy = true;
  state.wakeResume = resumeWake;
  state.chatController = new AbortController();
  $("#chatInput").value = "";
  $("#sendButton").disabled = true;
  $("#stopButton").hidden = false;
  setCore("thinking");

  appendMessage("user", prompt);
  state.chatHistory.push({ role: "user", content: prompt });
  const assistant = appendMessage("assistant", "");
  renderMessageText(assistant.content, "", true);
  let answer = "";
  let completed = false;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ model, messages: state.chatHistory.slice(-40) }),
      signal: state.chatController.signal,
    });
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}));
      throw new ApiError(payload.error || `Chat HTTP ${response.status}`, response.status, payload);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processChatEvent(line, assistant, (delta) => {
        answer += delta;
        renderMessageText(assistant.content, answer, true);
      });
    }
    buffer += decoder.decode();
    if (buffer.trim()) processChatEvent(buffer, assistant, (delta) => {
      answer += delta;
    });
    completed = true;
  } catch (error) {
    if (error.name === "AbortError") {
      if (!answer) answer = "หยุดการตอบแล้ว";
      appendTrace(assistant, "หยุดโดยผู้ใช้");
    } else {
      if (!answer) answer = `เกิดข้อผิดพลาด: ${error.message}`;
      appendTrace(assistant, `ERROR · ${error.message}`);
      showToast(`แชทไม่สำเร็จ: ${error.message}`);
    }
  } finally {
    renderMessageText(assistant.content, answer || "ไม่มีข้อความตอบกลับ");
    if (answer) state.chatHistory.push({ role: "assistant", content: answer });
    state.chatBusy = false;
    state.chatController = null;
    $("#sendButton").disabled = false;
    $("#stopButton").hidden = true;
    await refreshStatus({ silent: true });
    if (completed && answer && $("#autoSpeakToggle").checked) speak(answer);
    else restoreIdleVoice();
  }
}

function processChatEvent(line, message, onDelta) {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type === "delta" && event.content) onDelta(String(event.content));
  else if (event.type === "mode") appendTrace(message, `${String(event.mode || "chat").toUpperCase()} MODE${event.toolCount != null ? ` · ${event.toolCount} tools` : ""}${event.notice ? ` · ${event.notice}` : ""}`);
  else if (event.type === "reasoning") {
    if (!message.reasoningShown) {
      appendTrace(message, "กำลังวิเคราะห์บน local model…");
      message.reasoningShown = true;
    }
  } else if (event.type === "tool-call") appendTrace(message, `TOOL CALL · ${event.name}`);
  else if (event.type === "tool-result") appendTrace(message, `TOOL RESULT · ${event.name}`);
  else if (event.type === "tool-error") appendTrace(message, `TOOL ERROR · ${event.name}: ${event.error}`);
  else if (event.type === "error" || event.error) throw new Error(event.error || "Agent stream error");
}

function stopChat() {
  state.chatController?.abort();
  window.speechSynthesis?.cancel();
}

function speechRecognitionConstructor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function configureRecognition() {
  const Constructor = speechRecognitionConstructor();
  if (!Constructor) return null;
  if (state.recognition) return state.recognition;
  const recognition = new Constructor();
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    state.recognitionStarting = false;
    setCore("listening", state.voiceMode === "wake" ? `รอคำปลุก “${wakeWord()}”` : "กำลังฟังคำสั่ง...", "พูดได้เลย ระบบจะส่งเมื่อจบประโยค");
  };
  recognition.onresult = (event) => handleRecognitionResult(event);
  recognition.onerror = (event) => {
    state.recognitionStarting = false;
    if (["aborted", "no-speech"].includes(event.error)) return;
    if (["not-allowed", "service-not-allowed"].includes(event.error)) {
      $("#wakeToggle").checked = false;
      writeStorage(STORAGE_WAKE, "");
      state.wakeResume = false;
      setCore("error", "Browser ไม่อนุญาตให้ใช้ไมค์", window.isSecureContext ? "ตรวจ permission ของเว็บไซต์แล้วลองใหม่" : "มือถือบน LAN ต้องเปิดผ่าน trusted HTTPS เพื่อใช้เสียง");
    } else {
      setCore("error", `Voice error: ${event.error}`, "แตะวงแหวนเพื่อลองใหม่");
    }
  };
  recognition.onend = () => {
    state.recognitionStarting = false;
    const wasMode = state.voiceMode;
    state.voiceMode = null;
    if (wasMode === "wake" && $("#wakeToggle").checked && !state.chatBusy && !window.speechSynthesis?.speaking) scheduleWakeRestart();
    else if (!state.chatBusy && !window.speechSynthesis?.speaking) setCore("standby");
  };
  state.recognition = recognition;
  return recognition;
}

async function preferOnDeviceRecognition(recognition, Constructor) {
  const language = state.rwang?.identity?.language || "th-TH";
  recognition.lang = language;
  const supportsLocalPreference = "processLocally" in recognition && Constructor && typeof Constructor.available === "function";
  if (!supportsLocalPreference) {
    $("#voiceHint").textContent = "VOICE SERVICE · ENTER ส่ง · SHIFT+ENTER ขึ้นบรรทัดใหม่";
    return;
  }
  try {
    const availability = await Constructor.available({ langs: [language], processLocally: true });
    recognition.processLocally = availability === "available";
    $("#voiceHint").textContent = recognition.processLocally
      ? "ON-DEVICE VOICE · ENTER ส่ง · SHIFT+ENTER ขึ้นบรรทัดใหม่"
      : "BROWSER VOICE · ENTER ส่ง · SHIFT+ENTER ขึ้นบรรทัดใหม่";
  } catch {
    recognition.processLocally = false;
    $("#voiceHint").textContent = "BROWSER VOICE · ENTER ส่ง · SHIFT+ENTER ขึ้นบรรทัดใหม่";
  }
}

function wakeWord() {
  return String(state.rwang?.identity?.wakeWord || $("#wakeWordInput").value || "อาหวัง").trim();
}

async function startRecognition(mode = "push") {
  const recognition = configureRecognition();
  if (!recognition) {
    setCore("error", "Browser นี้ไม่มี Speech Recognition", "ยังพิมพ์แชทและใช้คำตอบเสียงได้ตามปกติ");
    showToast("Browser นี้ไม่รองรับ SpeechRecognition · ใช้ Chrome หรือ Edge เวอร์ชันล่าสุด");
    return;
  }
  if (!window.isSecureContext && !state.rwang?.access?.local) {
    showToast("ไมค์บนมือถือผ่าน LAN HTTP อาจถูกบล็อก · ใช้ trusted HTTPS เพื่อเปิดเสียง");
  }
  clearTimeout(state.recognitionRestartTimer);
  if (state.voiceMode || state.recognitionStarting) {
    stopRecognition({ keepWake: mode === "wake" });
    setTimeout(() => void startRecognition(mode), 180);
    return;
  }
  state.voiceMode = mode;
  state.recognitionStarting = true;
  await preferOnDeviceRecognition(recognition, speechRecognitionConstructor());
  if (state.voiceMode !== mode || !state.recognitionStarting) return;
  recognition.continuous = mode === "wake";
  try {
    recognition.start();
  } catch (error) {
    state.voiceMode = null;
    state.recognitionStarting = false;
    showToast(`เปิดไมค์ไม่สำเร็จ: ${error.message}`);
  }
}

function stopRecognition({ keepWake = false } = {}) {
  clearTimeout(state.recognitionRestartTimer);
  state.wakeResume = keepWake;
  if (!state.recognition || (!state.voiceMode && !state.recognitionStarting)) return;
  state.voiceMode = null;
  state.recognitionStarting = false;
  try {
    state.recognition.stop();
  } catch {}
}

function scheduleWakeRestart() {
  clearTimeout(state.recognitionRestartTimer);
  if (!$("#wakeToggle").checked || state.chatBusy || window.speechSynthesis?.speaking) return;
  state.recognitionRestartTimer = setTimeout(() => void startRecognition("wake"), 650);
}

function handleRecognitionResult(event) {
  let finalText = "";
  let interimText = "";
  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const transcript = event.results[index][0]?.transcript || "";
    if (event.results[index].isFinal) finalText += transcript;
    else interimText += transcript;
  }
  const heard = (finalText || interimText).trim();
  if (!heard) return;

  if (state.voiceMode === "push") {
    $("#chatInput").value = heard;
    if (finalText.trim()) {
      stopRecognition({ keepWake: $("#wakeToggle").checked });
      void sendPrompt(finalText.trim());
    }
    return;
  }

  if (state.voiceMode === "wake" && finalText.trim()) {
    const phrase = finalText.trim();
    const lowerPhrase = phrase.toLocaleLowerCase("th-TH");
    const lowerWake = wakeWord().toLocaleLowerCase("th-TH");
    const position = lowerPhrase.indexOf(lowerWake);
    if (position < 0) {
      setCore("listening", `รอคำปลุก “${wakeWord()}”`, `ได้ยิน: ${phrase.slice(0, 70)}`);
      return;
    }
    const command = phrase.slice(position + wakeWord().length).replace(new RegExp("^[\\s,.:;!?]+"), "").trim();
    if (!command) {
      setCore("listening", "ครับ ผมฟังอยู่", "พูดคำสั่งต่อโดยเรียกคำปลุกอีกครั้ง");
      return;
    }
    $("#chatInput").value = command;
    stopRecognition({ keepWake: true });
    void sendPrompt(command);
  }
}

function speak(text) {
  if (!("speechSynthesis" in window)) {
    restoreIdleVoice();
    return;
  }
  stopRecognition({ keepWake: $("#wakeToggle").checked });
  window.speechSynthesis.cancel();
  const clean = String(text)
    .replace(new RegExp("```[\\s\\S]*?```", "g"), " ส่วนโค้ดถูกแสดงบนหน้าจอ ")
    .replace(new RegExp("[`*_#>]", "g"), " ")
    .slice(0, 12000);
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = state.rwang?.identity?.language || "th-TH";
  const voices = window.speechSynthesis.getVoices();
  const language = utterance.lang.toLowerCase();
  utterance.voice = voices.find((voice) => voice.lang.toLowerCase() === language)
    || voices.find((voice) => voice.lang.toLowerCase().startsWith(language.split("-")[0]))
    || null;
  utterance.rate = 1.02;
  utterance.pitch = 0.94;
  utterance.onstart = () => setCore("speaking");
  utterance.onend = () => restoreIdleVoice();
  utterance.onerror = () => restoreIdleVoice();
  window.speechSynthesis.speak(utterance);
}

function restoreIdleVoice() {
  if (state.chatBusy) return;
  setCore("standby");
  if ($("#wakeToggle").checked || state.wakeResume) {
    state.wakeResume = false;
    scheduleWakeRestart();
  }
}

function renderPerceptionState(perceptionState = {}) {
  state.perceptionState = perceptionState;
  const active = perceptionState.camera === "active";
  const requesting = perceptionState.camera === "requesting";
  const handState = perceptionState.vision?.hand || "idle";
  const faceState = perceptionState.vision?.face || "idle";
  $("#perceptionStatus").textContent = perceptionState.lastError
    ? "SENSOR ERROR"
    : requesting ? "REQUESTING CAMERA"
      : active ? `CAMERA LIVE · HAND ${String(handState).toUpperCase()} · FACE ${String(faceState).toUpperCase()}`
        : "CAMERA OFFLINE";
  $("#perceptionPlaceholder").hidden = active;
  $("#startPerceptionButton").disabled = active || requesting;
  $("#stopPerceptionButton").disabled = !active && !requesting;
  $("#perceptionFps").textContent = active ? "12 FPS MAX" : "00 FPS";
  const confidence = Math.max(Number(perceptionState.gesture?.confidence || 0), Number(perceptionState.face?.quality || 0));
  $("#perceptionConfidence").textContent = confidence ? `CONF ${Math.round(confidence * 100)}%` : "CONF —";
  if (state.rwang) renderLoadout(state.rwang);
}

function handleGestureCommand(event) {
  if (state.rwang?.features?.gesture === false || skillById("gesture_control")?.enabled === false) return;
  const activeElement = document.activeElement;
  if (activeElement?.matches?.("input, textarea, select, [contenteditable='true']")) return;
  const actions = {
    open_palm: () => switchView("assistant"),
    pointing: () => switchView("systems"),
    victory: () => switchView("loadout"),
    thumbs_up: () => window.scrollBy({ top: -480, behavior: "smooth" }),
    thumbs_down: () => window.scrollBy({ top: 480, behavior: "smooth" }),
    closed_fist: () => {
      stopChat();
      window.speechSynthesis?.cancel();
    },
  };
  const labels = {
    open_palm: "OPEN PALM · ASSISTANT",
    pointing: "POINTING · SYSTEMS",
    victory: "VICTORY · LOADOUT",
    thumbs_up: "THUMBS UP · SCROLL UP",
    thumbs_down: "THUMBS DOWN · SCROLL DOWN",
    closed_fist: "CLOSED FIST · STOP",
  };
  const action = actions[event.name];
  if (!action) return;
  action();
  showToast(`GESTURE ${Math.round(Number(event.confidence || 0) * 100)}% · ${labels[event.name]}`);
}

function handleFaceEvent(event) {
  state.lastFace = event;
  if (event.enrolled) showToast("บันทึก Face Profile ในอุปกรณ์นี้แล้ว · ใช้แสดงสถานะเท่านั้น");
  if (typeof event.verified === "boolean") {
    showToast(`${event.verified ? "พบ" : "ไม่ตรงกับ"} Face Profile · ${Math.round(Number(event.confidence || 0) * 100)}% · ไม่ใช่การยืนยันสิทธิ์`);
  }
  const enrollments = state.perception?.listEnrollments?.();
  const shouldVerify = event.present
    && state.rwang?.features?.faceRecognition !== false
    && readStorage(STORAGE_PRESENCE_REQUIRED) !== "0"
    && enrollments?.face?.length
    && !state.faceVerifyBusy;
  if (shouldVerify) {
    state.faceVerifyBusy = true;
    void state.perception.verifyFace({ label: "owner", samples: 6, timeoutMs: 6000 })
      .catch((error) => showToast(`Face Profile: ${error.message}`))
      .finally(() => { state.faceVerifyBusy = false; });
  }
  if (state.rwang) renderLoadout(state.rwang);
}

function handleVoiceprintEvent(event) {
  state.lastVoiceprint = event;
  if (event.enrolled) showToast("บันทึก Voice Profile ในอุปกรณ์นี้แล้ว · ไม่ใช้แทน approval");
  if (typeof event.verified === "boolean") {
    showToast(`${event.verified ? "พบ" : "ไม่ตรงกับ"} Voice Profile · ${Math.round(Number(event.confidence || 0) * 100)}% · ไม่ใช่การยืนยันสิทธิ์`);
  }
  if (state.rwang) renderLoadout(state.rwang);
}

async function initializePerception({ recreate = false } = {}) {
  if (recreate && state.perception) await state.perception.destroy();
  if (state.perception && !recreate) return state.perception;
  const threshold = Math.max(0.5, Math.min(0.99, Number(readStorage(STORAGE_PERCEPTION_THRESHOLD)) || 0.82));
  state.perception = createPerceptionController({
    videoElement: $("#perceptionVideo"),
    canvasElement: $("#perceptionCanvas"),
    inferenceFps: 12,
    gestureStableFrames: 3,
    gestureCooldownMs: 1800,
    faceMatchThreshold: threshold,
    voiceMatchThreshold: threshold,
    stopOnHidden: true,
    mirror: true,
    onState: renderPerceptionState,
    onGesture: handleGestureCommand,
    onFace: handleFaceEvent,
    onVoiceprint: handleVoiceprintEvent,
    onError: (error) => showToast(`PERCEPTION · ${error.message}`, 5200),
  });
  renderPerceptionState(state.perception.getState());
  return state.perception;
}

async function refreshCameraDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
  const select = $("#perceptionDeviceSelect");
  const previous = select.value;
  select.replaceChildren(new Option("Default camera", ""));
  devices.forEach((device, index) => select.add(new Option(device.label || `Camera ${index + 1}`, device.deviceId)));
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

async function startPerception() {
  try {
    const controller = await initializePerception();
    const deviceId = $("#perceptionDeviceSelect").value;
    await controller.startCamera(deviceId ? { deviceId: { exact: deviceId } } : {});
    await refreshCameraDevices();
    showToast("เปิด Perception แบบ local แล้ว · กล้องไม่ถูกส่งออกอัตโนมัติ");
  } catch (error) {
    showToast(`เปิด Perception ไม่สำเร็จ: ${error.message}`, 5200);
  }
}

async function stopPerception() {
  await state.perception?.stop();
  renderPerceptionState(state.perception?.getState?.() || {});
  showToast("ปิดกล้องและไมค์ของ Perception แล้ว");
}

async function enrollOrVerifyFace() {
  try {
    const controller = await initializePerception();
    if (controller.getState().camera !== "active") await startPerception();
    const enrolled = controller.listEnrollments().face.length > 0;
    if (enrolled) await controller.verifyFace({ label: "owner" });
    else await controller.enrollFace({ label: "owner", samples: 10, timeoutMs: 10000 });
  } catch (error) {
    showToast(`Face Profile: ${error.message}`, 6000);
  }
}

async function enrollOrVerifyVoice() {
  try {
    const controller = await initializePerception();
    const enrolled = controller.listEnrollments().voice.length > 0;
    showToast(enrolled ? "พูดวลีเดิมประมาณ 3 วินาทีเพื่อตรวจ Voice Profile" : "พูดวลีตัวอย่างประมาณ 4 วินาทีเพื่อสร้าง Voice Profile");
    if (enrolled) await controller.verifyVoiceprint({ label: "owner", durationMs: 3000 });
    else await controller.enrollVoiceprint({ label: "owner", durationMs: 4000 });
  } catch (error) {
    showToast(`Voice Profile: ${error.message}`, 6000);
  }
}

async function clearBiometricProfiles() {
  if (!window.confirm("ล้าง Face Profile และ Voice Profile ที่เก็บในอุปกรณ์นี้หรือไม่")) return;
  const controller = await initializePerception();
  controller.clearBiometricData({ face: true, voice: true });
  state.lastFace = null;
  state.lastVoiceprint = null;
  if (state.rwang) renderLoadout(state.rwang);
  showToast("ล้างโปรไฟล์ใบหน้าและเสียงในอุปกรณ์นี้แล้ว");
}

function applyRemoteUiCommand(command) {
  if (command.action === "navigate") {
    switchView(command.target);
    return;
  }
  if (command.action === "scroll") {
    if (command.direction === "top") window.scrollTo({ top: 0, behavior: "smooth" });
    else if (command.direction === "bottom") window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
    else window.scrollBy({ top: command.direction === "up" ? -command.amount : command.amount, behavior: "smooth" });
    return;
  }
  if (command.action === "spotlight") {
    const selectors = {
      "voice-core": "#micButton",
      chat: "#assistantView",
      approvals: "#approvalSection",
      integrations: "#integrationStrip",
      connectors: "#settingsButton",
      skills: "#skillInventory",
      schedule: "#scheduleList",
      models: "#installedGrid",
      queue: "#modelList",
      logs: "#activityLog",
      loadout: "#loadoutView",
    };
    const target = $(selectors[command.target]);
    if (!target) return;
    target.classList.toggle("remote-spotlight", command.active !== false);
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => target.classList.remove("remote-spotlight"), Number(command.durationMs || 3000));
  }
}

function renderRemoteState(remoteState = {}) {
  state.remoteState = remoteState;
  const mode = remoteState.mode || "idle";
  const active = mode !== "idle";
  const phase = String(remoteState.phase || "idle").replaceAll("-", " ").toUpperCase();
  $("#sharePlaceholder").hidden = Boolean(remoteState.hasLocalStream || remoteState.hasRemoteStream);
  $("#shareStatus").textContent = remoteState.lastError || (active ? phase : "เลือกแอปหรือหน้าจอเพื่อเริ่มแชร์");
  $("#shareViewerCount").textContent = String(remoteState.viewerCount || 0);
  $("#remotePairCode").textContent = remoteState.sessionId
    ? remoteState.sessionId.slice(-6).toUpperCase().split("").join(" ")
    : "— — — — — —";
  $("#remoteStatus").textContent = remoteState.lastError
    ? "LINK ERROR"
    : mode === "viewer" ? (remoteState.allowRemoteControl ? "REMOTE READY" : "VIEW ONLY")
      : mode === "host" ? (remoteState.allowRemoteControl ? "CONTROL 10 MIN" : "VIEW ONLY")
        : "NOT PAIRED";

  const viewerSelect = $("#remoteViewerSelect");
  const previousViewer = viewerSelect.value;
  const viewers = Array.isArray(remoteState.viewers) ? remoteState.viewers : [];
  viewerSelect.replaceChildren();
  if (!viewers.length) {
    viewerSelect.append(new Option("รออุปกรณ์ JOIN", ""));
  } else {
    for (const viewer of viewers) {
      const suffix = viewer.allowRemoteControl ? " · CONTROL" : viewer.connected === false ? " · OFFLINE" : "";
      viewerSelect.append(new Option(`${viewer.name || "Mobile viewer"}${suffix}`, viewer.id));
    }
    viewerSelect.value = viewers.some((viewer) => viewer.id === previousViewer)
      ? previousViewer
      : viewers.find((viewer) => viewer.allowRemoteControl)?.id || viewers[0].id;
  }

  const local = state.rwang?.access?.local !== false;
  $("#startShareButton").disabled = !local || active || state.rwang?.features?.screenShare === false;
  $("#stopShareButton").disabled = mode !== "host";
  $("#joinShareButton").disabled = active;
  const inviteFresh = remoteState.inviteAvailable === true
    && (!remoteState.inviteExpiresAt || Date.parse(remoteState.inviteExpiresAt) > Date.now());
  const copyButton = $("#copyShareLinkButton");
  copyButton.disabled = mode !== "host" || Number(remoteState.viewerCount || 0) > 0;
  copyButton.innerHTML = inviteFresh
    ? 'COPY PRIVATE VIEW LINK <span>⧉</span>'
    : 'NEW PRIVATE VIEW LINK <span>＋</span>';
  const selectedViewer = viewers.find((viewer) => viewer.id === viewerSelect.value);
  $("#remoteEnableButton").disabled = mode !== "host" || !local || !selectedViewer || selectedViewer.allowRemoteControl || state.rwang?.features?.mobileRemote === false;
  $("#remoteDisconnectButton").disabled = mode === "idle" || (mode === "host" && !selectedViewer);
  for (const button of $$("[data-remote-command]")) {
    button.disabled = mode !== "viewer" || !remoteState.allowRemoteControl;
  }
  if (state.rwang) renderLoadout(state.rwang);
}

function initializeRemote() {
  if (state.remote) return state.remote;
  state.remote = createRemoteController({
    apiFetch: window.fetch.bind(window),
    previewElement: $("#sharePreview"),
    onState: renderRemoteState,
    onCommand: applyRemoteUiCommand,
  });
  renderRemoteState(state.remote.getState());
  return state.remote;
}

async function startScreenShare() {
  try {
    await initializeRemote().startHost({
      source: $("#shareSourceSelect").value,
      includeAudio: false,
      allowRemoteControl: false,
    });
    showToast("เริ่มแชร์แล้ว · browser picker เป็นผู้กำหนด app/window/screen ที่อนุญาต");
  } catch (error) {
    showToast(`Screen Share: ${error.message}`, 6000);
  }
}

async function stopScreenShare() {
  try {
    if (state.remote?.getState().mode === "viewer") await state.remote.leave();
    else await state.remote?.stopHost();
    showToast("หยุด screen-share และปิด WebRTC session แล้ว");
  } catch (error) {
    showToast(`Screen Share: ${error.message}`, 5200);
  }
}

async function joinScreenShare(reference = $("#shareSessionInput").value) {
  $("#shareSessionInput").value = "";
  try {
    await initializeRemote().join(reference, { name: "RWANG Mobile" });
    $("#shareSessionInput").value = "";
    showToast("เชื่อมต่อ screen-share ด้วย scoped session token แล้ว");
    return true;
  } catch (error) {
    showToast(`JOIN: ${error.message}`, 6000);
    return false;
  }
}

async function copyShareLink() {
  try {
    const controller = initializeRemote();
    const remoteState = controller.getState();
    const inviteFresh = remoteState.inviteAvailable === true
      && (!remoteState.inviteExpiresAt || Date.parse(remoteState.inviteExpiresAt) > Date.now());
    if (!inviteFresh) await controller.renewShareInvite();
    const base = state.rwang?.access?.lanUrls?.[0] || location.origin;
    const link = controller.buildShareLink(base);
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(link);
    else {
      const field = $("#shareSessionInput");
      field.value = link;
      field.focus();
      field.select();
      document.execCommand("copy");
      field.value = "";
    }
    showToast("คัดลอก private view link แล้ว · ลิงก์ไม่มี RWANG master token");
  } catch (error) {
    showToast(`คัดลอกลิงก์ไม่สำเร็จ: ${error.message}`);
  }
}

async function disconnectRemoteViewer() {
  try {
    const controller = initializeRemote();
    if (controller.getState().mode === "viewer") {
      await stopScreenShare();
      return;
    }
    await controller.disconnectViewer($("#remoteViewerSelect").value);
    showToast("ตัด viewer และหยุด stream ไปยังอุปกรณ์นั้นแล้ว");
  } catch (error) {
    showToast(`DISCONNECT: ${error.message}`, 5200);
  }
}

async function toggleRemoteControl(enabled) {
  try {
    await initializeRemote().setRemoteControl(enabled, {
      durationMs: 10 * 60 * 1000,
      viewerId: $("#remoteViewerSelect").value,
    });
    showToast(enabled ? "อนุญาตเฉพาะ RWANG UI เป็นเวลา 10 นาที" : "ปิดการควบคุมจากมือถือแล้ว");
  } catch (error) {
    showToast(`Remote: ${error.message}`, 5200);
  }
}

function commandFromRemoteButton(value) {
  if (["assistant", "loadout", "systems"].includes(value)) return { action: "navigate", target: value };
  if (value === "scroll-up") return { action: "scroll", direction: "up", amount: 480 };
  if (value === "scroll-down") return { action: "scroll", direction: "down", amount: 480 };
  if (["top", "bottom"].includes(value)) return { action: "scroll", direction: value };
  if (["skills", "schedule", "integrations"].includes(value)) return { action: "spotlight", target: value, durationMs: 3500 };
  return null;
}

async function sendRemoteButtonCommand(event) {
  const button = event.target.closest("button[data-remote-command]");
  if (!button) return;
  const command = commandFromRemoteButton(button.dataset.remoteCommand);
  if (!command) return;
  try {
    await initializeRemote().sendCommand(command);
  } catch (error) {
    showToast(`Remote: ${error.message}`);
  }
}

function switchView(name) {
  const target = ["assistant", "loadout", "systems"].includes(name) ? name : "assistant";
  for (const [viewName, selector] of [["assistant", "#assistantView"], ["loadout", "#loadoutView"], ["systems", "#systemsView"]]) {
    const view = $(selector);
    const active = viewName === target;
    view.hidden = !active;
    view.classList.toggle("active", active);
  }
  for (const button of $$(".nav-button")) button.classList.toggle("active", button.dataset.view === target);
  history.replaceState(null, "", `${location.pathname}${location.search}#${target}`);
  if (target !== "assistant") void refreshStatus({ silent: true });
}

function openSettings(tab = "assistant") {
  hydrateSettings();
  selectSettingsTab(tab);
  const dialog = $("#settingsDialog");
  if (!dialog.open) dialog.showModal();
}

function selectSettingsTab(tab) {
  for (const button of $$("[data-settings-tab]")) button.classList.toggle("active", button.dataset.settingsTab === tab);
  for (const panel of $$("[data-tab-panel]")) panel.classList.toggle("active", panel.dataset.tabPanel === tab);
}

async function postConfig(body, successMessage) {
  const result = await apiFetch("/api/rwang/config", { method: "POST", body });
  await refreshStatus({ silent: true });
  if (successMessage) showToast(successMessage);
  return result;
}

function parseJsonField(field, fallback, expected) {
  const raw = field.value.trim();
  if (!raw) return fallback;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${field.closest("label")?.firstChild?.textContent?.trim() || "JSON"} ไม่ใช่ JSON ที่ถูกต้อง`);
  }
  if (expected === "array" && !Array.isArray(value)) throw new Error("Args ต้องเป็น JSON array");
  if (expected === "object" && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("Headers ต้องเป็น JSON object");
  return value;
}

async function handleAssistantSettings(event) {
  event.preventDefault();
  try {
    await postConfig({
      section: "assistant",
      wakeWord: $("#wakeWordInput").value,
      language: $("#languageInput").value,
      defaultModel: $("#defaultModelInput").value,
      autoSpeak: $("#settingsAutoSpeak").checked,
    }, "บันทึกตัวตนและเสียงของ RWANG แล้ว");
    $("#autoSpeakToggle").checked = $("#settingsAutoSpeak").checked;
    if (state.recognition) state.recognition.lang = $("#languageInput").value;
  } catch (error) {
    showToast(`บันทึกไม่สำเร็จ: ${error.message}`);
  }
}

async function handlePerceptionSettings(event) {
  event.preventDefault();
  const threshold = Math.max(0.5, Math.min(0.99, Number($("#perceptionThresholdInput").value) || 0.82));
  try {
    await postConfig({
      section: "features",
      features: {
        gesture: $("#gestureEnabledInput").checked,
        faceRecognition: $("#faceEnabledInput").checked,
        voiceRecognition: $("#voiceIdEnabledInput").checked,
      },
    });
    writeStorage(STORAGE_PERCEPTION_THRESHOLD, String(threshold));
    writeStorage(STORAGE_PRESENCE_REQUIRED, $("#presenceRequiredInput").checked ? "1" : "0");
    await initializePerception({ recreate: true });
    showToast("บันทึก Perception แล้ว · โปรไฟล์ทดลองยังไม่ใช้แทน token หรือ approval");
  } catch (error) {
    showToast(`Perception: ${error.message}`, 5200);
  }
}

async function handleScheduleSettings(event) {
  event.preventDefault();
  try {
    await postConfig({
      section: "scheduler",
      enabled: $("#schedulerEnabledInput").checked,
      timeZone: $("#scheduleTimeZoneInput").value,
      missedRun: $("#missedScheduleInput").value,
      requireApproval: $("#scheduleGlobalApprovalInput").checked,
    }, "บันทึกกติกา Schedule แล้ว");
  } catch (error) {
    showToast(`Schedule: ${error.message}`, 5200);
  }
}

async function handlePerceptionModeChange() {
  if (state.rwang?.access?.local === false) return;
  const values = Object.fromEntries($$('[data-perception-mode]').map((input) => [input.dataset.perceptionMode, input.checked]));
  try {
    await postConfig({
      section: "features",
      features: {
        gesture: values.gesture,
        faceRecognition: values.face,
        voiceRecognition: values.voice,
      },
    });
  } catch (error) {
    showToast(`Perception: ${error.message}`);
  }
}

async function handleSkillInventoryClick(event) {
  const button = event.target.closest("button[data-skill-action]");
  if (!button) return;
  if (state.rwang?.access?.local === false) return showToast("จัดการ skills ได้จากเครื่องหลักเท่านั้น");
  const skill = state.rwang?.skills?.find((item) => item.id === button.dataset.skillId);
  if (!skill) return;
  button.disabled = true;
  try {
    await postConfig({ section: "skills", id: skill.id, enabled: !skill.enabled }, `${skill.name}: ${skill.enabled ? "ถอดออกจาก loadout" : "ติดตั้งใน loadout"} แล้ว`);
  } catch (error) {
    showToast(`Skill: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function toDatetimeLocal(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

async function handleScheduleForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const when = new Date($("#scheduleWhenInput").value);
  if (Number.isNaN(when.getTime())) return showToast("กรุณาเลือกเวลาเริ่ม routine");
  try {
    await apiFetch("/api/rwang/schedule", {
      method: "POST",
      body: {
        action: "upsert",
        schedule: {
          id: form.dataset.editId || undefined,
          name: $("#scheduleNameInput").value,
          when: when.toISOString(),
          repeat: $("#scheduleRepeatInput").value,
          prompt: $("#scheduleCommandInput").value,
          requiresApproval: $("#scheduleApprovalInput").checked,
          enabled: true,
        },
      },
    });
    form.reset();
    delete form.dataset.editId;
    form.querySelector("button[type='submit']").textContent = "ADD ROUTINE";
    $("#scheduleApprovalInput").checked = true;
    $("#scheduleWhenInput").value = toDatetimeLocal(Date.now() + 60 * 60 * 1000);
    await refreshStatus({ silent: true });
    showToast("บันทึก routine แล้ว · external actions ยังผ่าน approval gate");
  } catch (error) {
    showToast(`Schedule: ${error.message}`, 5200);
  }
}

async function handleScheduleListClick(event) {
  const button = event.target.closest("button[data-schedule-action]");
  if (!button) return;
  const schedule = state.rwang?.schedules?.find((item) => item.id === button.dataset.scheduleId);
  if (!schedule) return;
  const action = button.dataset.scheduleAction;
  if (action === "edit") {
    const form = $("#scheduleForm");
    form.dataset.editId = schedule.id;
    $("#scheduleNameInput").value = schedule.name;
    $("#scheduleWhenInput").value = toDatetimeLocal(schedule.nextRunAt);
    $("#scheduleRepeatInput").value = schedule.repeat;
    $("#scheduleCommandInput").value = schedule.prompt || "";
    $("#scheduleApprovalInput").checked = schedule.requiresApproval !== false;
    form.querySelector("button[type='submit']").textContent = "UPDATE ROUTINE";
    $("#scheduleNameInput").focus();
    return;
  }
  if (action === "remove" && !window.confirm(`ลบ routine “${schedule.name}” หรือไม่`)) return;
  button.disabled = true;
  try {
    const body = { action, id: schedule.id };
    if (action === "toggle") body.enabled = !schedule.enabled;
    if (action === "snooze") body.minutes = 10;
    if (action === "run") body.expectedNextRunAt = schedule.nextRunAt;
    const result = await apiFetch("/api/rwang/schedule", { method: "POST", body });
    await refreshStatus({ silent: true });
    if (action === "run") {
      switchView("assistant");
      await sendPrompt(result.prompt);
    } else {
      showToast(action === "remove" ? "ลบ routine แล้ว" : action === "snooze" ? "เลื่อน routine ออกไป 10 นาที" : "อัปเดต routine แล้ว");
    }
  } catch (error) {
    showToast(`Schedule: ${error.message}`, 5200);
  } finally {
    button.disabled = false;
  }
}

async function handleHomeAssistantSettings(event) {
  event.preventDefault();
  try {
    const result = await postConfig({
      section: "home-assistant",
      enabled: $("#haEnabledInput").checked,
      baseUrl: $("#haUrlInput").value,
      token: $("#haTokenInput").value,
    });
    $("#haTokenInput").value = "";
    showToast(result.status?.state === "online" ? "เชื่อมต่อ Home Assistant สำเร็จ" : `บันทึกแล้ว · ${result.status?.message || result.status?.state || "รอทดสอบ"}`);
  } catch (error) {
    showToast(`Home Assistant: ${error.message}`, 5000);
  }
}

function updateMcpTransportFields() {
  const stdio = $("#mcpTransportInput").value === "stdio";
  $("#mcpTargetLabel").childNodes[0].nodeValue = stdio ? "Command" : "MCP URL";
  $("#mcpTargetInput").placeholder = stdio ? "node" : "http://127.0.0.1:3000/mcp";
  $("#mcpArgsLabel").hidden = !stdio;
}

async function handleMcpForm(event) {
  event.preventDefault();
  try {
    const transport = $("#mcpTransportInput").value;
    const target = $("#mcpTargetInput").value.trim();
    const server = {
      id: $("#mcpIdInput").value || undefined,
      name: $("#mcpNameInput").value,
      enabled: true,
      transport,
      url: transport === "stdio" ? "" : target,
      command: transport === "stdio" ? target : "",
      args: transport === "stdio" ? parseJsonField($("#mcpArgsInput"), [], "array") : [],
      headers: parseJsonField($("#mcpHeadersInput"), {}, "object"),
    };
    await postConfig(
      { section: "mcp", server, trust: false },
      "บันทึกและตรวจ MCP server แล้ว · ตรวจรายการ tools ก่อนกด TRUST TOOLS",
    );
    event.currentTarget.reset();
    $("#mcpIdInput").value = "";
    $("#mcpTransportInput").value = "http";
    updateMcpTransportFields();
  } catch (error) {
    showToast(`MCP: ${error.message}`, 5200);
  }
}

async function handleMcpListClick(event) {
  const button = event.target.closest("button[data-mcp-action]");
  if (!button) return;
  const server = state.rwang?.mcpServers?.find((item) => item.id === button.dataset.id);
  if (!server) return;
  const action = button.dataset.mcpAction;
  if (action === "edit") {
    $("#mcpIdInput").value = server.id;
    $("#mcpNameInput").value = server.name;
    $("#mcpTransportInput").value = server.transport;
    $("#mcpTargetInput").value = server.target || "";
    $("#mcpArgsInput").value = "";
    $("#mcpHeadersInput").value = "";
    updateMcpTransportFields();
    $("#mcpNameInput").focus();
    return;
  }
  if (action === "remove" && !window.confirm(`ลบ MCP server “${server.name}” หรือไม่`)) return;
  button.disabled = true;
  try {
    if (action === "remove") {
      await postConfig({ section: "mcp", action: "remove", id: server.id }, "ลบ MCP server แล้ว");
    } else {
      const result = await apiFetch("/api/rwang/test", { method: "POST", body: { type: "mcp", id: server.id, trust: action === "trust" } });
      await refreshStatus({ silent: true });
      showToast(`${server.name}: ${result.message || result.state}`);
    }
  } catch (error) {
    showToast(`MCP: ${error.message}`, 5200);
  } finally {
    button.disabled = false;
  }
}

async function handleWebhookForm(event) {
  event.preventDefault();
  try {
    const webhook = {
      id: $("#webhookIdInput").value || undefined,
      name: $("#webhookNameInput").value,
      enabled: true,
      method: $("#webhookMethodInput").value,
      url: $("#webhookUrlInput").value,
      headers: parseJsonField($("#webhookHeadersInput"), {}, "object"),
    };
    await postConfig({ section: "webhook", webhook }, "บันทึก IoT webhook แล้ว · ทุกครั้งที่เรียกยังต้องอนุมัติ");
    event.currentTarget.reset();
    $("#webhookIdInput").value = "";
  } catch (error) {
    showToast(`Webhook: ${error.message}`, 5200);
  }
}

async function handleWebhookListClick(event) {
  const button = event.target.closest("button[data-webhook-action]");
  if (!button) return;
  const hook = state.rwang?.webhooks?.find((item) => item.id === button.dataset.id);
  if (!hook) return;
  if (button.dataset.webhookAction === "edit") {
    $("#webhookIdInput").value = hook.id;
    $("#webhookNameInput").value = hook.name;
    $("#webhookMethodInput").value = hook.method;
    $("#webhookUrlInput").value = hook.target || "";
    $("#webhookHeadersInput").value = "";
    $("#webhookNameInput").focus();
    return;
  }
  if (!window.confirm(`ลบ webhook “${hook.name}” หรือไม่`)) return;
  try {
    await postConfig({ section: "webhook", action: "remove", id: hook.id }, "ลบ IoT webhook แล้ว");
  } catch (error) {
    showToast(`Webhook: ${error.message}`);
  }
}

async function resolveApproval(id, decision, button) {
  button.disabled = true;
  try {
    const result = await apiFetch("/api/rwang/approval", { method: "POST", body: { id, decision } });
    showToast(decision === "approve" ? "ดำเนินการที่อนุมัติสำเร็จ" : "ปฏิเสธคำสั่งแล้ว");
    await refreshStatus({ silent: true });
    if (result.approval?.result && decision === "approve") appendMessage("assistant", `ผลการทำงานที่อนุมัติ: ${result.approval.result}`);
  } catch (error) {
    showToast(`Approval: ${error.message}`, 5200);
    await refreshStatus({ silent: true });
  } finally {
    button.disabled = false;
  }
}

async function postSystemAction(body, successMessage = "ส่งคำสั่งแล้ว") {
  const result = await apiFetch("/api/action", { method: "POST", body });
  showToast(result.message || successMessage);
  await refreshStatus({ silent: true });
  return result;
}

async function handleCommand(event) {
  event.preventDefault();
  const command = $("#commandInput").value.trim();
  if (!command) return;
  const output = $("#commandOutput");
  output.classList.remove("error");
  output.textContent = "กำลังส่งคำสั่ง...";
  $("#executeButton").disabled = true;
  try {
    const result = await postSystemAction({ type: "command", command }, "ส่งคำสั่งแล้ว");
    output.textContent = result.message || "ดำเนินการสำเร็จ";
    if (result.model && result.message?.includes("รัน")) $("#modelSelect").value = result.model;
  } catch (error) {
    output.classList.add("error");
    output.textContent = error.message;
  } finally {
    $("#executeButton").disabled = false;
  }
}

async function handleQueueAction(event) {
  const direct = event.target.closest("button[data-action]");
  const row = event.target.closest("button[data-model-action]");
  if (!direct && !row) return;
  const button = direct || row;
  button.disabled = true;
  try {
    if (direct) await postSystemAction({ type: direct.dataset.action });
    else {
      const type = row.dataset.modelAction;
      const body = { type, model: row.dataset.model };
      if (row.dataset.id) body.id = row.dataset.id;
      await postSystemAction(body);
    }
  } catch (error) {
    showToast(`SYSTEMS: ${error.message}`, 5200);
  } finally {
    button.disabled = false;
  }
}

async function handleMemoryAction(event) {
  const button = event.target.closest("button[data-memory-action]");
  if (!button) return;
  button.disabled = true;
  try {
    await postSystemAction({ type: button.dataset.memoryAction, model: button.dataset.model });
  } catch (error) {
    showToast(`Model: ${error.message}`, 5200);
  } finally {
    button.disabled = false;
  }
}

async function copyMobileUrl() {
  const output = $("#mobileUrlOutput");
  try {
    await navigator.clipboard.writeText(output.value);
    showToast("คัดลอก Mobile URL แล้ว");
  } catch {
    output.focus();
    output.select();
    document.execCommand("copy");
    showToast("คัดลอก Mobile URL แล้ว");
  }
}

async function createPairingCode() {
  try {
    const result = await apiFetch("/api/rwang/pairing", { method: "POST", body: { action: "create" } });
    state.pairingCode = String(result.code || "");
    state.pairingExpiresAt = result.expiresAt || "";
    if (state.rwang?.access) {
      state.rwang.access.pairingActive = true;
      state.rwang.access.pairingExpiresAt = state.pairingExpiresAt;
    }
    renderMobile(state.rwang || {});
    showToast("สร้างรหัสจับคู่ใช้ครั้งเดียวแล้ว · หมดอายุใน 3 นาที");
  } catch (error) {
    showToast(`สร้างรหัสจับคู่ไม่สำเร็จ: ${error.message}`, 5200);
  }
}

async function cancelPairingCode() {
  try {
    await apiFetch("/api/rwang/pairing", { method: "POST", body: { action: "cancel" } });
    state.pairingCode = "";
    state.pairingExpiresAt = "";
    await refreshStatus({ silent: true });
    showToast("ยกเลิกรหัสจับคู่แล้ว");
  } catch (error) {
    showToast(`ยกเลิกรหัสไม่สำเร็จ: ${error.message}`);
  }
}

async function handlePairedDeviceAction(event) {
  const button = event.target.closest("button[data-device-action]");
  if (!button || button.dataset.deviceAction !== "revoke") return;
  try {
    await apiFetch("/api/rwang/pairing", {
      method: "POST",
      body: { action: "revoke", id: button.dataset.deviceId },
    });
    await refreshStatus({ silent: true });
    showToast("ยกเลิกสิทธิ์อุปกรณ์แล้ว");
  } catch (error) {
    showToast(`Revoke ไม่สำเร็จ: ${error.message}`);
  }
}

async function rotateAccessToken() {
  if (!window.confirm("หมุน master token และยกเลิกสิทธิ์อุปกรณ์มือถือทั้งหมดหรือไม่")) return;
  try {
    await apiFetch("/api/rwang/rotate-token", { method: "POST", body: {} });
    state.accessToken = "";
    await refreshStatus({ silent: true });
    state.pairingCode = "";
    state.pairingExpiresAt = "";
    showToast("หมุน master token และ revoke อุปกรณ์ทั้งหมดแล้ว");
  } catch (error) {
    showToast(`เปลี่ยน token ไม่สำเร็จ: ${error.message}`);
  }
}

function setupPwa() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker
      .register("/service-worker.js?v=7", { updateViaCache: "none" })
      .catch(() => {}));
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstall = event;
    $("#installButton").hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    state.deferredInstall = null;
    $("#installButton").hidden = true;
    showToast("ติดตั้ง RWANG บนอุปกรณ์แล้ว");
  });
  $("#installButton").addEventListener("click", async () => {
    if (!state.deferredInstall) return;
    state.deferredInstall.prompt();
    await state.deferredInstall.userChoice;
    state.deferredInstall = null;
    $("#installButton").hidden = true;
  });
}

function scopedShareReferenceFromUrl() {
  const url = new URL(location.href);
  const fragmentQuery = url.hash.includes("?") ? url.hash.split("?")[1] : "";
  const fragment = new URLSearchParams(fragmentQuery);
  const sessionId = fragment.get("remoteSession");
  const shareToken = fragment.get("shareToken");
  if (!sessionId || !shareToken) return null;
  history.replaceState(null, "", `${url.pathname}${url.search}#loadout`);
  return { sessionId, shareToken };
}

async function enterScopedViewer(reference) {
  state.rwang = {
    identity: { name: "RWANG", thaiName: "อาหวัง", wakeWord: "อาหวัง", language: "th-TH", autoSpeak: false },
    access: { local: false, authenticated: true, lanUrls: [] },
    features: { gesture: false, faceRecognition: false, voiceRecognition: false, screenShare: true, mobileRemote: true },
    skills: [
      { id: "screen_share", name: "Vision Relay", category: "REMOTE", level: 4, enabled: true, configured: true },
      { id: "mobile_remote", name: "Safe Remote", category: "REMOTE", level: 4, enabled: true, configured: true },
    ],
    scheduler: { enabled: false, timeZone: "Asia/Bangkok", missedRun: "skip", requireApproval: true },
    schedules: [],
    loadout: { level: 1, xp: 0, nextLevelXp: 250, equipped: 2, capacity: 2, activeFeatures: 2, connected: 1 },
    homeAssistant: { enabled: false, configured: false, state: "disabled" },
    mcpServers: [],
    webhooks: [],
    approvals: [],
  };
  state.status = { online: true, version: "VIEW", installed: [], running: [], presets: [], queueState: { jobs: [], log: [] }, remote: {} };
  $("#accessGate").hidden = true;
  renderRwang(state.rwang);
  renderHeader(state.status);
  switchView("loadout");
  await joinScreenShare(reference);
}

function bindEvents() {
  for (const button of $$(".nav-button")) button.addEventListener("click", () => switchView(button.dataset.view));
  $("#settingsButton").addEventListener("click", () => openSettings("assistant"));
  for (const button of $$('[data-open-settings]')) button.addEventListener("click", () => openSettings(button.dataset.openSettings));
  for (const button of $$("[data-settings-tab]")) button.addEventListener("click", () => selectSettingsTab(button.dataset.settingsTab));

  $("#composerForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void sendPrompt($("#chatInput").value);
  });
  $("#chatInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("#composerForm").requestSubmit();
    }
  });
  for (const button of $$("[data-prompt]")) button.addEventListener("click", () => void sendPrompt(button.dataset.prompt));
  $("#stopButton").addEventListener("click", stopChat);
  $("#clearChat").addEventListener("click", () => {
    stopChat();
    state.chatHistory = [];
    $("#chatMessages").replaceChildren(makeWelcome());
    showToast("ล้างบทสนทนาแล้ว");
  });

  $("#micButton").addEventListener("click", () => {
    if (state.voiceMode || state.recognitionStarting) stopRecognition();
    else startRecognition("push");
  });
  $("#composerMic").addEventListener("click", () => {
    if (state.voiceMode || state.recognitionStarting) stopRecognition();
    else startRecognition("push");
  });
  $("#wakeToggle").addEventListener("change", (event) => {
    writeStorage(STORAGE_WAKE, event.currentTarget.checked ? "1" : "");
    if (event.currentTarget.checked) startRecognition("wake");
    else {
      state.wakeResume = false;
      stopRecognition();
      setCore("standby");
    }
  });
  $("#autoSpeakToggle").addEventListener("change", async (event) => {
    $("#settingsAutoSpeak").checked = event.currentTarget.checked;
    writeStorage(STORAGE_AUTO_SPEAK, event.currentTarget.checked ? "1" : "0");
    if (!event.currentTarget.checked) window.speechSynthesis?.cancel();
    if (!state.rwang) return;
    if (state.rwang.access?.local === false) {
      showToast(event.currentTarget.checked ? "เปิด Auto Speak บนอุปกรณ์นี้แล้ว" : "ปิด Auto Speak บนอุปกรณ์นี้แล้ว");
      return;
    }
    try {
      await postConfig({
        section: "assistant",
        wakeWord: state.rwang.identity.wakeWord,
        language: state.rwang.identity.language,
        defaultModel: state.rwang.identity.defaultModel,
        autoSpeak: event.currentTarget.checked,
      });
    } catch (error) {
      showToast(`บันทึก Auto Speak ไม่สำเร็จ: ${error.message}`);
    }
  });

  $("#approvalList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-approval-id]");
    if (button) void resolveApproval(button.dataset.approvalId, button.dataset.decision, button);
  });

  $("#assistantSettings").addEventListener("submit", handleAssistantSettings);
  $("#perceptionSettings").addEventListener("submit", handlePerceptionSettings);
  $("#clearBiometricsButton").addEventListener("click", () => void clearBiometricProfiles());
  $("#homeAssistantForm").addEventListener("submit", handleHomeAssistantSettings);
  $("#mcpForm").addEventListener("submit", handleMcpForm);
  $("#mcpTransportInput").addEventListener("change", updateMcpTransportFields);
  $("#mcpServerList").addEventListener("click", handleMcpListClick);
  $("#webhookForm").addEventListener("submit", handleWebhookForm);
  $("#webhookList").addEventListener("click", handleWebhookListClick);
  $("#copyMobileUrl").addEventListener("click", copyMobileUrl);
  $("#createPairCode").addEventListener("click", () => void createPairingCode());
  $("#cancelPairCode").addEventListener("click", () => void cancelPairingCode());
  $("#pairedDeviceList").addEventListener("click", (event) => void handlePairedDeviceAction(event));
  $("#rotateToken").addEventListener("click", rotateAccessToken);

  $("#skillInventory").addEventListener("click", handleSkillInventoryClick);
  $("#manageSkillsButton").addEventListener("click", () => openSettings("mcp"));
  for (const input of $$('[data-perception-mode]')) input.addEventListener("change", () => void handlePerceptionModeChange());
  $("#startPerceptionButton").addEventListener("click", () => void startPerception());
  $("#stopPerceptionButton").addEventListener("click", () => void stopPerception());
  $("#calibrateGestureButton").addEventListener("click", () => {
    void startPerception();
    showToast("GESTURES · ฝ่ามือ=Assistant · ชี้=Systems · V=Loadout · โป้งขึ้น/ลง=เลื่อน · กำมือ=หยุด", 7000);
  });
  $("#enrollFaceButton").addEventListener("click", () => void enrollOrVerifyFace());
  $("#enrollVoiceButton").addEventListener("click", () => void enrollOrVerifyVoice());

  $("#scheduleSettings").addEventListener("submit", handleScheduleSettings);
  $("#scheduleForm").addEventListener("submit", handleScheduleForm);
  $("#scheduleList").addEventListener("click", handleScheduleListClick);

  $("#startShareButton").addEventListener("click", () => void startScreenShare());
  $("#stopShareButton").addEventListener("click", () => void stopScreenShare());
  $("#joinShareButton").addEventListener("click", () => void joinScreenShare());
  $("#copyShareLinkButton").addEventListener("click", () => void copyShareLink());
  $("#remoteEnableButton").addEventListener("click", () => void toggleRemoteControl(true));
  $("#remoteViewerSelect").addEventListener("change", () => renderRemoteState(state.remoteState || {}));
  $("#remoteDisconnectButton").addEventListener("click", () => void disconnectRemoteViewer());
  $(".remote-deck").addEventListener("click", (event) => void sendRemoteButtonCommand(event));

  $("#commandForm").addEventListener("submit", handleCommand);
  $("#modelList").addEventListener("click", handleQueueAction);
  $(".panel-actions").addEventListener("click", handleQueueAction);
  $("#installedGrid").addEventListener("click", handleMemoryAction);
  $("#refreshButton").addEventListener("click", () => void refreshStatus());

  $("#accessForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const supplied = $("#accessTokenInput").value.trim().replace(/\s+/g, "");
    if (!supplied) return;
    if (/^\d{8}$/.test(supplied)) {
      try {
        const response = await fetch("/api/rwang/pair", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            code: supplied,
            name: `${navigator.platform || "Mobile"} · RWANG`,
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new ApiError(payload.error || "จับคู่ไม่สำเร็จ", response.status, payload);
        state.accessToken = "";
        const result = await refreshStatus();
        if (!result) throw new Error("ได้รับ credential แล้วแต่เชื่อมต่อไม่สำเร็จ");
        $("#accessTokenInput").value = "";
        showToast("จับคู่อุปกรณ์สำเร็จ · ไม่ได้ส่ง master token มายังเครื่องนี้");
      } catch (error) {
        $("#accessError").textContent = error.message;
      }
      return;
    }
    state.accessToken = supplied;
    const result = await refreshStatus();
    if (result) {
      $("#accessTokenInput").value = "";
      showToast("เชื่อมต่อด้วย recovery token สำเร็จ");
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (state.voiceMode === "wake") stopRecognition({ keepWake: true });
    } else {
      void refreshStatus({ silent: true });
      if ($("#wakeToggle").checked) scheduleWakeRestart();
    }
  });
  window.addEventListener("beforeunload", () => {
    disconnectEvents();
    stopRecognition();
    state.chatController?.abort();
    void state.perception?.destroy();
    void state.remote?.close();
  });
}

async function bootstrap() {
  scrubLegacyAccessToken();
  bindEvents();
  setupPwa();
  initializeRemote();
  updateMcpTransportFields();
  $("#perceptionThresholdInput").value = readStorage(STORAGE_PERCEPTION_THRESHOLD) || "0.82";
  $("#presenceRequiredInput").checked = readStorage(STORAGE_PRESENCE_REQUIRED) !== "0";
  $("#scheduleWhenInput").value = toDatetimeLocal(Date.now() + 60 * 60 * 1000);
  $("#wakeToggle").checked = readStorage(STORAGE_WAKE) === "1";
  const shareReference = scopedShareReferenceFromUrl();
  if (shareReference) {
    await enterScopedViewer(shareReference);
    return;
  }
  const requestedView = ["#assistant", "#loadout", "#systems"].includes(location.hash) ? location.hash.slice(1) : "assistant";
  switchView(requestedView);
  const status = await refreshStatus();
  if (status && $("#wakeToggle").checked) scheduleWakeRestart();
  setInterval(() => {
    if (!document.hidden) void refreshStatus({ silent: true });
  }, 15000);
}

void bootstrap();
