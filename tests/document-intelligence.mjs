import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDocumentIntelligence,
  DOCUMENT_INTELLIGENCE_VERSION,
  DocumentIntelligenceError,
} from "../document-intelligence.mjs";

const rootDir = realpathSync(path.dirname(fileURLToPath(new URL("../package.json", import.meta.url))));
const adapterSource = await readFile(path.join(rootDir, "document-intelligence.mjs"), "utf8");
assert.match(adapterSource, /SCAN_SKIPPED_DIRECTORIES[\s\S]*?"\.pnpm-store"[\s\S]*?\]\);/,
  "Document Intelligence must skip the gitignored pnpm dependency cache");
const scannerSource = await readFile(
  path.join(rootDir, "capabilities", "rwang-document-intelligence", "scripts", "scan-annotations.ps1"),
  "utf8",
);
assert.doesNotMatch(scannerSource, /Get-ChildItem[^\r\n]*-Recurse/i,
  "the scanner must prune ignored directories and reparse points before recursion");
assert.doesNotMatch(scannerSource, /Get-ChildItem/i,
  "the scanner must not materialize PowerShell provider entries before pruning");
assert.match(scannerSource, /Directory\]::EnumerateDirectories/,
  "the scanner must enumerate directory names before reading child attributes");
assert.doesNotMatch(scannerSource, /Resolve-Path\s+\$Path/i,
  "the scanner must not resolve its root through the PowerShell provider");
assert.match(scannerSource, /Path\]::GetFullPath\(\$Path\)/,
  "the scanner must resolve its root without provider traversal");
assert.match(scannerSource, /FileAttributes\]::ReparsePoint/,
  "the scanner must reject reparse points before enqueueing directories");
const capability = createDocumentIntelligence({ rootDir });

