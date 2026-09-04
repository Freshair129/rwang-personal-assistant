import http from "node:http";
import https from "node:https";
import { createHmac } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRwangCore, migrateLegacyMutableData } from "./rwang.mjs";
import { createRemoteCore } from "./remote.mjs";
import { createSpotlightIndex, handleSpotlightApi } from "./spotlight.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const blobsDir = path.join(process.env.USERPROFILE || "C:\\Users\\pc", ".ollama", "models", "blobs");
const OLLAMA = "http://127.0.0.1:11434";
const DEFAULT_PORT = 4173;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const DESKTOP_NONCE_PATTERN = /^[0-9a-fA-F]{64}$/;
const DESKTOP_CHALLENGE_PATTERN = /^[0-9a-f]{64}$/;

// Runtime roots intentionally remain unset until startup validation completes. This
// prevents a malformed environment from causing writes to the source checkout.
let resourceDir = "";
let dataDir = "";
let workspaceDir = "";
let capabilityDir = "";
let publicDir = "";
let stateFile = "";
let stateTempFile = "";
let logFile = "";
let PORT = DEFAULT_PORT;
let TLS_OPTIONS = null;
let TRANSPORT_PROTOCOL = "http";
let HOST = "127.0.0.1";
let PUBLIC_ORIGIN = "";
let ICE_SERVERS = [];
let ALLOWED_HOSTS = new Set();
let server = null;
let DESKTOP_MODE = false;
let DESKTOP_NONCE = "";
const runtime = { state: "starting", readyAt: null };
const startupAbortController = new AbortController();
let resolveStartupFinished;
const startupFinished = new Promise((resolve) => {
  resolveStartupFinished = resolve;
});

function cleanEnv(value, max = 2048) {
  return String(value || "").trim().slice(0, max);
}

function startupError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.startupSafeMessage = message;
  return error;
}

function startupShutdownError() {
  return startupError("STARTUP_CANCELLED", "RWANG startup cancelled during shutdown");
}

function assertStartupActive() {
  if (shuttingDown || startupAbortController.signal.aborted) throw startupShutdownError();
}

function configureDesktopReadiness() {
  DESKTOP_MODE = String(process.env.RWANG_DESKTOP || "").trim() === "1";
  DESKTOP_NONCE = "";
  if (!DESKTOP_MODE) return;

  // The nonce is deliberately read without cleanEnv(): surrounding whitespace
  // must not be silently accepted for an authentication secret.
  const nonce = String(process.env.RWANG_DESKTOP_NONCE ?? "");
  if (!DESKTOP_NONCE_PATTERN.test(nonce)) {
    throw startupError(
      "INVALID_DESKTOP_NONCE",
      "RWANG_DESKTOP_NONCE must be exactly 64 hexadecimal characters",
    );
  }
  DESKTOP_NONCE = nonce;
}

function desktopHealthProof(req) {
  if (!DESKTOP_MODE) return "";
  const challenge = req.headers["x-rwang-desktop-challenge"];
  if (typeof challenge !== "string" || !DESKTOP_CHALLENGE_PATTERN.test(challenge)) return null;
  return createHmac("sha256", Buffer.from(DESKTOP_NONCE, "hex"))
    .update(Buffer.from(challenge, "hex"))
    .digest("hex");
}

