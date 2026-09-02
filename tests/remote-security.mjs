import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRemoteCore } from "../remote.mjs";

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.status = 0;
    this.payload = null;
    this.headers = {};
    this.headersSent = false;
    this.chunks = [];
    this.writableLength = 0;
  }

  writeHead(status, headers = {}) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end() {
    this.ended = true;
  }
}

function request({ method = "POST", local = false, headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = {
    host: local ? "localhost:4173" : "rwang.test:4173",
    ...headers,
  };
  req.socket = { remoteAddress: local ? "127.0.0.1" : "192.0.2.50" };
  return req;
}

function json(res, status, payload, headers = {}) {
  res.status = status;
  res.payload = payload;
  res.headers = headers;
  res.headersSent = true;
}

function createHarness(options = {}) {
  const remote = createRemoteCore({
    isLocal: (req) => req.socket.remoteAddress === "127.0.0.1",
    isAuthorized: options.isAuthorized || (() => false),
    getPolicy: () => ({ screenShare: true, mobileRemote: true }),
    getIceServers: () => [],
  });

  async function call({ method = "POST", local = false, pathname, body = {}, headers = {}, res = new MockResponse() }) {
    const req = request({ method, local, headers });
    await remote.handleApi(req, res, new URL(`https://rwang.test:4173${pathname}`), {
      readBody: async () => body,
      json,
    });
    return { req, res };
  }

  return { remote, call };
}

async function remoteBoundaryTest() {
  const { remote, call } = createHarness();
  try {
    const created = (await call({
      local: true,
      pathname: "/api/remote/session",
      body: { action: "create", maxViewers: 1, ttlMinutes: 5 },
    })).res;
    assert.equal(created.status, 201);
    const sessionId = created.payload.session.id;
    const firstInvite = created.payload.session.shareToken;
    assert.equal(created.payload.session.inviteAvailable, true);

    const leakedQuery = (await call({
      method: "GET",
      pathname: `/api/remote?sessionId=${sessionId}&shareToken=${firstInvite}`,
    })).res;
    assert.equal(leakedQuery.status, 401, "share token in query must be rejected");

    const scopedHeader = (await call({
      method: "GET",
      pathname: `/api/remote?sessionId=${sessionId}`,
      headers: { "x-rwang-share-token": firstInvite },
    })).res;
    assert.equal(scopedHeader.status, 200);

    const joined = (await call({
      pathname: "/api/remote/join",
      body: { sessionId, shareToken: firstInvite, name: "Phone" },
    })).res;
    assert.equal(joined.status, 201);
    const { viewerId, viewerToken } = joined.payload;

    const localSnapshot = (await call({ method: "GET", local: true, pathname: "/api/remote" })).res;
    assert.equal(localSnapshot.payload.sessions[0].inviteUsed, true);
    assert.equal(localSnapshot.payload.sessions[0].shareToken, undefined);

    const grantedAt = Date.now();
    const granted = (await call({
      local: true,
      pathname: "/api/remote/session",
      body: { action: "set-control", sessionId, viewerId, enabled: true, durationMs: 60 * 60 * 1000 },
    })).res;
    assert.equal(granted.status, 200);
    const controlExpiry = Date.parse(granted.payload.controlExpiresAt);
    assert.ok(controlExpiry <= grantedAt + 10 * 60 * 1000 + 1000, "server must clamp control to ten minutes");

    const ticket = (await call({
      pathname: "/api/remote/events-ticket",
      body: { role: "viewer", sessionId, viewerId, viewerToken },
    })).res;
    assert.equal(ticket.status, 201);

    const firstStream = await call({
      method: "GET",
      pathname: `/api/remote/events?ticket=${ticket.payload.ticket}`,
    });
    assert.equal(firstStream.res.status, 200);
    firstStream.req.emit("close");

    const replayedStream = (await call({
      method: "GET",
      pathname: `/api/remote/events?ticket=${ticket.payload.ticket}`,
    })).res;
    assert.equal(replayedStream.status, 401, "event ticket must be consumed once");

    const disconnected = (await call({
      local: true,
      pathname: "/api/remote/session",
      body: { action: "disconnect-viewer", sessionId, viewerId },
    })).res;
    assert.equal(disconnected.status, 200);

    const staleViewer = (await call({
      pathname: "/api/remote/command",
      body: {
        sessionId,
        viewerId,
        viewerToken,
        command: { action: "navigate", target: "assistant" },
      },
    })).res;
    assert.equal(staleViewer.status, 401, "disconnected viewer token must stop working");

    const renewed = (await call({
      local: true,
      pathname: "/api/remote/session",
      body: { action: "new-invite", sessionId },
    })).res;
    assert.equal(renewed.status, 201);
    assert.notEqual(renewed.payload.shareToken, firstInvite);

    const staleInvite = (await call({
      pathname: "/api/remote/join",
      body: { sessionId, shareToken: firstInvite, name: "Stale" },
    })).res;
    assert.equal(staleInvite.status, 401);

    const renewedJoin = (await call({
      pathname: "/api/remote/join",
      body: { sessionId, shareToken: renewed.payload.shareToken, name: "Replacement" },
    })).res;
    assert.equal(renewedJoin.status, 201);
  } finally {
    await remote.close();
  }
}

async function remoteScopeHookTest() {
  let requiredScope = "";
  const { remote, call } = createHarness({
    isAuthorized: (_req, _url, scope) => {
      requiredScope = scope;
      return false;
    },
  });
  try {
    const result = (await call({ method: "GET", pathname: "/api/remote?sessionId=invalid" })).res;
    assert.equal(result.status, 401);
    assert.equal(requiredScope, "remote");
  } finally {
    await remote.close();
  }
}

await remoteBoundaryTest();
await remoteScopeHookTest();
console.log("RWANG remote security tests passed");
