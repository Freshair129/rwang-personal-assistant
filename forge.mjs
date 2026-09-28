#!/usr/bin/env node
// RWANG Forge — run implementation units of a specification repository (STD-005) against local Ollama
// models: packets (one FR × one layer) and micro-tasks (one pure function with visible + holdout
// acceptance). Stages what the model returns, applies it to the workspace only with --apply, runs the
// deterministic gate, and keeps append-only records (runs, model_stats.jsonl, ledger.jsonl).
//
//   node forge.mjs models                                   list Ollama models
//   node forge.mjs smoke <model> [--json-mode]              onboarding gate: 3 fixed micro-tasks with known answers
//   node forge.mjs pick --task-type <t>                     deterministic model choice from model_stats.jsonl
//   node forge.mjs warm --model <m>                         pre-warm a model (keep_alive 30m)
//   node forge.mjs estimate <unit.json>                     token estimate and what the unit contains
//   node forge.mjs prompt <unit.json>                       the exact messages that would be sent
//   node forge.mjs run <unit.json> [--model M] [--apply] [--num-ctx N] [--timeout S] [--json-mode] [--rework]
//   node forge.mjs queue <queue.json> [--model M] [--apply] [--continue]
//   node forge.mjs verify <packet.json>                     run only a packet's verification commands
//
// Environment (same names as the RWANG server; .env is loaded by the package script):
//   OLLAMA_URL            default http://127.0.0.1:11434
//   RWANG_WORKSPACE_DIR   the code repository the units target (required for --apply and packet verify)
//   RWANG_DATA_DIR        where records go (default %LOCALAPPDATA%\RWANG\data): forge/runs, forge/model_stats.jsonl, forge/ledger.jsonl
//   RWANG_FORGE_MODEL     default model when --model is not given
//
// Boundaries: files may land only under the unit's allowed_paths inside the workspace; a path that escapes or
// contains `..` is refused; a micro-task's holdout cases are read from <unit>.holdout.json next to the unit and
// never enter a prompt; verification runs only node/npm/pnpm/npx commands; nothing is ever deleted; without
// --apply nothing outside DATA_DIR is written; the gate is deterministic — no model judges a result.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const FORGE_VERSION = "0.2.0";
const VERIFY_ALLOW = new Set(["node", "npm", "pnpm", "npx"]);
const SPECIAL_TOKEN = /<unused\d+>|<\|[^|>]{1,40}\|>|<pad>|<\/?s>/;
const IMPURE = [/^\s*import\s/m, /\brequire\s*\(/, /\bprocess\./, /\bfs\./, /\bfetch\s*\(/, /\bglobalThis\b/, /\bDate\.now\b/, /\bnew Date\b/, /\bMath\.random\b/, /\bsetTimeout\b/, /\bconsole\./];

export function estimateTokens(text) { return Math.ceil(String(text).length / 3.6); }

/** Parse the model's answer into files: ```path=<rel> … ``` blocks; also the drifted forms small models produce. */
export function parseFileBlocks(text) {
  const files = [];
  const src = String(text).replace(/\r\n/g, "\n");
  const re = /(?:^[ \t]*(?:\*\*)?(?:path|file)\s*[:=]\s*(?:\*\*)?\s*`?([^\s`*]+)`?(?:\*\*)?[ \t]*\n)?```([^\n]*)\n([\s\S]*?)```/gm;
  let m;
  while ((m = re.exec(src))) {
    const info = m[2] || ""; let body = m[3]; let p = m[1] || (info.match(/path=([^\s`]+)/) || [])[1] || null;
    if (!p) { const first = body.split("\n")[0] || ""; const fm = first.match(/^\s*(?:\/\/|#|--|<!--)\s*(?:path|file)\s*[:=]\s*([^\s*]+)/i); if (fm) { p = fm[1]; body = body.split("\n").slice(1).join("\n"); } }
    if (!p) continue;
    files.push({ path: p.trim().replace(/\\/g, "/"), content: body.replace(/\n$/, "") + "\n" });
  }
  return files;
}

/** Extract one code body from a micro-task answer: JSON {code} first, then <think>-stripped fenced block. */
export function extractCode(text) {
  const raw = String(text);
  try { const j = JSON.parse(raw); if (j && typeof j.code === "string" && j.code.trim()) return { code: j.code.replace(/\n?$/, "\n"), via: "json" }; } catch {}
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const fence = stripped.match(/```(?:js|javascript|mjs|ts|typescript)?\s*\n([\s\S]*?)```/);
  if (fence && fence[1].trim()) return { code: fence[1].replace(/\n?$/, "\n"), via: "fence" };
  const bare = stripped.trim();
  if (/^(export\s+)?function\s+\w+\s*\(/m.test(bare) && !/```/.test(bare)) return { code: bare + "\n", via: "bare" };
  return null;
}

/** STD-005 E2 post-check: the returned code must be pure. */
export function purityCheck(code) { const hits = IMPURE.filter((re) => re.test(code)).map((re) => re.source); return { pure: hits.length === 0, hits }; }

/** A relative path is accepted only inside one of the allowed prefixes and never escapes. */
export function guardPath(rel, allowed) {
  const norm = String(rel).replace(/\\/g, "/").replace(/^\.\//, "");
  if (!norm || path.isAbsolute(norm) || /^[A-Za-z]:/.test(norm) || norm.split("/").includes("..")) return { ok: false, reason: "path escapes the workspace" };
  if (norm === "DESIGN_GAP.md") return { ok: true, path: norm, gap: true };
  const hit = (allowed || []).some((p) => { const a = String(p).replace(/\\/g, "/").replace(/^\.\//, ""); return norm === a || norm.startsWith(a.endsWith("/") ? a : a + "/") || (a.includes(".") && norm === a); });
  return hit ? { ok: true, path: norm } : { ok: false, reason: `not under an allowed path (${(allowed || []).join(", ")})` };
}

/** Packet prompt (FR × layer): the packet as data plus guard rails. */
export function buildMessages(packet) {
  if (packet.kind === "micro") return [{ role: "user", content: buildMicroPrompt(packet) }];
  const system = [
    "You are a coding worker executing one implementation packet. You see nothing but this packet.",
    `Task for layer "${packet.layer}": ${packet.task}`,
    "Rules that always apply:",
    ...(packet.guardrails || []).map((g) => `- ${g}`),
    `Allowed paths: ${(packet.allowed_paths || []).join(", ")}`,
    packet.output_contract || "Respond with files only, each as a fenced block with info string path=<relative path>.",
    "Exact output form, nothing before or after the blocks:",
    "```path=" + ((packet.allowed_paths || [])[0] || "relative/dir/") + "example.js",
    "// @trace implements " + (packet.fr || "FR-000-000"),
    "…complete file content…",
    "```",
    "Trace lines are code comments (// … in JavaScript), never bare text.",
  ].join("\n");
  const body = { requirement: packet.requirement, feature: packet.feature, design: packet.design, contracts: packet.contracts, rules: packet.rules, tests: packet.tests, existing_code: (packet.code || []).map((c) => ({ path: c.path, content: c.content })) };
  return [{ role: "system", content: system }, { role: "user", content: `PACKET ${packet.id}\n\n${JSON.stringify(body, null, 1)}\n\nProduce the files now.` }];
}

/** Micro-task prompt, template v2: plain instruction, one action, exact signature, ≤ 6 rules, visible acceptance only. */
export function buildMicroPrompt(unit, { jsonMode = false, pastMistakes = [] } = {}) {
  const lines = [
    "You are a focused code generator. ONE task. Pure function, no imports, no I/O, no global state.",
    jsonMode ? 'Respond as JSON: {"code": "<full file contents>"}' : "Output ONLY one ```js block with the complete file. No prose.",
    "",
    `Implement EXACTLY in ${unit.path}:`,
    `export function ${unit.signature}`,
    "",
    "Rules:",
    `- First line of the file: ${unit.trace || "// @trace implements " + unit.fr}`,
    ...(unit.rules || []).slice(0, 6).map((r) => `- ${r}`),
    "",
    "Acceptance: " + (unit.acceptance || []).map((c) => `${c.call} -> ${c.expected}`).join(". ") + ".",
  ];
  if (pastMistakes.length) lines.push("", "PAST MISTAKES (do not repeat):", ...pastMistakes.slice(0, 3).map((m) => `- ${m}`));
  return lines.join("\n");
}

function dataDir() { if (process.env.RWANG_DATA_DIR) return process.env.RWANG_DATA_DIR; return process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || os.homedir(), "RWANG", "data") : path.join(os.homedir(), ".rwang", "data"); }
const ollamaUrl = () => (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const appendJsonl = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(obj) + "\n"); };
const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