function isContained(parent, child, { strict = false } = {}) {
  const relative = path.relative(parent, child);
  if (!relative) return !strict;
  return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function hasUnsafePathNamespace(value) {
  const normalized = String(value || "").replaceAll("/", "\\").toLowerCase();
  return normalized.startsWith("\\\\?\\")
    || normalized.startsWith("\\\\.\\")
    || normalized.startsWith("\\\\\\?\\");
}

function normalizeConfiguredPath(name, supplied) {
  if (typeof supplied !== "string" || !supplied.trim() || !path.isAbsolute(supplied.trim())) {
    throw startupError(`INVALID_${name}`, `${name} must be an absolute path`);
  }
  const requested = path.resolve(supplied.trim());
  if (hasUnsafePathNamespace(requested)) {
    throw startupError(`INVALID_${name}`, `${name} uses an unsupported path namespace`);
  }
  return requested;
}

async function resolveConfiguredDirectory(name, supplied, { create = false } = {}) {
  const requested = normalizeConfiguredPath(name, supplied);
  try {
    if (create) await mkdir(requested, { recursive: true });
    const requestedStats = await lstat(requested);
    if (!requestedStats.isDirectory() || requestedStats.isSymbolicLink()) {
      throw startupError(`INVALID_${name}`, `${name} must be a directory`);
    }
    const canonical = await realpath(requested);
    const canonicalStats = await lstat(canonical);
    if (!canonicalStats.isDirectory() || canonicalStats.isSymbolicLink()) {
      throw startupError(`INVALID_${name}`, `${name} must be a directory`);
    }
    return canonical;
  } catch (error) {
    if (error?.code === `INVALID_${name}`) throw error;
    throw startupError(`INVALID_${name}`, `${name} is unavailable or inaccessible`);
  }
}

async function canonicalizeProspectiveConfiguredDirectory(name, requested) {
  const missingSegments = [];
  let current = requested;
  while (true) {
    try {
      const canonicalAncestor = await realpath(current);
      const ancestorStats = await lstat(canonicalAncestor);
      if (!ancestorStats.isDirectory() || ancestorStats.isSymbolicLink()) {
        throw startupError(`INVALID_${name}`, `${name} must descend from a directory`);
      }
      return path.join(canonicalAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") {
        if (error?.code === `INVALID_${name}`) throw error;
        throw startupError(`INVALID_${name}`, `${name} is unavailable or inaccessible`);
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw startupError(`INVALID_${name}`, `${name} has no accessible ancestor`);
      }
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

function assertDataDirectorySeparate(dataPath, otherPath) {
  if (isContained(otherPath, dataPath) || isContained(dataPath, otherPath)) {
    throw startupError("INVALID_DATA_DIR", "RWANG_DATA_DIR must be separate from RESOURCE_DIR and WORKSPACE_DIR");
  }
}

function pathsMatch(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function resolveContainedRegularFile(root, requested, errorCode, message) {
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
    const rootStats = await lstat(canonicalRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("invalid root");
  } catch {
    throw startupError(errorCode, message);
  }

  const lexicalPath = path.resolve(requested);
  if (!isContained(canonicalRoot, lexicalPath, { strict: true })) {
    throw startupError(errorCode, message);
  }

  let requestedStats;
  try {
    requestedStats = await lstat(lexicalPath);
  } catch {
    throw startupError(errorCode, message);
  }
  if (requestedStats.isSymbolicLink() || !requestedStats.isFile()) {
    throw startupError(errorCode, message);
  }

  let canonicalPath;
  try {
    canonicalPath = await realpath(lexicalPath);
    const canonicalStats = await lstat(canonicalPath);
    if (canonicalStats.isSymbolicLink() || !canonicalStats.isFile()) throw new Error("invalid target");
  } catch {
    throw startupError(errorCode, message);
  }
  // A canonical path change indicates a link/reparse traversal. Reject it even
  // when the resolved target happens to remain below the configured root.
  if (!pathsMatch(lexicalPath, canonicalPath)
    || !isContained(canonicalRoot, canonicalPath, { strict: true })) {
    throw startupError(errorCode, message);
  }
  return canonicalPath;
}

function parsePort(value) {
  const supplied = cleanEnv(value, 16) || String(DEFAULT_PORT);
  if (!/^\d+$/.test(supplied)) {
    throw startupError("INVALID_PORT", "OLLAMA_CENTER_PORT must be an integer from 1 to 65535");
  }
  const port = Number(supplied);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw startupError("INVALID_PORT", "OLLAMA_CENTER_PORT must be an integer from 1 to 65535");
  }
  return port;
}

function isLoopbackBind(host) {
  return ["127.0.0.1", "::1", "localhost"].includes(String(host || "").trim().toLowerCase());
}

async function resolveSecretFile(value) {
  const supplied = cleanEnv(value);
  if (!supplied) return "";
  const resolved = path.resolve(resourceDir, supplied);
  return resolveContainedRegularFile(
    resourceDir,
    resolved,
    "INVALID_TLS_PATH",
    "TLS files must be regular files contained by RWANG_RESOURCE_DIR",
  );
}

async function loadTlsConfiguration() {
  const certFile = await resolveSecretFile(process.env.RWANG_TLS_CERT_FILE);
  const keyFile = await resolveSecretFile(process.env.RWANG_TLS_KEY_FILE);
  const pfxFile = await resolveSecretFile(process.env.RWANG_TLS_PFX_FILE);
  const passphrase = cleanEnv(process.env.RWANG_TLS_PASSPHRASE, 4096);

  if (pfxFile && (certFile || keyFile)) {
    throw startupError("INVALID_TLS_CONFIG", "กำหนด TLS เป็น PFX หรือ cert/key อย่างใดอย่างหนึ่งเท่านั้น");
  }
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw startupError("INVALID_TLS_CONFIG", "ต้องกำหนด RWANG_TLS_CERT_FILE และ RWANG_TLS_KEY_FILE ให้ครบคู่");
  }
  if (!pfxFile && !certFile) return null;

  try {
    if (pfxFile) return { pfx: await readFile(pfxFile), ...(passphrase ? { passphrase } : {}) };
    return {
      cert: await readFile(certFile),
      key: await readFile(keyFile),
      ...(passphrase ? { passphrase } : {}),
    };
  } catch {
    throw startupError("INVALID_TLS_FILES", "อ่านไฟล์ TLS ไม่สำเร็จ ตรวจ path และสิทธิ์ของ cert/key/PFX");
  }
}

function normalizePublicOrigin(value) {
  const supplied = cleanEnv(value);
  if (!supplied) return "";
  const url = new URL(supplied);
  if (!["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("RWANG_PUBLIC_ORIGIN ต้องเป็น origin เท่านั้น เช่น https://rwang.home.arpa:4173");
  }
  return url.origin;
}

function normalizeIceServers(value) {
  if (!cleanEnv(value)) return [];
  let input;
  try {
    input = JSON.parse(value);
  } catch {
    throw new Error("RWANG_ICE_SERVERS_JSON ต้องเป็น JSON array ที่ถูกต้อง");
  }
  if (!Array.isArray(input) || input.length > 6) throw new Error("กำหนด ICE server ได้ไม่เกิน 6 รายการ");
  return input.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("ICE server แต่ละรายการต้องเป็น object");
    const values = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    const urls = values.map((url) => cleanEnv(url, 1000)).filter(Boolean);
    if (!urls.length || urls.length > 8 || urls.some((url) => !/^(?:stun|stuns|turn|turns):/i.test(url))) {
      throw new Error("ICE server รองรับเฉพาะ stun:, stuns:, turn: หรือ turns:");
    }
    return {
      urls: Array.isArray(entry.urls) ? urls : urls[0],
      ...(entry.username ? { username: cleanEnv(entry.username, 500) } : {}),
      ...(entry.credential ? { credential: cleanEnv(entry.credential, 1000) } : {}),
    };
  });
}

function buildAllowedHosts() {
  const values = new Set([
    `localhost:${PORT}`,
    `127.0.0.1:${PORT}`,
    `[::1]:${PORT}`,
  ]);
  if (PUBLIC_ORIGIN) values.add(new URL(PUBLIC_ORIGIN).host.toLowerCase());
  if (!['0.0.0.0', '::'].includes(HOST) && !isLoopbackBind(HOST)) values.add(`${HOST}:${PORT}`.toLowerCase());
  for (const group of Object.values(os.networkInterfaces())) {
    for (const address of group || []) {
      if (address.family === "IPv4" && !address.internal) values.add(`${address.address}:${PORT}`.toLowerCase());
    }
  }
  for (const item of cleanEnv(process.env.RWANG_ALLOWED_HOSTS, 4000).split(",")) {
    const value = item.trim().toLowerCase();
    if (/^[a-z0-9.[\]:_-]+$/.test(value)) values.add(value.includes(":") ? value : `${value}:${PORT}`);
  }
  return values;
}

let rwang;
let remote;
let spotlight;

async function configureRuntime() {
  configureDesktopReadiness();
  assertStartupActive();
  PORT = parsePort(process.env.OLLAMA_CENTER_PORT);

  const userDataRoot = cleanEnv(process.env.LOCALAPPDATA, 1000);
  const defaultDataDir = userDataRoot && path.isAbsolute(userDataRoot)
    ? path.join(userDataRoot, "RWANG", "data")
    : path.join(os.homedir(), ".rwang", "data");
  const requestedResourceDir = cleanEnv(process.env.RWANG_RESOURCE_DIR, 4000) || __dirname;
  const requestedWorkspaceDir = cleanEnv(process.env.RWANG_WORKSPACE_DIR, 4000) || requestedResourceDir;
  const requestedDataDir = cleanEnv(process.env.RWANG_DATA_DIR, 4000) || defaultDataDir;
  const requestedCapabilityDir = cleanEnv(process.env.RWANG_CAPABILITY_DIR, 4000)
    || path.join(requestedResourceDir, "capabilities", "rwang-document-intelligence");

  resourceDir = await resolveConfiguredDirectory("RESOURCE_DIR", requestedResourceDir);
  assertStartupActive();
  workspaceDir = await resolveConfiguredDirectory("WORKSPACE_DIR", requestedWorkspaceDir);
  assertStartupActive();
  // Validate the lexical relationship before create:true can mutate a source
  // or workspace tree. Canonical checks below still protect symlink aliases
  // after the data directory exists.
  const requestedDataPath = normalizeConfiguredPath("DATA_DIR", requestedDataDir);
  const prospectiveDataPath = await canonicalizeProspectiveConfiguredDirectory("DATA_DIR", requestedDataPath);
  assertDataDirectorySeparate(prospectiveDataPath, resourceDir);
  assertDataDirectorySeparate(prospectiveDataPath, workspaceDir);
  dataDir = await resolveConfiguredDirectory("DATA_DIR", requestedDataPath, { create: true });
  assertStartupActive();
  capabilityDir = await resolveConfiguredDirectory("CAPABILITY_DIR", requestedCapabilityDir);
  assertStartupActive();

  if (!isContained(resourceDir, capabilityDir, { strict: true })) {
    throw startupError("INVALID_CAPABILITY_DIR", "RWANG_CAPABILITY_DIR must be contained by RWANG_RESOURCE_DIR");
  }
  if (isContained(resourceDir, dataDir) || isContained(dataDir, resourceDir)) {
    throw startupError("INVALID_DATA_DIR", "RWANG_DATA_DIR must be separate from RWANG_RESOURCE_DIR");
  }
  if (isContained(workspaceDir, dataDir) || isContained(dataDir, workspaceDir)) {
    throw startupError("INVALID_DATA_DIR", "RWANG_DATA_DIR must be separate from RWANG_WORKSPACE_DIR");
  }

  const requestedPublicDir = path.join(resourceDir, "public");
  try {
    const publicStats = await lstat(requestedPublicDir);
    if (!publicStats.isDirectory() || publicStats.isSymbolicLink()) throw new Error("not a directory");
    publicDir = await realpath(requestedPublicDir);
    if (!isContained(resourceDir, publicDir, { strict: true })) throw new Error("outside resource root");
  } catch {
    throw startupError("INVALID_RESOURCE_DIR", "RWANG_RESOURCE_DIR must contain the public resource directory");
  }
  stateFile = path.join(dataDir, ".queue-state.json");
  stateTempFile = path.join(dataDir, ".queue-state.tmp");
  logFile = path.join(dataDir, "rwang.log");

  const migration = await migrateLegacyMutableData({ legacyRoot: resourceDir, dataRoot: dataDir });
  assertStartupActive();
  if (migration.copied.length) {
    console.log(`RWANG legacy data copied to DATA_DIR: ${migration.copied.join(", ")}`);
  }

  TLS_OPTIONS = await loadTlsConfiguration();
  assertStartupActive();
  TRANSPORT_PROTOCOL = TLS_OPTIONS ? "https" : "http";
  const allowInsecureLan = TRUE_VALUES.has(String(process.env.RWANG_ALLOW_INSECURE_LAN || "").trim().toLowerCase());
  HOST = cleanEnv(process.env.RWANG_HOST, 255)
    || (TLS_OPTIONS || allowInsecureLan ? "0.0.0.0" : "127.0.0.1");
  PUBLIC_ORIGIN = normalizePublicOrigin(process.env.RWANG_PUBLIC_ORIGIN);
  ICE_SERVERS = normalizeIceServers(process.env.RWANG_ICE_SERVERS_JSON);

  if (!TLS_OPTIONS && !allowInsecureLan && !isLoopbackBind(HOST)) {
    throw startupError("INSECURE_LAN_DISABLED", "ปฏิเสธ LAN HTTP: ตั้งค่า TLS หรือ RWANG_ALLOW_INSECURE_LAN=1 อย่างชัดเจน");
  }
  if (PUBLIC_ORIGIN && (!TLS_OPTIONS || new URL(PUBLIC_ORIGIN).protocol !== "https:")) {
    throw startupError("INVALID_PUBLIC_ORIGIN", "RWANG_PUBLIC_ORIGIN ใช้ได้เฉพาะ native HTTPS เท่านั้น และไม่ยกระดับ HTTP จาก reverse proxy");
  }
  if (PUBLIC_ORIGIN && isLoopbackBind(HOST)) {
    throw startupError("INVALID_PUBLIC_ORIGIN", "RWANG_PUBLIC_ORIGIN ต้องใช้ native HTTPS listener บน LAN; reverse-proxy loopback mode ไม่ได้รับความไว้วางใจ");
  }
  ALLOWED_HOSTS = buildAllowedHosts();
}

function spotlightRootConfiguration() {
  const homeDir = os.homedir();
  const configured = cleanEnv(process.env.RWANG_SPOTLIGHT_ROOTS, 8000);
  const personalRoots = configured
    ? configured.split(path.delimiter).map((value) => value.trim()).filter(Boolean)
    : ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"]
      .map((name) => path.join(homeDir, name));
  return [
    { label: "Workspace", path: workspaceDir },
    ...personalRoots.slice(0, 7).map((rootPath, index) => ({
      label: configured ? path.basename(rootPath) || `Folder ${index + 1}` : path.basename(rootPath),
      path: rootPath,
    })),
  ];
}

const presets = [
  {
    id: "mellum2",
    name: "hf.co/JetBrains/Mellum2-12B-A2.5B-Thinking-GGUF-Q4_K_M:Q4_K_M",
    label: "Mellum2 Thinking",
    role: "Reasoning · Coding",
    digest: "489cf0d7ca86",
  },
  {
    id: "omnicoder",
    name: "hf.co/Tesslate/OmniCoder-9B-GGUF:Q4_K_M",
    label: "OmniCoder 9B",
    role: "Coding",
    digest: "550e8f7253c8",
  },
  {
    id: "dark-champion",
    name: "hf.co/DavidAU/Llama-3.2-8X3B-MOE-Dark-Champion-Instruct-uncensored-abliterated-18.4B-GGUF:Q4_K_M",
    label: "Dark Champion 18.4B",
    role: "General · MoE",
    digest: "d98bc0df90da",
  },
  {
    id: "thaidoc",
    name: "hf.co/dearxoasis/thaidoc-finetune-gguf:Q4_K_M",
    label: "ThaiDoc Finetune",
    role: "Thai documents",
    digest: "d6c0d0595f06",
  },
  {
    id: "dagger",
    name: "hf.co/peculiar-ragdoll/Dagger-Qwen3.6-27B-GGUF-MTP:Q4_K_M",
    label: "Dagger Qwen 27B",
    role: "Coding · MTP",
    digest: "d3da36658e06",
  },
];

const state = {
  jobs: new Map(),
  activeId: null,
  queue: [],
  controllers: new Map(),
  log: [],
  pauseQueue: false,
};
const MAX_QUEUE_EVENT_CLIENTS = 16;
const MAX_QUEUE_EVENT_CLIENTS_PER_PRINCIPAL = 2;
const MAX_LOCAL_QUEUE_EVENT_CLIENTS = 8;
const MAX_QUEUE_EVENT_BUFFER_BYTES = 256 * 1024;
const clients = new Set();
const queueClientKeys = new Map();
const queueClientCounts = new Map();
let persistTimer = null;
let persistChain = Promise.resolve();

function now() {
  return new Date().toISOString();
}

function addLog(level, message, model = "system") {
  const entry = { at: now(), level, message, model };
  state.log.unshift(entry);
  state.log = state.log.slice(0, 120);
  void appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf8").catch(() => {});
  broadcast();
}

function publicState() {
  return {
    activeId: state.activeId,
    queue: state.queue,
    paused: state.pauseQueue,
    jobs: [...state.jobs.values()],
    log: state.log,
  };
}

async function persist() {
  const saved = {
    jobs: [...state.jobs.values()].map(({ speed, ...job }) => ({ ...job, speed: 0 })),
    queue: state.queue,
    paused: state.pauseQueue,
  };
  persistChain = persistChain.then(async () => {
    await writeFile(stateTempFile, JSON.stringify(saved, null, 2), "utf8");
    await rename(stateTempFile, stateFile);
  }).catch((error) => {
    void appendFile(logFile, `${JSON.stringify({ at: now(), level: "error", message: `บันทึกสถานะไม่สำเร็จ: ${error.message}`, model: "system" })}\n`, "utf8");
  });
  await persistChain;
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void persist(), 250);
}

async function restore() {
  try {
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    for (const job of saved.jobs || []) {
      const status = ["downloading", "retrying"].includes(job.status) ? "paused" : job.status;
      state.jobs.set(job.id, { ...job, status, speed: 0 });
    }
    state.queue = [];
    state.pauseQueue = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      void appendFile(logFile, `${JSON.stringify({ at: now(), level: "warn", message: "ไฟล์สถานะเดิมอ่านไม่ได้ จึงสร้างสถานะใหม่จาก Ollama", model: "system" })}\n`, "utf8");
    }
  }
}

