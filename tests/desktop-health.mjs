import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capabilityPath = path.join(repositoryRoot, "capabilities", "rwang-document-intelligence");
const DESKTOP_NONCE = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const DESKTOP_CHALLENGE = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const SECOND_DESKTOP_CHALLENGE = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

function expectedDesktopProof(challenge) {
  return createHmac("sha256", Buffer.from(DESKTOP_NONCE, "hex"))
    .update(Buffer.from(challenge, "hex"))
    .digest("hex");
}

function proofMatches(challenge, proof) {
  if (!/^[0-9a-f]{64}$/.test(challenge) || !/^[0-9a-f]{64}$/.test(proof || "")) return false;
  const expected = Buffer.from(expectedDesktopProof(challenge), "hex");
  const supplied = Buffer.from(proof, "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

async function freeLoopbackPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  return port;
}

function runtimeEnvironment({ dataDir, workspaceDir, port, nonce = undefined, ...overrides }) {
  const env = {
    ...process.env,
    OLLAMA_CENTER_PORT: String(port),
    RWANG_HOST: "127.0.0.1",
    RWANG_ALLOW_INSECURE_LAN: "0",
    RWANG_RESOURCE_DIR: repositoryRoot,
    RWANG_DATA_DIR: dataDir,
    RWANG_WORKSPACE_DIR: workspaceDir,
    RWANG_CAPABILITY_DIR: capabilityPath,
    RWANG_SPOTLIGHT_ROOTS: workspaceDir,
    RWANG_SPOTLIGHT_REFRESH_MS: "0",
    RWANG_SPOTLIGHT_MAX_FILES: "32",
    RWANG_DESKTOP: "1",
    ...overrides,
  };
  if (nonce === undefined) delete env.RWANG_DESKTOP_NONCE;
  else env.RWANG_DESKTOP_NONCE = nonce;
  return env;
}

function launchServer(env) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: repositoryRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const records = [];
  let stdout = "";
  let stderr = "";

  function readStream(stream, name) {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      const text = String(chunk);
      if (name === "stdout") stdout += text;
      else stderr += text;
      pending += text;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        records.push({ stream: name, line: pending.slice(0, newline).replace(/\r$/, "") });
        pending = pending.slice(newline + 1);
      }
    });
    stream.once("end", () => {
      if (pending) records.push({ stream: name, line: pending.replace(/\r$/, "") });
    });
  }

  readStream(child.stdout, "stdout");
  readStream(child.stderr, "stderr");
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, records, closed, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

