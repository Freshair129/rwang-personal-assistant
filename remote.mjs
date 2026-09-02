import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// RWANG LAN screen-share signaling API. These routes may run before RWANG's master-token gate,
// so every remote-capable endpoint authenticates itself with a scoped, short-lived credential:
//   GET  /api/remote                         - local/full or authenticated/scoped sanitized inventory
//   POST /api/remote/session                - local host creates/stops a session or toggles UI remote control
//   POST /api/remote/join                   - viewer exchanges the session shareToken for viewer credentials
//   POST /api/remote/leave                  - viewerToken-authenticated viewer leaves its session
//   POST /api/remote/signal                 - local host or viewerToken-authenticated WebRTC signaling
//   GET  /api/remote/events                 - role-scoped SSE (local host or viewerId + viewerToken)
//   POST /api/remote/command                - viewerToken-authenticated RWANG UI relay, never OS input

const SESSION_ID_RE = /^rs_[A-Za-z0-9_-]{24}$/;
const VIEWER_ID_RE = /^rv_[A-Za-z0-9_-]{24}$/;
const SCOPED_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const MAX_SESSIONS = 1;
const DEFAULT_MAX_VIEWERS = 1;
const HARD_MAX_VIEWERS = 8;
const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MIN_SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const SHARE_INVITE_TTL_MS = 5 * 60 * 1000;
const VIEWER_IDLE_TTL_MS = 30 * 60 * 1000;
const PRUNE_INTERVAL_MS = 20 * 1000;
const KEEPALIVE_INTERVAL_MS = 20 * 1000;
const MAX_SDP_BYTES = 128 * 1024;
const MAX_ICE_BYTES = 8 * 1024;
const MAX_COMMAND_BYTES = 2 * 1024;
const MAX_EVENT_COUNT = 64;
const MAX_EVENT_HISTORY_BYTES = 512 * 1024;
const MAX_SSE_CLIENTS_PER_ROLE = 2;
const EVENT_TICKET_TTL_MS = 30 * 1000;
const MAX_EVENT_TICKETS = 64;
const DEFAULT_CONTROL_DURATION_MS = 10 * 60 * 1000;
const MIN_CONTROL_DURATION_MS = 10 * 1000;
// Ten minutes is a security boundary, not merely a UI default. Keep the server
// authoritative even when a browser tab is suspended and its timers do not run.
const MAX_CONTROL_DURATION_MS = DEFAULT_CONTROL_DURATION_MS;
const RATE_LIMITS = {
  join: { limit: 12, windowMs: 60 * 1000 },
  signal: { limit: 240, windowMs: 60 * 1000 },
  command: { limit: 120, windowMs: 60 * 1000 },
  events: { limit: 30, windowMs: 60 * 1000 },
};

const NAVIGATION_TARGETS = new Set(["assistant", "systems", "loadout"]);
const SPOTLIGHT_TARGETS = new Set([
  "voice-core",
  "chat",
  "approvals",
  "integrations",
  "connectors",
  "skills",
  "schedule",
  "models",
  "queue",
  "logs",
  "loadout",
]);
const SHARE_MODES = new Set(["application", "browser", "screen"]);

function iso(time = Date.now()) {
  return new Date(time).toISOString();
}