function removeQueueEventClient(client) {
  if (!clients.delete(client)) return;
  const key = queueClientKeys.get(client);
  queueClientKeys.delete(client);
  if (key) {
    const remaining = Math.max(0, (queueClientCounts.get(key) || 1) - 1);
    if (remaining) queueClientCounts.set(key, remaining);
    else queueClientCounts.delete(key);
  }
}

function writeQueueEvent(client, payload) {
  if (client.destroyed || !client.writable || client.writableLength > MAX_QUEUE_EVENT_BUFFER_BYTES) {
    removeQueueEventClient(client);
    try { client.end(); } catch {}
    return false;
  }
  try {
    if (!client.write(payload)) {
      removeQueueEventClient(client);
      try { client.end(); } catch {}
      return false;
    }
    return true;
  } catch {
    removeQueueEventClient(client);
    try { client.end(); } catch {}
    return false;
  }
}

function queueEventPrincipalKey(principal, req) {
  if (principal.kind === "device") return `device:${principal.device.id}`;
  if (principal.kind === "local") return "local";
  return `master:${String(req.socket?.remoteAddress || "unknown")}`;
}

function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const client of [...clients]) writeQueueEvent(client, payload);
  schedulePersist();
}

async function ollamaFetch(route, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${OLLAMA}${route}`, { ...options, signal: options.signal || controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ollamaJson(route, fallback) {
  try {
    const res = await ollamaFetch(route);
    if (!res.ok) return fallback;
    return await res.json();
  } catch {
    return fallback;
  }
}

async function getPartialMap() {
  const result = {};
  try {
    for (const entry of await readdir(blobsDir)) {
      if (!entry.endsWith("-partial")) continue;
      const info = await stat(path.join(blobsDir, entry));
      const digest = entry.replace("sha256-", "").replace("-partial", "");
      result[digest.slice(0, 12)] = { bytes: info.size, modifiedAt: info.mtime.toISOString() };
    }
  } catch {}
  return result;
}

async function getDisk() {
  try {
    const info = await statfs(blobsDir);
    return { free: info.bavail * info.bsize, total: info.blocks * info.bsize };
  } catch {
    return { free: 0, total: 0 };
  }
}

async function getStatus() {
  const [version, tags, running, partials, disk] = await Promise.all([
    ollamaJson("/api/version", null),
    ollamaJson("/api/tags", { models: [] }),
    ollamaJson("/api/ps", { models: [] }),
    getPartialMap(),
    getDisk(),
  ]);
  const installed = new Set((tags.models || []).map((m) => m.name));
  return {
    online: Boolean(version),
    version: version?.version || "—",
    disk,
    installed: tags.models || [],
    running: running.models || [],
    presets: presets.map((model) => ({
      ...model,
      installed: installed.has(model.name),
      partial: partials[model.digest] || null,
    })),
    queueState: publicState(),
  };
}

function makeJob(model) {
  const preset = presets.find((item) => item.name === model || item.id === model);
  const name = preset?.name || model.replaceAll("\\_", "_");
  const existing = [...state.jobs.values()].find((job) => job.name === name);
  if (existing) return existing;
  const job = {
    id: preset?.id || `custom-${Date.now()}`,
    name,
    label: preset?.label || name.split("/").at(-1),
    status: "queued",
    detail: "รอคิว",
    completed: 0,
    total: 0,
    percent: 0,
    speed: 0,
    attempts: 0,
    updatedAt: now(),
  };
  state.jobs.set(job.id, job);
  return job;
}

function enqueue(model, resetAttempts = false) {
  const job = makeJob(model);
  if (resetAttempts) job.attempts = 0;
  if (job.status === "complete") return job;
  job.status = "queued";
  job.detail = "รอคิวดาวน์โหลด";
  job.updatedAt = now();
  if (!state.queue.includes(job.id) && state.activeId !== job.id) state.queue.push(job.id);
  state.pauseQueue = false;
  addLog("info", `เพิ่ม ${job.label} เข้าคิว`, job.id);
  void processQueue();
  return job;
}

async function processQueue() {
  if (state.activeId || state.pauseQueue) return;
  const id = state.queue.shift();
  if (!id) return;
  const job = state.jobs.get(id);
  if (!job) return void processQueue();
  state.activeId = id;
  await pull(job);
  state.activeId = null;
  broadcast();
  void processQueue();
}

async function pull(job) {
  const controller = new AbortController();
  state.controllers.set(job.id, controller);
  job.status = "downloading";
  job.attempts += 1;
  job.detail = "กำลังเชื่อมต่อแหล่งโมเดล";
  job.updatedAt = now();
  addLog("info", `เริ่ม/ต่อดาวน์โหลด ครั้งที่ ${job.attempts}`, job.id);

  let lastBytes = job.completed || 0;
  let lastAt = Date.now();
  try {
    const res = await fetch(`${OLLAMA}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: job.name, stream: true }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Ollama ตอบกลับ ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.error) throw new Error(event.error);
        const timestamp = Date.now();
        const elapsed = Math.max((timestamp - lastAt) / 1000, 0.1);
        if (event.completed != null) {
          job.speed = Math.max(0, (event.completed - lastBytes) / elapsed);
          lastBytes = event.completed;
          lastAt = timestamp;
          job.completed = event.completed;
        }
        if (event.total) job.total = event.total;
        job.percent = job.total ? Math.min(100, (job.completed / job.total) * 100) : 0;
        job.detail = event.status || "กำลังดาวน์โหลด";
        job.updatedAt = now();
        broadcast();
      }
    }
    job.status = "complete";
    job.percent = 100;
    job.speed = 0;
    job.detail = job.runAfterPull ? "ดาวน์โหลดเสร็จ — กำลังโหลดเข้า memory" : "ดาวน์โหลดและตรวจสอบสำเร็จ";
    addLog("success", `${job.label} พร้อมใช้งาน`, job.id);
    if (job.runAfterPull) {
      try {
        await modelAction("load", job.name);
        job.detail = "พร้อมใช้งานและอยู่ใน memory";
      } catch (error) {
        job.detail = "ดาวน์โหลดสำเร็จ แต่โหลดเข้า memory ไม่สำเร็จ";
        addLog("error", `โหลด ${job.label} ไม่สำเร็จ: ${error.message}`, job.id);
      } finally {
        job.runAfterPull = false;
      }
    }
  } catch (error) {
    job.speed = 0;
    if (controller.signal.aborted) {
      job.status = "paused";
      job.detail = "หยุดโดยผู้ใช้ — ไฟล์ partial ยังอยู่";
      addLog("warn", `หยุด ${job.label} โดยเก็บไฟล์ไว้`, job.id);
    } else if (job.attempts < 6) {
      const delay = Math.min(60, 5 * 2 ** (job.attempts - 1));
      job.status = "retrying";
      job.detail = `การเชื่อมต่อขาด — ลองใหม่ใน ${delay} วินาที`;
      job.error = error.message;
      addLog("warn", `${error.message}; จะลองใหม่อัตโนมัติ`, job.id);
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      if (!state.pauseQueue && job.status === "retrying") {
        state.queue.unshift(job.id);
      } else {
        job.status = "paused";
      }
    } else {
      job.status = "failed";
      job.detail = "ลองครบ 6 ครั้งแล้ว — กด Retry เพื่อเริ่มรอบใหม่";
      job.error = error.message;
      addLog("error", `${job.label}: ${error.message}`, job.id);
    }
  } finally {
    state.controllers.delete(job.id);
    job.updatedAt = now();
    broadcast();
  }
}

