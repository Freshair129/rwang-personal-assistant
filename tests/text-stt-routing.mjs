import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRwangCore } from "../rwang.mjs";

const PRP_KEY = "fixture-prp-client-key-0123456789";
const LALIN_KEY = "fixture-lalin-worker-key-0123456789";

function localRequest(method = "GET", contentType = "application/json") {
  return {
    method,
    headers: {
      host: "localhost:4173",
      origin: "http://localhost:4173",
      ...(contentType ? { "content-type": contentType } : {}),
    },
    socket: { remoteAddress: "127.0.0.1" },
    on() {},
  };
}

function jsonResponse() {
  return { status: 0, payload: null, headers: {}, headersSent: false };
}

function json(res, status, payload, headers = {}) {
  res.status = status;
  res.payload = payload;
  res.headers = headers;
  res.headersSent = true;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

function restoreEnv(original, names) {
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
}

async function testPrpTextRouting() {
  let chatRequests = 0;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${PRP_KEY}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "prp-chat-1", object: "model" }] }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      chatRequests += 1;
      for await (const _chunk of req) {}
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write('data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"PRP ตอบแล้ว"},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n');
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  const base = await mkdtemp(path.join(os.tmpdir(), "rwang-prp-routing-"));
  const names = ["RWANG_TEXT_PROVIDER", "RWANG_PRP_TEXT_BASE_URL", "RWANG_PRP_TEXT_MODEL", "RWANG_PRP_TEXT_CLIENT_KEY", "RWANG_LALIN_VOICE_WORKER_TOKEN"];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  let core;
  try {
    const url = await listen(server);
    process.env.RWANG_TEXT_PROVIDER = "prp";
    process.env.RWANG_PRP_TEXT_BASE_URL = url;
    process.env.RWANG_PRP_TEXT_MODEL = "prp-chat-1";
    process.env.RWANG_PRP_TEXT_CLIENT_KEY = PRP_KEY;
    delete process.env.RWANG_LALIN_VOICE_WORKER_TOKEN;
    core = await createRwangCore({ rootDir: base, ollamaUrl: "http://127.0.0.1:11434", port: 4173, getSystemStatus: async () => ({}) });

    const credentialResponse = jsonResponse();
    await core.handleApi(localRequest("PUT"), credentialResponse, new URL("http://localhost:4173/api/rwang/text/config"), {
      readBody: async () => ({ apiKey: PRP_KEY }),
      json,
    });
    if (credentialResponse.status === 503 && credentialResponse.payload.code === "SECRET_STORE_UNAVAILABLE") {
      console.log(JSON.stringify({ ok: true, status: "PARTIAL", reason: "Windows secure user store unavailable in current session" }));
    } else {
      assert.equal(credentialResponse.status, 200);
      assert.equal(credentialResponse.payload.credential.verification, "verified");
      assert.equal(JSON.stringify(credentialResponse.payload).includes(PRP_KEY), false);
      const stored = await readFile(path.join(base, ".secrets", "prp-text-client.dpapi"), "utf8");
      assert.equal(stored.includes(PRP_KEY), false);
      await core.close();
      core = await createRwangCore({ rootDir: base, ollamaUrl: "http://127.0.0.1:11434", port: 4173, getSystemStatus: async () => ({}) });
      const restarted = await core.snapshot(localRequest());
      assert.equal(restarted.textProvider.credential.source, "desktop");
      assert.equal(JSON.stringify(restarted).includes(PRP_KEY), false);
    }

    const snapshot = await core.snapshot(localRequest());
    assert.equal(snapshot.textProvider.provider, "prp");
    assert.equal(snapshot.textProvider.model, "prp-chat-1");
    assert.equal(snapshot.textProvider.baseUrl, url);
    assert.equal(JSON.stringify(snapshot).includes(PRP_KEY), false);

    const req = new EventEmitter();
    req.on = req.on.bind(req);
    req.headers = { host: "localhost:4173" };
    req.socket = { remoteAddress: "127.0.0.1" };
    const res = new EventEmitter();
    const chunks = [];
    res.writeHead = () => {};
    res.write = (chunk) => chunks.push(String(chunk));
    res.end = () => {};
    await core.streamChat(req, res, async () => ({
      model: "ignored-ollama-model",
      messages: [{ role: "user", content: "สวัสดี" }],
    }));
    const output = chunks.join("");
    assert.equal(chatRequests, 1);
    assert.equal(output.includes('"provider":"prp"'), true);
    assert.equal(output.includes("PRP ตอบแล้ว"), true);
    assert.equal(output.includes(PRP_KEY), false);
    if (credentialResponse.status === 200) {
      const cleared = jsonResponse();
      await core.handleApi(localRequest("DELETE", ""), cleared, new URL("http://localhost:4173/api/rwang/text/config"), {
        readBody: async () => ({}),
        json,
      });
      assert.equal(cleared.status, 200);
      await assert.rejects(lstat(path.join(base, ".secrets", "prp-text-client.dpapi")), { code: "ENOENT" });
    }
  } finally {
    await core?.close?.();
    restoreEnv(original, names);
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(base, { recursive: true, force: true });
  }
}

