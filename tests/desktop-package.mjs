import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repositoryRoot, "scripts", "stage-desktop-runtime.ps1");
const acquireScriptPath = path.join(repositoryRoot, "scripts", "acquire-node-runtime.ps1");
const nodeRuntimeSpecPath = path.join(repositoryRoot, "scripts", "node-runtime.json");
const docsPath = path.join(repositoryRoot, "docs", "desktop-package-staging.md");
const releaseDocsPath = path.join(repositoryRoot, "docs", "desktop-release.md");
const desktopDagPath = path.join(repositoryRoot, "docs", "desktop-dag.md");
const readmePath = path.join(repositoryRoot, "README.md");
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

async function listRelativeFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listRelativeFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
    }
  }
  return files;
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

async function findPowerShellHosts() {
  if (process.platform !== "win32") return [];
  const hosts = [];
  for (const candidate of ["powershell", "pwsh"]) {
    try {
      const result = await runPowerShell(candidate, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
      if (result.code === 0) hosts.push(candidate);
    } catch {
      // Keep probing; developer machines may have only one host.
    }
  }
  if (process.env.CI) {
    assert.deepEqual(hosts, ["powershell", "pwsh"], "Windows CI must exercise both PowerShell 5.1 and PowerShell 7");
  }
  return hosts;
}

function assertOrdered(text, label, markers) {
  let previous = -1;
  for (const marker of markers) {
    const index = text.indexOf(marker, previous + 1);
    assert.ok(index > previous, `${label} must contain ${marker} after the preceding gate`);
    previous = index;
  }
}

async function staticContract() {
  const [script, docs, releaseDocs, desktopDag, readme, acquireScript, nodeRuntimeSpecText, desktopWorkflow] = await Promise.all([
    readFile(scriptPath, "utf8"),
    readFile(docsPath, "utf8"),
    readFile(releaseDocsPath, "utf8"),
    readFile(desktopDagPath, "utf8"),
    readFile(readmePath, "utf8"),
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
  assert.match(script, /forbidden \.env secret file/);
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
  assert.match(script, /function Get-Sha256Hex/);
  assert.match(script, /\[Security\.Cryptography\.SHA256\]::Create\(\)/);
  assert.doesNotMatch(script, /Get-FileHash/);
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
  assert.match(docs, /pnpm --config\.enable-global-virtual-store=false install --prod --frozen-lockfile --ignore-scripts --node-linker=hoisted/);
  assert.match(docs, /rwang\/runtime\/node\/node\.exe/);
  assert.match(docs, /resources/);
  assert.match(docs, /junctions?\/symlinks|external junction/i);
  assert.match(docs, /desktop:stage/);
  assert.match(docs, /desktop:runtime/);
  assert.match(docs, /v24\.20\.0/);
  for (const document of [docs, releaseDocs, desktopDag]) {
    assert.match(document, /^---\r?\nversion: "\d+\.\d+\.\d+b"/);
    assert.match(document, /\ncreated_at: ".+,[^,]+,[0-9a-f]{40}"/);
    assert.match(document, /\nlast_update: ".+,[^,]+"/);
    assert.match(document, /\nstatus: "beta"/);
    assert.match(document, /\n## CHANGELOG\r?\n/);
  }
  assert.match(acquireScript, /Invoke-WebRequest/);
  assert.match(acquireScript, /Expand-Archive/);
  assert.match(acquireScript, /function Get-Sha256Hex/);
  assert.match(acquireScript, /\[Security\.Cryptography\.SHA256\]::Create\(\)/);
  assert.doesNotMatch(acquireScript, /Get-FileHash/);
  assert.match(acquireScript, /LICENSE/);
  const nodeRuntimeSpec = JSON.parse(nodeRuntimeSpecText);
  assert.equal(nodeRuntimeSpec.version, "v24.20.0");
  assert.equal(nodeRuntimeSpec.platform, "win-x64");
  assert.match(nodeRuntimeSpec.url, /^https:\/\/nodejs\.org\/dist\/v24\.20\.0\//);
  assert.match(nodeRuntimeSpec.shasumsUrl, /^https:\/\/nodejs\.org\/dist\/v24\.20\.0\/SHASUMS256\.txt$/);
  assert.match(nodeRuntimeSpec.archiveSha256, /^[0-9a-f]{64}$/);
  assert.match(nodeRuntimeSpec.nodeSha256, /^[0-9a-f]{64}$/);

  assert.doesNotMatch(desktopWorkflow, /Get-FileHash/);
  assert.doesNotMatch(desktopWorkflow, /sbom|placeholder/i);
  const directPwshStageCalls = desktopWorkflow.match(/shell: pwsh\s+run: \.\\scripts\\stage-desktop-runtime\.ps1 -ReplaceExisting/g) ?? [];
  assert.equal(directPwshStageCalls.length, 2, "both CI jobs must stage directly in explicit pwsh steps");

  const ciJob = desktopWorkflow.split(/\n  desktop-ci:\s*\n/)[1]?.split(/\n  desktop-release:\s*\n/)[0];
  const releaseJob = desktopWorkflow.split(/\n  desktop-release:\s*\n/)[1];
  assert.ok(ciJob, "desktop workflow must define the CI job");
  assert.ok(releaseJob, "desktop workflow must define the release job");
  const canonicalPrefix = [
    "pnpm install --frozen-lockfile",
    "pnpm check",
    ".\\scripts\\acquire-node-runtime.ps1 -ReplaceExisting",
    ".\\scripts\\stage-desktop-runtime.ps1 -ReplaceExisting",
    "pnpm test:security",
    "pnpm test:desktop-package",
    "pnpm test:model-selector-layout",
    "pnpm test:desktop-contract",
    "git diff --check",
    "cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check",
    "cargo check --manifest-path src-tauri/Cargo.toml",
    "cargo test --manifest-path src-tauri/Cargo.toml",
  ];
  assertOrdered(ciJob, "desktop CI job", [...canonicalPrefix, "pnpm exec tauri build --no-bundle"]);
  assertOrdered(releaseJob, "desktop release job", [...canonicalPrefix, "pnpm exec tauri build --bundles nsis"]);
  assert.match(releaseJob, /-Filter "RWANG_\*_x64-setup\.exe"/);
  assert.match(releaseJob, /\$nsisFiles\.Count -ne 1/);
  assert.match(releaseJob, /\$copiedHash -ne \$sourceHash/);
  assert.match(releaseJob, /\$recordedChecksum -ne \$checksumLine/);

  const readmeRuntimeIndex = readme.indexOf("pnpm desktop:runtime");
  const readmeStageIndex = readme.indexOf("pnpm desktop:stage", readmeRuntimeIndex);
  const readmeSecurityIndex = readme.indexOf("pnpm test:security", readmeStageIndex);
  const readmeContractIndex = readme.indexOf("pnpm test:desktop-contract", readmeStageIndex);
  assert.ok(readmeRuntimeIndex >= 0 && readmeRuntimeIndex < readmeStageIndex,
    "README must acquire the pinned runtime before staging");
  assert.ok(readmeStageIndex < readmeSecurityIndex && readmeSecurityIndex < readmeContractIndex,
    "README must run security and desktop contracts after staging");
  assertOrdered(readme.slice(readmeRuntimeIndex), "README desktop gate", [
    "pnpm desktop:runtime",
    "pnpm desktop:stage",
    "pnpm test:security",
    "pnpm test:desktop-package",
    "pnpm test:model-selector-layout",
    "pnpm test:desktop-contract",
    "git diff --check",
    "cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check",
    "cargo check --manifest-path src-tauri/Cargo.toml",
    "cargo test --manifest-path src-tauri/Cargo.toml",
    "pnpm exec tauri build --no-bundle",
  ]);
  assert.match(releaseDocs, /RWANG_\*_x64-setup\.exe/);
  assert.doesNotMatch(releaseDocs, /sbom|placeholder/i);
  assert.match(desktopDag, /%LOCALAPPDATA%\\com\.freshair129\.rwang\\data/);
  assert.doesNotMatch(desktopDag, /%APPDATA%\\RWANG/);
  assert.match(desktopDag, /manual.*Windows 11/i);
  assert.match(desktopDag, /manual.*Windows 10/i);
}

async function dryRunContract() {
  const powershellHosts = await findPowerShellHosts();
  if (powershellHosts.length === 0) {
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
    for (const powershell of powershellHosts) {
      const result = await runPowerShell(powershell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", scriptPath, "-DryRun", "-NodePath", process.execPath,
        "-NodeLicensePath", licensePath, "-NodeSha256", nodeSha256,
      ]);
      assert.equal(result.code, 0, `${powershell} staging dry-run failed:\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /DRY RUN: no files were written under desktop\/stage/);
      assert.equal(await exists(runtimeRoot), beforeStage, `${powershell} dry-run must not create runtime output`);
      if (beforeStage) {
        const afterStageStat = await stat(runtimeRoot);
        assert.equal(afterStageStat.mtimeMs, beforeStageStat.mtimeMs, `${powershell} dry-run must not mutate existing output`);
      }

      const mismatch = await runPowerShell(powershell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", scriptPath, "-DryRun", "-NodePath", process.execPath,
        "-NodeLicensePath", licensePath, "-NodeSha256", "0".repeat(64),
      ]);
      assert.notEqual(mismatch.code, 0, `${powershell} staging dry-run must fail closed on a SHA-256 mismatch`);
      assert.match(`${mismatch.stdout}\n${mismatch.stderr}`, /SHA-256\s+mismatch/);
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function dryRunAcquireContract() {
  const powershellHosts = await findPowerShellHosts();
  for (const powershell of powershellHosts) {
    const result = await runPowerShell(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", acquireScriptPath, "-DryRun",
    ]);
    assert.equal(result.code, 0, `${powershell} Node runtime dry-run failed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /DRY RUN: no download or runtime files were written/);
  }
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
  const secretEnvironmentPattern = /(^|\/)\.env(?:\.|$)/i;
  const stagedFiles = await listRelativeFiles(runtimeRoot);
  for (const relative of stagedFiles) {
    assert.equal(secretEnvironmentPattern.test(relative), false,
      `staged source must exclude .env secret files: ${relative}`);
  }
  for (const { path: relative } of manifest.files) {
    assert.equal(secretEnvironmentPattern.test(relative), false,
      `runtime manifest must exclude .env secret files: ${relative}`);
  }
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