async function listModels() { const r = await fetch(`${ollamaUrl()}/api/tags`); if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`); return ((await r.json()).models || []).map((m) => ({ name: m.name, size: m.size, family: m.details?.family, params: m.details?.parameter_size, quant: m.details?.quantization_level })); }

// Thinking models spend the whole num_predict budget in `message.thinking` and return an empty answer
// (observed: qwen3.5:9b, eval_count 2048, content ""). Forge therefore asks for think:false by default and
// retries without the field when the runtime rejects it for a model that cannot think.
async function chat({ model, messages, numCtx, numPredict = 2048, timeoutMs, jsonMode = false, think = false }) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const send = async (withThink) => {
      const body = { model, messages, stream: false, keep_alive: "30m", options: { num_ctx: numCtx, num_predict: numPredict, temperature: 0.1 } };
      if (jsonMode) body.format = { type: "object", properties: { code: { type: "string" } }, required: ["code"] };
      if (withThink) body.think = think;
      const r = await fetch(`${ollamaUrl()}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, signal: ac.signal, body: JSON.stringify(body) });
      const text = await r.text();
      if (!r.ok) { if (withThink && r.status === 400 && /think/i.test(text)) return send(false); throw new Error(`Ollama ${r.status}: ${text}`); }
      return JSON.parse(text);
    };
    const j = await send(true); if (j.error) throw new Error(j.error);
    return { text: j.message?.content || "", thinking_chars: (j.message?.thinking || "").length, eval_count: j.eval_count, prompt_eval_count: j.prompt_eval_count, total_duration_ms: Math.round((j.total_duration || 0) / 1e6), load_duration_ms: Math.round((j.load_duration || 0) / 1e6), done_reason: j.done_reason };
  } finally { clearTimeout(timer); }
}

