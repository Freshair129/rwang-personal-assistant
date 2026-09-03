import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DOCUMENT_INTELLIGENCE_VERSION = "1.3.0";

const MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CAPABILITY_RELATIVE_PATH = path.join("capabilities", "rwang-document-intelligence");
const MAX_PLAYBOOK_BYTES = 128 * 1024;
const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const PROCESS_TIMEOUT_MS = 30_000;
const MAX_FINDINGS = 500;
const MAX_ANNOTATIONS = 2_000;
const MAX_TRAVERSAL_ENTRIES = 100_000;
const SCAN_SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".pnpm-store",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "venv",
]);

const PINNED_SOURCE = Object.freeze({
  sourceUrl: "https://github.com/Freshair129/rwang-plugin.git",
  version: DOCUMENT_INTELLIGENCE_VERSION,
  tag: "v1.3.0",
  commit: "7354738094432fed22d6e00568315e1a1bd8fe15",
  artifactName: "rwang-codex-plugin-v1.3.0.zip",
  artifactSha256: "4225e902d65ebffe9e9af945376c9b6b459f7bccc4c67a04dc80a6ad01d13432",
  excluded: Object.freeze(["hooks/", "scripts/bump-version.ps1"]),
  normalization: Object.freeze(["line-endings-per-project-gitattributes", "trim-trailing-whitespace"]),
  adaptations: Object.freeze([
    "scripts/scan-annotations.ps1: bounded enumeration skips ignored directories and reparse points before recursion",
  ]),
});

const RUNTIME_FILE_SHA256 = Object.freeze({
  "SOURCE.json": "3d36f4d0ec50aabaab003e36c136fb816a31bf94a6b9d1101f43784330549506",
  ".codex-plugin/plugin.json": "5785bb48f9be98902e281f1c3ccf7f8dd3d7a030eac926659358f4fa24a21f45",
  "references/execution-modes/zuri-v2.catalog.json": "96f0719b93a9f7addbbc101b0e14f4025cf03788b54387b454f29a60d3675273",
  "scripts/scan-annotations.ps1": "e1d6904f3cc5043098896749de1a43a023b1590f00a3f2e43eed8f9934a5ea2c",
  "scripts/validate-graph.ps1": "4ca070f89d45bf74518670db366e97c0f6ef952350de648e6debd841b4d36efc",
  "scripts/validate-plan.ps1": "c303935b9aa000e9a8dcbf7e5bc6d91c46af2b9417e76124ebd7438845e9ecd4",
  "skills/doc-architect/SKILL.md": "432a04564efc87fc421e110589b33b83a4e762bd5524c173deb389070f452ec0",
  "skills/doc-preflight/SKILL.md": "c76b7741f422582b383d66e555c65d423dc462a7afca987a8b72f33d1d7691ed",
  "skills/doc-graph/SKILL.md": "00c22e03452d201866d8f70585a65eaffdadf617e13d8a68ae1dc5387e3fa8a9",
  "skills/implementation-plan/SKILL.md": "840dc8998e9c400fa9050f49396704d028c539647a4a2ccfe87e275e22bac0c3",
  "skills/exec-plan/SKILL.md": "89237299473d1c7c47eb84b55267cbab3f131ef72df20da7a3fa4204b32aaa05",
  "skills/subagent-driven/SKILL.md": "b859149cf09e3e146a33e919fb4bd4e8496a2bdf00a22e27ef3c57abbab6825b",
  "skills/rwang-self-audit/SKILL.md": "955de77a2884fa84c46e255798b78912f3c24541bfb59249de362083310dab7b",
});

const HOST_POLICY = Object.freeze({
  adapterActions: "read-only",
  playbooks: "proposal-only",
  graphWriter: "doc-graph-only",
  scannedRepositoryContent: "untrusted-data",
  autoWrite: false,
  autoSubagentExecution: false,
});

