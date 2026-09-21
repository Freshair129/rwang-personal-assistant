import assert from "node:assert/strict";
import { createServer } from "node:http";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRwangCore } from "../rwang.mjs";

const VALID_KEY = "fixture-lalin-token-0123456789";
const INVALID_KEY = "fixture-invalid-token-0123456789";
const ENV_KEY = "fixture-env-token-0123456789";

function request(method = "GET", { local = true, origin = "http://localhost:4173" } = {}) {
  return {
    method,
    headers: {
      host: local ? "localhost:4173" : "rwang.test:4173",
      ...(origin ? { origin } : {}),
      ...(method === "PUT" ? { "content-type": "application/json" } : {}),
    },
    socket: { remoteAddress: local ? "127.0.0.1" : "192.0.2.10" },
  };
}

function response() {
  return { status: 0, payload: null, headers: {}, headersSent: false };
}

function json(res, status, payload, headers = {}) {
  res.status = status;
  res.payload = payload;
  res.headers = headers;
  res.headersSent = true;
}

async function listenFixture() {
  const server = createServer((req, res) => {
    const token = String(req.headers.authorization || "");
    if (token !== `Bearer ${VALID_KEY}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "unauthorized" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/worker/v1/describe") {
      res.end(JSON.stringify({
        engine: { name: "faster-whisper", labeled_stub: false },
        profiles: [{ profile_id: "asr-th-en-01", profile_revision: "rev-fixture-large-v3-turbo", engine: "faster-whisper" }],
      }));
      return;
    }
    if (req.url === "/worker/v1/readiness") {
      res.end(JSON.stringify({ ready: true, profiles: [{ profile_id: "asr-th-en-01", ready: true }] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
  };
}

async function call(core, method, body, options = {}) {
  const res = response();
  await core.handleApi(request(method, options), res, new URL("http://localhost:4173/api/rwang/voice/config"), {
    readBody: async () => body,
    json,
  });
  return res;
}

async function main() {
  const originalUrl = process.env.RWANG_LALIN_VOICE_WORKER_URL;
  const originalToken = process.env.RWANG_LALIN_VOICE_WORKER_TOKEN;
  const fixture = await listenFixture();
  const base = await mkdtemp(path.join(os.tmpdir(), "rwang-lalin-voice-config-"));
  let core;
  try {
    process.env.RWANG_LALIN_VOICE_WORKER_URL = fixture.url;
    process.env.RWANG_LALIN_VOICE_WORKER_TOKEN = ENV_KEY;
    core = await createRwangCore({
      rootDir: base,
      ollamaUrl: "http://127.0.0.1:11434",
      port: 4173,
      getSystemStatus: async () => ({}),
    });

    const remote = await call(core, "PUT", { apiKey: VALID_KEY }, { local: false, origin: "http://localhost:4173" });
    assert.equal(remote.status, 403);

    const malformed = await call(core, "PUT", { apiKey: "short" });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.payload.code, "INVALID_CREDENTIAL");

    const invalid = await call(core, "PUT", { apiKey: INVALID_KEY });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.payload.code, "INVALID_CREDENTIAL");
    await assert.rejects(lstat(path.join(base, ".secrets", "lalin-voice-worker.dpapi")), { code: "ENOENT" });

    const saved = await call(core, "PUT", { apiKey: VALID_KEY });
    if (saved.status === 503 && saved.payload.code === "SECRET_STORE_UNAVAILABLE") {
      console.log(JSON.stringify({ ok: true, status: "SKIPPED", reason: "Windows secure user store unavailable in current session" }));
      return;
    }
    assert.equal(saved.status, 200);
    assert.equal(saved.payload.credential.verification, "verified");
    assert.equal(JSON.stringify(saved.payload).includes(VALID_KEY), false);

    const persistedConfig = await readFile(path.join(base, ".rwang-config.json"), "utf8");
    assert.equal(persistedConfig.includes(VALID_KEY), false);
    const persistedSecret = await readFile(path.join(base, ".secrets", "lalin-voice-worker.dpapi"), "utf8");
    assert.equal(persistedSecret.includes(VALID_KEY), false);

    await core.close();
    core = await createRwangCore({
      rootDir: base,
      ollamaUrl: "http://127.0.0.1:11434",
      port: 4173,
      getSystemStatus: async () => ({}),
    });

    const status = await call(core, "GET");
    assert.equal(status.status, 200);
    assert.deepEqual(status.payload.credential, {
      configured: true,
      source: "desktop",
      verification: "unverified",
      masked: "••••••••",
      checkedAt: status.payload.credential.checkedAt,
      backend: "dpapi",
    });
    assert.equal(JSON.stringify(status.payload).includes(VALID_KEY), false);

    const cleared = await call(core, "DELETE");
    assert.equal(cleared.status, 200);
    assert.equal(cleared.payload.credential.configured, true);
    assert.equal(cleared.payload.credential.source, "environment");
    await assert.rejects(lstat(path.join(base, ".secrets", "lalin-voice-worker.dpapi")), { code: "ENOENT" });
  } finally {
    await core?.close?.();
    if (originalUrl === undefined) delete process.env.RWANG_LALIN_VOICE_WORKER_URL;
    else process.env.RWANG_LALIN_VOICE_WORKER_URL = originalUrl;
    if (originalToken === undefined) delete process.env.RWANG_LALIN_VOICE_WORKER_TOKEN;
    else process.env.RWANG_LALIN_VOICE_WORKER_TOKEN = originalToken;
    await new Promise((resolve) => fixture.server.close(() => resolve()));
    await rm(base, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ok: true, status: "passed" }));
}

await main();