function runCommand(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const [exe, ...args] = cmd.trim().split(/\s+/);
    if (!VERIFY_ALLOW.has(exe.replace(/\.(exe|cmd)$/i, ""))) return resolve({ cmd, code: -1, stdout: "", stderr: `refused: "${exe}" is not an allowed verification executable (${[...VERIFY_ALLOW].join(", ")})` });
    const child = process.platform === "win32" ? spawn(cmd.trim(), { cwd, shell: true, env: process.env, windowsHide: true }) : spawn(exe, args, { cwd, env: process.env });
    // On Windows the child is cmd.exe; child.kill() leaves its node grandchild running (an infinite loop in model code
    // would then hang the gate forever), so kill the whole tree. A timeout is a gate failure, never a hang.
    let stdout = "", stderr = ""; let timedOut = false;
    const t = setTimeout(() => { timedOut = true; stderr += `\n[forge] timed out after ${timeoutMs} ms — killed`; if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); else child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d)); child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => { clearTimeout(t); resolve({ cmd, code: timedOut ? 124 : code, timed_out: timedOut, stdout: stdout.slice(-8000), stderr: stderr.slice(-8000) }); });
    child.on("error", (e) => { clearTimeout(t); resolve({ cmd, code: -1, stdout, stderr: String(e) }); });
  });
}
async function verifyPacket(packet, workspace, timeoutMs) { const results = []; for (const cmd of packet.verify || []) results.push(await runCommand(cmd, workspace, timeoutMs)); return results; }

/** Run acceptance cases against a staged micro-task file: a generated node:test file that imports it. Deterministic; the calls are the Architect's. */
export async function runCases(stagedFile, unitName, cases, label, timeoutMs = 60_000) {
  if (!cases?.length) return { label, code: 0, ran: 0, stdout: "", stderr: "no cases" };
  const dir = path.dirname(stagedFile); const test = path.join(dir, `${path.basename(stagedFile, path.extname(stagedFile))}.${label}.test.mjs`);
  const body = [`import { test } from 'node:test';`, `import assert from 'node:assert/strict';`, `import * as m from './${path.basename(stagedFile)}';`, `const ${unitName} = m.${unitName} ?? m.default;`,
    ...cases.map((c, i) => `test(${JSON.stringify(`${label} ${i + 1}: ${c.call}`)}, () => { assert.deepStrictEqual(${c.call}, ${c.expected}); });`)].join("\n");
  fs.writeFileSync(test, body);
  const r = await runCommand(`node --test ${path.basename(test)}`, dir, timeoutMs);
  return { label, code: r.code, timed_out: !!r.timed_out, ran: cases.length, stdout: r.stdout, stderr: r.stderr };
}