const SKILL_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "doc-architect",
    name: "Document Architect",
    description: "Analyze project signals and design an appropriate governed documentation structure.",
    mode: "guided",
    core: true,
  }),
  Object.freeze({
    id: "doc-preflight",
    name: "Document Preflight",
    description: "Audit documentation health, coverage, consistency, and traceability before a release or change.",
    mode: "guided",
    core: true,
  }),
  Object.freeze({
    id: "doc-graph",
    name: "Document Graph",
    description: "Model governed relationships between requirements, documents, tests, diagrams, and code.",
    mode: "guided",
    core: true,
  }),
  Object.freeze({
    id: "implementation-plan",
    name: "Implementation Plan",
    description: "Derive a phased implementation roadmap from verified project documentation.",
    mode: "guided",
    core: true,
  }),
  Object.freeze({
    id: "exec-plan",
    name: "Executable Plan",
    description: "Compose and validate a typed PlanEnvelope against the pinned execution-mode catalog.",
    mode: "guided",
    core: true,
  }),
  Object.freeze({
    id: "subagent-driven",
    name: "Subagent-Driven Documentation",
    description: "Coordinate multi-step documentation work with isolated tasks and explicit review gates.",
    mode: "orchestrated",
    core: true,
  }),
  Object.freeze({
    id: "rwang-self-audit",
    name: "RWANG Self Audit",
    description: "Run an explicit read-only audit of annotations and document-graph availability.",
    mode: "read-only",
    core: true,
  }),
]);

const EXPECTED_SKILL_IDS = Object.freeze(SKILL_DEFINITIONS.map(({ id }) => id).sort());
const EXPECTED_EXECUTION_MODES = Object.freeze([
  "SOFTWARE_SPRINT",
  "DATA_MIGRATION",
  "B2B_SALES",
  "B2C_CAMPAIGN",
  "PRODUCT_LAUNCH",
  "OPERATIONS",
  "BUSINESS_EXPANSION",
].sort());

const OPERATION_DESCRIPTORS = Object.freeze([
  Object.freeze({ id: "scan-annotations", name: "Scan annotations", readOnly: true, localOnly: true }),
  Object.freeze({ id: "validate-graph", name: "Validate document graph", readOnly: true, localOnly: true }),
  Object.freeze({ id: "validate-plan", name: "Validate executable plan", readOnly: true, localOnly: true }),
  Object.freeze({ id: "self-audit", name: "Run self audit", readOnly: true, localOnly: true }),
]);

const FIXED_PARSER_COMMAND = `& { param([string]$ScriptPath) ${[
  "$tokens = $null",
  "$parseErrors = $null",
  "[void][System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$tokens, [ref]$parseErrors)",
  "$findings = @($parseErrors | ForEach-Object { [ordered]@{ code = 'PS-PARSE'; message = $_.Message } })",
  "$result = [ordered]@{ ok = ($parseErrors.Count -eq 0); finding_count = $parseErrors.Count; findings = $findings }",
  "$result | ConvertTo-Json -Depth 4 -Compress",
  "if ($parseErrors.Count -gt 0) { exit 1 }",
].join("; ")} }`;

export class DocumentIntelligenceError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = "DocumentIntelligenceError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function failIntegrity(message) {
  throw new DocumentIntelligenceError(
    "DOCUMENT_INTELLIGENCE_INTEGRITY",
    `Document Intelligence pack failed integrity validation: ${message}`,
    503,
  );
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function compareStringLists(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertRegularVendoredFile(capabilityRoot, relativePath, maxBytes = Number.MAX_SAFE_INTEGER) {
  const requested = path.join(capabilityRoot, relativePath);
  let actual;
  try {
    const linkInfo = lstatSync(requested);
    if (linkInfo.isSymbolicLink()) failIntegrity(`${relativePath} must not be a symbolic link`);
    actual = realpathSync.native(requested);
    const info = statSync(actual);
    if (!info.isFile()) failIntegrity(`${relativePath} is not a regular file`);
    if (info.size > maxBytes) failIntegrity(`${relativePath} exceeds its size limit`);
  } catch (error) {
    if (error instanceof DocumentIntelligenceError) throw error;
    failIntegrity(`${relativePath} is missing or unreadable`);
  }
  if (!isContained(capabilityRoot, actual)) failIntegrity(`${relativePath} escapes the vendored pack`);
  const normalizedRelativePath = relativePath.replaceAll("\\", "/");
  const expectedSha256 = RUNTIME_FILE_SHA256[normalizedRelativePath];
  if (expectedSha256) {
    const contents = readFileSync(actual);
    const digestInput = normalizedRelativePath.endsWith(".ps1")
      ? Buffer.from(contents.toString("utf8").replace(/\r\n?/g, "\n"), "utf8")
      : contents;
    const actualSha256 = createHash("sha256").update(digestInput).digest("hex");
    if (actualSha256 !== expectedSha256) failIntegrity(`${relativePath} does not match its pinned SHA-256`);
  }
  return actual;
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    failIntegrity(`${label} is not valid JSON`);
  }
}