function parseJsonLine(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function waitForRecord(processHandle, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const record of processHandle.records) {
      const value = parseJsonLine(record.line);
      if (value && predicate(value, record)) return value;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for lifecycle record.\nstdout:\n${processHandle.stdout}\nstderr:\n${processHandle.stderr}`);
}

async function waitForClose(processHandle, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([
      processHandle.closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `Runtime did not exit within ${timeoutMs} ms.\nstdout:\n${processHandle.stdout}\nstderr:\n${processHandle.stderr}`,
        )), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopServer(processHandle) {
  if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) {
    return processHandle.closed;
  }
  const startedAt = Date.now();
  try {
    processHandle.child.kill("SIGTERM");
  } catch {}
  try {
    const result = await waitForClose(processHandle, 8_000);
    return { ...result, durationMs: Date.now() - startedAt };
  } catch {
    try { processHandle.child.kill("SIGKILL"); } catch {}
    const result = await waitForClose(processHandle, 3_000);
    return { ...result, durationMs: Date.now() - startedAt, forced: true };
  }
}

async function removeTree(directory) {
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

async function authenticatedDesktopHealthContract() {
  const base = await mkdtemp(path.join(os.tmpdir(), "rwang-desktop-health-"));
  const dataDir = path.join(base, "data");
  const workspaceDir = path.join(base, "workspace");
  await mkdir(dataDir);
  await mkdir(workspaceDir);
  const port = await freeLoopbackPort();
  let processHandle = launchServer(runtimeEnvironment({
    dataDir,
    workspaceDir,
    port,
    nonce: DESKTOP_NONCE,
  }));

  try {
    const ready = await waitForRecord(
      processHandle,
      (value) => (value.event || value.type || value.status) === "ready" && value.port === port,
    );
    assert.equal(ready.ok, true);
    assert.equal(ready.service, "rwang");
    assert.equal(JSON.stringify(ready).includes(DESKTOP_NONCE), false, "ready line must not echo desktop nonce");
    assert.equal(JSON.stringify(ready).includes(base), false, "ready line must not expose local paths");

    const requests = [
      {},
      { "x-rwang-desktop-challenge": "" },
      { "x-rwang-desktop-challenge": "A".repeat(64) },
      { "x-rwang-desktop-challenge": "g".repeat(64) },
      { "x-rwang-desktop-challenge": "0".repeat(63) },
      { "x-rwang-desktop-challenge": `${DESKTOP_CHALLENGE.slice(0, 32)} ${DESKTOP_CHALLENGE.slice(32)}` },
      { "x-rwang-desktop-nonce": DESKTOP_NONCE },
    ];
    for (const headers of requests) {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers,
        signal: AbortSignal.timeout(3_000),
      });
      assert.notEqual(response.status, 200, "invalid or missing desktop nonce must not return success");
      const health = await response.json();
      assert.equal(health.ok, false);
      assert.equal(health.ready, false);
      assert.equal(health.service, "rwang");
      assert.equal(response.headers.get("x-rwang-desktop-proof"), null, "unauthorized health must not return a proof");
      const body = JSON.stringify(health);
      assert.equal(body.includes(DESKTOP_NONCE), false, "unauthorized response must not echo desktop nonce");
      assert.equal(body.includes(base), false, "unauthorized response must not expose local paths");
    }

    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { "x-rwang-desktop-challenge": DESKTOP_CHALLENGE },
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    const proof = response.headers.get("x-rwang-desktop-proof");
    assert.equal(proof, expectedDesktopProof(DESKTOP_CHALLENGE));
    assert.equal(proofMatches(DESKTOP_CHALLENGE, proof), true);
    assert.equal(proofMatches(SECOND_DESKTOP_CHALLENGE, proof), false, "proof for another challenge must be rejected");
    assert.notEqual(proof, expectedDesktopProof(SECOND_DESKTOP_CHALLENGE), "fresh challenge must produce a different proof");
    const health = await response.json();
    assert.deepEqual(health, { ok: true, ready: true, status: "ready", service: "rwang" });
    const body = JSON.stringify(health);
    assert.equal(body.includes(DESKTOP_NONCE), false, "health response must not echo desktop nonce");
    assert.equal(body.includes(DESKTOP_CHALLENGE), false, "health response must not echo challenge");
    assert.equal(body.includes(proof), false, "health JSON must not contain proof header value");
    assert.equal(body.includes(base), false, "health response must not expose local paths");

    const stopped = await stopServer(processHandle);
    assert.ok(stopped.durationMs < 8_000, "SIGTERM shutdown must be bounded");
    processHandle = null;
  } finally {
    if (processHandle) await stopServer(processHandle);
    await removeTree(base);
  }
}

async function rejectsInvalidDesktopNonce(nonce) {
  const base = await mkdtemp(path.join(os.tmpdir(), "rwang-desktop-nonce-fatal-"));
  const dataDir = path.join(base, "data");
  const workspaceDir = path.join(base, "workspace");
  await mkdir(dataDir);
  await mkdir(workspaceDir);
  const port = await freeLoopbackPort();
  const processHandle = launchServer(runtimeEnvironment({ dataDir, workspaceDir, port, nonce }));
  try {
    const fatal = await waitForRecord(
      processHandle,
      (value) => (value.event || value.type || value.status) === "fatal",
    );
    assert.equal(fatal.ok, false);
    assert.equal(fatal.error?.code, "INVALID_DESKTOP_NONCE");
    assert.equal(JSON.stringify(fatal).includes(base), false, "fatal line must not expose local paths");
    if (nonce) assert.equal(JSON.stringify(fatal).includes(nonce), false, "fatal line must not echo nonce");
    const result = await waitForClose(processHandle, 8_000);
    assert.notEqual(result.code, 0, "invalid desktop nonce must fail startup");
    const combined = `${processHandle.stdout}\n${processHandle.stderr}`;
    assert.equal(combined.includes(base), false, "startup output must not expose local paths");
    if (nonce) assert.equal(combined.includes(nonce), false, "startup output must not echo nonce");
  } finally {
    if (processHandle.child.exitCode === null && processHandle.child.signalCode === null) await stopServer(processHandle);
    await removeTree(base);
  }
}

await authenticatedDesktopHealthContract();
await rejectsInvalidDesktopNonce(undefined);
await rejectsInvalidDesktopNonce("a".repeat(63));
await rejectsInvalidDesktopNonce("g".repeat(64));
console.log("RWANG desktop health contract tests passed");