async function verifyTraversalLinkPolicy() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "rwang-document-intelligence-links-"));
  const cachedRoot = path.join(fixtureRoot, "cached-root");
  const unsafeRoot = path.join(fixtureRoot, "unsafe-root");
  const outsideRoot = path.join(fixtureRoot, "outside-root");
  await Promise.all([
    mkdir(path.join(cachedRoot, ".pnpm-store"), { recursive: true }),
    mkdir(unsafeRoot, { recursive: true }),
    mkdir(outsideRoot, { recursive: true }),
  ]);
  await writeFile(path.join(cachedRoot, ".pnpm-store", "ignored.ps1"), "# @req FR-001\n", "utf8");

  try {
    try {
      await symlink(
        path.join(outsideRoot, "missing-global-store-project"),
        path.join(cachedRoot, ".pnpm-store", "dangling-project"),
        "junction",
      );
      await symlink(outsideRoot, path.join(unsafeRoot, "outside-link"), "junction");
    } catch (error) {
      if (["EACCES", "EPERM", "ENOSYS", "UNKNOWN"].includes(error?.code)) {
        console.log(`RWANG Document Intelligence link policy test skipped: ${error.code}`);
        return;
      }
      throw error;
    }

    const cachedCapability = createDocumentIntelligence({ rootDir: cachedRoot });
    try {
      const cachedScan = await cachedCapability.scanAnnotations();
      assert.equal(
        cachedScan.status,
        "passed",
        `dangling links inside .pnpm-store must be outside the scan boundary: ${JSON.stringify(cachedScan)}`,
      );
      assert.deepEqual(cachedScan.report.annotations, [], "regular files inside .pnpm-store must remain outside the scan boundary");
    } finally {
      await cachedCapability.close();
    }

    const unsafeCapability = createDocumentIntelligence({ rootDir: unsafeRoot });
    try {
      await assert.rejects(
        unsafeCapability.scanAnnotations(),
        (error) => error instanceof DocumentIntelligenceError && error.code === "UNSAFE_REPOSITORY_PATH",
        "links outside the application root must remain fail-closed",
      );
    } finally {
      await unsafeCapability.close();
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

try {
  const snapshot = capability.snapshot({ local: true });
  assert.equal(snapshot.id, "rwang-document-intelligence");
  assert.equal(snapshot.version, DOCUMENT_INTELLIGENCE_VERSION);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.sourceUrl, "https://github.com/Freshair129/rwang-plugin");
  assert.equal(snapshot.commit, "7354738094432fed22d6e00568315e1a1bd8fe15");
  assert.equal(snapshot.runtime.policy, "read-only");
  assert.equal(snapshot.integrity.status, "sha256-verified");
  assert.equal(snapshot.integrity.signed, false);
  assert.equal(snapshot.hostPolicy.playbooks, "proposal-only");
  assert.equal(snapshot.hostPolicy.graphWriter, "doc-graph-only");
  assert.equal(snapshot.hostPolicy.scannedRepositoryContent, "untrusted-data");
  assert.equal(snapshot.source.tag, "v1.3.0");
  assert.equal(snapshot.source.commit, "7354738094432fed22d6e00568315e1a1bd8fe15");
  assert.equal(snapshot.source.artifactSha256, "4225e902d65ebffe9e9af945376c9b6b459f7bccc4c67a04dc80a6ad01d13432");
  assert.deepEqual(snapshot.source.adaptations, [
    "scripts/scan-annotations.ps1: bounded enumeration skips ignored directories and reparse points before recursion",
  ]);
  assert.equal(snapshot.skills.length, 7);
  assert.equal(new Set(snapshot.skills.map(({ id }) => id)).size, 7);
  assert.equal(snapshot.skills.every(({ core }) => core === true), true);
  assert.equal(snapshot.skills.find(({ id }) => id === "doc-preflight").mode, "guided");
  assert.equal(snapshot.catalog.modes.length, 7);
  assert.equal(snapshot.operations.every(({ readOnly, localOnly, enabled }) => readOnly && localOnly && enabled), true);
  assert.equal(JSON.stringify(snapshot).includes(rootDir), false, "snapshot must not expose local paths");

  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "rwang-document-intelligence-"));
  try {
    const isolatedCapability = createDocumentIntelligence({ rootDir: isolatedRoot });
    assert.equal(isolatedCapability.snapshot().available, true, "vendored pack must not depend on the scan target");
    await isolatedCapability.close();
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }

  const tamperedRoot = await mkdtemp(path.join(os.tmpdir(), "rwang-document-intelligence-tamper-"));
  try {
    const copiedPack = path.join(tamperedRoot, "pack");
    await cp(path.join(rootDir, "capabilities", "rwang-document-intelligence"), copiedPack, { recursive: true });
    const copiedScanner = path.join(copiedPack, "scripts", "scan-annotations.ps1");
    const scannerText = await readFile(copiedScanner, "utf8");
    await writeFile(copiedScanner, scannerText.replace(/\r\n?/g, "\r\n"), "utf8");
    const crlfCapability = createDocumentIntelligence({ rootDir, capabilityDir: copiedPack });
    await crlfCapability.close();
    await appendFile(copiedScanner, "\r\n# tampered\r\n", "utf8");
    assert.throws(
      () => createDocumentIntelligence({ rootDir, capabilityDir: copiedPack }),
      (error) => error instanceof DocumentIntelligenceError && error.code === "DOCUMENT_INTELLIGENCE_INTEGRITY",
      "tampered runtime scripts must be rejected",
    );
  } finally {
    await rm(tamperedRoot, { recursive: true, force: true });
  }

  const playbook = capability.getPlaybook("rwang-self-audit");
  assert.equal(playbook.id, "rwang-self-audit");
  assert.equal(playbook.mode, "read-only");
  assert.equal(playbook.hostPolicy.adapterActions, "read-only");
  assert.equal(playbook.hostPolicy.autoSubagentExecution, false);
  assert.equal(playbook.playbook.includes("PostToolUse"), false);
  assert.equal(playbook.playbook.includes("drift-check.ps1"), false);
  assert.throws(
    () => capability.getPlaybook("../../scripts/drift-check"),
    (error) => error instanceof DocumentIntelligenceError && error.code === "UNKNOWN_SKILL",
  );

  for (const deniedPath of [
    "../plan.json",
    "docs/../plan.json",
    "C:\\Windows\\plan.json",
    "\\\\server\\share\\plan.json",
    "\\\\?\\C:\\plan.json",
    "/tmp/plan.json",
    "plan.yaml",
  ]) {
    await assert.rejects(
      capability.validatePlan(deniedPath),
      (error) => error instanceof DocumentIntelligenceError && error.code === "INVALID_PLAN_PATH",
      `expected path denial for ${deniedPath}`,
    );
  }

  if (process.platform === "win32") {
    await verifyTraversalLinkPolicy();

    const scan = await capability.scanAnnotations();
    assert.equal(scan.operation, "scan-annotations");
    assert.equal(scan.readOnly, true);
    assert.equal(scan.status, "passed");
    assert.equal(scan.ok, true);
    assert.equal(typeof scan.durationMs, "number");
    assert.equal(typeof scan.report?.summary?.filesScanned, "number");
    assert.equal(JSON.stringify(scan).includes(rootDir), false, "scan result must not expose the application root");

    const planValidation = await capability.validatePlan("package.json");
    assert.equal(planValidation.operation, "validate-plan");
    assert.equal(planValidation.readOnly, true);
    assert.equal(planValidation.status, "findings", "validator exit 1 must be represented as findings");
    assert.equal(planValidation.ok, false);
    assert.ok(planValidation.report.findingCount > 0);
  }
} finally {
  await capability.close();
}

console.log("RWANG Document Intelligence adapter tests passed");
