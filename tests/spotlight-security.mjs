import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SPOTLIGHT_LIMITS,
  createSpotlightIndex,
  handleSpotlightApi,
} from "../spotlight.mjs";

async function writeFixture(filePath, content = "fixture") {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function trySymlink(target, linkPath, type = "file") {
  try {
    await symlink(target, linkPath, process.platform === "win32" && type === "dir" ? "junction" : type);
    return true;
  } catch (error) {
    if (["EACCES", "EPERM", "ENOSYS"].includes(error?.code)) return false;
    throw error;
  }
}

function captureErrorCode(expectedCode) {
  return (error) => {
    assert.equal(error?.code, expectedCode);
    return true;
  };
}

function mockResponse() {
  return { status: 0, payload: null, headers: {} };
}

function json(res, status, payload, headers = {}) {
  res.status = status;
  res.payload = payload;
  res.headers = headers;
}

async function callApi(spotlight, {
  method = "GET",
  pathname,
  principal = { kind: "local" },
  body = {},
} = {}) {
  const req = { method };
  const res = mockResponse();
  const handled = await handleSpotlightApi(req, res, new URL(`http://localhost:4173${pathname}`), {
    principal,
    spotlight,
    readBody: async () => body,
    json,
  });
  return { handled, res };
}

async function spotlightBoundaryTest() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rwang-spotlight-home-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "rwang-spotlight-outside-"));
  const documentsDir = path.join(homeDir, "Documents");
  const downloadsDir = path.join(homeDir, "Downloads");
  const workspaceDir = path.join(outsideDir, "workspace");
  const rejectedDir = path.join(outsideDir, "not-allowed");
  const reportPath = path.join(documentsDir, "projects", "quarterly-report.md");
  const injectionName = "notes & calc.txt";
  const injectionPath = path.join(documentsDir, "projects", injectionName);
  const blockedPath = path.join(documentsDir, "projects", "launch-me.cmd");
  const unknownScriptPath = path.join(documentsDir, "projects", "module.mjs");
  const workspacePath = path.join(workspaceDir, "workspace-plan.json");
  const outsideSecretPath = path.join(rejectedDir, "outside-secret.txt");
  const launches = [];
  let clock = Date.now();
  let spotlight;

  try {
    await Promise.all([
      writeFixture(reportPath, "Quarterly report content must never enter the metadata index."),
      writeFixture(injectionPath, "safe text"),
      writeFixture(blockedPath, "@echo off\r\ncalc.exe"),
      writeFixture(unknownScriptPath, "process.exit(0)"),
      writeFixture(workspacePath, "{\"plan\":true}"),
      writeFixture(path.join(downloadsDir, "download-note.txt"), "download"),
      writeFixture(outsideSecretPath, "outside"),
      writeFixture(path.join(documentsDir, ".private", "hidden-secret.md"), "hidden"),
      writeFixture(path.join(documentsDir, "node_modules", "dependency-secret.txt"), "ignored"),
      writeFixture(path.join(documentsDir, "desktop.ini"), "ignored"),
    ]);

    const linkedDirectory = await trySymlink(rejectedDir, path.join(documentsDir, "escape-directory"), "dir");
    const linkedFile = await trySymlink(outsideSecretPath, path.join(documentsDir, "escape-file.txt"));

    spotlight = await createSpotlightIndex({
      roots: [
        { label: "Documents", path: documentsDir },
        { label: "Documents", path: downloadsDir },
        { label: "Workspace", path: workspaceDir },
        { label: "Rejected", path: rejectedDir },
        { label: "Profile", path: homeDir },
      ],
      homeDir,
      workspaceRoot: workspaceDir,
      launcher: async (launch) => launches.push({ ...launch }),
      refreshIntervalMs: 0,
      now: () => clock,
    });

    const indexed = await spotlight.reindex();
    assert.equal(indexed.state, "ready");
    assert.equal(indexed.rootCount, 3, "personal child roots and the exact workspace root should be accepted");
    assert.equal(indexed.rejectedRootCount, 2, "the profile root itself and paths outside it must be rejected");
    assert.deepEqual(indexed.roots, ["Documents", "Documents 2", "Workspace"]);
    assert.equal(new Set(indexed.roots.map((label) => label.toLowerCase())).size, indexed.roots.length);
    assert.equal(JSON.stringify(indexed).includes(homeDir), false, "status must not expose the home directory");
    assert.equal(JSON.stringify(indexed).includes(outsideDir), false, "status must not expose rejected paths");

    assert.deepEqual(spotlight.search("q").results, [], "one-character queries must not enumerate the index");
    assert.throws(
      () => spotlight.search("x".repeat(SPOTLIGHT_LIMITS.maxQueryLength + 1)),
      captureErrorCode("QUERY_TOO_LONG"),
    );
    assert.doesNotThrow(() => spotlight.search("[.*+?"), "search input must never become a dynamic regular expression");

    for (const skippedQuery of ["hidden secret", "dependency secret", "outside secret", "desktop ini"]) {
      assert.equal(spotlight.search(skippedQuery).results.length, 0, `${skippedQuery} must remain outside the index`);
    }
    if (linkedDirectory || linkedFile) {
      assert.equal(spotlight.search("escape").results.length, 0, "symlink/junction entries must not be indexed");
    }

    const report = spotlight.search("quarterly report").results[0];
    assert.ok(report);
    assert.match(report.id, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(report.path, "Documents/projects/quarterly-report.md");
    assert.equal(report.openable, true);
    assert.equal("snippet" in report, false);
    assert.equal("content" in report, false);
    assert.equal(JSON.stringify(report).includes(homeDir), false, "results must use labels and relative paths only");

    const workspace = spotlight.searchWorkspace("workspace plan").results[0];
    assert.ok(workspace);
    assert.equal(workspace.path, "workspace-plan.json");
    assert.equal("id" in workspace, false, "agent-facing workspace search must not issue open handles");
    assert.match(spotlight.searchWorkspace("workspace").notice, /untrusted local metadata/i);

    const blocked = spotlight.search("launch me").results[0];
    const unknownScript = spotlight.search("module mjs").results[0];
    assert.equal(blocked.openable, false);
    assert.equal(unknownScript.openable, false, "unknown/script formats must be reveal-only");

    await spotlight.open(report.id, { action: "open" });
    assert.deepEqual(launches.at(-1), { filePath: reportPath, action: "open" });
    clock += 400;
    assert.equal(JSON.stringify(await spotlight.open(report.id, { action: "reveal" })).includes(reportPath), false);

    clock += 400;
    const injectionResult = spotlight.search("notes calc").results[0];
    await spotlight.open(injectionResult.id, { action: "open" });
    assert.deepEqual(
      launches.at(-1),
      { filePath: injectionPath, action: "open" },
      "metacharacters must reach only the fixed launcher argument, never a command string",
    );

    await assert.rejects(
      spotlight.open(blocked.id, { action: "open" }),
      captureErrorCode("UNSAFE_FILE_TYPE"),
    );
    await assert.rejects(
      spotlight.open(unknownScript.id, { action: "open" }),
      captureErrorCode("UNSAFE_FILE_TYPE"),
    );
    clock += 400;
    await spotlight.open(blocked.id, { action: "reveal" });
    assert.deepEqual(launches.at(-1), { filePath: blockedPath, action: "reveal" });

    await assert.rejects(
      spotlight.open(reportPath, { action: "open" }),
      captureErrorCode("INVALID_RESULT_ID"),
    );
    await assert.rejects(
      spotlight.open("A".repeat(43), { action: "open" }),
      captureErrorCode("STALE_RESULT"),
    );
    await assert.rejects(
      spotlight.open(report.id, { action: "execute" }),
      captureErrorCode("INVALID_OPEN_ACTION"),
    );

    await writeFile(reportPath, "The indexed file was replaced with different content and size.", "utf8");
    clock += 400;
    await assert.rejects(
      spotlight.open(report.id, { action: "open" }),
      captureErrorCode("STALE_RESULT"),
    );

    clock += 400;
    await spotlight.open(injectionResult.id, { action: "open" });
    clock += 100;
    await assert.rejects(
      spotlight.open(injectionResult.id, { action: "open" }),
      captureErrorCode("OPEN_RATE_LIMIT"),
    );

    const remotePrincipals = [
      { kind: "device" },
      { kind: "master" },
      { kind: "none" },
    ];
    for (const principal of remotePrincipals) {
      for (const request of [
        { method: "GET", pathname: "/api/spotlight/status" },
        { method: "GET", pathname: "/api/spotlight/search?q=report" },
        { method: "POST", pathname: "/api/spotlight/reindex" },
        { method: "POST", pathname: "/api/spotlight/open", body: { id: report.id } },
      ]) {
        const { handled, res } = await callApi(spotlight, { ...request, principal });
        assert.equal(handled, true);
        assert.equal(res.status, 403, `${principal.kind} must not access ${request.pathname}`);
        assert.equal(JSON.stringify(res.payload).includes(homeDir), false);
      }
    }

    const localStatus = await callApi(spotlight, { pathname: "/api/spotlight/status" });
    assert.equal(localStatus.res.status, 200);
    assert.equal(JSON.stringify(localStatus.res.payload).includes(homeDir), false);

    const badLimit = await callApi(spotlight, { pathname: "/api/spotlight/search?q=report&limit=-1" });
    assert.equal(badLimit.res.status, 400);
    assert.equal(badLimit.res.payload.code, "INVALID_LIMIT");

    const rawPathOpen = await callApi(spotlight, {
      method: "POST",
      pathname: "/api/spotlight/open",
      body: { path: reportPath, action: "open" },
    });
    assert.equal(rawPathOpen.res.status, 400, "the API must never accept a client-supplied path");
    assert.equal(rawPathOpen.res.payload.code, "INVALID_RESULT_ID");

    const wrongMethod = await callApi(spotlight, { method: "PUT", pathname: "/api/spotlight/status" });
    assert.equal(wrongMethod.res.status, 405);

    const capIndex = await createSpotlightIndex({
      roots: [{ label: "Documents", path: documentsDir }],
      homeDir,
      maxFiles: 2,
      refreshIntervalMs: 0,
    });
    try {
      const capStatus = await capIndex.reindex();
      assert.equal(capStatus.fileCount, 2);
      assert.equal(capStatus.truncated, true);
    } finally {
      await capIndex.close();
    }

    let timeoutClock = 0;
    let monotonicClock = 0;
    const timeoutIndex = await createSpotlightIndex({
      roots: [{ label: "Documents", path: documentsDir }],
      homeDir,
      refreshIntervalMs: 0,
      maxScanMs: 100,
      now: () => {
        timeoutClock += 60;
        return timeoutClock;
      },
      monotonicNow: () => {
        monotonicClock += 60;
        return monotonicClock;
      },
    });
    try {
      const timeoutStatus = await timeoutIndex.reindex();
      assert.equal(timeoutStatus.state, "ready");
      assert.equal(timeoutStatus.timedOut, true, "wall-clock deadline must stop a long index scan");
      assert.equal(timeoutStatus.truncated, true);
    } finally {
      await timeoutIndex.close();
    }

    const shallowRoot = path.join(homeDir, "DepthRoot");
    await writeFixture(path.join(shallowRoot, "one", "two", "too-deep.txt"), "deep");
    const shallowIndex = await createSpotlightIndex({
      roots: [{ label: "Depth", path: shallowRoot }],
      homeDir,
      maxDepth: 0,
      refreshIntervalMs: 0,
    });
    try {
      await shallowIndex.reindex();
      assert.equal(shallowIndex.search("too deep").results.length, 0);
    } finally {
      await shallowIndex.close();
    }

    await spotlight.close();
    spotlight = null;
  } finally {
    await spotlight?.close();
    await Promise.all([
      rm(homeDir, { recursive: true, force: true }),
      rm(outsideDir, { recursive: true, force: true }),
    ]);
  }
}

async function closeAbortsIndexTest() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rwang-spotlight-abort-"));
  const rootDir = path.join(homeDir, "Documents");
  let spotlight;
  try {
    await writeFixture(path.join(rootDir, "pending.txt"), "pending");
    spotlight = await createSpotlightIndex({
      roots: [{ label: "Documents", path: rootDir }],
      homeDir,
      refreshIntervalMs: 0,
    });
    const outcome = spotlight.start().then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    await spotlight.close();
    const settled = await outcome;
    assert.equal(settled.ok, false, "close must abort an in-flight index build");
    assert.equal(settled.error?.name, "AbortError");
    assert.equal(spotlight.status().state, "closed");
    assert.equal(spotlight.status().indexedFiles, 0);
    assert.throws(() => spotlight.search("pending"), captureErrorCode("INDEX_CLOSED"));
  } finally {
    await spotlight?.close();
    await rm(homeDir, { recursive: true, force: true });
  }
}

await spotlightBoundaryTest();
await closeAbortsIndexTest();
console.log("RWANG Spotlight security tests passed");