function randomId(prefix) {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function randomScopedToken() {
  return randomBytes(24).toString("base64url");
}

function tokenDigest(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest();
}

function requireTokenMatch(supplied, expected, message) {
  const value = typeof supplied === "string" ? supplied.slice(0, 256) : "";
  const matches = timingSafeEqual(tokenDigest(value), tokenDigest(expected));
  if (!SCOPED_TOKEN_RE.test(value) || !matches) fail(401, message);
}

function cleanText(value, max = 100) {
  return String(value ?? "").trim().slice(0, max);
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function byteLength(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function requireSessionId(value) {
  const id = String(value ?? "").slice(0, 100);
  if (!SESSION_ID_RE.test(id)) fail(400, "รูปแบบ sessionId ไม่ถูกต้อง");
  return id;
}

function requireViewerId(value) {
  const id = String(value ?? "").slice(0, 100);
  if (!VIEWER_ID_RE.test(id)) fail(400, "รูปแบบ viewerId ไม่ถูกต้อง");
  return id;
}

function normalizeSignal(input, role) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail(400, "signal ต้องเป็น object");
  }
  const kind = String(input.type ?? "").toLowerCase();
  if (role === "host" && !["offer", "ice"].includes(kind)) {
    fail(400, "host ส่งได้เฉพาะ offer หรือ ICE");
  }
  if (role === "viewer" && !["answer", "ice"].includes(kind)) {
    fail(400, "viewer ส่งได้เฉพาะ answer หรือ ICE");
  }

  if (kind === "offer" || kind === "answer") {
    const sdp = typeof input.sdp === "string" ? input.sdp : "";
    if (!sdp || byteLength(sdp) > MAX_SDP_BYTES) fail(400, "SDP ว่างหรือมีขนาดใหญ่เกินกำหนด");
    return { type: kind, sdp };
  }

  const rawCandidate = input.candidate;
  if (rawCandidate !== null && typeof rawCandidate !== "string") {
    fail(400, "ICE candidate ต้องเป็น string หรือ null");
  }
  const candidate = rawCandidate === null ? null : rawCandidate;
  if (candidate !== null && byteLength(candidate) > MAX_ICE_BYTES) {
    fail(400, "ICE candidate มีขนาดใหญ่เกินกำหนด");
  }
  const sdpMid = input.sdpMid == null ? null : cleanText(input.sdpMid, 256);
  const line = input.sdpMLineIndex;
  const sdpMLineIndex = line == null ? null : Number(line);
  if (sdpMLineIndex !== null && (!Number.isSafeInteger(sdpMLineIndex) || sdpMLineIndex < 0 || sdpMLineIndex > 65535)) {
    fail(400, "sdpMLineIndex ไม่ถูกต้อง");
  }
  const usernameFragment = input.usernameFragment == null ? null : cleanText(input.usernameFragment, 256);
  return { type: "ice", candidate, sdpMid, sdpMLineIndex, usernameFragment };
}

function normalizeRemoteCommand(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || byteLength(input) > MAX_COMMAND_BYTES) {
    fail(400, "remote command ไม่ถูกต้องหรือมีขนาดใหญ่เกินกำหนด");
  }
  const action = String(input.action ?? "").toLowerCase();

  if (action === "navigate") {
    const target = String(input.target ?? "").toLowerCase();
    if (!NAVIGATION_TARGETS.has(target)) fail(400, "ปลายทาง navigate ไม่อยู่ใน allowlist");
    return { action, target };
  }

  if (action === "scroll") {
    const direction = String(input.direction ?? "").toLowerCase();
    if (!["up", "down", "top", "bottom"].includes(direction)) fail(400, "ทิศทาง scroll ไม่ถูกต้อง");
    const amount = ["up", "down"].includes(direction)
      ? clampInteger(input.amount, 420, 40, 1200)
      : undefined;
    return amount === undefined ? { action, direction } : { action, direction, amount };
  }

  if (action === "spotlight") {
    const target = String(input.target ?? "").toLowerCase();
    if (!SPOTLIGHT_TARGETS.has(target)) fail(400, "เป้าหมาย spotlight ไม่อยู่ใน allowlist");
    return {
      action,
      target,
      active: input.active !== false,
      durationMs: clampInteger(input.durationMs, 3000, 500, 10000),
    };
  }

  // Deliberately reject click, key, pointer, text entry, shell, and every other OS-level action.
  fail(400, "อนุญาตเฉพาะ navigate, scroll และ spotlight ภายใน RWANG UI");
}

function ssePacket(record) {
  return `id: ${record.id}\nevent: ${record.event}\ndata: ${JSON.stringify(record.data)}\n\n`;
}

function directSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function appendHistory(history, record) {
  history.push(record);
  let total = history.reduce((sum, item) => sum + item.bytes, 0);
  while (history.length > MAX_EVENT_COUNT || total > MAX_EVENT_HISTORY_BYTES) {
    const removed = history.shift();
    total -= removed?.bytes || 0;
  }
}

