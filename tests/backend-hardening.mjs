import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createRwangCore, publicApprovalSnapshot } from "../rwang.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capabilityRelativePath = path.join("capabilities", "rwang-document-intelligence");
const capabilitySource = path.join(repositoryRoot, capabilityRelativePath);

async function freeLoopbackPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  assert.ok(port > 0 && port <= 65535);
  return port;
}

async function prepareResource(resourceDir) {
  await mkdir(path.join(resourceDir, "public"), { recursive: true });
  await writeFile(path.join(resourceDir, "public", "index.html"), "<!doctype html><title>hardening</title>\n", "utf8");
  await cp(capabilitySource, path.join(resourceDir, capabilityRelativePath), { recursive: true });
}

function runtimeEnvironment({ resourceDir, dataDir, workspaceDir, port, ...overrides }) {
  const env = {
    ...process.env,
    OLLAMA_CENTER_PORT: String(port),
    RWANG_HOST: "127.0.0.1",
    RWANG_ALLOW_INSECURE_LAN: "0",
    RWANG_RESOURCE_DIR: resourceDir,
    RWANG_DATA_DIR: dataDir,
    RWANG_WORKSPACE_DIR: workspaceDir,
    RWANG_CAPABILITY_DIR: path.join(resourceDir, capabilityRelativePath),
    RWANG_SPOTLIGHT_ROOTS: workspaceDir,
    RWANG_SPOTLIGHT_REFRESH_MS: "0",
    RWANG_SPOTLIGHT_MAX_FILES: "16",
    ...overrides,
  };
  for (const key of [
    "RWANG_DESKTOP",
    "RWANG_DESKTOP_NONCE",
    "RWANG_TLS_CERT_FILE",
    "RWANG_TLS_KEY_FILE",
    "RWANG_TLS_PFX_FILE",
    "RWANG_TLS_PASSPHRASE",
  ]) {
    if (!(key in overrides)) delete env[key];
  }
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
  for (const [stream, name] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) {
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
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  return { child, records, closed, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

function parseRecord(record) {
  try {
    const value = JSON.parse(record.line);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

async function waitForRecord(processHandle, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const record of processHandle.records) {
      const value = parseRecord(record);
      if (value && predicate(value, record)) return value;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for lifecycle record\n${processHandle.stdout}\n${processHandle.stderr}`);
}

async function waitForClose(processHandle, timeoutMs = 8_000) {
  let timer;
  try {
    return await Promise.race([
      processHandle.closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`runtime did not close in ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopServer(processHandle) {
  if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) return processHandle.closed;
  try { processHandle.child.kill("SIGTERM"); } catch {}
  try {
    return await waitForClose(processHandle);
  } catch {
    try { processHandle.child.kill("SIGKILL"); } catch {}
    return processHandle.closed;
  }
}

async function removeTree(directory) {
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

async function assertMissing(filePath) {
  await assert.rejects(lstat(filePath), (error) => error?.code === "ENOENT");
}

async function approvalProjectionContract() {
  const item = {
    id: "approval-hardening",
    kind: "webhook",
    label: "IoT webhook",
    summary: "raw user summary must stay local",
    risk: "high",
    payload: { secret: "payload-secret" },
    result: "result-secret",
    status: "approved",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:01.000Z",
    internal: { token: "internal-secret" },
  };
  const remote = publicApprovalSnapshot(item);
  assert.deepEqual(remote, {
    id: item.id,
    kind: item.kind,
    label: item.label,
    risk: item.risk,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  });
  for (const secret of ["summary", "payload", "result", "internal"]) assert.equal(secret in remote, false);

  const local = publicApprovalSnapshot(item, { local: true });
  assert.equal(local.summary, item.summary);
  assert.deepEqual(local.payload, item.payload);
  assert.equal(local.result, item.result);
  assert.equal("internal" in local, false);
}

async function legacyHomeAssistantContract() {
  const base = await mkdtemp(path.join(os.tmpdir(), "rwang-ha-sanitize-"));
  const resourceDir = path.join(base, "resource");
  const workspaceDir = path.join(base, "workspace");
  const dataDir = path.join(base, "data");
  const masterToken = "master-hardening-token";
  await Promise.all([mkdir(resourceDir), mkdir(workspaceDir), mkdir(dataDir)]);
  await prepareResource(resourceDir);
  await writeFile(path.join(dataDir, ".rwang-config.json"), JSON.stringify({
    access: { token: masterToken },
    homeAssistant: {
      enabled: true,
      baseUrl: "https://user:password@example.test/api/?leak=query#fragment",
      token: "ha-secret",
    },
  }), "utf8");
  let core;
  try {
    core = await createRwangCore({
      resourceDir,
      dataDir,
      workspaceDir,
      ollamaUrl: "http://127.0.0.1:11434",
      port: 4173,
      getSystemStatus: async () => ({}),
    });
    const snapshot = await core.snapshot({
      socket: { remoteAddress: "192.0.2.10" },
      headers: { host: "192.0.2.10:4173", "x-rwang-token": masterToken },
    });
    assert.equal(snapshot.homeAssistant.baseUrl, "https://example.test/api");
    assert.equal(snapshot.homeAssistant.baseUrl.includes("user"), false);
    assert.equal(snapshot.homeAssistant.baseUrl.includes("password"), false);
    assert.equal(snapshot.homeAssistant.baseUrl.includes("?"), false);
    const persisted = JSON.parse(await readFile(path.join(dataDir, ".rwang-config.json"), "utf8"));
    assert.equal(persisted.homeAssistant.baseUrl, "https://example.test/api");
  } finally {
    await core?.close?.();
    await removeTree(base);
  }
}

async function coreOverlapContract() {
  const base = await mkdtemp(path.join(os.tmpdir(), "rwang-core-overlap-"));
  const resourceDir = path.join(base, "resource");
  const workspaceDir = path.join(base, "workspace");
  const nestedData = path.join(resourceDir, "nested-data");
  await Promise.all([mkdir(resourceDir), mkdir(workspaceDir)]);
  try {
    await assert.rejects(
      createRwangCore({
        resourceDir,
        dataDir: nestedData,
        workspaceDir,
        ollamaUrl: "http://127.0.0.1:11434",
        port: 4173,
      }),
      (error) => error?.code === "INVALID_DATA_DIR",
    );
    await assertMissing(nestedData);
  } finally {
    await removeTree(base);
  }
}

async function serverRejectsNestedData({ nestedUnder }) {
  const base = await mkdtemp(path.join(os.tmpdir(), "rwang-server-overlap-"));
  const resourceDir = path.join(base, "resource");
  const workspaceDir = path.join(base, "workspace");
  const dataDir = path.join(nestedUnder === "resource" ? resourceDir : workspaceDir, "nested-data");
  await Promise.all([mkdir(resourceDir), mkdir(workspaceDir)]);
  await prepareResource(resourceDir);
  const port = await freeLoopbackPort();
  const processHandle = launchServer(runtimeEnvironment({ resourceDir, dataDir, workspaceDir, port }));
  try {
    const fatal = await waitForRecord(processHandle, (value) => value.event === "fatal");
    assert.equal(fatal.error?.code, "INVALID_DATA_DIR");
    await waitForClose(processHandle);
    await assertMissing(dataDir);
  } finally {
    if (processHandle.child.exitCode === null && processHandle.child.signalCode === null) await stopServer(processHandle);
    await removeTree(base);
  }
}

async function staticSymlinkContract() {
  const base = await mkdtemp(path.join(os.tmpdir(), "rwang-static-containment-"));
  const resourceDir = path.join(base, "resource");
  const workspaceDir = path.join(base, "workspace");
  const dataDir = path.join(base, "data");
  const outsideFile = path.join(base, "outside-secret.txt");
  const linkedFile = path.join(resourceDir, "public", "leak.txt");
  await Promise.all([mkdir(resourceDir), mkdir(workspaceDir), mkdir(dataDir)]);
  await prepareResource(resourceDir);
  await writeFile(outsideFile, "outside-static-secret", "utf8");
  try {
    await symlink(outsideFile, linkedFile, "file");
  } catch (error) {
    if (["EACCES", "EPERM", "UNKNOWN"].includes(error?.code)) {
      console.warn("RWANG static symlink test skipped: symlink creation is unavailable");
      await removeTree(base);
      return;
    }
    throw error;
  }
  const port = await freeLoopbackPort();
  const processHandle = launchServer(runtimeEnvironment({ resourceDir, dataDir, workspaceDir, port }));
  try {
    await waitForRecord(processHandle, (value) => value.event === "ready");
    const valid = await fetch(`http://127.0.0.1:${port}/index.html`, { signal: AbortSignal.timeout(3_000) });
    assert.equal(valid.status, 200);
    assert.match(await valid.text(), /hardening/);
    const blocked = await fetch(`http://127.0.0.1:${port}/leak.txt`, { signal: AbortSignal.timeout(3_000) });
    assert.equal(blocked.status, 404);
    assert.equal((await blocked.text()).includes("outside-static-secret"), false);
  } finally {
    await stopServer(processHandle);
    await removeTree(base);
  }
}

async function tlsSymlinkContract() {
  const base = await mkdtemp(path.join(os.tmpdir(), "rwang-tls-containment-"));
  const resourceDir = path.join(base, "resource");
  const workspaceDir = path.join(base, "workspace");
  const dataDir = path.join(base, "data");
  const outsideFile = path.join(base, "outside-cert.pem");
  const linkedFile = path.join(resourceDir, "cert-link.pem");
  await Promise.all([mkdir(resourceDir), mkdir(workspaceDir), mkdir(dataDir)]);
  await prepareResource(resourceDir);
  await writeFile(outsideFile, "not-a-certificate", "utf8");
  try {
    await symlink(outsideFile, linkedFile, "file");
  } catch (error) {
    if (["EACCES", "EPERM", "UNKNOWN"].includes(error?.code)) {
      console.warn("RWANG TLS symlink test skipped: symlink creation is unavailable");
      await removeTree(base);
      return;
    }
    throw error;
  }
  const port = await freeLoopbackPort();
  const processHandle = launchServer(runtimeEnvironment({
    resourceDir,
    dataDir,
    workspaceDir,
    port,
    RWANG_TLS_CERT_FILE: linkedFile,
  }));
  try {
    const fatal = await waitForRecord(processHandle, (value) => value.event === "fatal");
    assert.equal(fatal.error?.code, "INVALID_TLS_PATH");
    await waitForClose(processHandle);
  } finally {
    if (processHandle.child.exitCode === null && processHandle.child.signalCode === null) await stopServer(processHandle);
    await removeTree(base);
  }
}

async function startupCancellationContract() {
  const base = await mkdtemp(path.join(os.tmpdir(), "rwang-startup-cancel-"));
  const resourceDir = path.join(base, "resource");
  const workspaceDir = path.join(base, "workspace");
  const dataDir = path.join(base, "data");
  await Promise.all([mkdir(resourceDir), mkdir(workspaceDir), mkdir(dataDir)]);
  await prepareResource(resourceDir);
  const port = await freeLoopbackPort();
  const processHandle = launchServer(runtimeEnvironment({ resourceDir, dataDir, workspaceDir, port }));
  try {
    // Deliver SIGTERM before the normal ready event. The startup abort path must
    // prevent a later listener bind/ready record, even if an awaited import or
    // filesystem operation is still in progress.
    try { processHandle.child.kill("SIGTERM"); } catch {}
    await waitForClose(processHandle, 8_000);
    assert.equal(processHandle.records.some((record) => parseRecord(record)?.event === "ready"), false);
  } finally {
    if (processHandle.child.exitCode === null && processHandle.child.signalCode === null) await stopServer(processHandle);
    await removeTree(base);
  }
}

await approvalProjectionContract();
await legacyHomeAssistantContract();
await coreOverlapContract();
await serverRejectsNestedData({ nestedUnder: "resource" });
await serverRejectsNestedData({ nestedUnder: "workspace" });
await staticSymlinkContract();
await tlsSymlinkContract();
await startupCancellationContract();
console.log("RWANG backend hardening tests passed");