async function modelAction(type, model) {
  if (type === "load") {
    const res = await ollamaFetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: "10m" }),
    }, 120000);
    if (!res.ok) throw new Error(await res.text());
    addLog("success", "โหลดโมเดลเข้า memory แล้ว", model);
    return;
  }
  if (type === "unload") {
    const res = await ollamaFetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: 0 }),
    }, 30000);
    if (!res.ok) throw new Error(await res.text());
    addLog("info", "นำโมเดลออกจาก memory แล้ว", model);
  }
}

async function executeCommand(rawCommand) {
  const command = String(rawCommand || "").trim().replaceAll("\\_", "_");
  if (!command) throw new Error("กรุณาใส่คำสั่ง Ollama");
  if (/^ollama\s+(list|ps)\s*$/i.test(command)) {
    return { message: "อัปเดตสถานะโมเดลแล้ว", refresh: true };
  }
  const match = command.match(/^ollama\s+(run|pull|stop)\s+(.+)$/i);
  if (!match) throw new Error("รองรับคำสั่ง ollama run, ollama pull, ollama stop, ollama list และ ollama ps");
  const operation = match[1].toLowerCase();
  const model = match[2].trim().replace(/^['"]|['"]$/g, "");
  if (!model || /[\r\n;&|<>]/.test(model)) throw new Error("ชื่อโมเดลไม่ถูกต้อง");

  if (operation === "pull") {
    const job = enqueue(model);
    return { message: `เพิ่ม ${job.label} เข้าคิวดาวน์โหลดแล้ว`, jobId: job.id, model };
  }
  if (operation === "stop") {
    await modelAction("unload", model);
    return { message: `หยุด ${model} และนำออกจาก memory แล้ว`, model };
  }

  const tags = await ollamaJson("/api/tags", { models: [] });
  const installed = (tags.models || []).some((item) => item.name === model || item.model === model);
  if (installed) {
    await modelAction("load", model);
    return { message: `รัน ${model} แล้ว · พร้อมเลือกใน Chat Workspace`, model };
  }
  const job = enqueue(model);
  job.runAfterPull = true;
  job.detail = "รอดาวน์โหลด แล้วจะรันอัตโนมัติ";
  broadcast();
  return { message: `ยังไม่มีโมเดลในเครื่อง — เพิ่มเข้าคิวและจะรันอัตโนมัติเมื่อเสร็จ`, jobId: job.id, model };
}

async function streamChat(req, res) {
  const body = await readBody(req);
  const model = String(body.model || "").trim().replaceAll("\\_", "_");
  const inputMessages = Array.isArray(body.messages) ? body.messages : [];
  if (!model || /[\r\n;&|<>]/.test(model)) throw new Error("กรุณาเลือกโมเดลที่ถูกต้อง");
  if (!inputMessages.length) throw new Error("กรุณาใส่ข้อความก่อนส่ง");

  const messages = inputMessages.slice(-40).map((message) => {
    const role = ["system", "user", "assistant"].includes(message?.role) ? message.role : "user";
    const content = String(message?.content || "").slice(0, 100000);
    return { role, content };
  }).filter((message) => message.content.trim());
  if (!messages.length) throw new Error("ไม่พบข้อความที่ส่งได้");

  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  res.on("close", () => controller.abort());
  addLog("info", `เริ่ม chat ด้วย ${model.split("/").at(-1)}`, "chat");

  const upstream = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true, keep_alive: "10m" }),
    signal: controller.signal,
  });
  if (!upstream.ok || !upstream.body) {
    throw new Error((await upstream.text()) || `Ollama ตอบกลับ ${upstream.status}`);
  }

  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
  });
  const reader = upstream.body.getReader();
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    completed = true;
    res.end();
    addLog("success", `ตอบ chat สำเร็จด้วย ${model.split("/").at(-1)}`, "chat");
  } catch (error) {
    if (!controller.signal.aborted) {
      res.write(`${JSON.stringify({ error: error.message, done: true })}\n`);
      res.end();
      addLog("error", `chat ล้มเหลว: ${error.message}`, "chat");
    }
  } finally {
    if (!completed) controller.abort();
  }
}