function validateSourceMetadata(source) {
  const expected = PINNED_SOURCE;
  const excluded = Array.isArray(source.excluded) ? [...source.excluded].sort() : [];
  const normalization = Array.isArray(source.normalization) ? [...source.normalization].sort() : [];
  const adaptations = Array.isArray(source.adaptations) ? [...source.adaptations].sort() : [];
  if (
    source.sourceUrl !== expected.sourceUrl
    || source.version !== expected.version
    || source.tag !== expected.tag
    || source.commit !== expected.commit
    || source.artifact?.name !== expected.artifactName
    || source.artifact?.sha256 !== expected.artifactSha256
    || !compareStringLists(excluded, [...expected.excluded].sort())
    || !compareStringLists(normalization, [...expected.normalization].sort())
    || !compareStringLists(adaptations, [...expected.adaptations].sort())
  ) {
    failIntegrity("SOURCE.json does not match the pinned v1.3.0 release");
  }
}

function parseSkillFile(contents, expectedId) {
  const normalized = contents.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) failIntegrity(`${expectedId}/SKILL.md has no frontmatter`);
  const frontmatterEnd = normalized.indexOf("\n---\n", 4);
  if (frontmatterEnd < 0) failIntegrity(`${expectedId}/SKILL.md has invalid frontmatter`);
  const frontmatter = normalized.slice(4, frontmatterEnd);
  const fields = {};
  for (const line of frontmatter.split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (match) fields[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  if (fields.name !== expectedId) failIntegrity(`${expectedId}/SKILL.md declares a different skill name`);
  if (!fields.description || fields.description.length > 4_000) {
    failIntegrity(`${expectedId}/SKILL.md has no bounded description`);
  }
  return {
    upstreamDescription: fields.description,
    upstreamVersion: fields.version || null,
    body: normalized.slice(frontmatterEnd + 5),
  };
}

function sanitizeText(value, roots = [], maxLength = 8_000) {
  let text = String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  for (const root of roots.filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const variant of new Set([root, root.replaceAll("\\", "/"), root.replaceAll("/", "\\")])) {
      text = text.replace(new RegExp(escapeRegExp(variant), "gi"), ".");
    }
  }
  text = text
    .replace(/\\\\[?.]\\[^\s"'<>|)]+/g, "<absolute-path>")
    .replace(/\\\\[^\\\s"'<>|)]+\\[^\s"'<>|)]+/g, "<absolute-path>")
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>|)]+/g, "<absolute-path>");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function assertContainedTraversal(rootDir, startPath, { skipDirectories = new Set() } = {}) {
  if (!existsSync(startPath)) return;
  const stack = [startPath];
  let entryCount = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      throw new DocumentIntelligenceError("UNSAFE_REPOSITORY_PATH", "Repository traversal could not be bounded safely.", 409);
    }
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_TRAVERSAL_ENTRIES) {
        throw new DocumentIntelligenceError("REPOSITORY_SCAN_LIMIT", "Repository exceeds the bounded scan entry limit.", 413);
      }
      const entryPath = path.join(current, entry.name);
      let info;
      try {
        info = lstatSync(entryPath);
        if (info.isSymbolicLink()) {
          const target = realpathSync.native(entryPath);
          if (!isContained(rootDir, target)) {
            throw new DocumentIntelligenceError("UNSAFE_REPOSITORY_PATH", "Repository contains a link outside the application root.", 409);
          }
          continue;
        }
      } catch (error) {
        if (error instanceof DocumentIntelligenceError) throw error;
        throw new DocumentIntelligenceError("UNSAFE_REPOSITORY_PATH", "Repository contains an unreadable or unstable path.", 409);
      }
      if (info.isDirectory() && !skipDirectories.has(entry.name.toLowerCase())) stack.push(entryPath);
    }
  }
}

function assertContainedFixedInput(rootDir, relativePath) {
  const requested = path.join(rootDir, relativePath);
  if (!existsSync(requested)) return;
  try {
    const actual = realpathSync.native(requested);
    if (!isContained(rootDir, actual) || !statSync(actual).isFile()) {
      throw new Error("outside root");
    }
  } catch {
    throw new DocumentIntelligenceError("UNSAFE_REPOSITORY_PATH", "Repository input escapes the application root.", 409);
  }
}

