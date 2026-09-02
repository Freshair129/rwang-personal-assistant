const SESSION_ID_RE = /rs_[A-Za-z0-9_-]{24}/;
const VIEWER_ID_RE = /^rv_[A-Za-z0-9_-]{24}$/;
const DEFAULT_CONTROL_DURATION_MS = 10 * 60 * 1000;
const MAX_CONTROL_DURATION_MS = DEFAULT_CONTROL_DURATION_MS;

const NAVIGATION_TARGETS = new Set(["assistant", "systems", "loadout"]);
const SCROLL_DIRECTIONS = new Set(["up", "down", "top", "bottom"]);
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

const SOURCE_ALIASES = {
  application: "application",
  window: "application",
  browser: "browser",
  tab: "browser",
  screen: "screen",
  monitor: "screen",
  choose: "choose",
  auto: "choose",
};

function asError(error, fallback = "Remote session failed") {
  if (error instanceof Error) return error;
  return new Error(String(error || fallback));
}

function errorMessage(error) {
  return asError(error).message.slice(0, 500);
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeRtcConfiguration(value) {
  const input = value && typeof value === "object" ? value : {};
  const iceServers = Array.isArray(input.iceServers) ? input.iceServers.slice(0, 6) : [];
  return {
    iceServers: iceServers.map((entry) => {
      const urls = Array.isArray(entry?.urls) ? entry.urls.slice(0, 8) : entry?.urls;
      return {
        urls,
        ...(entry?.username ? { username: String(entry.username).slice(0, 500) } : {}),
        ...(entry?.credential ? { credential: String(entry.credential).slice(0, 1000) } : {}),
      };
    }).filter((entry) => entry.urls && (Array.isArray(entry.urls) ? entry.urls.length : true)),
    ...(input.iceTransportPolicy === "relay" ? { iceTransportPolicy: "relay" } : {}),
  };
}

function parseEventData(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

function normalizeSource(value) {
  return SOURCE_ALIASES[String(value || "choose").toLowerCase()] || "choose";
}

function sourceConstraint(source) {
  if (source === "application") return { displaySurface: "window" };
  if (source === "browser") return { displaySurface: "browser" };
  if (source === "screen") return { displaySurface: "monitor" };
  return true;
}

function detectedShareMode(stream, requested) {
  const displaySurface = stream?.getVideoTracks?.()[0]?.getSettings?.().displaySurface;
  if (displaySurface === "window") return "application";
  if (displaySurface === "browser") return "browser";
  if (displaySurface === "monitor") return "screen";
  return requested === "choose" ? "screen" : requested;
}

function normalizeCommand(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Remote command must be an object");
  }

  const action = String(input.action || "").toLowerCase();
  if (action === "navigate") {
    const target = String(input.target || "").toLowerCase();
    if (!NAVIGATION_TARGETS.has(target)) throw new TypeError("Navigation target is not allowlisted");
    return { action, target };
  }

  if (action === "scroll") {
    const direction = String(input.direction || "").toLowerCase();
    if (!SCROLL_DIRECTIONS.has(direction)) throw new TypeError("Scroll direction is not allowlisted");
    if (direction === "top" || direction === "bottom") return { action, direction };
    return {
      action,
      direction,
      amount: clampInteger(input.amount, 420, 40, 1200),
    };
  }

  if (action === "spotlight") {
    const target = String(input.target || "").toLowerCase();
    if (!SPOTLIGHT_TARGETS.has(target)) throw new TypeError("Spotlight target is not allowlisted");
    return {
      action,
      target,
      active: input.active !== false,
      durationMs: clampInteger(input.durationMs, 3000, 500, 10000),
    };
  }

  throw new TypeError("Only navigate, scroll, and spotlight commands inside RWANG are allowed");
}

function signalFromCandidate(candidate) {
  if (!candidate) {
    return {
      type: "ice",
      candidate: null,
      sdpMid: null,
      sdpMLineIndex: null,
      usernameFragment: null,
    };
  }
  const value = typeof candidate.toJSON === "function" ? candidate.toJSON() : candidate;
  return {
    type: "ice",
    candidate: value.candidate || "",
    sdpMid: value.sdpMid ?? null,
    sdpMLineIndex: value.sdpMLineIndex ?? null,
    usernameFragment: value.usernameFragment ?? null,
  };
}

function candidateFromSignal(signal) {
  if (signal.candidate === null) return null;
  return {
    candidate: String(signal.candidate || ""),
    sdpMid: signal.sdpMid ?? null,
    sdpMLineIndex: signal.sdpMLineIndex ?? null,
    usernameFragment: signal.usernameFragment ?? null,
  };
}

/**
 * Browser-side RWANG screen-share and safe UI remote controller.
 *
 * `apiFetch` may be the application's JSON fetch wrapper or native `window.fetch`.
 * EventSource uses a one-time ticket and never carries the master token. A
 * viewer uses the short-lived `viewerToken` returned by
 * `/api/remote/join`; a copied share link contains only the scoped `shareToken`,
 * never RWANG's master access token.
 */
export function createRemoteController(options = {}) {
  const apiFetch = options.apiFetch || globalThis.fetch?.bind(globalThis);
  const authHeaders = options.authHeaders;
  const onState = typeof options.onState === "function" ? options.onState : () => {};
  const onCommand = typeof options.onCommand === "function" ? options.onCommand : () => {};
  let rtcConfiguration = normalizeRtcConfiguration(options.rtcConfiguration);
  const mediaDevices = options.mediaDevices || globalThis.navigator?.mediaDevices;
  let previewElement = options.previewElement
    || globalThis.document?.getElementById?.("sharePreview")
    || null;

  if (typeof apiFetch !== "function") throw new TypeError("createRemoteController requires fetch support");

  const state = {
    mode: "idle",
    phase: "idle",
    sessionId: "",
    viewerId: "",
    shareMode: "",
    viewerCount: 0,
    viewers: [],
    inviteAvailable: false,
    inviteUsed: false,
    inviteExpiresAt: "",
    allowRemoteControl: false,
    remoteControlExpiresAt: "",
    expiresAt: "",
    hasLocalStream: false,
    hasRemoteStream: false,
    connectionState: "new",
    lastError: "",
  };

  let generation = 0;
  let disposed = false;
  let shareToken = "";
  let viewerToken = "";
  let localStream = null;
  let remoteStream = null;
  let hostEventSource = null;
  let viewerEventSource = null;
  let viewerPeer = null;
  let controlTimer = null;
  const hostPeers = new Map();

  function getState() {
    return { ...state };
  }

  function publish(patch = {}) {
    Object.assign(state, patch);
    try {
      onState(getState());
    } catch {}
  }

  function report(error, phase = "error", epoch = generation) {
    const actual = asError(error);
    if (epoch === generation && !disposed) {
      publish({ phase, lastError: errorMessage(actual) });
    }
    return actual;
  }

  function resolveHeaders(initial = {}) {
    const base = new Headers(initial);
    let supplied = authHeaders;
    if (typeof authHeaders === "function") supplied = authHeaders(base);
    const headers = new Headers(supplied || base);
    for (const [key, value] of base) if (!headers.has(key)) headers.set(key, value);
    return headers;
  }

  async function decodeResponse(response) {
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("json")
      ? await response.json().catch(() => null)
      : await response.text().catch(() => "");
    if (!response.ok) {
      const error = new Error(payload?.error || payload?.message || payload || `HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function request(path, body, { scoped = false } = {}) {
    const result = await apiFetch(path, {
      method: "POST",
      headers: scoped
        ? new Headers({ "content-type": "application/json" })
        : resolveHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body || {}),
      credentials: scoped ? "omit" : "same-origin",
    });
    if (typeof Response !== "undefined" && result instanceof Response) return decodeResponse(result);
    if (result?.ok === false && result?.error) throw new Error(String(result.error));
    return result;
  }

  function eventUrl(params) {
    const base = globalThis.location?.href || "http://127.0.0.1/";
    const url = new URL("/api/remote/events", base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  function requireBrowserRtc({ capture = false } = {}) {
    if (typeof globalThis.RTCPeerConnection !== "function") {
      throw new Error("เบราว์เซอร์นี้ไม่รองรับ WebRTC");
    }
    if (typeof globalThis.EventSource !== "function") {
      throw new Error("เบราว์เซอร์นี้ไม่รองรับ EventSource signaling");
    }
    if (capture && typeof mediaDevices?.getDisplayMedia !== "function") {
      throw new Error("Screen capture ต้องเปิดผ่าน localhost/HTTPS และเบราว์เซอร์ที่รองรับ");
    }
  }

  function attachStream(stream, role) {
    if (!previewElement) return;
    previewElement.playsInline = true;
    previewElement.autoplay = true;
    previewElement.muted = role === "host";
    previewElement.srcObject = stream;
    const playback = previewElement.play?.();
    if (playback && typeof playback.catch === "function") playback.catch(() => {});
  }

  function detachPreview() {
    if (!previewElement) return;
    try {
      previewElement.pause?.();
    } catch {}
    previewElement.srcObject = null;
  }

  function attachPreview(element) {
    if (element != null && typeof element !== "object") {
      throw new TypeError("preview element must be an HTMLMediaElement");
    }
    detachPreview();
    previewElement = element || null;
    if (previewElement && localStream) attachStream(localStream, "host");
    else if (previewElement && remoteStream) attachStream(remoteStream, "viewer");
    return getState();
  }

  function closeEventSources() {
    hostEventSource?.close();
    viewerEventSource?.close();
    hostEventSource = null;
    viewerEventSource = null;
  }

  function closePeerRecord(record) {
    if (!record || record.closed) return;
    record.closed = true;
    try {
      record.pc.onicecandidate = null;
      record.pc.ontrack = null;
      record.pc.onconnectionstatechange = null;
      record.pc.close();
    } catch {}
  }

  function removeHostPeer(viewerId) {
    const record = hostPeers.get(viewerId);
    if (!record) return;
    closePeerRecord(record);
    hostPeers.delete(viewerId);
    publish({ viewerCount: hostPeers.size });
  }

  function closePeers() {
    for (const record of hostPeers.values()) closePeerRecord(record);
    hostPeers.clear();
    closePeerRecord(viewerPeer);
    viewerPeer = null;
  }

  function stopMedia() {
    for (const stream of [localStream, remoteStream]) {
      for (const track of stream?.getTracks?.() || []) {
        try {
          track.stop();
        } catch {}
      }
    }
    localStream = null;
    remoteStream = null;
  }

  function clearControlTimer() {
    if (controlTimer) clearTimeout(controlTimer);
    controlTimer = null;
  }

  function resetLocal(error = "") {
    generation += 1;
    closeEventSources();
    closePeers();
    clearControlTimer();
    stopMedia();
    detachPreview();
    shareToken = "";
    viewerToken = "";
    publish({
      mode: "idle",
      phase: error ? "error" : "idle",
      sessionId: "",
      viewerId: "",
      shareMode: "",
      viewerCount: 0,
      viewers: [],
      inviteAvailable: false,
      inviteUsed: false,
      inviteExpiresAt: "",
      allowRemoteControl: false,
      remoteControlExpiresAt: "",
      expiresAt: "",
      hasLocalStream: false,
      hasRemoteStream: false,
      connectionState: "closed",
      lastError: error,
    });
  }

  function enqueue(record, operation, epoch = generation) {
    record.chain = record.chain
      .then(async () => {
        if (record.closed || epoch !== generation || disposed) return;
        await operation();
      })
      .catch((error) => {
        if (!record.closed && epoch === generation) report(error, "signaling-error", epoch);
      });
    return record.chain;
  }

  async function relaySignal(role, targetViewerId, signal) {
    return request("/api/remote/signal", {
      sessionId: state.sessionId,
      viewerId: targetViewerId,
      role,
      ...(role === "viewer" ? { viewerToken } : {}),
      signal,
    }, { scoped: role === "viewer" });
  }

  function createPeerRecord(role, targetViewerId, epoch) {
    const pc = new RTCPeerConnection(rtcConfiguration);
    const record = { pc, chain: Promise.resolve(), closed: false, viewerId: targetViewerId };

    pc.onicecandidate = (event) => {
      enqueue(record, () => relaySignal(role, targetViewerId, signalFromCandidate(event.candidate)), epoch);
    };
    pc.onconnectionstatechange = () => {
      if (record.closed || epoch !== generation) return;
      const connectionState = pc.connectionState || "unknown";
      publish({
        connectionState,
        phase: connectionState === "connected"
          ? (role === "host" ? "sharing" : "viewing")
          : connectionState === "failed" ? "connection-failed" : state.phase,
      });
      if (role === "host" && ["failed", "closed"].includes(connectionState)) {
        removeHostPeer(targetViewerId);
      }
    };
    return record;
  }

  function ensureHostPeer(targetViewerId, epoch) {
    if (!VIEWER_ID_RE.test(String(targetViewerId || ""))) return null;
    const existing = hostPeers.get(targetViewerId);
    if (existing) return existing;

    const record = createPeerRecord("host", targetViewerId, epoch);
    hostPeers.set(targetViewerId, record);
    for (const track of localStream?.getTracks?.() || []) record.pc.addTrack(track, localStream);
    publish({ viewerCount: hostPeers.size });

    enqueue(record, async () => {
      const offer = await record.pc.createOffer();
      await record.pc.setLocalDescription(offer);
      await relaySignal("host", targetViewerId, {
        type: "offer",
        sdp: record.pc.localDescription?.sdp || offer.sdp,
      });
    }, epoch);
    return record;
  }

  function handleHostSignal(data, epoch) {
    if (data?.from !== "viewer" || !VIEWER_ID_RE.test(String(data.viewerId || ""))) return;
    const record = ensureHostPeer(data.viewerId, epoch);
    const signal = data.signal;
    if (!record || !signal) return;
    enqueue(record, async () => {
      if (signal.type === "answer") {
        await record.pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      } else if (signal.type === "ice") {
        await record.pc.addIceCandidate(candidateFromSignal(signal));
      }
    }, epoch);
  }

  function invokeCommand(data, epoch) {
    if (epoch !== generation || data?.command == null) return;
    try {
      const command = normalizeCommand(data.command);
      const result = onCommand(command, {
        viewerId: data.viewerId || "",
        sessionId: state.sessionId,
      });
      if (result && typeof result.catch === "function") {
        result.catch((error) => report(error, "command-error", epoch));
      }
    } catch (error) {
      report(error, "command-error", epoch);
    }
  }

  async function openHostEvents(epoch) {
    hostEventSource?.close();
    let grant;
    try {
      grant = await request("/api/remote/events-ticket", {
        role: "host",
        sessionId: state.sessionId,
      });
    } catch (error) {
      report(error, "signaling-error", epoch);
      return;
    }
    if (epoch !== generation || !grant?.ticket) return;
    const events = new EventSource(eventUrl({ ticket: grant.ticket }));
    hostEventSource = events;

    events.addEventListener("ready", (event) => {
      if (epoch !== generation) return;
      const data = parseEventData(event);
      publish({ phase: "sharing", expiresAt: data?.expiresAt || state.expiresAt, lastError: "" });
    });
    events.addEventListener("viewer-joined", (event) => {
      if (epoch !== generation) return;
      const data = parseEventData(event);
      ensureHostPeer(data?.viewerId, epoch);
      const viewers = state.viewers.filter((viewer) => viewer.id !== data?.viewerId);
      viewers.push({
        id: data?.viewerId || "",
        name: data?.name || "Mobile viewer",
        connected: true,
        allowRemoteControl: false,
        controlExpiresAt: null,
      });
      shareToken = "";
      publish({
        viewers,
        viewerCount: viewers.length,
        inviteAvailable: false,
        inviteUsed: true,
      });
    });
    events.addEventListener("viewer-left", (event) => {
      if (epoch !== generation) return;
      const data = parseEventData(event);
      removeHostPeer(data?.viewerId);
      const viewers = state.viewers.filter((viewer) => viewer.id !== data?.viewerId);
      publish({
        viewers,
        viewerCount: viewers.length,
        allowRemoteControl: viewers.some((viewer) => viewer.allowRemoteControl),
      });
    });
    events.addEventListener("signal", (event) => {
      if (epoch !== generation) return;
      handleHostSignal(parseEventData(event), epoch);
    });
    events.addEventListener("control-policy", (event) => {
      if (epoch !== generation) return;
      const data = parseEventData(event);
      const viewers = state.viewers.map((viewer) => viewer.id === data?.viewerId
        ? {
            ...viewer,
            allowRemoteControl: data?.allowRemoteControl === true,
            controlExpiresAt: data?.controlExpiresAt || null,
          }
        : data?.allowRemoteControl === true
          ? { ...viewer, allowRemoteControl: false, controlExpiresAt: null }
          : viewer);
      publish({
        viewers,
        allowRemoteControl: viewers.some((viewer) => viewer.allowRemoteControl),
        remoteControlExpiresAt: data?.allowRemoteControl ? (data?.controlExpiresAt || "") : "",
      });
    });
    events.addEventListener("remote-command", (event) => {
      invokeCommand(parseEventData(event), epoch);
    });
    events.addEventListener("session-ended", () => {
      if (epoch === generation) resetLocal();
    });
    events.onerror = () => {
      events.close();
      if (epoch === generation && state.mode === "host") {
        publish({ phase: "signaling-reconnecting" });
        setTimeout(() => {
          if (epoch === generation && state.mode === "host") void openHostEvents(epoch);
        }, 1500);
      }
    };
  }

  function createViewerPeer(epoch) {
    const record = createPeerRecord("viewer", state.viewerId, epoch);
    viewerPeer = record;
    remoteStream = new MediaStream();
    record.pc.ontrack = (event) => {
      if (epoch !== generation || record.closed) return;
      const provided = event.streams?.[0];
      if (provided) {
        remoteStream = provided;
      } else if (event.track && !remoteStream.getTracks().includes(event.track)) {
        remoteStream.addTrack(event.track);
      }
      attachStream(remoteStream, "viewer");
      publish({ hasRemoteStream: true, phase: "viewing" });
    };
    return record;
  }

  function handleViewerSignal(data, epoch) {
    if (data?.from !== "host" || !data.signal || !viewerPeer) return;
    const signal = data.signal;
    enqueue(viewerPeer, async () => {
      if (signal.type === "offer") {
        await viewerPeer.pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        const answer = await viewerPeer.pc.createAnswer();
        await viewerPeer.pc.setLocalDescription(answer);
        await relaySignal("viewer", state.viewerId, {
          type: "answer",
          sdp: viewerPeer.pc.localDescription?.sdp || answer.sdp,
        });
      } else if (signal.type === "ice") {
        await viewerPeer.pc.addIceCandidate(candidateFromSignal(signal));
      }
    }, epoch);
  }

  async function openViewerEvents(epoch) {
    viewerEventSource?.close();
    let grant;
    try {
      grant = await request("/api/remote/events-ticket", {
        role: "viewer",
        sessionId: state.sessionId,
        viewerId: state.viewerId,
        viewerToken,
      }, { scoped: true });
    } catch (error) {
      report(error, "signaling-error", epoch);
      return;
    }
    if (epoch !== generation || !grant?.ticket) return;
    const events = new EventSource(eventUrl({ ticket: grant.ticket }));
    viewerEventSource = events;

    events.addEventListener("ready", (event) => {
      if (epoch !== generation) return;
      const data = parseEventData(event);
      publish({ phase: "waiting-for-host", expiresAt: data?.expiresAt || state.expiresAt, lastError: "" });
    });
    events.addEventListener("signal", (event) => {
      if (epoch !== generation) return;
      handleViewerSignal(parseEventData(event), epoch);
    });
    events.addEventListener("control-policy", (event) => {
      if (epoch !== generation) return;
      const data = parseEventData(event);
      publish({
        allowRemoteControl: data?.allowRemoteControl === true,
        remoteControlExpiresAt: data?.allowRemoteControl ? (data?.controlExpiresAt || "") : "",
      });
    });
    events.addEventListener("session-ended", () => {
      if (epoch === generation) resetLocal();
    });
    events.onerror = () => {
      events.close();
      if (epoch === generation && state.mode === "viewer") {
        publish({ phase: "signaling-reconnecting" });
        setTimeout(() => {
          if (epoch === generation && state.mode === "viewer") void openViewerEvents(epoch);
        }, 1500);
      }
    };
  }

  function parseSessionReference(value) {
    const raw = typeof value === "object" && value
      ? String(value.sessionId || value.session || "")
      : String(value || "");
    const match = raw.trim().match(SESSION_ID_RE);
    if (!match) throw new TypeError("ไม่พบ session ID ที่ถูกต้อง");
    return match[0];
  }

  function parseShareReference(value, explicitToken = "") {
    const sessionId = parseSessionReference(value);
    let token = String(explicitToken || (typeof value === "object" && value ? value.shareToken || "" : "")).trim();
    const raw = typeof value === "string" ? value.trim() : "";
    if (!token && raw) {
      try {
        const url = new URL(raw, globalThis.location?.href || "http://127.0.0.1/");
        if (url.hash.includes("?")) {
          token = String(new URLSearchParams(url.hash.split("?")[1]).get("shareToken") || "").trim();
        }
      } catch {}
    }
    if (!token || token.length > 512) throw new TypeError("ไม่พบ scoped share token ที่ถูกต้อง");
    return { sessionId, shareToken: token };
  }

  function getShareReference() {
    if (state.mode !== "host" || !state.sessionId || !shareToken || !state.inviteAvailable) {
      throw new Error("invite นี้ถูกใช้หรือหมดอายุแล้ว กรุณาสร้าง invite ใหม่");
    }
    return { sessionId: state.sessionId, shareToken };
  }

  function buildShareLink(baseUrl = globalThis.location?.href || "http://127.0.0.1/") {
    const reference = getShareReference();
    const url = new URL(baseUrl, globalThis.location?.href || "http://127.0.0.1/");
    // Never carry RWANG's master access token into a screen-share invitation.
    url.searchParams.delete("token");
    url.searchParams.delete("accessToken");
    url.searchParams.delete("remoteSession");
    url.searchParams.delete("shareToken");
    const fragment = new URLSearchParams({
      remoteSession: reference.sessionId,
      shareToken: reference.shareToken,
    });
    // Keep the one-time invitation in the fragment so it never reaches HTTP,
    // proxy logs, referrers, or the service worker request URL.
    url.hash = `loadout?${fragment}`;
    return url.toString();
  }

  async function startHost({
    source = globalThis.document?.getElementById?.("shareSourceSelect")?.value || "choose",
    includeAudio = false,
    maxViewers = 1,
    ttlMinutes = 120,
    allowRemoteControl = false,
    controlDurationMs = DEFAULT_CONTROL_DURATION_MS,
  } = {}) {
    if (disposed) throw new Error("Remote controller is closed");
    if (state.mode !== "idle") throw new Error("หยุดหรือออกจาก remote session ปัจจุบันก่อน");
    requireBrowserRtc({ capture: true });

    const requested = normalizeSource(source);
    const epoch = ++generation;
    publish({
      mode: "host",
      phase: "requesting-capture",
      shareMode: requested === "choose" ? "" : requested,
      lastError: "",
      connectionState: "new",
    });

    let captured;
    let createdSessionId = "";
    try {
      // The displaySurface value is a hint only. The browser picker and the user
      // remain authoritative about the selected tab, window, or entire screen.
      captured = await mediaDevices.getDisplayMedia({
        video: sourceConstraint(requested),
        audio: Boolean(includeAudio),
      });
      if (epoch !== generation || disposed) {
        for (const track of captured.getTracks()) track.stop();
        throw new DOMException("Screen-share start was cancelled", "AbortError");
      }

      const actualMode = detectedShareMode(captured, requested);
      publish({ phase: "creating-session", shareMode: actualMode });
      const result = await request("/api/remote/session", {
        action: "create",
        shareMode: actualMode,
        maxViewers: clampInteger(maxViewers, 1, 1, 8),
        ttlMinutes: clampInteger(ttlMinutes, 120, 5, 360),
        allowRemoteControl: allowRemoteControl === true,
      });
      const session = result?.session;
      rtcConfiguration = normalizeRtcConfiguration(result?.rtcConfiguration);
      if (!SESSION_ID_RE.test(String(session?.id || ""))) throw new Error("Server returned an invalid remote session");
      createdSessionId = session.id;
      const scopedShareToken = String(result?.shareToken || session?.shareToken || "").trim();
      if (!scopedShareToken || scopedShareToken.length > 512) throw new Error("Server did not return a scoped share token");
      if (epoch !== generation || disposed) {
        await request("/api/remote/session", { action: "stop", sessionId: session.id }).catch(() => {});
        for (const track of captured.getTracks()) track.stop();
        throw new DOMException("Screen-share start was cancelled", "AbortError");
      }

      localStream = captured;
      shareToken = scopedShareToken;
      for (const track of localStream.getTracks()) {
        track.addEventListener("ended", () => {
          if (epoch === generation && state.mode === "host") void stopHost().catch(() => resetLocal());
        }, { once: true });
      }
      publish({
        sessionId: session.id,
        phase: "sharing",
        shareMode: session.shareMode || actualMode,
        viewerCount: Number(session.viewerCount || 0),
        viewers: Array.isArray(session.viewers) ? session.viewers : [],
        inviteAvailable: session.inviteAvailable === true,
        inviteUsed: session.inviteUsed === true,
        inviteExpiresAt: session.inviteExpiresAt || "",
        allowRemoteControl: session.allowRemoteControl === true,
        expiresAt: session.expiresAt || "",
        hasLocalStream: true,
      });
      attachStream(localStream, "host");
      void openHostEvents(epoch);
      if (session.allowRemoteControl) scheduleControlExpiry(controlDurationMs, epoch);
      return getState();
    } catch (error) {
      if (createdSessionId) {
        await request("/api/remote/session", { action: "stop", sessionId: createdSessionId }).catch(() => {});
      }
      for (const track of captured?.getTracks?.() || []) {
        try {
          track.stop();
        } catch {}
      }
      if (epoch === generation) resetLocal(errorMessage(error));
      throw asError(error);
    }
  }

  async function stopHost() {
    if (state.mode === "idle") return getState();
    if (state.mode !== "host") throw new Error("Controller is not hosting a share");
    const sessionId = state.sessionId;
    publish({ phase: "stopping" });
    let failure = null;
    if (sessionId) {
      try {
        await request("/api/remote/session", { action: "stop", sessionId });
      } catch (error) {
        failure = asError(error);
      }
    }
    resetLocal(failure ? errorMessage(failure) : "");
    if (failure) throw failure;
    return getState();
  }

  async function join(sessionReference, { name = "Mobile viewer", shareToken: suppliedShareToken = "" } = {}) {
    if (disposed) throw new Error("Remote controller is closed");
    if (state.mode !== "idle") throw new Error("หยุดหรือออกจาก remote session ปัจจุบันก่อน");
    requireBrowserRtc();
    const reference = parseShareReference(sessionReference, suppliedShareToken);
    const sessionId = reference.sessionId;
    const epoch = ++generation;
    publish({
      mode: "viewer",
      phase: "joining",
      sessionId,
      viewerId: "",
      lastError: "",
      connectionState: "new",
    });

    let joinedViewerId = "";
    let joinedViewerToken = "";
    try {
      const result = await request("/api/remote/join", {
        sessionId,
        shareToken: reference.shareToken,
        name: String(name).slice(0, 60),
      }, { scoped: true });
      if (!VIEWER_ID_RE.test(String(result?.viewerId || ""))) throw new Error("Server returned an invalid viewer identity");
      joinedViewerId = result.viewerId;
      const scopedViewerToken = String(result?.viewerToken || "").trim();
      if (!scopedViewerToken || scopedViewerToken.length > 512) throw new Error("Server did not return a scoped viewer token");
      joinedViewerToken = scopedViewerToken;
      if (epoch !== generation || disposed) {
        await request("/api/remote/leave", {
          sessionId,
          viewerId: result.viewerId,
          viewerToken: scopedViewerToken,
        }, { scoped: true }).catch(() => {});
        throw new DOMException("Join was cancelled", "AbortError");
      }

      const session = result.session || {};
      rtcConfiguration = normalizeRtcConfiguration(result?.rtcConfiguration);
      viewerToken = scopedViewerToken;
      shareToken = "";
      publish({
        viewerId: result.viewerId,
        shareMode: session.shareMode || "",
        viewerCount: Number(session.viewerCount || 1),
        allowRemoteControl: session.allowRemoteControl === true,
        expiresAt: session.expiresAt || "",
        phase: "waiting-for-host",
      });
      createViewerPeer(epoch);
      void openViewerEvents(epoch);
      return getState();
    } catch (error) {
      if (joinedViewerId && joinedViewerToken) {
        await request("/api/remote/leave", {
          sessionId,
          viewerId: joinedViewerId,
          viewerToken: joinedViewerToken,
        }, { scoped: true }).catch(() => {});
      }
      if (epoch === generation) resetLocal(errorMessage(error));
      throw asError(error);
    }
  }

  async function leave() {
    if (state.mode === "idle") return getState();
    if (state.mode !== "viewer") throw new Error("Controller is not a remote viewer");
    const sessionId = state.sessionId;
    const viewerId = state.viewerId;
    publish({ phase: "leaving" });
    let failure = null;
    if (sessionId && viewerId) {
      try {
        await request("/api/remote/leave", { sessionId, viewerId, viewerToken }, { scoped: true });
      } catch (error) {
        failure = asError(error);
      }
    }
    resetLocal(failure ? errorMessage(failure) : "");
    if (failure) throw failure;
    return getState();
  }

  function scheduleControlExpiry(durationMs, epoch = generation) {
    clearControlTimer();
    const duration = clampInteger(
      durationMs,
      DEFAULT_CONTROL_DURATION_MS,
      10 * 1000,
      MAX_CONTROL_DURATION_MS,
    );
    const expiresAt = new Date(Date.now() + duration).toISOString();
    publish({ remoteControlExpiresAt: expiresAt });
    controlTimer = setTimeout(() => {
      if (epoch !== generation || state.mode !== "host" || !state.allowRemoteControl) return;
      void setRemoteControl(false).catch((error) => report(error, "control-policy-error", epoch));
    }, duration);
  }

  async function setRemoteControl(enabled, { durationMs = DEFAULT_CONTROL_DURATION_MS, viewerId = "" } = {}) {
    if (state.mode !== "host" || !state.sessionId) {
      throw new Error("เปิดหรือปิดรีโมตได้จากเครื่องที่กำลังแชร์เท่านั้น");
    }
    const value = enabled === true;
    const targetViewerId = String(viewerId || state.viewers.find((viewer) => viewer.allowRemoteControl)?.id || state.viewers[0]?.id || "");
    if (!VIEWER_ID_RE.test(targetViewerId)) throw new Error("เลือกอุปกรณ์ผู้ชมที่ต้องการอนุญาตก่อน");
    const result = await request("/api/remote/session", {
      action: "set-control",
      sessionId: state.sessionId,
      viewerId: targetViewerId,
      enabled: value,
      durationMs: clampInteger(durationMs, DEFAULT_CONTROL_DURATION_MS, 10 * 1000, MAX_CONTROL_DURATION_MS),
    });
    clearControlTimer();
    const viewers = state.viewers.map((viewer) => viewer.id === targetViewerId
      ? {
          ...viewer,
          allowRemoteControl: result?.allowRemoteControl === true,
          controlExpiresAt: result?.controlExpiresAt || null,
        }
      : value ? { ...viewer, allowRemoteControl: false, controlExpiresAt: null } : viewer);
    publish({
      allowRemoteControl: result?.allowRemoteControl === true,
      remoteControlExpiresAt: result?.controlExpiresAt || "",
      viewers,
    });
    if (result?.allowRemoteControl) scheduleControlExpiry(durationMs);
    return getState();
  }

  async function disconnectViewer(viewerId = "") {
    if (state.mode !== "host" || !state.sessionId) {
      throw new Error("ตัด viewer ได้จากเครื่องที่กำลังแชร์เท่านั้น");
    }
    const targetViewerId = String(viewerId || state.viewers[0]?.id || "");
    if (!VIEWER_ID_RE.test(targetViewerId)) throw new Error("เลือกอุปกรณ์ผู้ชมที่ต้องการตัดก่อน");
    await request("/api/remote/session", {
      action: "disconnect-viewer",
      sessionId: state.sessionId,
      viewerId: targetViewerId,
    });
    removeHostPeer(targetViewerId);
    const viewers = state.viewers.filter((viewer) => viewer.id !== targetViewerId);
    publish({
      viewers,
      viewerCount: viewers.length,
      allowRemoteControl: viewers.some((viewer) => viewer.allowRemoteControl),
      remoteControlExpiresAt: viewers.find((viewer) => viewer.allowRemoteControl)?.controlExpiresAt || "",
    });
    return getState();
  }

  async function renewShareInvite() {
    if (state.mode !== "host" || !state.sessionId) {
      throw new Error("สร้าง invite ได้จากเครื่องที่กำลังแชร์เท่านั้น");
    }
    const result = await request("/api/remote/session", {
      action: "new-invite",
      sessionId: state.sessionId,
    });
    const token = String(result?.shareToken || "").trim();
    if (!token || token.length > 512) throw new Error("Server ไม่ได้ส่ง invite token ที่ถูกต้อง");
    shareToken = token;
    publish({
      inviteAvailable: true,
      inviteUsed: false,
      inviteExpiresAt: result?.inviteExpiresAt || "",
    });
    return getState();
  }

  async function sendCommand(input) {
    if (state.mode !== "viewer" || !state.sessionId || !state.viewerId) {
      throw new Error("ต้อง JOIN จากอุปกรณ์รีโมตก่อนส่งคำสั่ง");
    }
    if (!state.allowRemoteControl) throw new Error("เครื่องหลักยังไม่อนุญาตการควบคุม RWANG UI");
    const command = normalizeCommand(input);
    return request("/api/remote/command", {
      sessionId: state.sessionId,
      viewerId: state.viewerId,
      viewerToken,
      command,
    }, { scoped: true });
  }

  async function close() {
    if (disposed) return;
    try {
      if (state.mode === "host" && state.sessionId) {
        await request("/api/remote/session", { action: "stop", sessionId: state.sessionId });
      } else if (state.mode === "viewer" && state.sessionId && state.viewerId) {
        await request("/api/remote/leave", {
          sessionId: state.sessionId,
          viewerId: state.viewerId,
          viewerToken,
        }, { scoped: true });
      }
    } catch {}
    resetLocal();
    disposed = true;
  }

  publish();
  return Object.freeze({
    getState,
    attachPreview,
    parseSessionReference,
    parseShareReference,
    getShareReference,
    buildShareLink,
    startHost,
    stopHost,
    join,
    leave,
    setRemoteControl,
    setControlPolicy: setRemoteControl,
    disconnectViewer,
    renewShareInvite,
    sendCommand,
    close,
  });
}