export function pickModel(stats, ledger, taskType, { candidatesUsed = new Set() } = {}) {
  // The ledger is chronological: a model's standing is its latest verdict. A later smoke pass lifts an earlier
  // blacklist; so does an explicit operator "override" (`forge override`) — a documented decision to trust the
  // model despite a failed smoke task, never a claim that the smoke suite actually passed.
  const blacklist = new Set(), smoked = new Set();
  for (const l of ledger) { if (!l.model) continue; if (l.blacklist) { blacklist.add(l.model); smoked.delete(l.model); } else if ((l.kind === "pass" && l.task_type === "smoke") || l.kind === "override") { blacklist.delete(l.model); if (l.kind === "pass") smoked.add(l.model); } }
  const by = {}, smoke = {};
  for (const s of stats) {
    if (!s.model) continue;
    const bucket = s.task_type === "smoke" ? smoke : s.task_type === taskType ? by : null; if (!bucket) continue;
    const b = (bucket[s.model] ??= { n: 0, pass: 0, lat: [] }); b.n++; if (s.gate === "pass") b.pass++; if (s.warm && typeof s.latency_s === "number") b.lat.push(s.latency_s);
  }
  // A model that passed the smoke suite but has no dispatch of this type yet is a candidate with n = 0; its smoke evidence stands in for pass rate and latency.
  for (const m of smoked) if (!by[m]) { const sm = smoke[m]; by[m] = { n: 0, pass: 0, lat: sm?.lat || [], prior: sm?.n ? sm.pass / sm.n : 1 }; }
  const rows = Object.entries(by).filter(([m]) => !blacklist.has(m)).map(([model, b]) => { const lat = b.lat.sort((a, c) => a - c); const med = lat.length ? lat[Math.floor(lat.length / 2)] : 10; const pass_rate = b.n ? b.pass / b.n : (b.prior ?? 0); return { model, n: b.n, pass_rate, median_warm_latency_s: med, score: pass_rate - 0.1 * (med / 10), candidate: b.n < 5 }; })
    .filter((r) => !(r.n >= 5 && r.pass_rate < 0.6)).filter((r) => !(r.candidate && candidatesUsed.has(r.model)));
  rows.sort((a, b) => b.score - a.score || a.model.localeCompare(b.model));
  if (!rows.length) return { model: null, reason: "no eligible local model" };
  const best = rows[0]; return { ...best, reason: best.candidate ? "candidate (n<5): one dispatch per batch" : "best score, n>=5" };
}

export const SMOKE_TASKS = [
  { id: "smoke-clamp01", task_type: "smoke", name: "clamp01", signature: "clamp01(x)", path: "smoke/clamp01.js", rules: ["return x clamped to the closed range 0..1", "non-number or NaN input returns 0"], acceptance: [{ call: "clamp01(-1)", expected: "0" }, { call: "clamp01(0.5)", expected: "0.5" }, { call: "clamp01(2)", expected: "1" }], holdout: [{ call: "clamp01(NaN)", expected: "0" }, { call: "clamp01(1)", expected: "1" }] },
  { id: "smoke-parseTimecode", task_type: "smoke", name: "parseTimecode", signature: "parseTimecode(s)", path: "smoke/parse-timecode.js", rules: ["format is mm:ss.mmm with two-digit minutes and seconds and three-digit milliseconds", "return total seconds as a number", "any other input returns -1"], acceptance: [{ call: "parseTimecode('01:02.500')", expected: "62.5" }, { call: "parseTimecode('00:00.000')", expected: "0" }, { call: "parseTimecode('bad')", expected: "-1" }], holdout: [{ call: "parseTimecode('10:00.250')", expected: "600.25" }, { call: "parseTimecode('1:2.5')", expected: "-1" }] },
  { id: "smoke-metronomeTicks", task_type: "smoke", name: "metronomeTicks", signature: "metronomeTicks(bpm, beatsPerBar, durationSec)", path: "smoke/metronome-ticks.js", rules: ["return an array of ticks {t, accent} for every beat with t < durationSec", "t is the beat time in seconds starting at 0, rounded to 3 decimals", "accent is true on the first beat of every bar", "bpm <= 0, beatsPerBar <= 0 or durationSec <= 0 returns []"], acceptance: [{ call: "metronomeTicks(120, 4, 2)", expected: "[{t:0,accent:true},{t:0.5,accent:false},{t:1,accent:false},{t:1.5,accent:false}]" }, { call: "metronomeTicks(0, 4, 2)", expected: "[]" }], holdout: [{ call: "metronomeTicks(60, 2, 3)", expected: "[{t:0,accent:true},{t:1,accent:false},{t:2,accent:true}]" }] },
];