function publicSession(session, local) {
  const activeControls = [...session.viewers.values()]
    .filter((viewer) => Number.isFinite(viewer.controlExpiresAt) && viewer.controlExpiresAt > Date.now());
  const value = {
    id: session.id,
    createdAt: iso(session.createdAt),
    expiresAt: iso(session.expiresAt),
    shareMode: session.shareMode,
    viewerCount: session.viewers.size,
    maxViewers: session.maxViewers,
    inviteExpiresAt: iso(session.shareTokenExpiresAt),
    inviteUsed: session.shareTokenUsed,
    inviteAvailable: !session.shareTokenUsed && session.shareTokenExpiresAt > Date.now(),
    allowRemoteControl: activeControls.length > 0,
    controlExpiresAt: activeControls.length
      ? iso(Math.max(...activeControls.map((viewer) => viewer.controlExpiresAt)))
      : null,
    hostConnected: session.hostClients.size > 0,
  };
  if (local) {
    if (!session.shareTokenUsed && session.shareTokenExpiresAt > Date.now()) value.shareToken = session.shareToken;
    value.viewers = [...session.viewers.values()].map((viewer) => ({
      id: viewer.id,
      name: viewer.name,
      joinedAt: iso(viewer.joinedAt),
      connected: viewer.clients.size > 0,
      allowRemoteControl: viewer.controlExpiresAt > Date.now(),
      controlExpiresAt: viewer.controlExpiresAt > Date.now() ? iso(viewer.controlExpiresAt) : null,
    }));
  }
  return value;
}

