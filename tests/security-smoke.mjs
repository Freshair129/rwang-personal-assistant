import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRemoteCore } from "../remote.mjs";
import { createRwangCore } from "../rwang.mjs";

function request({ local = false, cookie = "", token = "", encrypted = false } = {}) {
  return {
    method: "POST",
    headers: {
      host: local ? "localhost:4173" : "rwang.test:4173",
      ...(cookie ? { cookie } : {}),
      ...(token ? { "x-rwang-token": token } : {}),
    },
    socket: { remoteAddress: local ? "127.0.0.1" : "192.0.2.10", encrypted },
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

async function corePairingTest() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "rwang-security-"));
  let revoked = 0;
  let core;
  try {
    core = await createRwangCore({
      rootDir,
      ollamaUrl: "http://127.0.0.1:11434",
      port: 4173,
      protocol: "https",
      host: "0.0.0.0",
      publicOrigin: "https://rwang.test:4173",
      getSystemStatus: async () => ({}),
      onAccessRevoked: async () => { revoked += 1; },
    });

    const localReq = request({ local: true, encrypted: true });
    const createRes = response();
    await core.handleApi(localReq, createRes, new URL("https://localhost:4173/api/rwang/pairing"), {
      readBody: async () => ({ action: "create" }),
      json,
    });
    assert.equal(createRes.status, 201);
    assert.match(createRes.payload.code, /^\d{8}$/);

    const insecurePairRes = response();
    await core.handlePublicApi(request(), insecurePairRes, new URL("http://rwang.test:4173/api/rwang/pair"), {
      readBody: async () => ({ code: createRes.payload.code, name: "Plaintext phone" }),
      json,
    });
    assert.equal(insecurePairRes.status, 426);

    const pairReq = request({ encrypted: true });
    const pairRes = response();
    await core.handlePublicApi(pairReq, pairRes, new URL("https://rwang.test:4173/api/rwang/pair"), {
      readBody: async () => ({ code: createRes.payload.code, name: "Security test phone" }),
      json,
    });
    assert.equal(pairRes.status, 201);
    assert.match(pairRes.headers["set-cookie"], /^__Host-rwang-device=rd_/);
    assert.equal(pairRes.payload.device.scopes.includes("approve"), false);

    const cookie = pairRes.headers["set-cookie"].split(";", 1)[0];
    const deviceReq = request({ cookie });
    assert.equal(core.authorize(deviceReq).kind, "device");
    assert.equal(core.isDeviceApiAllowed(
      { ...deviceReq, method: "POST" },
      new URL("https://rwang.test:4173/api/chat"),
    ), true);
    assert.equal(core.isDeviceApiAllowed(
      { ...deviceReq, method: "POST" },
      new URL("https://rwang.test:4173/api/rwang/approval"),
    ), false);
    assert.equal(core.isDeviceApiAllowed(
      { ...deviceReq, method: "POST" },
      new URL("https://rwang.test:4173/api/action"),
    ), false);
    assert.equal(core.isDeviceApiAllowed(
      { ...deviceReq, method: "POST" },
      new URL("https://rwang.test:4173/api/rwang/document-intelligence"),
    ), false);

    const deviceDocumentRes = response();
    await core.handleApi(deviceReq, deviceDocumentRes, new URL("https://rwang.test:4173/api/rwang/document-intelligence"), {
      readBody: async () => ({ action: "self-audit" }),
      json,
    });
    assert.equal(deviceDocumentRes.status, 403, "paired devices must not trigger workspace scans");

    const deviceSnapshot = await core.snapshot(deviceReq);
    assert.equal(deviceSnapshot.documentIntelligence.available, true);
    assert.equal(deviceSnapshot.documentIntelligence.operations.every(({ enabled }) => enabled === false), true);
    assert.equal(deviceSnapshot.documentIntelligence.lastAudit, undefined);
    assert.equal(JSON.stringify(deviceSnapshot.documentIntelligence).includes(rootDir), false);

    const localDocumentRes = response();
    await core.handleApi(localReq, localDocumentRes, new URL("https://localhost:4173/api/rwang/document-intelligence"), {
      readBody: async () => ({ action: "self-audit" }),
      json,
    });
    assert.equal(localDocumentRes.status, 200);
    assert.equal(localDocumentRes.payload.ok, true);
    assert.equal(localDocumentRes.payload.result.completed, true);

    const disableCoreSkillRes = response();
    await core.handleApi(localReq, disableCoreSkillRes, new URL("https://localhost:4173/api/rwang/config"), {
      readBody: async () => ({ section: "skills", id: "doc-architect", enabled: false }),
      json,
    });
    assert.equal(disableCoreSkillRes.status, 400, "Document Intelligence core skills must be immutable");

    core.authorize(deviceReq).device.scopes = ["status"];
    assert.equal(core.isDeviceApiAllowed(
      { ...deviceReq, method: "POST" },
      new URL("https://rwang.test:4173/api/chat"),
    ), false);
    assert.equal(core.isDeviceApiAllowed(
      { ...deviceReq, method: "GET" },
      new URL("https://rwang.test:4173/api/status"),
    ), true);
    assert.equal(core.isAuthorized(deviceReq, new URL("https://rwang.test:4173/api/remote"), "remote"), false);

    const replayRes = response();
    await core.handlePublicApi(request({ encrypted: true }), replayRes, new URL("https://rwang.test:4173/api/rwang/pair"), {
      readBody: async () => ({ code: createRes.payload.code, name: "Replay" }),
      json,
    });
    assert.equal(replayRes.status, 401);

    const revokeRes = response();
    await core.handleApi(localReq, revokeRes, new URL("https://localhost:4173/api/rwang/pairing"), {
      readBody: async () => ({ action: "revoke", id: pairRes.payload.device.id }),
      json,
    });
    assert.equal(revokeRes.status, 200);
    assert.equal(core.authorize(deviceReq).authorized, false);
    assert.equal(revoked, 1);

    const localSnapshot = await core.snapshot(localReq);
    assert.equal(localSnapshot.access.token, undefined);
    assert.equal(localSnapshot.documentIntelligence.status, "ready");
    assert.equal(localSnapshot.documentIntelligence.skills.length, 7);
    assert.equal(localSnapshot.documentIntelligence.lastAudit.status, "passed");
    assert.equal(localSnapshot.skills.filter(({ core }) => core).length, 7);
    assert.equal(JSON.stringify(localSnapshot.documentIntelligence).includes(rootDir), false);
    const savedConfig = JSON.parse(await readFile(path.join(rootDir, ".rwang-config.json"), "utf8"));
    const queryOnlyReq = request();
    assert.equal(core.isAuthorized(queryOnlyReq, new URL(`https://rwang.test:4173/?token=${savedConfig.access.token}`)), false);
  } finally {
    await core?.close();
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function remoteGrantTest() {
  const remote = createRemoteCore({
    isLocal: (req) => req.socket.remoteAddress === "127.0.0.1",
    isAuthorized: () => false,
    getPolicy: () => ({ screenShare: true, mobileRemote: true }),
    getIceServers: () => [{ urls: "turns:turn.example.test:5349", username: "test", credential: "test" }],
  });

  async function call({ local = false, pathname, body }) {
    const req = request({ local });
    const res = response();
    await remote.handleApi(req, res, new URL(`https://rwang.test:4173${pathname}`), {
      readBody: async () => body,
      json,
    });
    return res;
  }

  try {
    const created = await call({
      local: true,
      pathname: "/api/remote/session",
      body: { action: "create", shareMode: "screen", ttlMinutes: 5 },
    });
    assert.equal(created.status, 201);
    assert.equal(created.payload.rtcConfiguration.iceServers.length, 1);
    const { id: sessionId, shareToken } = created.payload.session;

    const joined = await call({
      pathname: "/api/remote/join",
      body: { sessionId, shareToken, name: "Phone A" },
    });
    assert.equal(joined.status, 201);
    const { viewerId, viewerToken } = joined.payload;

    const replay = await call({
      pathname: "/api/remote/join",
      body: { sessionId, shareToken, name: "Phone B" },
    });
    assert.equal(replay.status, 401);

    const granted = await call({
      local: true,
      pathname: "/api/remote/session",
      body: { action: "set-control", sessionId, viewerId, enabled: true, durationMs: 10_000 },
    });
    assert.equal(granted.status, 200);
    assert.equal(granted.payload.allowRemoteControl, true);

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 11_000;
      const expired = await call({
        pathname: "/api/remote/command",
        body: {
          sessionId,
          viewerId,
          viewerToken,
          command: { action: "navigate", target: "assistant" },
        },
      });
      assert.equal(expired.status, 403);
    } finally {
      Date.now = realNow;
    }
  } finally {
    await remote.close();
  }
}

await corePairingTest();
await remoteGrantTest();
console.log("RWANG security smoke tests passed");