export async function runMicro(unit, holdoutCases, { model, apply = false, numCtx = 8192, timeoutMs = 300_000, workspace, out, jsonMode = false, reworkRound = 0, warm = null, pastMistakes = [] }) {
  if (!model) throw new Error("no model: pass --model or set RWANG_FORGE_MODEL");
  const runId = `${unit.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runDir = path.join(out, "forge", "runs", runId); fs.mkdirSync(path.join(runDir, "files"), { recursive: true });
  const prompt = buildMicroPrompt(unit, { jsonMode, pastMistakes });
  const messages = [{ role: "user", content: prompt }];
  const record = { forge: FORGE_VERSION, kind: "micro", run_id: runId, unit: unit.id, fr: unit.fr, task_type: unit.task_type || "pure-function", model, num_ctx: numCtx, json_mode: jsonMode, rework_round: reworkRound, prompt_hash: crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16), prompt_tokens_estimate: estimateTokens(prompt), started_at: new Date().toISOString(), apply, files: [], refused: [], verify: { visible_exit: null, holdout_exit: null }, extracted_via: null, status: "started" };
  const t0 = Date.now();
  const reply = await chat({ model, messages, numCtx, numPredict: 4096, timeoutMs, jsonMode });
  const latency_s = (Date.now() - t0) / 1000;
  fs.writeFileSync(path.join(runDir, "prompt.txt"), prompt); fs.writeFileSync(path.join(runDir, "reply.md"), reply.text);
  Object.assign(record, { eval_count: reply.eval_count, prompt_eval_count: reply.prompt_eval_count, thinking_chars: reply.thinking_chars, model_ms: reply.total_duration_ms, load_ms: reply.load_duration_ms, done_reason: reply.done_reason, latency_s, warm: warm ?? (reply.load_duration_ms != null ? reply.load_duration_ms < 2000 : null) });
  let gate = "fail";
  try {
    if (SPECIAL_TOKEN.test(reply.text)) { record.status = "garbage"; throw 0; }
    if ((reply.eval_count ?? 30) < 30 && !reply.text.trim()) { record.status = "empty"; throw 0; }
    const ex = extractCode(reply.text); if (!ex) { record.status = "no_files"; throw 0; }
    record.extracted_via = ex.via;
    let code = ex.code; if (!/@trace\s+implements/.test(code) && unit.trace) code = unit.trace + "\n" + code;
    const g = guardPath(unit.path, unit.allowed_paths || [unit.path]); if (!g.ok) { record.refused.push({ path: unit.path, reason: g.reason }); record.status = "refused"; throw 0; }
    const pc = purityCheck(code); if (!pc.pure) { record.purity = pc.hits; record.status = "impure"; throw 0; }
    const staged = path.join(runDir, "files", g.path); fs.mkdirSync(path.dirname(staged), { recursive: true }); fs.writeFileSync(staged, code);
    record.files.push({ path: g.path, bytes: Buffer.byteLength(code), traced: true, applied: false });
    const caseMs = Math.min(timeoutMs, 20_000); const vis = await runCases(staged, unit.name, unit.acceptance, "visible", caseMs); record.verify.visible_exit = vis.code; record.verify.visible = { ran: vis.ran, stderr: vis.stderr.slice(-2000) };
    const hold = await runCases(staged, unit.name, holdoutCases || [], "holdout", caseMs); record.verify.holdout_exit = hold.code; record.verify.holdout = { ran: hold.ran, stderr: hold.stderr.slice(-2000) };
    if (vis.code === 0 && hold.code === 0) { gate = "pass"; record.status = "verified"; if (apply) { if (!workspace) throw new Error("--apply needs RWANG_WORKSPACE_DIR"); const target = path.join(workspace, g.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, code); record.files[0].applied = true; record.status = "applied"; } }
    else record.status = "failed";
  } catch (e) { if (e !== 0) throw e; }
  record.gate = gate; record.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(runDir, "record.json"), JSON.stringify(record, null, 1) + "\n");
  appendJsonl(path.join(out, "forge", "model_stats.jsonl"), { run_id: runId, unit: unit.id, task_type: record.task_type, model, gate, status: record.status, verify: record.verify.visible_exit == null ? null : { visible_exit: record.verify.visible_exit, holdout_exit: record.verify.holdout_exit }, eval_count: reply.eval_count, latency_s: +latency_s.toFixed(1), warm: record.warm, rework_round: reworkRound, ts: record.finished_at });
  return { record, runDir };
}

export async function runPacket(packet, { model, apply = false, numCtx = 16384, timeoutMs = 600_000, workspace, out }) {
  if (!model) throw new Error("no model: pass --model or set RWANG_FORGE_MODEL");
  const runId = `${packet.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runDir = path.join(out, "forge", "runs", runId); fs.mkdirSync(path.join(runDir, "files"), { recursive: true });
  const messages = buildMessages(packet);
  const promptHash = crypto.createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 16);
  const record = { forge: FORGE_VERSION, kind: "packet", run_id: runId, packet: packet.id, fr: packet.fr, layer: packet.layer, model, num_ctx: numCtx, prompt_hash: promptHash, prompt_tokens_estimate: estimateTokens(JSON.stringify(messages)), started_at: new Date().toISOString(), apply, files: [], refused: [], design_gap: null, verify: [], status: "started" };
  const reply = await chat({ model, messages, numCtx, numPredict: 4096, timeoutMs });
  fs.writeFileSync(path.join(runDir, "reply.md"), reply.text);
  Object.assign(record, { eval_count: reply.eval_count, prompt_eval_count: reply.prompt_eval_count, model_ms: reply.total_duration_ms });
  for (const f of parseFileBlocks(reply.text)) {
    const g = guardPath(f.path, packet.allowed_paths);
    if (!g.ok) { record.refused.push({ path: f.path, reason: g.reason }); continue; }
    if (g.gap) { record.design_gap = f.content; fs.writeFileSync(path.join(runDir, "DESIGN_GAP.md"), f.content); continue; }
    const staged = path.join(runDir, "files", g.path); fs.mkdirSync(path.dirname(staged), { recursive: true }); fs.writeFileSync(staged, f.content);
    const entry = { path: g.path, bytes: Buffer.byteLength(f.content), traced: /@trace\s+(implements|verifies)\s+(FR|AC|NFR)-/.test(f.content), applied: false };
    if (apply) { if (!workspace) throw new Error("--apply needs RWANG_WORKSPACE_DIR"); const target = path.join(workspace, g.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, f.content); entry.applied = true; }
    record.files.push(entry);
  }
  if (record.design_gap) record.status = "design_gap";
  else if (!record.files.length) record.status = "no_files";
  else if (apply && workspace && (packet.verify || []).length) { record.verify = await verifyPacket(packet, workspace, timeoutMs); record.status = record.verify.every((v) => v.code === 0) ? "verified" : "failed"; }
  else record.status = apply ? "applied" : "staged";
  record.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(runDir, "record.json"), JSON.stringify(record, null, 1) + "\n");
  appendJsonl(path.join(out, "forge", "model_stats.jsonl"), { run_id: runId, unit: packet.id, task_type: `packet:${packet.layer}`, model, gate: record.status === "verified" ? "pass" : record.status === "staged" || record.status === "applied" ? "unverified" : "fail", status: record.status, eval_count: reply.eval_count, latency_s: +(reply.total_duration_ms / 1000).toFixed(1), ts: record.finished_at });
  return { record, runDir };
}

