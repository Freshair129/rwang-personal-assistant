import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
assert.match(adapterSource, /const PROCESS_TIMEOUT_MS = 60_000;/,
  "Windows PowerShell actions must keep the approved bounded hosted-runner deadline");
const scannerSource = await readFile(
  path.join(rootDir, "capabilities", "rwang-document-intelligence", "scripts", "scan-annotations.ps1"),
  "utf8",
);
const shellScannerSource = await readFile(
  path.join(rootDir, "capabilities", "rwang-document-intelligence", "scripts", "scan-annotations.sh"),
  "utf8",
);
const sourceMetadata = JSON.parse(await readFile(
  path.join(rootDir, "capabilities", "rwang-document-intelligence", "SOURCE.json"),
  "utf8",
));
const readmeText = await readFile(path.join(rootDir, "README.md"), "utf8");
const noticeText = await readFile(
  path.join(rootDir, "capabilities", "rwang-document-intelligence", "NOTICE.md"),
  "utf8",
);
const provenanceTick = String.fromCharCode(96);
assert.ok(
  readmeText.includes("release " + provenanceTick + "v" + sourceMetadata.version + provenanceTick)
    && readmeText.includes("commit " + provenanceTick + sourceMetadata.commit + provenanceTick),
  "README provenance must match SOURCE.json",
);
assert.ok(
  noticeText.includes("tag " + provenanceTick + "v" + sourceMetadata.version + provenanceTick + ", commit")
    && noticeText.includes(provenanceTick + sourceMetadata.commit + provenanceTick)
    && noticeText.includes(provenanceTick + sourceMetadata.artifact.sha256 + provenanceTick),
  "vendoring notice provenance must match SOURCE.json",
);
assert.doesNotMatch(scannerSource, /Get-ChildItem[^\r\n]*-Recurse/i,
  "the scanner must prune ignored directories and reparse points before recursion");
assert.doesNotMatch(scannerSource, /Get-ChildItem/i,
  "the scanner must not materialize PowerShell provider entries before pruning");
assert.match(scannerSource, /Directory\]::EnumerateDirectories/,
  "the scanner must enumerate directory names before reading child attributes");
assert.doesNotMatch(scannerSource, /New-Object\s+['"]System\.Collections\.Generic\.Stack/i,
  "the scanner must not depend on cmdlet resolution to initialize traversal state");
assert.match(scannerSource, /Stack\[string\]\]::new\(\)/,
  "the scanner must construct traversal state through the static .NET path");
assert.match(scannerSource, /\nexit 0\s*$/,
  "the scanner must terminate explicitly after flushing its final output pipeline");
assert.doesNotMatch(scannerSource, /Resolve-Path\s+\$Path/i,
  "the scanner must not resolve its root through the PowerShell provider");
assert.match(scannerSource, /Path\]::GetFullPath\(\$Path\)/,
  "the scanner must resolve its root without provider traversal");
assert.match(scannerSource, /FileAttributes\]::ReparsePoint/,
  "the scanner must reject reparse points before enqueueing directories");
assert.match(scannerSource, /\*\.mjs/,
  "the PowerShell scanner must include the host repository's .mjs modules");
assert.match(scannerSource, /SDD\|PER\|SEC/,
  "the PowerShell scanner must include Persona requirement identifiers");
assert.match(scannerSource, /js\|jsx\|mjs\|py/,
  "the PowerShell scanner must accept .mjs test references");
assert.match(shellScannerSource, /EXTENSIONS="[^"]*mjs/,
  "the shell scanner must include the host repository's .mjs modules");
assert.match(shellScannerSource, /js\|jsx\|mjs\|py/,
  "the shell scanner must accept .mjs test references");
assert.match(shellScannerSource, /SDD\|PER\|SEC/,
  "the shell scanner must include Persona requirement identifiers");
const capability = createDocumentIntelligence({ rootDir });

function runPowerShell(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function verifyScannerHostCoverage() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "rwang-document-intelligence-coverage-"));
  try {
    await Promise.all([
      writeFile(path.join(fixtureRoot, "control.js"), "// @req FR-001\n", "utf8"),
      writeFile(path.join(fixtureRoot, "backend.mjs"), "// @req FR-002\n", "utf8"),
      writeFile(path.join(fixtureRoot, "persona.js"), "// @req PER-001\n", "utf8"),
      writeFile(path.join(fixtureRoot, "test-link.js"), "// @tested tests/persona-contract.mjs\n", "utf8"),
    ]);
    const result = await runPowerShell("powershell", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(rootDir, "capabilities", "rwang-document-intelligence", "scripts", "scan-annotations.ps1"),
      "-Path", fixtureRoot, "-Format", "json",
    ]);
    assert.equal(result.code, 0, "scanner fixture failed:\n" + result.stdout + "\n" + result.stderr);
    const report = JSON.parse(result.stdout);
    const annotations = new Map(report.annotations.map((annotation) => [annotation.file, annotation]));
    const firstId = (annotation) => Array.isArray(annotation?.ids) ? annotation.ids[0] : annotation?.ids;
    assert.equal(firstId(annotations.get("backend.mjs")), "FR-002");
    assert.equal(firstId(annotations.get("persona.js")), "PER-001");
    assert.equal(annotations.get("test-link.js")?.form, "test-ref");
    assert.equal(firstId(annotations.get("test-link.js")), "tests/persona-contract.mjs");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

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
  assert.equal(snapshot.commit, "42ef41ffff3b62dcfd88ac28780d8f0d26b1c617");
  assert.equal(snapshot.runtime.policy, "read-only");
  assert.equal(snapshot.integrity.status, "sha256-verified");
  assert.equal(snapshot.integrity.signed, false);
  assert.equal(snapshot.hostPolicy.playbooks, "proposal-only");
  assert.equal(snapshot.hostPolicy.graphWriter, "doc-graph-only");
  assert.equal(snapshot.hostPolicy.scannedRepositoryContent, "untrusted-data");
  assert.equal(snapshot.source.tag, "v1.4.0");
  assert.equal(snapshot.source.commit, "42ef41ffff3b62dcfd88ac28780d8f0d26b1c617");
  assert.equal(snapshot.source.artifactSha256, "d93209d15b3b154327bb04d7e15452465b3743441e81d6b21fd6ccb037bc217a");
  assert.deepEqual(snapshot.source.adaptations, [
    "scripts/scan-annotations.ps1: bounded enumeration skips ignored directories and reparse points before recursion",
    "scripts/scan-annotations.ps1: no Get-ChildItem at all — directories are enumerated through [IO.Directory]::EnumerateDirectories so provider entries are never materialized before pruning",
    "scripts/scan-annotations.ps1: traversal state is constructed as Stack[string]]::new(), not New-Object, so it does not depend on cmdlet resolution",
    "scripts/scan-annotations.ps1: the root is resolved without Resolve-Path, so it is not resolved through the PowerShell provider",
    "scripts/scan-annotations.ps1: terminates with an explicit exit 0 after flushing its output pipeline",
    "scripts/scan-annotations.ps1 and scan-annotations.sh: scan the repository's .mjs modules and test references",
    "scripts/scan-annotations.ps1 and scan-annotations.sh: recognize the Persona PRD PER-xxx requirement identifiers",
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
    await verifyScannerHostCoverage();
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