function sanitizePlaybookMarkdown(body, roots) {
  const safeLines = [];
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (/drift-check(?:\.ps1)?|PostToolUse|bump-version\.ps1|hooks[\\/]hooks\.json/i.test(line)) continue;
    safeLines.push(line);
  }
  return sanitizeText(safeLines.join("\n"), roots, MAX_PLAYBOOK_BYTES)
    .replace(/<\/?(?:script|iframe|object|embed|style)\b[^>]*>/gi, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(?:javascript|data|file):/gi, "blocked:");
}

function boundedStringArray(value, maxItems = 100) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => sanitizeText(item, [], 160));
}

function sanitizeCatalog(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.modes)) {
    failIntegrity("execution-mode catalog has an invalid shape");
  }
  const modeNames = raw.modes.map((mode) => mode?.executionMode).sort();
  if (!compareStringLists(modeNames, [...EXPECTED_EXECUTION_MODES])) {
    failIntegrity("execution-mode catalog does not contain the expected seven modes");
  }
  const modes = raw.modes.map((mode) => ({
    executionMode: sanitizeText(mode.executionMode, [], 80),
    executionModeId: sanitizeText(mode.executionModeId, [], 120),
    executionContractId: sanitizeText(mode.executionContractId, [], 120),
    contractVersion: sanitizeText(mode.contractVersion, [], 32),
    progressStrategy: sanitizeText(mode.progressStrategy, [], 80),
    containerSubtypes: boundedStringArray(mode.containerSubtypes, 32),
    itemSubtypes: boundedStringArray(mode.itemSubtypes, 32),
    metricKeys: boundedStringArray(mode.metricKeys, 64),
  }));
  return {
    id: sanitizeText(raw.catalog_id, [], 80),
    description: sanitizeText(raw.description, [], 1_000),
    envelope: {
      schemaVersions: boundedStringArray(raw.envelope?.schema_versions, 16),
      preferredSchemaVersion: sanitizeText(raw.envelope?.preferred_schema_version, [], 32),
      dependencyTypes: boundedStringArray(raw.envelope?.dependency_types, 32),
    },
    modes,
  };
}

function resolvePowerShellExecutable() {
  if (process.platform !== "win32") return null;
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot) || /^(?:\\\\|\\\\[?.]\\)/.test(systemRoot)) {
    throw new DocumentIntelligenceError("POWERSHELL_UNAVAILABLE", "Windows PowerShell is unavailable.", 503);
  }
  const root = realpathSync.native(systemRoot);
  const executable = realpathSync.native(path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  if (!isContained(root, executable) || !statSync(executable).isFile()) {
    throw new DocumentIntelligenceError("POWERSHELL_UNAVAILABLE", "Windows PowerShell is unavailable.", 503);
  }
  return { executable, systemRoot: root };
}

function minimalPowerShellEnvironment(systemRoot) {
  const environment = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    POWERSHELL_TELEMETRY_OPTOUT: "1",
  };
  for (const name of ["TEMP", "TMP"]) {
    const value = process.env[name];
    if (value && path.win32.isAbsolute(value) && !/^(?:\\\\|\\\\[?.]\\)/.test(value)) environment[name] = value;
  }
  return environment;
}

function runBoundedProcess({ executable, args, cwd, env, onSpawn = () => {}, onFinish = () => {} }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    let limitExceeded = false;
    let timedOut = false;
    let settled = false;
    let fallbackTimer;

    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    onSpawn(child);

    const capture = (chunks, chunk, used, maximum) => {
      const remaining = Math.max(0, maximum - used);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return used + chunk.length;
    };

    child.stdout.on("data", (chunk) => {
      stdoutBytes = capture(stdout, chunk, stdoutBytes, MAX_STDOUT_BYTES);
      if (stdoutBytes > MAX_STDOUT_BYTES && !limitExceeded) {
        limitExceeded = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = capture(stderr, chunk, stderrBytes, MAX_STDERR_BYTES);
      if (stderrBytes > MAX_STDERR_BYTES && !limitExceeded) {
        limitExceeded = true;
        child.kill();
      }
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      fallbackTimer = setTimeout(() => finish(null, null), 1_000);
      fallbackTimer.unref?.();
    }, PROCESS_TIMEOUT_MS);
    timeout.unref?.();

    function finish(exitCode, spawnError) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(fallbackTimer);
      onFinish(child);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8").replace(/^\uFEFF/, ""),
        stderr: Buffer.concat(stderr).toString("utf8").replace(/^\uFEFF/, ""),
        durationMs: Date.now() - startedAt,
        timedOut,
        limitExceeded,
        spawnError,
      });
    }

    child.once("error", (error) => finish(null, error));
    child.once("close", (code) => finish(code, null));
  });
}

function parseJsonOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isNonNegativeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateParsedOutput(operation, parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  if (operation === "scan-annotations") {
    return parsed.generated_by === "rwang:scan-annotations"
      && parsed.summary && typeof parsed.summary === "object"
      && Array.isArray(parsed.annotations)
      && isNonNegativeFiniteNumber(parsed.summary.files_scanned)
      && isNonNegativeFiniteNumber(parsed.summary.total_annotations);
  }
  if (operation === "parse-scanner") {
    return typeof parsed.ok === "boolean"
      && isNonNegativeFiniteNumber(parsed.finding_count)
      && Array.isArray(parsed.findings);
  }
  const expectedGenerator = operation === "validate-plan" ? "rwang:validate-plan" : "rwang:validate-graph";
  return parsed.generated_by === expectedGenerator
    && typeof parsed.ok === "boolean"
    && isNonNegativeFiniteNumber(parsed.finding_count)
    && Array.isArray(parsed.findings);
}

function safeRelativeReportPath(value) {
  const text = String(value ?? "").replaceAll("\\", "/");
  if (!text || text.startsWith("/") || /^[A-Za-z]:/.test(text) || text.split("/").includes("..")) return "<redacted>";
  return sanitizeText(text, [], 500);
}

function sanitizeFinding(finding, roots) {
  return {
    code: sanitizeText(finding?.code || "FINDING", [], 80),
    message: sanitizeText(finding?.message || "A validation finding was reported.", roots, 2_000),
  };
}

function sanitizeReport(operation, parsed, roots) {
  if (!parsed || typeof parsed !== "object") return null;
  if (operation === "scan-annotations") {
    const annotations = Array.isArray(parsed.annotations)
      ? parsed.annotations.slice(0, MAX_ANNOTATIONS).map((annotation) => ({
        file: safeRelativeReportPath(annotation?.file),
        line: Math.max(0, Number(annotation?.line) || 0),
        type: sanitizeText(annotation?.type, [], 40),
        annotation: sanitizeText(annotation?.annotation, [], 80),
        ids: boundedStringArray(annotation?.ids, 100),
      }))
      : [];
    return {
      generatedBy: "rwang:scan-annotations",
      generatedAt: sanitizeText(parsed.generated_at, [], 64),
      summary: {
        filesScanned: Math.max(0, Number(parsed.summary?.files_scanned) || 0),
        filesWithRefs: Math.max(0, Number(parsed.summary?.files_with_refs) || 0),
        structuredCount: Math.max(0, Number(parsed.summary?.structured_count) || 0),
        unstructuredCount: Math.max(0, Number(parsed.summary?.unstructured_count) || 0),
        totalAnnotations: Math.max(0, Number(parsed.summary?.total_annotations) || 0),
        uniqueRequirementCount: Math.max(0, Number(parsed.summary?.unique_req_ids) || 0),
        uniqueIds: boundedStringArray(parsed.summary?.unique_ids, 2_000),
      },
      annotations,
      truncated: Array.isArray(parsed.annotations) && parsed.annotations.length > MAX_ANNOTATIONS,
    };
  }
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.slice(0, MAX_FINDINGS).map((finding) => sanitizeFinding(finding, roots))
    : [];
  return {
    generatedBy: operation === "validate-plan" ? "rwang:validate-plan" : operation === "validate-graph" ? "rwang:validate-graph" : "powershell:parse",
    ok: parsed.ok === true,
    findingCount: Math.max(findings.length, Number(parsed.finding_count) || 0),
    findings,
    truncated: Array.isArray(parsed.findings) && parsed.findings.length > MAX_FINDINGS,
  };
}

