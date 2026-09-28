import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildMessages, buildMicroPrompt, estimateTokens, extractCode, guardPath, parseFileBlocks, pickModel, purityCheck, runCases, runMicro, runPacket, SMOKE_TASKS, FORGE_VERSION } from "../forge.mjs";

// ---------- packets (FR × layer) ----------
const packet = {
  id: "PKT-FR-001-001-service", layer: "service", fr: "FR-001-001", task: "Implement the application-service behaviour.",
  feature: { id: "FEAT-001", title: "Scope hierarchy", owner: "DOM-PRJ" },
  requirement: { id: "FR-001-001", title: "Scope entities carry UUID + unique human code", statement: "The system SHALL …", acceptance: [{ id: "AC-001-001-01", text: "Given …, when …, then …" }] },
  design: { sdd: "SDD-001", excerpt: "## Components\n- CMP-001 scope-service" }, contracts: [], rules: [], tests: [],
  guardrails: ["Write only inside the allowed paths of this packet."], allowed_paths: ["apps/server/src/modules/project-manager/application/"], code: [],
  output_contract: "Respond with files only.", verify: [],
};
const reply = "Here you go.\n```js path=apps/server/src/modules/project-manager/application/scope-service.js\n// @trace implements FR-001-001\nexport function createScope() {}\n```\n```path=apps/server/tests/x.test.js\nok\n```\n```path=../../etc/passwd\nnope\n```";
const files = parseFileBlocks(reply);
assert.equal(files.length, 3);
assert.equal(files[0].path, "apps/server/src/modules/project-manager/application/scope-service.js");
assert.equal(files[0].content, "// @trace implements FR-001-001\nexport function createScope() {}\n");
const drifted = "path=apps/server/tests/a.test.js\n```javascript\n// @trace verifies AC-001-001-01\nok\n```\n\n```js\n// path: apps/server/tests/b.test.js\nalso ok\n```\n**path:** `apps/server/tests/c.test.js`\n```\nthird\n```";
assert.deepEqual(parseFileBlocks(drifted).map((f) => f.path), ["apps/server/tests/a.test.js", "apps/server/tests/b.test.js", "apps/server/tests/c.test.js"]);
assert.equal(parseFileBlocks("```js\nno path here\n```").length, 0);

assert.equal(guardPath(files[0].path, packet.allowed_paths).ok, true);
assert.equal(guardPath("apps/server/tests/x.test.js", packet.allowed_paths).ok, false);
assert.equal(guardPath("../../etc/passwd", packet.allowed_paths).ok, false);
assert.equal(guardPath("C:/Windows/system32/x", packet.allowed_paths).ok, false);
assert.equal(guardPath("apps/server/src/modules/project-manager/application/../../../../secret", packet.allowed_paths).ok, false);
assert.equal(guardPath("apps/server/src/modules/pm/domain/scope-code.js", ["apps/server/src/modules/pm/domain/scope-code.js"]).ok, true, "an allowed path may be one exact file");
assert.deepEqual(guardPath("DESIGN_GAP.md", packet.allowed_paths), { ok: true, path: "DESIGN_GAP.md", gap: true });

const messages = buildMessages(packet);
assert.equal(messages.length, 2);
assert.match(messages[0].content, /Write only inside the allowed paths/);
assert.match(messages[1].content, /AC-001-001-01/);
assert.doesNotMatch(messages[1].content, /RWANG_|OLLAMA_/);
assert.ok(estimateTokens(JSON.stringify(messages)) > 50);

// ---------- micro-tasks ----------
const micro = { id: "MICRO-FR-001-001-clamp01", kind: "micro", fr: "FR-001-001", task_type: "pure-function", name: "clamp01", signature: "clamp01(x)", path: "apps/server/src/modules/pm/domain/clamp01.js", allowed_paths: ["apps/server/src/modules/pm/domain/clamp01.js"], rules: ["non-number returns 0"], acceptance: [{ call: "clamp01(-1)", expected: "0" }, { call: "clamp01(2)", expected: "1" }], trace: "// @trace implements FR-001-001", budget_tokens: 600 };
const holdout = [{ call: "clamp01(0.25)", expected: "0.25" }];
const prompt = buildMicroPrompt(micro);
assert.match(prompt, /export function clamp01\(x\)/);
assert.match(prompt, /clamp01\(-1\) -> 0/);
assert.doesNotMatch(prompt, /0\.25/, "holdout never enters the prompt");
assert.doesNotMatch(prompt, /\[ROLE\]|\[SCAFFOLD\]/, "plain instruction, no section headers");
assert.ok(estimateTokens(prompt) < 600);
assert.match(buildMicroPrompt(micro, { jsonMode: true }), /Respond as JSON/);
assert.match(buildMicroPrompt(micro, { pastMistakes: ["m1: used require()"] }), /PAST MISTAKES[\s\S]*require\(\)/);

