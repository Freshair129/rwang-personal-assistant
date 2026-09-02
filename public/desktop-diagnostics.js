/*
 * RWANG desktop media-parity diagnostics.
 *
 * This page is deliberately local-only. Capability checks read browser
 * properties and same-origin asset headers. Camera, microphone, and display
 * capture are only requested from the explicit user-button handlers below.
 * Every obtained MediaStream is stopped before the result is rendered.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SAFE_MEDIA_ERRORS = new Set([
  "AbortError",
  "NotAllowedError",
  "NotFoundError",
  "NotReadableError",
  "OverconstrainedError",
  "SecurityError",
  "TypeError",
]);

const MEDIAPIPE_ASSETS = Object.freeze([
  { path: "/vendor/tasks-vision.mjs", label: "MediaPipe tasks-vision module", required: true },
  { path: "/vendor/wasm/vision_wasm_internal.js", label: "MediaPipe WASM internal JS", required: true },
  { path: "/vendor/wasm/vision_wasm_internal.wasm", label: "MediaPipe WASM internal binary", required: true },
  { path: "/vendor/wasm/vision_wasm_module_internal.js", label: "MediaPipe WASM module JS", required: true },
  { path: "/vendor/wasm/vision_wasm_module_internal.wasm", label: "MediaPipe WASM module binary", required: true },
  { path: "/vendor/wasm/vision_wasm_nosimd_internal.js", label: "MediaPipe WASM fallback JS", required: true },
  { path: "/vendor/wasm/vision_wasm_nosimd_internal.wasm", label: "MediaPipe WASM fallback binary", required: true },
  { path: "/vendor/gesture_recognizer.task", label: "Gesture recognizer model", required: true },
  { path: "/vendor/face_landmarker.task", label: "Face landmarker model", required: true },
  { path: "/vendor/hand_landmarker.task", label: "Optional hand landmarker model", required: false },
]);

const state = {
  activeKind: "",
  originIsLoopback: false,
  passiveDone: false,
  results: new Map(),
};

function $(id) {
  return document.getElementById(id);
}

function statusClass(status) {
  return {
    pass: "complete",
    warn: "retrying",
    fail: "failed",
    pending: "retrying",
  }[status] || "";
}

function statusText(status) {
  return {
    pass: "PASS",
    warn: "WARN",
    fail: "FAIL",
    pending: "CHECKING",
  }[status] || "NOT RUN";
}

function setPill(element, status, text = statusText(status)) {
  if (!element) return;
  element.className = `status-pill ${statusClass(status)}`.trim();
  element.textContent = text;
}

function isLoopbackOrigin() {
  const protocol = window.location.protocol;
  const hostname = String(window.location.hostname || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return (protocol === "http:" || protocol === "https:") && LOOPBACK_HOSTS.has(hostname);
}

function originDetail() {
  if (state.originIsLoopback) return `${window.location.origin} · loopback`;
  if (window.location.origin === "null") return "opaque origin · เปิดผ่าน local server หรือ Tauri sidecar";
  return `${window.location.origin} · ไม่ใช่ loopback`;
}

function renderResult(result) {
  const tbody = $("resultRows");
  let row = tbody.querySelector(`tr[data-result-id="${result.id}"]`);
  if (!row) {
    row = document.createElement("tr");
    row.dataset.resultId = result.id;
    const labelCell = document.createElement("th");
    labelCell.scope = "row";
    const statusCell = document.createElement("td");
    const detailCell = document.createElement("td");
    row.append(labelCell, statusCell, detailCell);
    tbody.append(row);
  }

  row.children[0].textContent = result.label;
  row.children[1].replaceChildren();
  const pill = document.createElement("span");
  pill.className = `status-pill ${statusClass(result.status)}`.trim();
  pill.textContent = statusText(result.status);
  row.children[1].append(pill);
  row.children[2].textContent = result.detail;
}

function setResult(id, label, status, detail, category = "passive") {
  const result = { id, label, status, detail, category };
  state.results.set(id, result);
  renderResult(result);
  updateSummary();
}

function summarize(category) {
  const results = [...state.results.values()].filter((result) => result.category === category);
  return {
    total: results.length,
    pass: results.filter((result) => result.status === "pass").length,
    warn: results.filter((result) => result.status === "warn").length,
    fail: results.filter((result) => result.status === "fail").length,
    pending: results.filter((result) => result.status === "pending").length,
  };
}

function updateSummary() {
  const passive = summarize("passive");
  const active = summarize("active");
  const passiveReady = state.passiveDone && passive.pending === 0 && passive.total > 0;
  const activeReady = active.pending === 0;

  $("passiveSummary").textContent = passive.total ? `${passive.pass}/${passive.total}` : "—";
  $("passiveDetail").textContent = passiveReady
    ? `${passive.warn} warning · ${passive.fail} fail`
    : "กำลังตรวจ capability และ asset";
  $("activeSummary").textContent = active.total ? `${active.pass}/${active.total}` : "—";
  $("activeDetail").textContent = active.total
    ? `${active.warn} blocked · ${active.fail} error`
    : "ยังไม่มีการขอ permission";

  if (passiveReady) {
    const passiveStatus = passive.fail ? "fail" : passive.warn ? "warn" : "pass";
    setPill($("passiveStatus"), passiveStatus, passive.fail ? "ATTENTION" : passive.warn ? "REVIEW" : "READY");
  }
  if (active.total && activeReady) {
    const activeStatus = active.fail ? "fail" : active.warn ? "warn" : "pass";
    setPill($("activeStatus"), activeStatus, active.fail ? "ERROR" : active.warn ? "REVIEW" : "READY");
  } else if (state.activeKind) {
    setPill($("activeStatus"), "pending", "RUNNING");
  }

  const overallStatus = passive.fail ? "fail" : passive.warn ? "warn" : passiveReady ? "pass" : "pending";
  const overallLabel = overallStatus === "fail"
    ? "ATTENTION"
    : overallStatus === "warn"
      ? "REVIEW"
      : overallStatus === "pass"
        ? "READY"
        : "RUNNING";
  $("overallSummary").textContent = overallLabel;
  $("overallDetail").textContent = passive.fail
    ? "แก้ปัญหาในตารางก่อนทดสอบ packaged app"
    : "ผลนี้อยู่ในเครื่องนี้เท่านั้น";
  setPill($("passiveStatus"), passiveReady ? (passive.fail ? "fail" : passive.warn ? "warn" : "pass") : "pending", passiveReady ? (passive.fail ? "ATTENTION" : passive.warn ? "REVIEW" : "READY") : "CHECKING");
}

function passiveCapabilityResults() {
  const mediaDevices = navigator.mediaDevices || null;
  const recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  return [
    {
      id: "origin",
      label: "Loopback origin",
      status: state.originIsLoopback ? "pass" : "fail",
      detail: originDetail(),
    },
    {
      id: "secure-context",
      label: "Secure context",
      status: window.isSecureContext === true ? "pass" : "fail",
      detail: window.isSecureContext === true ? "isSecureContext = true" : "isSecureContext = false",
    },
    {
      id: "get-user-media",
      label: "getUserMedia API",
      status: typeof mediaDevices?.getUserMedia === "function" ? "pass" : "warn",
      detail: typeof mediaDevices?.getUserMedia === "function"
        ? "present · not called until a user clicks an active test"
        : "missing · camera and microphone tests unavailable",
    },
    {
      id: "get-display-media",
      label: "getDisplayMedia API",
      status: typeof mediaDevices?.getDisplayMedia === "function" ? "pass" : "warn",
      detail: typeof mediaDevices?.getDisplayMedia === "function"
        ? "present · not called until a user clicks an active test"
        : "missing · display test unavailable",
    },
    {
      id: "rtc-peer-connection",
      label: "RTCPeerConnection",
      status: typeof window.RTCPeerConnection === "function" ? "pass" : "warn",
      detail: typeof window.RTCPeerConnection === "function" ? "constructor present · not instantiated" : "constructor missing",
    },
    {
      id: "speech-recognition",
      label: "SpeechRecognition",
      status: typeof recognition === "function" ? "pass" : "warn",
      detail: typeof recognition === "function" ? "constructor present · not started" : "constructor missing",
    },
    {
      id: "speech-synthesis",
      label: "speechSynthesis",
      status: "speechSynthesis" in window ? "pass" : "warn",
      detail: "speechSynthesis" in window ? "API present · no utterance started" : "API missing",
    },
    {
      id: "webassembly",
      label: "WebAssembly",
      status: typeof window.WebAssembly?.instantiate === "function" ? "pass" : "warn",
      detail: typeof window.WebAssembly?.instantiate === "function" ? "instantiate API present · not compiled" : "WebAssembly unavailable",
    },
    {
      id: "service-worker",
      label: "Service worker",
      status: "serviceWorker" in navigator ? "pass" : "warn",
      detail: "serviceWorker" in navigator ? "API present · no registration attempted" : "API missing",
    },
  ];
}

function safeAssetUrl(pathname) {
  const url = new URL(pathname, window.location.href);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/vendor/")) {
    throw new Error("asset URL must remain same-origin under /vendor/");
  }
  return url;
}

async function probeAsset(asset) {
  if (!state.originIsLoopback) {
    return {
      id: `asset:${asset.path}`,
      label: asset.label,
      status: "fail",
      detail: "skipped · diagnostic page is not on a loopback origin",
    };
  }

  try {
    const url = safeAssetUrl(asset.path);
    const response = await fetch(url, {
      method: "HEAD",
      mode: "same-origin",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    if (response.ok) {
      return { id: `asset:${asset.path}`, label: asset.label, status: "pass", detail: `${asset.path} · ${response.status}` };
    }
    return {
      id: `asset:${asset.path}`,
      label: asset.label,
      status: asset.required ? "fail" : "warn",
      detail: `${asset.path} · HTTP ${response.status}${asset.required ? " · required" : " · optional"}`,
    };
  } catch {
    return {
      id: `asset:${asset.path}`,
      label: asset.label,
      status: asset.required ? "fail" : "warn",
      detail: `${asset.path} · same-origin HEAD failed${asset.required ? " · required" : " · optional"}`,
    };
  }
}

async function runPassiveChecks() {
  for (const result of passiveCapabilityResults()) setResult(result.id, result.label, result.status, result.detail);
  $("originSummary").textContent = state.originIsLoopback ? "LOOPBACK" : "REVIEW";
  $("originDetail").textContent = originDetail();
  const assets = await Promise.all(MEDIAPIPE_ASSETS.map((asset) => probeAsset(asset)));
  for (const result of assets) setResult(result.id, result.label, result.status, result.detail);
  state.passiveDone = true;
  updateSummary();
}

async function requestMedia(kind) {
  if (!navigator.mediaDevices) throw new Error("mediaDevices unavailable");
  if (kind === "camera") return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  if (kind === "microphone") return navigator.mediaDevices.getUserMedia({ video: false, audio: true });
  if (kind === "display") return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  throw new Error("unknown media test");
}

function stopStreamTracks(stream) {
  const tracks = typeof stream?.getTracks === "function" ? stream.getTracks() : [];
  let stopped = 0;
  for (const track of tracks) {
    if (typeof track?.stop !== "function") continue;
    try {
      track.stop();
      stopped += 1;
    } catch {
      // Track shutdown is best effort; never retain a stream reference.
    }
  }
  return stopped;
}

function safeMediaError(error) {
  const name = String(error?.name || "");
  return SAFE_MEDIA_ERRORS.has(name) ? name : "Browser rejected the media request";
}

async function runActiveMediaTest(kind, button) {
  if (state.activeKind) return;
  state.activeKind = kind;
  const buttons = [...document.querySelectorAll("[data-media-test]")];
  buttons.forEach((item) => { item.disabled = true; });
  setPill($("activeStatus"), "pending", "RUNNING");
  $("activeOutput").textContent = `${kind} test กำลังรอผลจาก browser...`;
  setResult(`active:${kind}`, `${kind} permission`, "pending", "user gesture received · requesting one stream", "active");

  let stream = null;
  try {
    // This is intentionally reachable only from the button click listener.
    stream = await requestMedia(kind);
    const stopped = stopStreamTracks(stream);
    stream = null;
    setResult(`active:${kind}`, `${kind} permission`, "pass", `${stopped} track(s) granted and stopped immediately`, "active");
    $("activeOutput").textContent = `${kind} test ผ่าน · หยุด ${stopped} track(s) ทันที`;
  } catch (error) {
    if (stream) stopStreamTracks(stream);
    stream = null;
    const status = SAFE_MEDIA_ERRORS.has(String(error?.name || "")) ? "warn" : "fail";
    setResult(`active:${kind}`, `${kind} permission`, status, `${safeMediaError(error)} · no stream retained`, "active");
    $("activeOutput").textContent = `${kind} test ${status === "warn" ? "ถูกปฏิเสธหรือยกเลิก" : "ผิดพลาด"} · ไม่มี stream ค้าง`;
  } finally {
    if (stream) stopStreamTracks(stream);
    state.activeKind = "";
    buttons.forEach((item) => { item.disabled = false; });
    updateSummary();
  }
}

function updateManualGateState() {
  const checks = [...document.querySelectorAll("[data-gate-check]")];
  const complete = checks.length > 0 && checks.every((check) => check.checked);
  setPill($("manualGateStatus"), complete ? "pass" : "pending", complete ? "READY" : "PENDING");
  if (!complete) $("manualGateOutput").textContent = "MANUAL GATE PENDING · ยังไม่มีการรับรอง";
}

function bindManualGate() {
  const form = $("manualGateForm");
  for (const check of form.querySelectorAll("[data-gate-check]")) check.addEventListener("change", updateManualGateState);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const checks = [...form.querySelectorAll("[data-gate-check]")];
    const remaining = checks.filter((check) => !check.checked);
    if (remaining.length) {
      $("manualGateOutput").textContent = `MANUAL GATE PENDING · เหลือ ${remaining.length} รายการ`;
      remaining[0].focus();
      return;
    }
    setPill($("manualGateStatus"), "pass", "RECORDED");
    $("manualGateOutput").textContent = "MANUAL GATE RECORDED · local attestation เท่านั้น ไม่ได้ส่งข้อมูลออกไป";
  });
}

function init() {
  state.originIsLoopback = isLoopbackOrigin();
  $("originSummary").textContent = state.originIsLoopback ? "LOOPBACK" : "REVIEW";
  $("originDetail").textContent = originDetail();
  for (const button of document.querySelectorAll("[data-media-test]")) {
    button.addEventListener("click", () => { void runActiveMediaTest(button.dataset.mediaTest, button); });
  }
  bindManualGate();
  void runPassiveChecks();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
else init();