function operationResult(operation, processResult, roots) {
  const parsed = parseJsonOutput(processResult.stdout);
  const report = validateParsedOutput(operation, parsed) ? sanitizeReport(operation, parsed, roots) : null;
  let status = "failed";
  if (processResult.timedOut) status = "timed-out";
  else if (processResult.limitExceeded) status = "output-limit";
  else if (
    processResult.exitCode === 0
    && report
    && (operation === "scan-annotations" || (report.ok === true && report.findingCount === 0))
  ) status = "passed";
  else if (processResult.exitCode === 1 && report?.ok === false && report.findingCount > 0) status = "findings";
  else if (processResult.spawnError?.code === "ENOENT") status = "unavailable";
  const diagnostics = sanitizeText(
    processResult.spawnError?.message || processResult.stderr || (!parsed ? processResult.stdout : ""),
    roots,
    8_000,
  ).trim();
  return {
    operation,
    readOnly: true,
    ok: status === "passed" && report?.ok !== false,
    status,
    exitCode: Number.isInteger(processResult.exitCode) ? processResult.exitCode : null,
    durationMs: processResult.durationMs,
    report,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function validateRelativePlanPath(rootDir, relativePlanPath) {
  if (typeof relativePlanPath !== "string" || !relativePlanPath || relativePlanPath.length > 512) {
    throw new DocumentIntelligenceError("INVALID_PLAN_PATH", "Plan path must be a bounded relative JSON path.");
  }
  if (relativePlanPath !== relativePlanPath.trim() || /[\u0000-\u001F\u007F]/.test(relativePlanPath)) {
    throw new DocumentIntelligenceError("INVALID_PLAN_PATH", "Plan path contains invalid characters.");
  }
  if (
    path.isAbsolute(relativePlanPath)
    || path.win32.isAbsolute(relativePlanPath)
    || path.posix.isAbsolute(relativePlanPath)
    || /^(?:\\\\|\/\/|\\\\[?.]\\)/.test(relativePlanPath)
  ) {
    throw new DocumentIntelligenceError("INVALID_PLAN_PATH", "Plan path must remain inside the application root.");
  }
  const segments = relativePlanPath.replaceAll("\\", "/").split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === ".." || /[<>:"|?*]/.test(segment) || /[. ]$/.test(segment))
    || path.extname(segments.at(-1)).toLowerCase() !== ".json"
  ) {
    throw new DocumentIntelligenceError("INVALID_PLAN_PATH", "Plan path must be a direct relative JSON path without traversal.");
  }
  const requested = path.join(rootDir, ...segments);
  let actual;
  let info;
  try {
    actual = realpathSync.native(requested);
    info = statSync(actual);
  } catch {
    throw new DocumentIntelligenceError("PLAN_NOT_FOUND", "The requested plan JSON does not exist.", 404);
  }
  if (!isContained(rootDir, actual)) {
    throw new DocumentIntelligenceError("INVALID_PLAN_PATH", "Plan path escapes the application root.");
  }
  if (!info.isFile() || info.size > MAX_PLAN_BYTES) {
    throw new DocumentIntelligenceError("INVALID_PLAN", "Plan must be a regular JSON file within the size limit.");
  }
  try {
    const parsed = JSON.parse(readFileSync(actual, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  } catch {
    throw new DocumentIntelligenceError("INVALID_PLAN", "Plan file must contain a JSON object.");
  }
  return actual;
}

function fixedArtifactAvailable(rootDir, relativePath) {
  const requested = path.join(rootDir, relativePath);
  if (!existsSync(requested)) return false;
  try {
    const actual = realpathSync.native(requested);
    return isContained(rootDir, actual) && statSync(actual).isFile();
  } catch {
    return false;
  }
}

export function createDocumentIntelligence({ rootDir = MODULE_ROOT, capabilityDir } = {}) {
  if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) {
    throw new DocumentIntelligenceError("INVALID_ROOT", "Document Intelligence requires an absolute application root.");
  }
  let applicationRoot;
  try {
    applicationRoot = realpathSync.native(rootDir);
  } catch {
    throw new DocumentIntelligenceError("INVALID_ROOT", "Document Intelligence application root is unavailable.");
  }
  if (!statSync(applicationRoot).isDirectory()) {
    throw new DocumentIntelligenceError("INVALID_ROOT", "Document Intelligence application root is not a directory.");
  }

  let capabilityRoot;
  if (capabilityDir == null) {
    const moduleRoot = realpathSync.native(MODULE_ROOT);
    capabilityRoot = realpathSync.native(path.join(moduleRoot, CAPABILITY_RELATIVE_PATH));
    if (!isContained(moduleRoot, capabilityRoot)) failIntegrity("default capability directory escapes the RWANG module root");
  } else {
    if (typeof capabilityDir !== "string" || !path.isAbsolute(capabilityDir)) {
      throw new DocumentIntelligenceError("INVALID_CAPABILITY_ROOT", "Capability directory must be an absolute canonical path.");
    }
    try {
      capabilityRoot = realpathSync.native(capabilityDir);
    } catch {
      throw new DocumentIntelligenceError("INVALID_CAPABILITY_ROOT", "Capability directory is unavailable.");
    }
  }
  if (!statSync(capabilityRoot).isDirectory()) {
    throw new DocumentIntelligenceError("INVALID_CAPABILITY_ROOT", "Capability directory is not a directory.");
  }

  const sourcePath = assertRegularVendoredFile(capabilityRoot, "SOURCE.json", 32 * 1024);
  const manifestPath = assertRegularVendoredFile(capabilityRoot, path.join(".codex-plugin", "plugin.json"), 64 * 1024);
  const catalogPath = assertRegularVendoredFile(
    capabilityRoot,
    path.join("references", "execution-modes", "zuri-v2.catalog.json"),
    512 * 1024,
  );
  const scripts = Object.freeze({
    scan: assertRegularVendoredFile(capabilityRoot, path.join("scripts", "scan-annotations.ps1"), 512 * 1024),
    validateGraph: assertRegularVendoredFile(capabilityRoot, path.join("scripts", "validate-graph.ps1"), 1024 * 1024),
    validatePlan: assertRegularVendoredFile(capabilityRoot, path.join("scripts", "validate-plan.ps1"), 512 * 1024),
  });

  const source = readJsonFile(sourcePath, "SOURCE.json");
  validateSourceMetadata(source);
  for (const excludedPath of PINNED_SOURCE.excluded) {
    if (existsSync(path.join(capabilityRoot, excludedPath))) {
      failIntegrity(`excluded upstream surface is present: ${excludedPath}`);
    }
  }
  const manifest = readJsonFile(manifestPath, ".codex-plugin/plugin.json");
  if (manifest.name !== "rwang-plugin" || manifest.version !== DOCUMENT_INTELLIGENCE_VERSION || manifest.skills !== "./skills") {
    failIntegrity("Codex manifest does not match the pinned adapter");
  }

  const skillsRoot = realpathSync.native(path.join(capabilityRoot, "skills"));
  const actualSkillIds = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (!compareStringLists(actualSkillIds, [...EXPECTED_SKILL_IDS])) {
    failIntegrity("skills directory does not match the seven-skill allowlist");
  }

  const playbooks = new Map();
  for (const descriptor of SKILL_DEFINITIONS) {
    const skillPath = assertRegularVendoredFile(
      capabilityRoot,
      path.join("skills", descriptor.id, "SKILL.md"),
      MAX_PLAYBOOK_BYTES,
    );
    const parsed = parseSkillFile(readFileSync(skillPath, "utf8"), descriptor.id);
    playbooks.set(descriptor.id, Object.freeze({
      ...descriptor,
      upstreamVersion: parsed.upstreamVersion,
      hostPolicy: HOST_POLICY,
      playbook: sanitizePlaybookMarkdown(parsed.body, [applicationRoot, capabilityRoot]),
    }));
  }

  const catalog = deepFreeze(sanitizeCatalog(readJsonFile(catalogPath, "execution-mode catalog")));
  const publicSkills = Object.freeze(SKILL_DEFINITIONS.map((skill) => Object.freeze({ ...skill })));
  const activeProcesses = new Set();
  let closed = false;

  function ensureOpen() {
    if (closed) throw new DocumentIntelligenceError("CAPABILITY_CLOSED", "Document Intelligence is closed.", 503);
  }

  async function runFixedAction(operation, actionArguments) {
    ensureOpen();
    for (const relativePath of Object.keys(RUNTIME_FILE_SHA256)) {
      assertRegularVendoredFile(capabilityRoot, relativePath);
    }
    const powershell = resolvePowerShellExecutable();
    if (!powershell) {
      return {
        operation,
        readOnly: true,
        ok: false,
        status: "unsupported",
        exitCode: null,
        durationMs: 0,
        report: null,
        diagnostics: "Document Intelligence validators currently require Windows PowerShell.",
      };
    }
    const result = await runBoundedProcess({
      executable: powershell.executable,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...actionArguments],
      cwd: applicationRoot,
      env: minimalPowerShellEnvironment(powershell.systemRoot),
      onSpawn: (child) => activeProcesses.add(child),
      onFinish: (child) => activeProcesses.delete(child),
    });
    return operationResult(operation, result, [applicationRoot, capabilityRoot]);
  }

  async function scanAnnotations({ tracePhases = false } = {}) {
    assertContainedTraversal(applicationRoot, applicationRoot, { skipDirectories: SCAN_SKIPPED_DIRECTORIES });
    return runFixedAction("scan-annotations", [
      "-File", scripts.scan, "-Path", applicationRoot, "-Format", "json",
      ...(tracePhases ? ["-TracePhases"] : []),
    ]);
  }

  async function validateGraph() {
    assertContainedTraversal(applicationRoot, path.join(applicationRoot, "docs"));
    assertContainedFixedInput(applicationRoot, "discovery.json");
    assertContainedFixedInput(applicationRoot, "traceability.json");
    return runFixedAction("validate-graph", ["-File", scripts.validateGraph, "-Root", applicationRoot, "-Mode", "validate"]);
  }

  async function validatePlan(relativePlanPath) {
    ensureOpen();
    const planPath = validateRelativePlanPath(applicationRoot, relativePlanPath);
    return runFixedAction("validate-plan", [
      "-File",
      scripts.validatePlan,
      "-PlanPath",
      planPath,
      "-CatalogPath",
      catalogPath,
    ]);
  }

  async function selfAudit() {
    ensureOpen();
    const parser = await runFixedAction("parse-scanner", ["-Command", FIXED_PARSER_COMMAND, scripts.scan]);
    const scan = await scanAnnotations();
    const graphAvailable = fixedArtifactAvailable(applicationRoot, path.join("docs", ".doc-graph.json"));
    const graph = graphAvailable ? await validateGraph() : null;
    const completed = parser.status === "passed" && scan.status === "passed";
    const ok = completed && (!graphAvailable || graph?.ok === true);
    return {
      operation: "self-audit",
      readOnly: true,
      ok,
      status: !completed ? "failed" : ok ? "passed" : "findings",
      completed,
      parser,
      scan,
      graph: {
        available: graphAvailable,
        validation: graph,
      },
    };
  }

  function getPlaybook(id) {
    ensureOpen();
    if (typeof id !== "string" || !playbooks.has(id)) {
      throw new DocumentIntelligenceError("UNKNOWN_SKILL", "Requested Document Intelligence skill is not allowlisted.", 404);
    }
    return cloneJson(playbooks.get(id));
  }

  function getCatalog() {
    ensureOpen();
    return cloneJson(catalog);
  }

  function snapshot({ local = false } = {}) {
    ensureOpen();
    return {
      id: "rwang-document-intelligence",
      name: "RWANG Document Intelligence",
      version: DOCUMENT_INTELLIGENCE_VERSION,
      status: "ready",
      core: true,
      available: true,
      sourceUrl: PINNED_SOURCE.sourceUrl.replace(/\.git$/, ""),
      commit: PINNED_SOURCE.commit,
      runtime: {
        engine: "Windows PowerShell",
        policy: "read-only",
        target: "application-root",
      },
      integrity: {
        status: "sha256-verified",
        scope: "allowlisted-runtime-files",
        signed: false,
        sealed: false,
      },
      hostPolicy: cloneJson(HOST_POLICY),
      source: {
        repository: PINNED_SOURCE.sourceUrl.replace(/\.git$/, ""),
        tag: PINNED_SOURCE.tag,
        commit: PINNED_SOURCE.commit,
        artifactSha256: PINNED_SOURCE.artifactSha256,
        normalization: [...PINNED_SOURCE.normalization],
        adaptations: [...PINNED_SOURCE.adaptations],
        upstreamLicenseDeclaration: "MIT",
        licenseFilePresentUpstream: false,
      },
      skills: cloneJson(publicSkills),
      catalog: getCatalog(),
      operations: OPERATION_DESCRIPTORS.map((operation) => ({
        ...operation,
        enabled: Boolean(local),
      })),
      security: {
        readOnlyTools: true,
        target: "application-root",
        arbitraryCommands: false,
        automaticHooks: false,
      },
    };
  }

  async function close() {
    closed = true;
    for (const child of activeProcesses) {
      try {
        child.kill();
      } catch {}
    }
    activeProcesses.clear();
  }

  return Object.freeze({
    snapshot,
    skills: publicSkills,
    catalog,
    getCatalog,
    getPlaybook,
    selfAudit,
    scanAnnotations,
    validateGraph,
    validatePlan,
    close,
  });
}