async function readBody(req, maxBytes = 1024 * 1024) {
  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    const error = new Error(`request body ใหญ่เกิน ${Math.ceil(maxBytes / 1024)} KB`);
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error(`request body ใหญ่เกิน ${Math.ceil(maxBytes / 1024)} KB`);
      error.status = 413;
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function sameHostOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol)
      && parsed.host.toLowerCase() === String(req.headers.host || "").toLowerCase();
  } catch {
    return false;
  }
}

function isRemoteApiPath(pathname) {
  return pathname === "/api/remote"
    || pathname === "/api/remote/session"
    || pathname === "/api/remote/join"
    || pathname === "/api/remote/leave"
    || pathname === "/api/remote/signal"
    || pathname === "/api/remote/events"
    || pathname === "/api/remote/events-ticket"
    || pathname === "/api/remote/command";
}

function enforceJsonPost(req, res) {
  if (!sameHostOrigin(req)) {
    json(res, 403, { error: "ปฏิเสธคำขอจากเว็บไซต์อื่น" });
    return false;
  }
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    json(res, 415, { error: "POST API ต้องใช้ Content-Type: application/json" });
    return false;
  }
  return true;
}

function closeQueueEventClients() {
  for (const client of [...clients]) {
    removeQueueEventClient(client);
    try {
      client.end();
    } catch {}
  }
}