export function createRemoteCore({
  notify = () => {},
  audit = () => {},
  isLocal,
  isAuthorized,
  getPolicy,
  getIceServers = () => [],
} = {}) {
  if (typeof isLocal !== "function") throw new TypeError("createRemoteCore requires isLocal(req)");
  if (isAuthorized !== undefined && typeof isAuthorized !== "function") {
    throw new TypeError("createRemoteCore isAuthorized must be a function when provided");
  }
  if (getPolicy !== undefined && typeof getPolicy !== "function") {
    throw new TypeError("createRemoteCore getPolicy must be a function when provided");
  }
  if (typeof getIceServers !== "function") throw new TypeError("createRemoteCore getIceServers must be a function");

  const sessions = new Map();
  const rateBuckets = new Map();
  const eventTickets = new Map();
  const invalidToken = randomScopedToken();
  let closed = false;

  function callSafely(fn, ...args) {
    try {
      const result = fn(...args);
      if (result && typeof result.catch === "function") void result.catch(() => {});
    } catch {}
  }

  function changed() {
    callSafely(notify);
  }

  function log(level, message) {
    callSafely(audit, level, cleanText(message, 500));
  }

  function getSession(value) {
    const id = requireSessionId(value);
    const session = sessions.get(id);
    if (!session) fail(404, "ไม่พบหรือ session หมดอายุแล้ว");
    return session;
  }

  function getViewer(session, value) {
    const id = requireViewerId(value);
    const viewer = session.viewers.get(id);
    if (!viewer) fail(404, "ไม่พบหรือ viewer หมดอายุแล้ว");
    return viewer;
  }

  function authenticateShare(sessionId, shareToken) {
    const id = String(sessionId ?? "").slice(0, 100);
    const session = SESSION_ID_RE.test(id) ? sessions.get(id) : undefined;
    requireTokenMatch(
      shareToken,
      session?.shareToken || invalidToken,
      "ลิงก์แชร์ไม่ถูกต้องหรือหมดอายุแล้ว",
    );
    if (!session) fail(401, "ลิงก์แชร์ไม่ถูกต้องหรือหมดอายุแล้ว");
    if (session.shareTokenUsed || session.shareTokenExpiresAt <= Date.now()) {
      fail(401, "ลิงก์แชร์ถูกใช้แล้วหรือหมดอายุแล้ว");
    }
    return session;
  }

  function authenticateViewer(sessionId, viewerId, viewerToken) {
    const safeSessionId = String(sessionId ?? "").slice(0, 100);
    const safeViewerId = String(viewerId ?? "").slice(0, 100);
    const session = SESSION_ID_RE.test(safeSessionId) ? sessions.get(safeSessionId) : undefined;
    const viewer = session && VIEWER_ID_RE.test(safeViewerId)
      ? session.viewers.get(safeViewerId)
      : undefined;
    requireTokenMatch(
      viewerToken,
      viewer?.viewerToken || invalidToken,
      "viewer credential ไม่ถูกต้องหรือหมดอายุแล้ว",
    );
    if (!session || !viewer) fail(401, "viewer credential ไม่ถูกต้องหรือหมดอายุแล้ว");
    return { session, viewer };
  }

  async function authorizeRemotePrincipal(req, url) {
    if (!isAuthorized) return false;
    const result = await isAuthorized(req, url, "remote");
    if (!result || typeof result !== "object") return Boolean(result);
    if (result.authorized !== true) return false;
    if (result.kind !== "device") return true;
    const scopes = result.scopes || result.device?.scopes;
    return Array.isArray(scopes) && scopes.includes("remote");
  }

  function enforceRateLimit(req, kind) {
    if (isLocal(req)) return;
    const config = RATE_LIMITS[kind];
    const address = cleanText(req.socket?.remoteAddress || "unknown", 100);
    const key = `${kind}:${address}`;
    const time = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || time >= bucket.resetAt) {
      bucket = { count: 0, resetAt: time + config.windowMs };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > config.limit) fail(429, "ส่งคำขอถี่เกินไป กรุณารอสักครู่");
    if (rateBuckets.size > 500) {
      for (const [entryKey, entry] of rateBuckets) {
        if (time >= entry.resetAt) rateBuckets.delete(entryKey);
      }
    }
  }

  function makeRecord(session, event, data) {
    const record = { id: ++session.sequence, event, data };
    record.bytes = byteLength(record) + 32;
    return record;
  }

  function sendToClients(clients, record) {
    const packet = ssePacket(record);
    for (const client of clients) {
      try {
        const writable = client.write(packet);
        if (!writable && client.writableLength > 256 * 1024) {
          client.end();
          clients.delete(client);
        }
      } catch {
        clients.delete(client);
      }
    }
  }

  function emitHost(session, event, data) {
    const record = makeRecord(session, event, data);
    appendHistory(session.hostEvents, record);
    sendToClients(session.hostClients, record);
  }

  function emitHostTransient(session, event, data) {
    const record = makeRecord(session, event, data);
    sendToClients(session.hostClients, record);
  }

  function emitViewer(session, viewer, event, data) {
    const record = makeRecord(session, event, data);
    appendHistory(viewer.events, record);
    sendToClients(viewer.clients, record);
  }

  function closeClients(clients) {
    for (const client of clients) {
      try {
        client.end();
      } catch {}
    }
    clients.clear();
  }

  function removeViewer(session, viewer, reason = "left") {
    if (!session.viewers.has(viewer.id)) return;
    emitViewer(session, viewer, "session-ended", { sessionId: session.id, reason });
    emitHost(session, "viewer-left", { sessionId: session.id, viewerId: viewer.id, reason });
    closeClients(viewer.clients);
    session.viewers.delete(viewer.id);
    session.lastActivity = Date.now();
    log("info", `Remote viewer left ${session.id} (${reason})`);
    changed();
  }

  function stopSession(session, reason = "stopped") {
    if (!sessions.has(session.id)) return;
    clearTimeout(session.hostDisconnectTimer);
    session.hostDisconnectTimer = null;
    emitHost(session, "session-ended", { sessionId: session.id, reason });
    for (const viewer of session.viewers.values()) {
      emitViewer(session, viewer, "session-ended", { sessionId: session.id, reason });
      closeClients(viewer.clients);
    }
    closeClients(session.hostClients);
    session.viewers.clear();
    sessions.delete(session.id);
    log(reason === "expired" ? "warn" : "info", `Remote session ${session.id} ${reason}`);
    changed();
  }

  function disableRemoteControl(session, reason = "disabled", onlyViewerId = "") {
    let changedControl = false;
    for (const viewer of session.viewers.values()) {
      if (onlyViewerId && viewer.id !== onlyViewerId) continue;
      if (!viewer.controlExpiresAt) continue;
      viewer.controlExpiresAt = 0;
      const data = {
        sessionId: session.id,
        viewerId: viewer.id,
        allowRemoteControl: false,
        controlExpiresAt: null,
        reason: cleanText(reason, 80),
      };
      emitHost(session, "control-policy", data);
      emitViewer(session, viewer, "control-policy", data);
      changedControl = true;
    }
    return changedControl;
  }

  function revokeAll(reason = "revoked") {
    const safeReason = cleanText(reason, 80) || "revoked";
    for (const session of [...sessions.values()]) stopSession(session, safeReason);
  }

  function readPolicy() {
    let value = {};
    try {
      value = getPolicy?.() || {};
    } catch {
      value = { screenShare: false, mobileRemote: false };
    }
    if (value && typeof value.then === "function") {
      throw new TypeError("getPolicy must return synchronously");
    }
    return {
      screenShare: value.screenShare !== false,
      mobileRemote: value.mobileRemote !== false,
    };
  }

  function enforcePolicy() {
    const policy = readPolicy();
    if (!policy.screenShare) {
      revokeAll("screen-share-policy-disabled");
      return policy;
    }
    if (!policy.mobileRemote) {
      let changedControl = false;
      for (const session of sessions.values()) {
        changedControl = disableRemoteControl(session, "mobile-remote-policy-disabled") || changedControl;
      }
      if (changedControl) {
        log("warn", "Mobile remote policy disabled active UI control");
        changed();
      }
    }
    return policy;
  }

  function prune() {
    if (closed) return;
    const time = Date.now();
    for (const [ticket, value] of eventTickets) {
      if (value.expiresAt <= time) eventTickets.delete(ticket);
    }
    for (const session of [...sessions.values()]) {
      if (time >= session.expiresAt) {
        stopSession(session, "expired");
        continue;
      }
      for (const viewer of [...session.viewers.values()]) {
        if (viewer.clients.size === 0 && time - viewer.lastSeen >= VIEWER_IDLE_TTL_MS) {
          removeViewer(session, viewer, "idle-timeout");
        }
      }
      for (const viewer of session.viewers.values()) {
        if (viewer.controlExpiresAt && viewer.controlExpiresAt <= time
          && disableRemoteControl(session, "control-expired", viewer.id)) {
          log("info", `Remote UI control expired for ${session.id}/${viewer.id}`);
          changed();
        }
      }
    }
  }

  function createSession(body) {
    prune();
    if (sessions.size >= MAX_SESSIONS) fail(409, "มี screen-share session อยู่แล้ว กรุณาหยุด session เดิมก่อน");
    const time = Date.now();
    const ttlMinutes = clampInteger(
      body?.ttlMinutes,
      DEFAULT_SESSION_TTL_MS / 60000,
      MIN_SESSION_TTL_MS / 60000,
      MAX_SESSION_TTL_MS / 60000,
    );
    const session = {
      id: randomId("rs"),
      shareToken: randomScopedToken(),
      shareTokenUsed: false,
      shareTokenExpiresAt: Math.min(time + SHARE_INVITE_TTL_MS, time + ttlMinutes * 60 * 1000),
      createdAt: time,
      expiresAt: time + ttlMinutes * 60 * 1000,
      lastActivity: time,
      maxViewers: clampInteger(body?.maxViewers, DEFAULT_MAX_VIEWERS, 1, HARD_MAX_VIEWERS),
      shareMode: SHARE_MODES.has(body?.shareMode) ? body.shareMode : "screen",
      sequence: 0,
      hostEvents: [],
      hostClients: new Set(),
      hostDisconnectTimer: null,
      viewers: new Map(),
    };
    sessions.set(session.id, session);
    log("success", `Remote session created ${session.id} (${session.shareMode})`);
    changed();
    return session;
  }

  function renewShareInvite(session) {
    if (session.viewers.size >= session.maxViewers) {
      fail(409, "จำนวนผู้ชมเต็มแล้ว กรุณาตัดการเชื่อมต่ออุปกรณ์เดิมก่อน");
    }
    const time = Date.now();
    session.shareToken = randomScopedToken();
    session.shareTokenUsed = false;
    session.shareTokenExpiresAt = Math.min(time + SHARE_INVITE_TTL_MS, session.expiresAt);
    session.lastActivity = time;
    log("info", `One-time view invitation renewed for ${session.id}`);
    changed();
    return {
      shareToken: session.shareToken,
      inviteExpiresAt: iso(session.shareTokenExpiresAt),
    };
  }

  function joinSession(req, body) {
    enforceRateLimit(req, "join");
    const session = isLocal(req)
      ? getSession(body?.sessionId)
      : authenticateShare(body?.sessionId, body?.shareToken);
    if (!readPolicy().screenShare) fail(403, "Screen Share skill ถูกปิดใช้งาน");
    if (session.viewers.size >= session.maxViewers) fail(409, "จำนวนผู้ชมเต็มแล้ว");
    const time = Date.now();
    const viewer = {
      id: randomId("rv"),
      viewerToken: randomScopedToken(),
      name: cleanText(body?.name, 60) || "Mobile viewer",
      joinedAt: time,
      lastSeen: time,
      controlExpiresAt: 0,
      events: [],
      clients: new Set(),
    };
    session.viewers.set(viewer.id, viewer);
    session.shareTokenUsed = true;
    session.shareToken = randomScopedToken();
    session.lastActivity = time;
    emitHost(session, "viewer-joined", {
      sessionId: session.id,
      viewerId: viewer.id,
      name: viewer.name,
      joinedAt: iso(time),
    });
    log("success", `Remote viewer joined ${session.id}`);
    changed();
    // This returns only a short-lived credential scoped to this viewer and session, never RWANG's master token.
    return {
      ok: true,
      session: publicSession(session, false),
      viewerId: viewer.id,
      viewerToken: viewer.viewerToken,
      viewerExpiresAfterIdleMs: VIEWER_IDLE_TTL_MS,
      rtcConfiguration: { iceServers: getIceServers() },
    };
  }

  function issueEventTicket(req, body) {
    enforceRateLimit(req, "events");
    if (eventTickets.size >= MAX_EVENT_TICKETS) fail(429, "มี event ticket รอใช้งานมากเกินไป");
    const role = cleanText(body?.role, 20);
    const session = getSession(body?.sessionId);
    let viewerId = "";
    if (role === "host") {
      if (!isLocal(req)) fail(403, "host event ticket ออกได้จากเครื่องหลักเท่านั้น");
    } else if (role === "viewer") {
      const authenticated = authenticateViewer(session.id, body?.viewerId, body?.viewerToken);
      viewerId = authenticated.viewer.id;
    } else {
      fail(400, "role ต้องเป็น host หรือ viewer");
    }
    const ticket = randomScopedToken();
    const expiresAt = Date.now() + EVENT_TICKET_TTL_MS;
    eventTickets.set(ticket, { role, sessionId: session.id, viewerId, expiresAt });
    return { ok: true, ticket, expiresAt: iso(expiresAt) };
  }

  function connectEvents(req, res, url) {
    const ticket = cleanText(url.searchParams.get("ticket"), 256);
    const grant = eventTickets.get(ticket);
    eventTickets.delete(ticket);
    if (!grant || grant.expiresAt <= Date.now()) fail(401, "event ticket ไม่ถูกต้อง หมดอายุ หรือถูกใช้แล้ว");
    const role = grant.role;
    const rawAfter = req.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0";
    const after = Number(rawAfter);
    if (!Number.isSafeInteger(after) || after < 0) fail(400, "SSE event cursor ไม่ถูกต้อง");

    let clients;
    let history;
    let viewer;
    let session;
    if (role === "host") {
      if (!isLocal(req)) fail(403, "host event stream เปิดได้จากเครื่องหลักเท่านั้น");
      session = getSession(grant.sessionId);
      clearTimeout(session.hostDisconnectTimer);
      session.hostDisconnectTimer = null;
      clients = session.hostClients;
      history = session.hostEvents;
    } else if (role === "viewer") {
      session = getSession(grant.sessionId);
      viewer = getViewer(session, grant.viewerId);
      viewer.lastSeen = Date.now();
      clients = viewer.clients;
      history = viewer.events;
    } else {
      fail(400, "role ต้องเป็น host หรือ viewer");
    }
    if (clients.size >= MAX_SSE_CLIENTS_PER_ROLE) fail(429, "เปิด event stream สำหรับ role นี้มากเกินไป");

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    });
    res.flushHeaders?.();
    clients.add(res);
    res.write(directSse("ready", {
      sessionId: session.id,
      role,
      viewerId: viewer?.id,
      expiresAt: iso(session.expiresAt),
    }));
    for (const record of history) if (record.id > after) res.write(ssePacket(record));

    const keepalive = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
        if (viewer) viewer.lastSeen = Date.now();
      } catch {
        clearInterval(keepalive);
        clients.delete(res);
      }
    }, KEEPALIVE_INTERVAL_MS);
    keepalive.unref?.();

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(keepalive);
      clients.delete(res);
      if (role === "host" && clients.size === 0 && sessions.has(session.id)) {
        if (disableRemoteControl(session, "host-disconnected")) changed();
        clearTimeout(session.hostDisconnectTimer);
        session.hostDisconnectTimer = setTimeout(() => {
          if (sessions.has(session.id) && session.hostClients.size === 0) {
            stopSession(session, "host-disconnected");
          }
        }, 20_000);
        session.hostDisconnectTimer.unref?.();
      }
    };
    req.once("close", cleanup);
    res.once("close", cleanup);
    return true;
  }

  function relaySignal(req, body) {
    const role = body?.role;
    const time = Date.now();

    if (role === "host") {
      if (!isLocal(req)) fail(403, "host signaling ส่งได้จากเครื่องหลักเท่านั้น");
      const session = getSession(body?.sessionId);
      if (!readPolicy().screenShare) fail(403, "Screen Share skill ถูกปิดใช้งาน");
      session.lastActivity = time;
      const viewer = getViewer(session, body?.viewerId);
      const signal = normalizeSignal(body?.signal, "host");
      viewer.lastSeen = time;
      emitViewer(session, viewer, "signal", {
        sessionId: session.id,
        from: "host",
        signal,
      });
      return { ok: true };
    }

    if (role === "viewer") {
      enforceRateLimit(req, "signal");
      const { session, viewer } = authenticateViewer(body?.sessionId, body?.viewerId, body?.viewerToken);
      if (!readPolicy().screenShare) fail(403, "Screen Share skill ถูกปิดใช้งาน");
      session.lastActivity = time;
      const signal = normalizeSignal(body?.signal, "viewer");
      viewer.lastSeen = time;
      emitHost(session, "signal", {
        sessionId: session.id,
        from: "viewer",
        viewerId: viewer.id,
        signal,
      });
      return { ok: true };
    }

    fail(400, "role ต้องเป็น host หรือ viewer");
  }

  function relayRemoteCommand(body) {
    const { session, viewer } = authenticateViewer(body?.sessionId, body?.viewerId, body?.viewerToken);
    if (!readPolicy().mobileRemote) fail(403, "Mobile Remote skill ถูกปิดใช้งาน");
    if (viewer.controlExpiresAt && viewer.controlExpiresAt <= Date.now()) {
      disableRemoteControl(session, "control-expired", viewer.id);
      changed();
    }
    if (!viewer.controlExpiresAt || viewer.controlExpiresAt <= Date.now()) {
      fail(403, "host ยังไม่อนุญาต viewer เครื่องนี้ให้ควบคุม RWANG UI");
    }
    if (session.hostClients.size === 0) fail(409, "host UI ยังไม่ได้เชื่อมต่อ จึงไม่เก็บคำสั่งไว้ replay");
    const command = normalizeRemoteCommand(body?.command);
    viewer.lastSeen = Date.now();
    session.lastActivity = viewer.lastSeen;
    emitHostTransient(session, "remote-command", {
      sessionId: session.id,
      viewerId: viewer.id,
      command,
    });
    log("info", `Remote UI command ${command.action} relayed for ${session.id}`);
    return { ok: true, accepted: command.action };
  }

  function snapshot(req, onlySessionId = null) {
    const policy = enforcePolicy();
    prune();
    const local = Boolean(isLocal(req));
    const visibleSessions = onlySessionId
      ? [...sessions.values()].filter((session) => session.id === onlySessionId)
      : [...sessions.values()];
    return {
      available: !closed,
      transport: "webrtc",
      sessions: visibleSessions.map((session) => publicSession(session, local)),
      limits: {
        maxSessions: MAX_SESSIONS,
        hardMaxViewers: HARD_MAX_VIEWERS,
        maxSdpBytes: MAX_SDP_BYTES,
        maxIceBytes: MAX_ICE_BYTES,
        maxSseClientsPerRole: MAX_SSE_CLIENTS_PER_ROLE,
      },
      capabilities: {
        policy,
        shareModes: [...SHARE_MODES],
        remoteCommands: {
          navigate: [...NAVIGATION_TARGETS],
          scroll: ["up", "down", "top", "bottom"],
          spotlight: [...SPOTLIGHT_TARGETS],
        },
        osInput: false,
        relayConfigured: getIceServers().length > 0,
      },
    };
  }

  async function handleApi(req, res, url, { readBody, json }) {
    const pathname = url.pathname;
    const known = pathname === "/api/remote"
      || pathname === "/api/remote/session"
      || pathname === "/api/remote/join"
      || pathname === "/api/remote/leave"
      || pathname === "/api/remote/signal"
      || pathname === "/api/remote/events"
      || pathname === "/api/remote/events-ticket"
      || pathname === "/api/remote/command";
    if (!known) return false;

    try {
      const policy = enforcePolicy();
      prune();
      if (req.method === "GET" && pathname === "/api/remote") {
        if (isLocal(req)) return json(res, 200, snapshot(req));

        let masterAuthorized = false;
        if (isAuthorized) {
          try {
            masterAuthorized = await authorizeRemotePrincipal(req, url);
          } catch {}
        }
        if (masterAuthorized) return json(res, 200, snapshot(req));

        const session = authenticateShare(
          url.searchParams.get("sessionId"),
          req.headers["x-rwang-share-token"],
        );
        return json(res, 200, snapshot(req, session.id));
      }
      if (req.method === "GET" && pathname === "/api/remote/events") {
        return connectEvents(req, res, url);
      }
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

      const body = await readBody(req);
      if (pathname === "/api/remote/events-ticket") {
        return json(res, 201, issueEventTicket(req, body));
      }
      if (pathname === "/api/remote/session") {
        if (!isLocal(req)) fail(403, "จัดการ screen-share session ได้จากเครื่องหลักเท่านั้น");
        if (body?.action === "create") {
          if (!policy.screenShare) fail(403, "Screen Share skill ถูกปิดใช้งาน");
          const session = createSession(policy.mobileRemote
            ? body
            : { ...body, allowRemoteControl: false });
          return json(res, 201, {
            ok: true,
            session: publicSession(session, true),
            rtcConfiguration: { iceServers: getIceServers() },
          });
        }
        if (body?.action === "stop") {
          const session = getSession(body?.sessionId);
          stopSession(session, "stopped");
          return json(res, 200, { ok: true });
        }
        if (body?.action === "set-control") {
          const session = getSession(body?.sessionId);
          const viewer = getViewer(session, body?.viewerId);
          if (!policy.mobileRemote && body?.enabled === true) {
            disableRemoteControl(session, "mobile-remote-policy-disabled", viewer.id);
            fail(403, "Mobile Remote skill ถูกปิดใช้งาน");
          }
          const enabled = body?.enabled === true;
          if (enabled) disableRemoteControl(session, "control-transferred");
          viewer.controlExpiresAt = enabled
            ? Date.now() + clampInteger(body?.durationMs, DEFAULT_CONTROL_DURATION_MS, MIN_CONTROL_DURATION_MS, MAX_CONTROL_DURATION_MS)
            : 0;
          const controlData = {
            sessionId: session.id,
            viewerId: viewer.id,
            allowRemoteControl: enabled,
            controlExpiresAt: enabled ? iso(viewer.controlExpiresAt) : null,
          };
          emitHost(session, "control-policy", {
            ...controlData,
          });
          emitViewer(session, viewer, "control-policy", { ...controlData });
          log("info", `Remote UI control ${enabled ? "enabled" : "disabled"} for ${session.id}/${viewer.id}`);
          changed();
          return json(res, 200, {
            ok: true,
            viewerId: viewer.id,
            allowRemoteControl: enabled,
            controlExpiresAt: controlData.controlExpiresAt,
          });
        }
        if (body?.action === "disconnect-viewer") {
          const session = getSession(body?.sessionId);
          const viewer = getViewer(session, body?.viewerId);
          removeViewer(session, viewer, "revoked-by-host");
          return json(res, 200, { ok: true, viewerId: viewer.id });
        }
        if (body?.action === "new-invite") {
          const session = getSession(body?.sessionId);
          return json(res, 201, { ok: true, ...renewShareInvite(session) });
        }
        fail(400, "action ต้องเป็น create, stop, set-control, disconnect-viewer หรือ new-invite");
      }
      if (pathname === "/api/remote/join") {
        return json(res, 201, joinSession(req, body));
      }
      if (pathname === "/api/remote/leave") {
        const { session, viewer } = authenticateViewer(body?.sessionId, body?.viewerId, body?.viewerToken);
        removeViewer(session, viewer, "left");
        return json(res, 200, { ok: true });
      }
      if (pathname === "/api/remote/signal") {
        return json(res, 202, relaySignal(req, body));
      }
      if (pathname === "/api/remote/command") {
        enforceRateLimit(req, "command");
        return json(res, 202, relayRemoteCommand(body));
      }
      return json(res, 405, { ok: false, error: "Method not allowed" });
    } catch (error) {
      if (!res.headersSent) {
        return json(res, Number.isInteger(error?.status) ? error.status : 400, {
          ok: false,
          error: cleanText(error?.message || error, 500),
        });
      }
      try {
        res.end();
      } catch {}
      return true;
    }
  }

  const pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();

  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(pruneTimer);
    revokeAll("server-closed");
    rateBuckets.clear();
    eventTickets.clear();
  }

  return { snapshot, handleApi, enforcePolicy, revokeAll, close };
}