assert.equal(extractCode('{"code":"export function f(){}\\n"}').via, "json");
assert.equal(extractCode("<think>hmm</think>\n```js\nexport function f(){}\n```").via, "fence");
assert.equal(extractCode("export function f() { return 1 }").via, "bare");
assert.equal(extractCode("I cannot do this."), null);
assert.equal(purityCheck("export function f(x){ return x }").pure, true);
assert.equal(purityCheck("import fs from 'node:fs'\nexport function f(){}").pure, false);
assert.equal(purityCheck("export function f(){ return Date.now() }").pure, false);

const good = "```js\n// @trace implements FR-001-001\nexport function clamp01(x) { if (typeof x !== 'number' || Number.isNaN(x)) return 0; return Math.min(1, Math.max(0, x)); }\n```";
const wrong = "```js\nexport function clamp01(x) { return x }\n```";
const impure = "```js\nimport fs from 'node:fs';\nexport function clamp01(x) { return 0 }\n```";
const tmp = await mkdtemp(path.join(os.tmpdir(), "rwang-forge-"));
const workspace = path.join(tmp, "workspace"); const data = path.join(tmp, "data");
const realFetch = globalThis.fetch;
let nextReply = good;
globalThis.fetch = async (url, init) => {
  assert.match(String(url), /\/api\/chat$/);
  const body = JSON.parse(init.body); assert.equal(body.stream, false); assert.equal(body.keep_alive, "30m"); assert.equal(body.options.temperature, 0.1);
  return new Response(JSON.stringify({ message: { content: nextReply }, eval_count: 80, prompt_eval_count: 100, total_duration: 5e8, load_duration: 1e6, done_reason: "stop" }), { status: 200 });
};
try {
  // gate: visible + holdout pass → verified, staged only
  let r = await runMicro(micro, holdout, { model: "fake-coder", numCtx: 8192, timeoutMs: 60_000, workspace, out: data });
  assert.equal(r.record.status, "verified", JSON.stringify(r.record.verify));
  assert.equal(r.record.gate, "pass"); assert.equal(r.record.verify.visible_exit, 0); assert.equal(r.record.verify.holdout_exit, 0);
  assert.equal(r.record.extracted_via, "fence");
  await assert.rejects(readFile(path.join(workspace, micro.path), "utf8"), "workspace untouched without --apply");
  assert.doesNotMatch(await readFile(path.join(r.runDir, "prompt.txt"), "utf8"), /0\.25/);
  const stats = (await readFile(path.join(data, "forge", "model_stats.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(stats.length, 1); assert.equal(stats[0].gate, "pass"); assert.equal(stats[0].task_type, "pure-function");
  // --apply writes exactly the guarded file
  r = await runMicro(micro, holdout, { model: "fake-coder", apply: true, numCtx: 8192, timeoutMs: 60_000, workspace, out: data });
  assert.equal(r.record.status, "applied"); assert.match(await readFile(path.join(workspace, micro.path), "utf8"), /@trace implements FR-001-001/);
  // wrong code: visible fails → failed, stats records fail
  nextReply = wrong; r = await runMicro(micro, holdout, { model: "fake-coder", numCtx: 8192, timeoutMs: 60_000, workspace, out: data });
  assert.equal(r.record.status, "failed"); assert.equal(r.record.gate, "fail"); assert.notEqual(r.record.verify.visible_exit, 0);
  // impure code never reaches the tests
  nextReply = impure; r = await runMicro(micro, holdout, { model: "fake-coder", numCtx: 8192, timeoutMs: 60_000, workspace, out: data });
  assert.equal(r.record.status, "impure"); assert.equal(r.record.verify.visible_exit, null);
  // special-token garbage
  nextReply = "<unused30><unused14>"; r = await runMicro(micro, holdout, { model: "fake-coder", numCtx: 8192, timeoutMs: 60_000, workspace, out: data });
  assert.equal(r.record.status, "garbage");
  // packets still work (design gap path)
  nextReply = "```path=DESIGN_GAP.md\nSDD-001 does not name the signature.\n```";
  const gap = await runPacket(packet, { model: "fake-coder", apply: true, numCtx: 4096, timeoutMs: 5000, workspace, out: data });
  assert.equal(gap.record.status, "design_gap"); assert.equal(gap.record.forge, FORGE_VERSION);
  // runCases with a bad call is a failure, not a crash
  const rc = await runCases(path.join(workspace, micro.path), "clamp01", [{ call: "clamp01(", expected: "0" }], "visible", 30_000);
  assert.notEqual(rc.code, 0);
  // model code that never returns is killed (whole process tree) and reported as a timeout, never a hung gate
  const loopFile = path.join(workspace, "apps/server/src/loop/spin.js"); await mkdir(path.dirname(loopFile), { recursive: true });
  await writeFile(loopFile, "export function spin(){ while (true) {} }\n");
  const t0 = Date.now(); const lp = await runCases(loopFile, "spin", [{ call: "spin()", expected: "0" }], "holdout", 3000);
  assert.equal(lp.code, 124); assert.equal(lp.timed_out, true); assert.match(lp.stderr, /timed out/); assert.ok(Date.now() - t0 < 15_000, "the gate returns soon after its timeout");
} finally { globalThis.fetch = realFetch; await rm(tmp, { recursive: true, force: true }); }

// ---------- router (STD-005 R9) ----------
const mk = (model, gate, n, lat = 5) => Array.from({ length: n }, () => ({ model, task_type: "parser", gate, warm: true, latency_s: lat }));
const stats = [...mk("A", "pass", 5), ...mk("B", "pass", 1), ...mk("B", "fail", 4), ...mk("C", "pass", 2, 3)];
let p = pickModel(stats, [], "parser");
assert.equal(p.model, "C", "a candidate (n<5) with the best score may take one dispatch per batch (exploration)"); assert.match(p.reason, /candidate/);
p = pickModel(stats, [], "parser", { candidatesUsed: new Set(["C"]) }); assert.equal(p.model, "A"); assert.match(p.reason, /n>=5/);
p = pickModel(stats, [{ model: "A", blacklist: true }], "parser", { candidatesUsed: new Set(["C"]) }); assert.equal(p.model, null, "B demoted (1/5), A blacklisted, C used → empty pool");
p = pickModel([], [], "parser"); assert.equal(p.model, null);
assert.equal(pickModel(stats, [], "parser").model, pickModel(stats, [], "parser").model, "deterministic");
// a smoke-passed model with no dispatch of this type yet is a candidate (n = 0) whose smoke evidence stands in
const smokeStats = [{ model: "D", task_type: "smoke", gate: "pass", warm: false, latency_s: 40 }, { model: "D", task_type: "smoke", gate: "pass", warm: true, latency_s: 2 }];
const smokeLedger = [{ kind: "pass", model: "D", task_type: "smoke", blacklist: false }];
p = pickModel(smokeStats, smokeLedger, "parser"); assert.equal(p.model, "D"); assert.equal(p.n, 0); assert.equal(p.median_warm_latency_s, 2); assert.match(p.reason, /candidate/);
p = pickModel([...stats, ...smokeStats], smokeLedger, "parser", { candidatesUsed: new Set(["C", "D"]) }); assert.equal(p.model, "A", "used candidates step aside for the established model");
// the ledger is chronological: a later smoke pass lifts an earlier blacklist, a later blacklist removes a pass
assert.equal(pickModel(smokeStats, [{ kind: "fail", model: "D", task_type: "smoke", blacklist: true }, ...smokeLedger], "parser").model, "D");
assert.equal(pickModel(smokeStats, [...smokeLedger, { kind: "fail", model: "D", task_type: "smoke", blacklist: true }], "parser").model, null);
// an operator override lifts a smoke blacklist honestly: it does not fabricate a smoke pass, so it seeds no
// smoke-derived candidate row — the model is only chosen once real dispatches of this task type back it
const overrideLedger = [{ kind: "fail", model: "E", task_type: "smoke", blacklist: true, lesson: "failed smoke-metronomeTicks" }, { kind: "override", model: "E", blacklist: false, lesson: "2/3 real FEAT-001 micro-tasks verified" }];
assert.equal(pickModel([], overrideLedger, "parser").model, null, "override alone gives no task-type evidence yet");
const eStats = [...mk("E", "pass", 2, 2), ...mk("A", "pass", 5)];
p = pickModel(eStats, overrideLedger, "parser"); assert.equal(p.model, "E", "real dispatches after the override win on their own merit");
assert.equal(pickModel(eStats, [...overrideLedger, { kind: "fail", model: "E", task_type: "smoke", blacklist: true }], "parser").model, "A", "a later re-blacklist overrides the override");
assert.equal(SMOKE_TASKS.length, 3);
for (const t of SMOKE_TASKS) { assert.ok(t.acceptance.length >= 2); assert.ok(t.holdout.length >= 1); }
console.log("forge: ok");