async function api(req, res, url) {
  // Keep health checks dependency-free so launchers and supervisors can probe
  // the listener without touching Ollama or config. Desktop launchers must
  // complete a per-request HMAC challenge before receiving readiness details.
  if (req.method === "GET" && url.pathname === "/api/health") {
    const desktopProof = desktopHealthProof(req);
    if (desktopProof === null) {
      return json(res, 401, {
        ok: false,
        ready: false,
        status: "unauthorized",
        service: "rwang",
      });
    }
    const ready = runtime.state === "ready";
    return json(res, ready ? 200 : 503, {
      ok: ready,
      ready,
      status: runtime.state,
      service: "rwang",
    }, desktopProof ? { "x-rwang-desktop-proof": desktopProof } : {});
  }
  if (url.pathname === "/api/rwang/pair") {
    if (req.method === "POST" && !enforceJsonPost(req, res)) return;
    const handled = await rwang.handlePublicApi(req, res, url, {
      readBody: (request) => readBody(request, 4 * 1024),
      json,
    });
    if (handled !== false) return handled;
  }
  if (isRemoteApiPath(url.pathname)) {
    if (req.method === "POST" && !enforceJsonPost(req, res)) return;
    const remoteBodyLimit = url.pathname === "/api/remote/signal" ? 144 * 1024 : 8 * 1024;
    const handled = await remote.handleApi(req, res, url, {
      readBody: (request) => readBody(request, remoteBodyLimit),
      json,
    });
    if (handled !== false) return handled;
  }
  const principal = rwang.authorize(req, url);
  if (!principal.authorized) {
    return json(res, 401, { error: "ต้องใช้ RWANG access token จากเครื่องหลัก" });
  }
  if (principal.kind === "device" && !rwang.isDeviceApiAllowed(req, url)) {
    return json(res, 403, { error: "อุปกรณ์นี้ไม่มี scope สำหรับคำสั่งดังกล่าว" });
  }
  if (req.method === "POST") {
    if (!enforceJsonPost(req, res)) return;
  }
  const spotlightHandled = await handleSpotlightApi(req, res, url, {
    principal,
    spotlight,
    readBody: (request) => readBody(request, 4 * 1024),
    json,
  });
  if (spotlightHandled !== false) return spotlightHandled;
  if (req.method === "GET" && url.pathname === "/api/status") {
    return json(res, 200, {
      ...(await getStatus()),
      rwang: await rwang.snapshot(req),
      remote: remote.snapshot(req),
    });
  }
  if (req.method === "GET" && url.pathname === "/api/events") {
    const clientKey = queueEventPrincipalKey(principal, req);
    const principalLimit = principal.kind === "local"
      ? MAX_LOCAL_QUEUE_EVENT_CLIENTS
      : MAX_QUEUE_EVENT_CLIENTS_PER_PRINCIPAL;
    if (clients.size >= MAX_QUEUE_EVENT_CLIENTS
      || (queueClientCounts.get(clientKey) || 0) >= principalLimit) {
      return json(res, 429, { error: "มี event stream เปิดอยู่มากเกินไป" });
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    });
    clients.add(res);
    queueClientKeys.set(res, clientKey);
    queueClientCounts.set(clientKey, (queueClientCounts.get(clientKey) || 0) + 1);
    const cleanup = () => removeQueueEventClient(res);
    req.once("close", cleanup);
    res.once("close", cleanup);
    writeQueueEvent(res, `data: ${JSON.stringify(publicState())}\n\n`);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/chat") {
    try {
      await rwang.streamChat(req, res, readBody);
    } catch (error) {
      addLog("error", `chat เริ่มไม่สำเร็จ: ${error.message}`, "chat");
      if (!res.headersSent) return json(res, 400, { error: error.message });
      res.end();
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/action") {
    try {
      const body = await readBody(req);
      if (body.type === "resume-all") {
        for (const preset of presets) enqueue(preset.name);
      } else if (body.type === "pause-all") {
        state.pauseQueue = true;
        state.queue = [];
        if (state.activeId) state.controllers.get(state.activeId)?.abort();
      } else if (body.type === "pull" || body.type === "retry") {
        enqueue(body.model, body.type === "retry");
      } else if (body.type === "cancel") {
        const job = state.jobs.get(body.id);
        state.queue = state.queue.filter((id) => id !== body.id);
        state.controllers.get(body.id)?.abort();
        if (job && job.status === "queued") {
          job.status = "paused";
          job.detail = "พักคิว — ไฟล์เดิมยังอยู่";
        }
      } else if (["load", "unload"].includes(body.type)) {
        await modelAction(body.type, body.model);
      } else if (body.type === "command") {
        const result = await executeCommand(body.command);
        broadcast();
        return json(res, 200, { ok: true, ...result });
      } else {
        throw new Error("ไม่รู้จักคำสั่งนี้");
      }
      broadcast();
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
  }
  const handled = await rwang.handleApi(req, res, url, { readBody, json });
  if (handled !== false) return handled;
  return false;
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
};

function staticCacheControl(filePath) {
  const extension = path.extname(filePath);
  if (filePath.includes(`${path.sep}vendor${path.sep}`)) return "public, max-age=86400";
  if ([".html", ".js", ".mjs", ".css", ".webmanifest"].includes(extension)) return "no-cache";
  return "public, max-age=300";
}

const requestHandler = async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(String(req.headers.host || "").toLowerCase())) {
      return json(res, 421, { error: "Host not allowed" });
    }
    const url = new URL(req.url || "/", `${TRANSPORT_PROTOCOL}://localhost`);
    if (url.pathname.startsWith("/api/")) {
      const handled = await api(req, res, url);
      if (handled !== false) return;
    }
    if (!["GET", "HEAD"].includes(req.method)) return json(res, 405, { error: "Method not allowed" });
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.resolve(publicDir, safePath);
    const canonicalFilePath = await resolveContainedRegularFile(
      publicDir,
      filePath,
      "INVALID_STATIC_PATH",
      "Static resource must be a regular file contained by RWANG_RESOURCE_DIR",
    );
    const content = await readFile(canonicalFilePath);
    res.writeHead(200, {
      "content-type": mime[path.extname(canonicalFilePath)] || "application/octet-stream",
      "cache-control": staticCacheControl(canonicalFilePath),
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "permissions-policy": "camera=(self), microphone=(self), display-capture=(self), on-device-speech-recognition=(self)",
      "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; manifest-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    res.end(req.method === "HEAD" ? undefined : content);
  } catch (error) {
    json(res, 404, { error: "Not found" });
  }
};

