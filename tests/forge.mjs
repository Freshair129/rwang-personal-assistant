import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildMessages, estimateTokens, guardPath, parseFileBlocks, runPacket, FORGE_VERSION } from "../forge.mjs";

// The packet a specification repository hands to Forge (STD-005). Only the fields Forge reads.
const packet = {
  id: "PKT-FR-001-001-service", layer: "service", fr: "FR-001-001",
  task: "Implement the application-service behaviour.",
  feature: { id: "FEAT-001", title: "Scope hierarchy", owner: "DOM-PRJ" },
  requirement: { id: "FR-001-001", title: "Scope entities carry UUID + unique human code", statement: "The system SHALL …", acceptance: [{ id: "AC-001-001-01", text: "Given …, when …, then …" }] },
  design: { sdd: "SDD-001", excerpt: "## Components\n- CMP-001 scope-service" },
  contracts: [], rules: [], tests: [],
  guardrails: ["Write only inside the allowed paths of this packet."],
  allowed_paths: ["apps/server/src/modules/project-manager/application/"],
  code: [],
  output_contract: "Respond with files only.",
  verify: [],
};

// 1. file blocks: language before or after path=, CRLF-free bodies, trailing newline normalised
const reply = "Here you go.\n```js path=apps/server/src/modules/project-manager/application/scope-service.js\n// @trace implements FR-001-001\nexport function createScope() {}\n```\n```path=apps/server/tests/x.test.js\nok\n```\n```path=../../etc/passwd\nnope\n```";
const files = parseFileBlocks(reply);
assert.equal(files.length, 3);
assert.equal(files[0].path, "apps/server/src/modules/project-manager/application/scope-service.js");
assert.equal(files[0].content, "// @trace implements FR-001-001\nexport function createScope() {}\n");

// 1b. the drifted forms small models produce: path on the line before the fence, or as the first comment line
const drifted = "path=apps/server/tests/a.test.js\n```javascript\n// @trace verifies AC-001-001-01\nok\n```\n\n```js\n// path: apps/server/tests/b.test.js\nalso ok\n```\n**path:** `apps/server/tests/c.test.js`\n```\nthird\n```";
const driftedFiles = parseFileBlocks(drifted);
assert.deepEqual(driftedFiles.map((f) => f.path), ["apps/server/tests/a.test.js", "apps/server/tests/b.test.js", "apps/server/tests/c.test.js"]);
assert.equal(driftedFiles[1].content, "also ok\n", "a path comment line is stripped from the body");
assert.equal(parseFileBlocks("```js\nno path here\n```").length, 0, "a block without a path is not a file");

// 2. path guard: allowed prefix only; escapes and absolute paths refused; DESIGN_GAP is a signal, not a file
assert.equal(guardPath(files[0].path, packet.allowed_paths).ok, true);
assert.equal(guardPath("apps/server/tests/x.test.js", packet.allowed_paths).ok, false);
assert.equal(guardPath("../../etc/passwd", packet.allowed_paths).ok, false);
assert.equal(guardPath("C:/Windows/system32/x", packet.allowed_paths).ok, false);
assert.equal(guardPath("/etc/passwd", packet.allowed_paths).ok, false);
assert.equal(guardPath("apps/server/src/modules/project-manager/application/../../../../secret", packet.allowed_paths).ok, false);
assert.deepEqual(guardPath("DESIGN_GAP.md", packet.allowed_paths), { ok: true, path: "DESIGN_GAP.md", gap: true });

// 3. messages carry the packet and nothing else: no environment, no workspace paths, guardrails verbatim
const messages = buildMessages(packet);
assert.equal(messages.length, 2);
assert.match(messages[0].content, /Write only inside the allowed paths/);
assert.match(messages[1].content, /AC-001-001-01/);
assert.doesNotMatch(messages[1].content, /RWANG_|OLLAMA_/);
assert.ok(estimateTokens(JSON.stringify(messages)) > 50);

// 4. a run against a fake Ollama: stages files under DATA_DIR only, never writes the workspace without --apply,
//    records refused paths and traced flags, and never touches anything outside the run directory
const tmp = await mkdtemp(path.join(os.tmpdir(), "rwang-forge-"));
const workspace = path.join(tmp, "workspace"); const data = path.join(tmp, "data");
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  assert.match(String(url), /\/api\/chat$/);
  const body = JSON.parse(init.body); assert.equal(body.stream, false); assert.equal(body.model, "fake-coder"); assert.equal(body.options.num_ctx, 4096);
  return new Response(JSON.stringify({ message: { content: reply }, eval_count: 10, prompt_eval_count: 100, total_duration: 5e8 }), { status: 200 });
};
try {
  const { record, runDir } = await runPacket(packet, { model: "fake-coder", apply: false, numCtx: 4096, timeoutMs: 5000, workspace, out: data });
  assert.equal(record.status, "staged");
  assert.equal(record.files.length, 1);
  assert.equal(record.files[0].traced, true);
  assert.equal(record.files[0].applied, false);
  assert.equal(record.refused.length, 2);
  assert.ok(runDir.startsWith(path.join(data, "forge", "runs")));
  const staged = await readFile(path.join(runDir, "files", files[0].path), "utf8");
  assert.match(staged, /@trace implements FR-001-001/);
  const saved = JSON.parse(await readFile(path.join(runDir, "record.json"), "utf8"));
  assert.equal(saved.forge, FORGE_VERSION); assert.equal(saved.model, "fake-coder"); assert.equal(saved.prompt_hash.length, 16);
  await assert.rejects(readFile(path.join(workspace, files[0].path), "utf8"), "workspace must be untouched without --apply");
  // --apply writes exactly the guarded file into the workspace
  const applied = await runPacket(packet, { model: "fake-coder", apply: true, numCtx: 4096, timeoutMs: 5000, workspace, out: data });
  assert.equal(applied.record.status, "applied");
  assert.match(await readFile(path.join(workspace, files[0].path), "utf8"), /createScope/);
  await assert.rejects(readFile(path.join(workspace, "apps/server/tests/x.test.js"), "utf8"), "a file outside allowed paths is never applied");
  // a DESIGN_GAP reply produces no files and a design_gap status
  globalThis.fetch = async () => new Response(JSON.stringify({ message: { content: "```path=DESIGN_GAP.md\nSDD-001 does not name the code generator signature.\n```" } }), { status: 200 });
  const gap = await runPacket(packet, { model: "fake-coder", apply: true, numCtx: 4096, timeoutMs: 5000, workspace, out: data });
  assert.equal(gap.record.status, "design_gap"); assert.equal(gap.record.files.length, 0); assert.match(gap.record.design_gap, /SDD-001/);
} finally {
  globalThis.fetch = realFetch;
  await rm(tmp, { recursive: true, force: true });
}
console.log("forge: ok");