async function smoke(model, { out, numCtx, timeoutMs, jsonMode }) {
  const results = []; let ok = true;
  for (const [i, task] of SMOKE_TASKS.entries()) {
    const unit = { ...task, kind: "micro", fr: "SMOKE", allowed_paths: [task.path], trace: "// @trace smoke" };
    const { record } = await runMicro(unit, task.holdout, { model, out, numCtx, timeoutMs, jsonMode, warm: i > 0 });
    const pass = record.gate === "pass"; ok = ok && pass;
    results.push({ task: task.id, status: record.status, gate: record.gate, eval_count: record.eval_count, latency_s: record.latency_s, load_ms: record.load_ms, extracted_via: record.extracted_via, run: record.run_id });
  }
  if (!ok) appendJsonl(path.join(out, "forge", "ledger.jsonl"), { ts: new Date().toISOString(), kind: "fail", model, task_type: "smoke", severity: "critical", lesson: `failed onboarding smoke: ${results.filter((r) => r.gate !== "pass").map((r) => `${r.task}=${r.status}`).join(", ")}`, blacklist: true });
  else appendJsonl(path.join(out, "forge", "ledger.jsonl"), { ts: new Date().toISOString(), kind: "pass", model, task_type: "smoke", severity: "info", lesson: `passed onboarding smoke (${results.map((r) => `${r.task} ${r.latency_s}s`).join(", ")})`, blacklist: false });
  return { model, ok, results };
}