let shuttingDown = false;
let shutdownPromise = null;

function lifecycleError(error) {
  const candidate = String(error?.code || "");
  const code = /^[A-Z][A-Z0-9_]{1,80}$/.test(candidate) ? candidate : "STARTUP_FAILED";
  const message = error?.startupSafeMessage && !/[\\/]|(?:[A-Za-z]:)/.test(error.startupSafeMessage)
    ? String(error.startupSafeMessage).slice(0, 240)
    : "RWANG could not start";
  return { code, message };
}

function emitLifecycle(event, details = {}) {
  const payload = {
    event,
    type: event,
    status: event,
    service: "rwang",
    ok: event === "ready",
    ...details,
  };
  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch {}
}

function listen(serverInstance) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      serverInstance.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      serverInstance.removeListener("error", onError);
      resolve();
    };
    serverInstance.once("error", onError);
    serverInstance.once("listening", onListening);
    try {
      serverInstance.listen(PORT, HOST);
    } catch (error) {
      onError(error);
    }
  });
}

function requestShutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  runtime.state = "stopping";
  startupAbortController.abort();
  shutdownPromise = (async () => {
    // Startup owns the resource graph until this settles. Waiting here means
    // objects assigned after the signal (core, spotlight, or HTTP server) are
    // still included in the final cleanup pass.
    await startupFinished;
    for (const controller of state.controllers.values()) controller.abort();
    closeQueueEventClients();
    clearTimeout(persistTimer);
    const cleanups = [
      remote?.close?.(),
      rwang?.close?.(),
      spotlight?.close?.(),
    ].filter(Boolean);
    await Promise.allSettled(cleanups);
    if (dataDir) await Promise.allSettled([persist()]);
    if (server?.listening) {
      await new Promise((resolve) => {
        const deadline = setTimeout(() => {
          server.closeAllConnections?.();
          resolve();
        }, 5000);
        deadline.unref?.();
        server.close(() => {
          clearTimeout(deadline);
          resolve();
        });
      });
    }
    process.exitCode = exitCode;
  })().catch(() => {
    process.exitCode = exitCode;
  });
  return shutdownPromise;
}

