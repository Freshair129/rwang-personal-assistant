import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capabilityPath = path.join(repositoryRoot, "capabilities", "rwang-document-intelligence");

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
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "OS must provide a valid loopback port");
  return port;
}

function runtimeEnvironment({ dataDir, workspaceDir, port, ...overrides }) {
  return {
    ...process.env,
    OLLAMA_CENTER_PORT: String(port),
    RWANG_HOST: "127.0.0.1",
    RWANG_ALLOW_INSECURE_LAN: "0",
    RWANG_RESOURCE_DIR: repositoryRoot,
    RWANG_DATA_DIR: dataDir,
    RWANG_WORKSPACE_DIR: workspaceDir,
    RWANG_CAPABILITY_DIR: capabilityPath,
    // Keep the contract test independent of the user's personal folders and
    // make the background index finish quickly.
    RWANG_SPOTLIGHT_ROOTS: workspaceDir,
    RWANG_SPOTLIGHT_REFRESH_MS: "0",
    RWANG_SPOTLIGHT_MAX_FILES: "32",
    ...overrides,
  };
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
  throw new Error(`Timed out waiting for runtime lifecycle record.\nstdout:\n${processHandle.stdout}\nstderr:\n${processHandle.stderr}`);
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
  } catch {
    // The close path below still gives us a bounded fallback.
  }
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

async function healthyRuntimeContract() {
  const base = await mkdtemp(path.join(os.tmpdir(), "rwang-sidecar-runtime-"));
  let processHandle = null;
  try {
    const dataDir = path.join(base, "data");
    const workspaceDir = path.join(base, "workspace");
    await mkdir(dataDir);
    await mkdir(workspaceDir);
    const port = await freeLoopbackPort();
    const secret = "sidecar-contract-secret";
    const resourceConfigPath = path.join(repositoryRoot, ".rwang-config.json");
    const resourceConfigBefore = await readFile(resourceConfigPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    processHandle = launchServer(runtimeEnvironment({
      dataDir,
      workspaceDir,
      port,
      RWANG_TLS_PASSPHRASE: secret,
    }));

    const ready = await waitForRecord(
      processHandle,
      (value) => (value.event || value.type || value.status) === "ready" && value.port === port,
    );
    assert.equal(ready.ok, true);
    assert.equal(ready.service, "rwang");
    assert.equal(JSON.stringify(ready).includes(secret), false, "ready line must not contain secrets");

    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.deepEqual(health, { ok: true, ready: true, status: "ready", service: "rwang" });
    assert.equal(JSON.stringify(health).includes(secret), false);

    // Allow the ordinary debounced persistence path to flush before sending
    // SIGTERM. This also keeps the assertion valid on Windows, where a child
    // signal can be delivered by the OS before Node runs a signal handler.
    await delay(400);
    const stopped = await stopServer(processHandle);
    assert.ok(stopped.durationMs < 8_000, "SIGTERM shutdown must be bounded");
    processHandle = null;

    const dataEntries = await readdir(dataDir);
    assert.ok(dataEntries.includes(".rwang-config.json"), "config must be written under DATA_DIR");
    assert.ok(dataEntries.includes(".queue-state.json"), "queue state must be written under DATA_DIR");
    assert.ok(dataEntries.includes("rwang.log"), "logs must be written under DATA_DIR");
    assert.deepEqual(await readdir(workspaceDir), [], "workspace must remain a scan target, not runtime storage");
    const resourceConfigAfter = await readFile(resourceConfigPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    assert.equal(resourceConfigAfter, resourceConfigBefore, "resource config must remain untouched");
  } finally {
    if (processHandle) await stopServer(processHandle);
    await removeTree(base);
  }
}

async function fatalRuntimeContract({ expectedCode, ...overrides }) {
  const base = await mkdtemp(path.join(os.tmpdir(), "rwang-sidecar-fatal-"));
  const dataDir = path.join(base, "data");
  const workspaceDir = path.join(base, "workspace");
  await mkdir(dataDir);
  await mkdir(workspaceDir);
  const port = await freeLoopbackPort();
  const secret = "fatal-contract-secret";
  const env = runtimeEnvironment({ dataDir, workspaceDir, port, RWANG_TLS_PASSPHRASE: secret, ...overrides });
  const processHandle = launchServer(env);
  try {
    const fatal = await waitForRecord(
      processHandle,
      (value) => (value.event || value.type || value.status) === "fatal",
    );
    assert.equal(fatal.ok, false);
    assert.equal(fatal.error?.code, expectedCode);
    assert.equal(JSON.stringify(fatal).includes(secret), false, "fatal line must not contain secrets");
    assert.equal(JSON.stringify(fatal).includes(base), false, "fatal line must not expose local paths");
    const result = await waitForClose(processHandle, 8_000);
    assert.notEqual(result.code, 0, "fatal startup must exit unsuccessfully");
    const combined = `${processHandle.stdout}\n${processHandle.stderr}`;
    assert.equal(combined.includes(secret), false, "startup output must not leak secrets");
    assert.equal(combined.includes(base), false, "startup output must not expose local paths");
  } finally {
    if (processHandle.child.exitCode === null && processHandle.child.signalCode === null) await stopServer(processHandle);
    await removeTree(base);
  }
}

async function main() {
  await healthyRuntimeContract();
  await fatalRuntimeContract({ expectedCode: "INVALID_PORT", OLLAMA_CENTER_PORT: "65536" });
  await fatalRuntimeContract({ expectedCode: "INVALID_DATA_DIR", RWANG_DATA_DIR: "relative-data-dir" });

  const base = await mkdtemp(path.join(os.tmpdir(), "rwang-sidecar-capability-"));
  const outsideCapability = path.join(base, "outside-capability");
  await mkdir(outsideCapability);
  try {
    await fatalRuntimeContract({ expectedCode: "INVALID_CAPABILITY_DIR", RWANG_CAPABILITY_DIR: outsideCapability });
  } finally {
    await removeTree(base);
  }
  console.log("RWANG sidecar runtime contract tests passed");
}

await main();