// ---- CLI ----
async function main(argv) {
  const cmd = argv[0]; const arg = argv[1];
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const flag = (n) => argv.includes(n);
  const model = opt("--model", process.env.RWANG_FORGE_MODEL || "");
  const timeoutMs = Number(opt("--timeout", 600)) * 1000; const jsonMode = flag("--json-mode");
  const workspace = process.env.RWANG_WORKSPACE_DIR ? path.resolve(process.env.RWANG_WORKSPACE_DIR) : null;
  const out = dataDir();
  const loadUnit = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
  const holdoutFor = (f) => { const h = f.replace(/\.json$/, ".holdout.json"); return fs.existsSync(h) ? JSON.parse(fs.readFileSync(h, "utf8")).cases || [] : []; };
  const pastMistakes = () => readJsonl(path.join(out, "forge", "ledger.jsonl")).filter((l) => l.blacklist || l.kind === "fail").slice(-3).map((l) => `${l.model}: ${l.lesson}`);
  if (cmd === "models") { for (const m of await listModels()) console.log(`${m.name}\t${m.params || ""}\t${m.quant || ""}\t${(m.size / 1e9).toFixed(1)} GB`); return 0; }
  if (cmd === "warm") { const m = opt("--model", model); if (!m) throw new Error("--model required"); const t0 = Date.now(); await chat({ model: m, messages: [{ role: "user", content: "ok" }], numCtx: 8192, numPredict: 5, timeoutMs }); console.log(`${m} warm in ${((Date.now() - t0) / 1000).toFixed(1)}s`); return 0; }
  if (cmd === "smoke") { const m = arg || model; if (!m) throw new Error("smoke <model>"); const r = await smoke(m, { out, numCtx: Number(opt("--num-ctx", 8192)), timeoutMs, jsonMode }); console.log(JSON.stringify(r, null, 1)); return r.ok ? 0 : 1; }
  if (cmd === "override") {
    // A documented operator decision to trust a smoke-blacklisted model anyway (e.g. real dispatches outperformed
    // the smoke suite). Never rewrites or removes the failing smoke record — it appends a new, later entry that
    // pickModel's chronological scan honours instead. Reversible the same way: smoke it again, or blacklist it again.
    const m = arg || model; if (!m) throw new Error("override <model> --reason \"...\"");
    const reason = opt("--reason", ""); if (!reason) throw new Error('--reason "..." required (what evidence justifies trusting this model despite its smoke record)');
    const entry = { ts: new Date().toISOString(), kind: "override", model: m, severity: "info", lesson: reason, blacklist: false };
    appendJsonl(path.join(out, "forge", "ledger.jsonl"), entry);
    console.log(JSON.stringify(entry));
    return 0;
  }
  if (cmd === "pick") { const r = pickModel(readJsonl(path.join(out, "forge", "model_stats.jsonl")), readJsonl(path.join(out, "forge", "ledger.jsonl")), opt("--task-type", "pure-function")); console.log(JSON.stringify(r)); return r.model ? 0 : 2; }
  if (cmd === "estimate" && arg) { const u = loadUnit(arg); const msgs = buildMessages(u); const est = estimateTokens(msgs.map((m) => m.content).join("\n")); const numCtx = Number(opt("--num-ctx", u.kind === "micro" ? 8192 : 16384)); console.log(JSON.stringify(u.kind === "micro" ? { unit: u.id, kind: "micro", task_type: u.task_type, visible_cases: u.acceptance?.length || 0, eligibility: u.eligibility, prompt_tokens_estimate: est, fits_budget: est <= (u.budget_tokens || 600) } : { packet: u.id, layer: u.layer, acceptance: u.requirement?.acceptance?.length || 0, tests: u.tests?.length || 0, contracts: u.contracts?.length || 0, rules: u.rules?.length || 0, code_files: u.code?.length || 0, allowed_paths: u.allowed_paths, prompt_tokens_estimate: est, fits_num_ctx: est < numCtx * 0.75 }, null, 1)); return 0; }
  if (cmd === "prompt" && arg) { for (const m of buildMessages(loadUnit(arg))) console.log(`--- ${m.role} ---\n${m.content}\n`); return 0; }
  if (cmd === "verify" && arg) { if (!workspace) throw new Error("RWANG_WORKSPACE_DIR is required"); const r = await verifyPacket(loadUnit(arg), workspace, timeoutMs); for (const v of r) console.log(`${v.code === 0 ? "PASS" : "FAIL"} ${v.cmd}\n${v.stderr || v.stdout}`); return r.every((v) => v.code === 0) ? 0 : 1; }
  const runOne = async (file) => {
    const u = loadUnit(file);
    if (u.kind === "micro") {
      if (u.eligibility && !u.eligibility.eligible) return { record: { status: "not_eligible", unit: u.id, model, files: [], refused: [], eligibility: u.eligibility }, runDir: "" };
      let r = await runMicro(u, holdoutFor(file), { model, apply: flag("--apply"), numCtx: Number(opt("--num-ctx", 8192)), timeoutMs, workspace, out, jsonMode, pastMistakes: pastMistakes() });
      if (r.record.gate !== "pass" && flag("--rework")) { const next = pickModel(readJsonl(path.join(out, "forge", "model_stats.jsonl")), readJsonl(path.join(out, "forge", "ledger.jsonl")), u.task_type || "pure-function", { candidatesUsed: new Set([model]) }); const alt = next.model && next.model !== model ? next.model : null; if (alt) r = await runMicro(u, holdoutFor(file), { model: alt, apply: flag("--apply"), numCtx: Number(opt("--num-ctx", 8192)), timeoutMs, workspace, out, jsonMode, reworkRound: 1, pastMistakes: pastMistakes() }); }
      return r;
    }
    return runPacket(u, { model, apply: flag("--apply"), numCtx: Number(opt("--num-ctx", 16384)), timeoutMs, workspace, out });
  };
  const line = (record, runDir) => `${String(record.status).padEnd(12)} ${record.unit || record.packet}  model=${record.model}  files=${record.files.length}${record.refused.length ? ` refused=${record.refused.length}` : ""}${record.verify && record.verify.visible_exit != null ? `  visible=${record.verify.visible_exit === 0 ? "pass" : "fail"} holdout=${record.verify.holdout_exit === 0 ? "pass" : "fail"}` : ""}${record.design_gap ? " DESIGN_GAP" : ""}${record.purity ? ` impure:${record.purity.join("|")}` : ""}${runDir ? `\n${runDir}` : ""}`;
  const OK = new Set(["verified", "staged", "applied"]);
  if (cmd === "run" && arg) { const { record, runDir } = await runOne(arg); console.log(line(record, runDir)); for (const v of Array.isArray(record.verify) ? record.verify : []) if (v.cmd) console.log(`  ${v.code === 0 ? "PASS" : "FAIL"} ${v.cmd}`); return OK.has(record.status) ? 0 : 1; }
  if (cmd === "queue" && arg) {
    const q = JSON.parse(fs.readFileSync(arg, "utf8")); const base = path.dirname(path.resolve(arg)); let failed = 0;
    for (const item of q.packets || []) {
      const file = path.isAbsolute(item.file) ? item.file : fs.existsSync(path.resolve(item.file)) ? path.resolve(item.file) : path.join(base, path.basename(item.file));
      const { record } = await runOne(file); console.log(line(record, ""));
      if (!OK.has(record.status)) { failed++; if (!flag("--continue")) { console.log("stopped on the first failed unit (STD-005 R5); pass --continue to keep going"); break; } }
    }
    return failed ? 1 : 0;
  }
  console.log("usage: forge models | smoke <model> | override <model> --reason \"...\" | pick --task-type T | warm --model M | estimate <unit> | prompt <unit> | run <unit> [--model M] [--apply] [--num-ctx N] [--timeout S] [--json-mode] [--rework] | queue <queue.json> [--apply] [--continue] | verify <packet>");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // exitCode, not process.exit(): on Windows an immediate exit right after a child process closes trips a libuv assertion
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message || e); process.exitCode = 1; });
}