process.on("SIGINT", () => void requestShutdown());
process.on("SIGTERM", () => void requestShutdown());

process.on("uncaughtException", (error) => {
  if (logFile) {
    void appendFile(logFile, `${JSON.stringify({ at: now(), level: "error", message: "uncaughtException", model: "system" })}\n`, "utf8").catch(() => {});
  }
});

process.on("unhandledRejection", (error) => {
  if (logFile) {
    void appendFile(logFile, `${JSON.stringify({ at: now(), level: "error", message: "unhandledRejection", model: "system" })}\n`, "utf8").catch(() => {});
  }
});

async function start() {
  try {
    await configureRuntime();
    assertStartupActive();
    server = TLS_OPTIONS
      ? https.createServer(TLS_OPTIONS, requestHandler)
      : http.createServer(requestHandler);
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 100;

    await restore();
    assertStartupActive();
    spotlight = await createSpotlightIndex({
      roots: spotlightRootConfiguration(),
      homeDir: os.homedir(),
      workspaceRoot: workspaceDir,
      refreshIntervalMs: Number(process.env.RWANG_SPOTLIGHT_REFRESH_MS || 5 * 60 * 1000),
      maxFiles: Number(process.env.RWANG_SPOTLIGHT_MAX_FILES || 50_000),
    });
    assertStartupActive();
    rwang = await createRwangCore({
      resourceDir,
      dataDir,
      workspaceDir,
      capabilityDir,
      rootDir: workspaceDir,
      ollamaUrl: OLLAMA,
      port: PORT,
      protocol: TRANSPORT_PROTOCOL,
      host: HOST,
      publicOrigin: PUBLIC_ORIGIN,
      spotlight,
      getSystemStatus: getStatus,
      notify: () => {
        broadcast();
        remote?.enforcePolicy();
      },
      audit: (level, message) => addLog(level, message, "rwang"),
      onTokenRotated: async () => {
        closeQueueEventClients();
        remote?.revokeAll("master-token-rotated");
      },
      onAccessRevoked: async () => {
        closeQueueEventClients();
      },
    });
    assertStartupActive();
    remote = createRemoteCore({
      notify: broadcast,
      audit: (level, message) => addLog(level, message, "remote"),
      isLocal: rwang.isLocal,
      isAuthorized: rwang.isAuthorized,
      getPolicy: rwang.remotePolicy,
      getIceServers: () => ICE_SERVERS,
    });
    assertStartupActive();
    void spotlight.start().then((indexStatus) => {
      addLog(
        indexStatus.truncated ? "warning" : "success",
        `Spotlight พร้อมค้นหา ${indexStatus.indexedFiles.toLocaleString("en-US")} ไฟล์`,
        "spotlight",
      );
    }).catch(() => {
      addLog("error", "Spotlight สร้างดัชนีไฟล์ไม่สำเร็จ", "spotlight");
    });
    await listen(server);
    assertStartupActive();
    runtime.state = "ready";
    runtime.readyAt = now();
    console.log(`RWANG Local Assistant: ${TRANSPORT_PROTOCOL}://127.0.0.1:${PORT}`);
    console.log(TLS_OPTIONS
      ? "LAN transport: HTTPS enabled"
      : isLoopbackBind(HOST)
        ? "LAN transport: disabled (secure loopback-only HTTP)"
        : "LAN transport: INSECURE HTTP explicitly enabled");
    console.log("กด Ctrl+C เพื่อปิด RWANG (Ollama จะยังทำงานตามปกติ)");
    addLog("success", `RWANG เริ่มทำงานบน ${TRANSPORT_PROTOCOL}://${HOST}:${PORT}`);
    assertStartupActive();
    emitLifecycle("ready", { port: PORT, protocol: TRANSPORT_PROTOCOL });
  } catch (error) {
    if (shuttingDown || startupAbortController.signal.aborted) {
      runtime.state = "stopping";
    } else {
      runtime.state = "fatal";
      emitLifecycle("fatal", { error: lifecycleError(error) });
      console.error("RWANG startup failed");
      requestShutdown(1);
    }
  } finally {
    resolveStartupFinished();
  }
}

await start();
