import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repositoryRoot, "scripts", "stage-desktop-runtime.ps1");
const acquireScriptPath = path.join(repositoryRoot, "scripts", "acquire-node-runtime.ps1");
const nodeRuntimeSpecPath = path.join(repositoryRoot, "scripts", "node-runtime.json");
const docsPath = path.join(repositoryRoot, "docs", "desktop-package-staging.md");
const desktopWorkflowPath = path.join(repositoryRoot, ".github", "workflows", "desktop.yml");
const stageRoot = path.join(repositoryRoot, "desktop", "stage");
const runtimeRoot = path.join(stageRoot, "rwang");

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runPowerShell(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
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

async function findPowerShell() {
  if (process.platform !== "win32") return null;
  for (const candidate of ["powershell", "pwsh"]) {
    try {
      const result = await runPowerShell(candidate, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
      if (result.code === 0) return candidate;
    } catch {
      // Try the Windows inbox host if pwsh is not installed.
    }
  }
  return null;
}

async function staticContract() {
  const [script, docs, acquireScript, nodeRuntimeSpecText, desktopWorkflow] = await Promise.all([
    readFile(scriptPath, "utf8"),
    readFile(docsPath, "utf8"),
    readFile(acquireScriptPath, "utf8"),
    readFile(nodeRuntimeSpecPath, "utf8"),
    readFile(desktopWorkflowPath, "utf8"),
  ]);

  assert.match(script, /\$stageRoot\s*=.*desktop\\stage/);
  assert.match(script, /\$runtimeRoot\s*=.*Join-Path\s+\$stageRoot\s+"rwang"/);
  assert.match(script, /\[switch\]\$DryRun/);
  assert.match(script, /\[switch\]\$ReplaceExisting/);
  assert.match(script, /\[string\]\$NodeSha256/);
  assert.match(script, /\[string\]\$NodeMetadataPath/);
  assert.match(script, /Node 24/);
  assert.match(script, /--config\.enable-global-virtual-store=false install --prod --frozen-lockfile --ignore-scripts --node-linker=hoisted/);
  assert.match(script, /Remove-PnpmInstallMetadata/);
  for (const metadata of [
    ".bin",
    ".modules.yaml",
    ".package-map.json",
    ".pnpm-workspace-state-v1.json",
    ".pnpm/lock.yaml",
  ]) {
    assert.match(script, new RegExp(metadata.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `staging must remove pnpm install-only metadata: ${metadata}`);
  }
  assert.doesNotMatch(script, /pnpm\s+deploy/i, "staging must not depend on pnpm deploy links");
  assert.match(script, /Get-FileHash\s+-LiteralPath.*-Algorithm SHA256/);
  assert.match(script, /runtime-manifest\.json/);
  assert.match(script, /Assert-StagingPath/);
  assert.match(script, /Assert-NotReparse/);
  assert.match(script, /Remove-ExactStagingTree/);
  assert.match(script, /Copy-PhysicalTree/);
  assert.match(script, /Move-Item\s+-LiteralPath\s+\$workRoot\s+-Destination\s+\$runtimeRoot/);
  assert.doesNotMatch(script, /\[string\]\$OutputPath|\[string\]\$DestinationPath/i);
  assert.doesNotMatch(script, /Remove-Item\s+-LiteralPath\s+\$(?:repoRoot|stageRoot)/i);
  assert.doesNotMatch(script, /Remove-Item\s+-Path\s+/i);

  for (const relative of [
    "desktop/runtime/entrypoint.mjs",
    "server.mjs",
    "rwang.mjs",
    "remote.mjs",
    "spotlight.mjs",
    "document-intelligence.mjs",
    "public",
    "capabilities",
    "runtime/node/node.exe",
    "runtime/node/LICENSE",
    "runtime/node/node-runtime.json",
    "runtime-manifest.json",
  ]) {
    assert.match(script, new RegExp(relative.replaceAll("/", "[\\\\/]")), `missing staging contract for ${relative}`);
  }

  assert.match(docs, /desktop\/stage\/rwang/);
  assert.match(docs, /pnpm install --prod --frozen-lockfile/);
  assert.match(docs, /rwang\/runtime\/node\/node\.exe/);
  assert.match(docs, /resources/);
  assert.match(docs, /junctions?\/symlinks|external junction/i);
  assert.match(docs, /desktop:stage/);
  assert.match(docs, /desktop:runtime/);
  assert.match(docs, /v24\.20\.0/);
  assert.match(acquireScript, /Invoke-WebRequest/);
  assert.match(acquireScript, /Expand-Archive/);
  assert.match(acquireScript, /Get-FileHash\s+-LiteralPath.*-Algorithm SHA256/);
  assert.match(acquireScript, /LICENSE/);
  const nodeRuntimeSpec = JSON.parse(nodeRuntimeSpecText);
  assert.equal(nodeRuntimeSpec.version, "v24.20.0");
  assert.equal(nodeRuntimeSpec.platform, "win-x64");
  assert.match(nodeRuntimeSpec.url, /^https:\/\/nodejs\.org\/dist\/v24\.20\.0\//);
  assert.match(nodeRuntimeSpec.shasumsUrl, /^https:\/\/nodejs\.org\/dist\/v24\.20\.0\/SHASUMS256\.txt$/);
  assert.match(nodeRuntimeSpec.archiveSha256, /^[0-9a-f]{64}$/);
  assert.match(nodeRuntimeSpec.nodeSha256, /^[0-9a-f]{64}$/);

  const releaseJob = desktopWorkflow.split(/\n  desktop-release:\s*\n/)[1];
  assert.ok(releaseJob, "desktop workflow must define the release job");
  const releaseStageIndex = releaseJob.indexOf("pnpm desktop:stage");
  const releaseSecurityIndex = releaseJob.indexOf("pnpm test:security");
  const releasePackageIndex = releaseJob.indexOf("pnpm test:desktop-contract");
  const releaseBuildIndex = releaseJob.indexOf("pnpm exec tauri build --bundles nsis");
  assert.ok(releaseStageIndex >= 0, "release job must stage the deterministic runtime");
  assert.ok(releaseStageIndex < releaseSecurityIndex, "release job must run security tests after staging");
  assert.ok(releaseSecurityIndex < releasePackageIndex, "release job must run the complete desktop contract");
  assert.ok(releasePackageIndex < releaseBuildIndex, "release job must verify the staged tree before building NSIS");
}

async function dryRunContract() {
  const powershell = await findPowerShell();
  if (!powershell) {
    console.log("RWANG desktop package dry-run skipped: PowerShell is unavailable");
    return;
  }

  const beforeStage = await exists(runtimeRoot);
  let beforeStageStat = null;
  if (beforeStage) beforeStageStat = await stat(runtimeRoot);

  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "rwang-desktop-package-"));
  const licensePath = path.join(fixtureRoot, "LICENSE");
  const nodeSha256 = createHash("sha256")
    .update(await readFile(process.execPath))
    .digest("hex");
  await writeFile(licensePath, "Node.js license fixture for dry-run validation\n", "utf8");
  try {
    const result = await runPowerShell(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-DryRun",
      "-NodePath",
      process.execPath,
      "-NodeLicensePath",
      licensePath,
      "-NodeSha256",
      nodeSha256,
    ]);
    assert.equal(result.code, 0, `PowerShell dry-run failed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /DRY RUN: no files were written under desktop\/stage/);
    assert.equal(await exists(runtimeRoot), beforeStage, "dry-run must not create runtime output");
    if (beforeStage) {
      const afterStageStat = await stat(runtimeRoot);
      assert.equal(afterStageStat.mtimeMs, beforeStageStat.mtimeMs, "dry-run must not mutate existing output");
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function dryRunAcquireContract() {
  const powershell = await findPowerShell();
  if (!powershell) return;

  const result = await runPowerShell(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    acquireScriptPath,
    "-DryRun",
  ]);
  assert.equal(result.code, 0, `Node runtime dry-run failed:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /DRY RUN: no download or runtime files were written/);
}

async function stagedRuntimeContract() {
  if (!(await exists(runtimeRoot))) {
    console.log("RWANG staged runtime metadata contract skipped: stage is unavailable");
    return;
  }
  const forbidden = [
    "node_modules/.bin",
    "node_modules/.modules.yaml",
    "node_modules/.package-map.json",
    "node_modules/.pnpm-workspace-state-v1.json",
    "node_modules/.pnpm/lock.yaml",
  ];
  for (const relative of forbidden) {
    assert.equal(await exists(path.join(runtimeRoot, ...relative.split("/"))), false,
      `staged runtime must exclude pnpm install-only metadata: ${relative}`);
  }
  const manifest = JSON.parse(await readFile(path.join(runtimeRoot, "runtime-manifest.json"), "utf8"));
  const manifestPaths = new Set(manifest.files.map(({ path: relative }) => relative));
  for (const relative of forbidden) {
    assert.equal(manifestPaths.has(relative), false,
      `runtime manifest must exclude pnpm install-only metadata: ${relative}`);
  }

  const binaryExtensions = new Set([
    ".dll", ".exe", ".gif", ".ico", ".jpeg", ".jpg", ".node", ".png", ".ttf", ".wasm", ".woff", ".woff2",
  ]);
  const leakedBuildMarkers = [
    ".rwang-build-",
    ".dependency-install",
    "cmd-shim-target=",
    "virtualStoreDir",
    "storeDir",
  ];
  for (const entry of manifest.files) {
    if (binaryExtensions.has(path.extname(entry.path).toLowerCase())) continue;
    const stagedPath = path.resolve(runtimeRoot, ...entry.path.split("/"));
    assert.ok(stagedPath.startsWith(`${runtimeRoot}${path.sep}`), `manifest path must stay inside the staged runtime: ${entry.path}`);
    const content = await readFile(stagedPath, "utf8");
    for (const marker of leakedBuildMarkers) {
      assert.equal(content.includes(marker), false, `staged runtime leaks pnpm build metadata '${marker}' in ${entry.path}`);
    }
  }
}

await staticContract();
await dryRunContract();
await dryRunAcquireContract();
await stagedRuntimeContract();
console.log("RWANG desktop package staging contract tests passed");