async function testLalinTranscriptionRouting() {
  let operationRequests = 0;
  let eraseRequests = 0;
  let receivedMultipart = false;
  let attemptId = "";
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${LALIN_KEY}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "UNAUTHORIZED" } }));
      return;
    }
    if (req.url === "/worker/v1/describe") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        runtime_id: "speech-asr-fw",
        runtime_epoch: "epoch-fixture",
        physical_resource_id: "gpu0-local-host",
        engine: { name: "faster-whisper", labeled_stub: false },
        profiles: [{
          profile_id: "asr-th-en-01",
          profile_revision: "rev-fixture-large-v3-turbo",
          engine: "faster-whisper",
          languages: ["th", "en"],
          limits: { max_audio_bytes: 10 * 1024 * 1024 },
        }],
      }));
      return;
    }
    if (req.url === "/worker/v1/readiness") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ready: true, runtime_epoch: "epoch-fixture", profiles: [{ profile_id: "asr-th-en-01", profile_revision: "rev-fixture-large-v3-turbo", ready: true }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/worker/v1/operations") {
      operationRequests += 1;
      receivedMultipart = String(req.headers["content-type"] || "").startsWith("multipart/form-data");
      let raw = "";
      for await (const chunk of req) raw += chunk.toString("utf8");
      assert.equal(raw.includes("fixture-audio"), true);
      attemptId = raw.match(/"attempt_id"\s*:\s*"([^"]+)"/)?.[1] || "";
      assert.equal(Boolean(attemptId), true);
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ attempt_id: attemptId, execution_status: "ACCEPTED", operation_outcome: null }));
      return;
    }
    if (req.method === "GET" && req.url === `/worker/v1/operations/${attemptId}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        attempt_id: attemptId,
        execution_status: "FINISHED",
        operation_outcome: "SUCCEEDED",
        result: { kind: "asr", engine: "faster-whisper", text: "เปิดไฟ", language: "th" },
      }));
      return;
    }
    if (req.method === "DELETE" && req.url === `/worker/v1/operations/${attemptId}/payload`) {
      eraseRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ attempt_id: attemptId, payload_state: "ERASED", execution_status: "FINISHED" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
  });
  const base = await mkdtemp(path.join(os.tmpdir(), "rwang-lalin-routing-"));
  const names = ["RWANG_TEXT_PROVIDER", "RWANG_PRP_TEXT_BASE_URL", "RWANG_PRP_TEXT_MODEL", "RWANG_PRP_TEXT_CLIENT_KEY", "RWANG_LALIN_VOICE_WORKER_URL", "RWANG_LALIN_VOICE_WORKER_TOKEN", "RWANG_LALIN_VOICE_PROFILE"];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  let core;
  try {
    const url = await listen(server);
    process.env.RWANG_TEXT_PROVIDER = "ollama";
    delete process.env.RWANG_PRP_TEXT_BASE_URL;
    delete process.env.RWANG_PRP_TEXT_MODEL;
    delete process.env.RWANG_PRP_TEXT_CLIENT_KEY;
    process.env.RWANG_LALIN_VOICE_WORKER_URL = url;
    process.env.RWANG_LALIN_VOICE_WORKER_TOKEN = LALIN_KEY;
    process.env.RWANG_LALIN_VOICE_PROFILE = "asr-th-en-01";
    core = await createRwangCore({ rootDir: base, ollamaUrl: "http://127.0.0.1:11434", port: 4173, getSystemStatus: async () => ({}) });
    const res = jsonResponse();
    await core.handleApi(localRequest("POST", "audio/wav"), res, new URL("http://localhost:4173/api/rwang/voice/transcribe?language=th-TH"), {
      readBody: async () => ({}),
      readAudio: async () => ({ audio: Buffer.from("fixture-audio"), mimeType: "audio/wav" }),
      json,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload.text, "เปิดไฟ");
    assert.equal(res.payload.provider, "lalin");
    assert.equal(operationRequests, 1);
    assert.equal(eraseRequests, 1);
    assert.equal(receivedMultipart, true);
    assert.equal(JSON.stringify(res.payload).includes(LALIN_KEY), false);
  } finally {
    await core?.close?.();
    restoreEnv(original, names);
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(base, { recursive: true, force: true });
  }
}

await testPrpTextRouting();
await testLalinTranscriptionRouting();
console.log(JSON.stringify({ ok: true, status: "passed", checks: ["prp-text-provider", "lalin-large-v3-turbo-stt"] }));
