#!/usr/bin/env node
// RWANG Forge — run one implementation packet (STD-005 of the target specification repository)
// against a local Ollama model, stage the files it returns, apply them to the workspace only when
// asked, run the packet's verification commands, and keep an evidence record of the run.
//
// The packet is produced by the specification repository's own tool (zuri-next: tools/packet.mjs).
// Forge never reads the specification itself: everything the model may see is inside the packet.
//
//   node forge.mjs models                                   list Ollama models
//   node forge.mjs estimate <packet.json>                   token estimate and what the packet contains
//   node forge.mjs prompt <packet.json>                     print the exact messages that would be sent
//   node forge.mjs run <packet.json> [--model M] [--apply] [--num-ctx 16384] [--timeout 600]
//   node forge.mjs queue <queue.json> [--model M] [--apply] [--continue]
//   node forge.mjs verify <packet.json>                     run only the verification commands
//
// Environment (same names as the RWANG server; .env is loaded by the package script):
//   OLLAMA_URL            default http://127.0.0.1:11434
//   RWANG_WORKSPACE_DIR   the code repository the packet targets (required for --apply and verify)
//   RWANG_DATA_DIR        where run records and staged files go (default %LOCALAPPDATA%\RWANG\data)
//   RWANG_FORGE_MODEL     default model when --model is not given
//
// Boundaries: files may land only under the packet's allowed_paths inside the workspace; a path that
// escapes the workspace or contains `..` is refused; verification runs only node/npm/pnpm/npx commands;
// a run never deletes anything; without --apply nothing outside DATA_DIR is written.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const FORGE_VERSION = "0.1.0";
const VERIFY_ALLOW = new Set(["node", "npm", "pnpm", "npx"]);

export function estimateTokens(text) { return Math.ceil(String(text).length / 3.6); }

/** Parse the model's answer into files: ```path=<rel> ... ``` blocks (info string may carry a language first). */
export function parseFileBlocks(text) {
  // Accepted forms, in order of preference (small models drift between them):
  //   ```path=a/b.js … ```                       the contract
  //   path=a/b.js  (own line) then ```lang … ``` the path on the line before the fence
  //   ```lang  then  // path: a/b.js  as the first line of the block
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

/** A relative path is accepted only inside one of the allowed prefixes and never escapes. */
export function guardPath(rel, allowed) {
  const norm = String(rel).replace(/\\/g, "/").replace(/^\.\//, "");
  if (!norm || path.isAbsolute(norm) || /^[A-Za-z]:/.test(norm) || norm.split("/").includes("..")) return { ok: false, reason: "path escapes the workspace" };
  if (norm === "DESIGN_GAP.md") return { ok: true, path: norm, gap: true };
  const hit = (allowed || []).some((p) => norm.startsWith(String(p).replace(/\\/g, "/").replace(/^\.\//, "")));
  return hit ? { ok: true, path: norm } : { ok: false, reason: `not under an allowed path (${(allowed || []).join(", ")})` };
}

export function buildMessages(packet) {
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
  const body = {
    requirement: packet.requirement,
    feature: packet.feature,
    design: packet.design,
    contracts: packet.contracts,
    rules: packet.rules,
    tests: packet.tests,
    existing_code: (packet.code || []).map((c) => ({ path: c.path, content: c.content })),
  };
  const user = `PACKET ${packet.id}\n\n${JSON.stringify(body, null, 1)}\n\nProduce the files now.`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function dataDir() {
  if (process.env.RWANG_DATA_DIR) return process.env.RWANG_DATA_DIR;
  return process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || os.homedir(), "RWANG", "data") : path.join(os.homedir(), ".rwang", "data");
}
const ollamaUrl = () => (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");

async function listModels() {
  const r = await fetch(`${ollamaUrl()}/api/tags`);
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`);
  return ((await r.json()).models || []).map((m) => ({ name: m.name, size: m.size, family: m.details?.family, params: m.details?.parameter_size, quant: m.details?.quantization_level }));
}

async function chat({ model, messages, numCtx, timeoutMs }) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${ollamaUrl()}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, signal: ac.signal,
      body: JSON.stringify({ model, messages, stream: false, keep_alive: "10m", options: { num_ctx: numCtx, temperature: 0.1 } }) });
    if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return { text: j.message?.content || "", eval_count: j.eval_count, prompt_eval_count: j.prompt_eval_count, total_duration_ms: Math.round((j.total_duration || 0) / 1e6) };
  } finally { clearTimeout(timer); }
}

function runCommand(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const [exe, ...args] = cmd.trim().split(/\s+/);
    if (!VERIFY_ALLOW.has(exe.replace(/\.(exe|cmd)$/i, ""))) return resolve({ cmd, code: -1, stdout: "", stderr: `refused: "${exe}" is not an allowed verification executable (${[...VERIFY_ALLOW].join(", ")})` });
    const child = spawn(exe, args, { cwd, shell: process.platform === "win32", env: process.env, windowsHide: true });
    let stdout = "", stderr = ""; const t = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d)); child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => { clearTimeout(t); resolve({ cmd, code, stdout: stdout.slice(-8000), stderr: stderr.slice(-8000) }); });
    child.on("error", (e) => { clearTimeout(t); resolve({ cmd, code: -1, stdout, stderr: String(e) }); });
  });
}

async function verify(packet, workspace, timeoutMs) {
  const results = [];
  for (const cmd of packet.verify || []) results.push(await runCommand(cmd, workspace, timeoutMs));
  return results;
}

export async function runPacket(packet, { model, apply = false, numCtx = 16384, timeoutMs = 600_000, workspace, out }) {
  if (!model) throw new Error("no model: pass --model or set RWANG_FORGE_MODEL");
  const runId = `${packet.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runDir = path.join(out, "forge", "runs", runId); fs.mkdirSync(path.join(runDir, "files"), { recursive: true });
  const messages = buildMessages(packet);
  const promptHash = crypto.createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 16);
  const record = { forge: FORGE_VERSION, run_id: runId, packet: packet.id, fr: packet.fr, layer: packet.layer, model, num_ctx: numCtx, prompt_hash: promptHash, prompt_tokens_estimate: estimateTokens(JSON.stringify(messages)), started_at: new Date().toISOString(), apply, files: [], refused: [], design_gap: null, verify: [], status: "started" };
  const reply = await chat({ model, messages, numCtx, timeoutMs });
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
  else if (apply && workspace && (packet.verify || []).length) { record.verify = await verify(packet, workspace, timeoutMs); record.status = record.verify.every((v) => v.code === 0) ? "verified" : "failed"; }
  else record.status = apply ? "applied" : "staged";
  record.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(runDir, "record.json"), JSON.stringify(record, null, 1) + "\n");
  return { record, runDir };
}

// ---- CLI ----
async function main(argv) {
  const cmd = argv[0]; const arg = argv[1];
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const flag = (n) => argv.includes(n);
  const model = opt("--model", process.env.RWANG_FORGE_MODEL || "");
  const numCtx = Number(opt("--num-ctx", 16384)); const timeoutMs = Number(opt("--timeout", 600)) * 1000;
  const workspace = process.env.RWANG_WORKSPACE_DIR ? path.resolve(process.env.RWANG_WORKSPACE_DIR) : null;
  const out = dataDir();
  const loadPacket = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
  if (cmd === "models") { for (const m of await listModels()) console.log(`${m.name}\t${m.params || ""}\t${m.quant || ""}\t${(m.size / 1e9).toFixed(1)} GB`); return 0; }
  if (cmd === "estimate" && arg) { const p = loadPacket(arg); const msgs = buildMessages(p); console.log(JSON.stringify({ packet: p.id, layer: p.layer, acceptance: p.requirement?.acceptance?.length || 0, tests: p.tests?.length || 0, contracts: p.contracts?.length || 0, rules: p.rules?.length || 0, code_files: p.code?.length || 0, allowed_paths: p.allowed_paths, prompt_tokens_estimate: estimateTokens(JSON.stringify(msgs)), fits_num_ctx: estimateTokens(JSON.stringify(msgs)) < numCtx * 0.75 }, null, 1)); return 0; }
  if (cmd === "prompt" && arg) { for (const m of buildMessages(loadPacket(arg))) console.log(`--- ${m.role} ---\n${m.content}\n`); return 0; }
  if (cmd === "verify" && arg) { if (!workspace) throw new Error("RWANG_WORKSPACE_DIR is required"); const r = await verify(loadPacket(arg), workspace, timeoutMs); for (const v of r) console.log(`${v.code === 0 ? "PASS" : "FAIL"} ${v.cmd}\n${v.stderr || v.stdout}`); return r.every((v) => v.code === 0) ? 0 : 1; }
  if (cmd === "run" && arg) { const { record, runDir } = await runPacket(loadPacket(arg), { model, apply: flag("--apply"), numCtx, timeoutMs, workspace, out }); console.log(`${record.status}  ${record.packet}  model=${record.model}  files=${record.files.length} refused=${record.refused.length}${record.design_gap ? " DESIGN_GAP" : ""}\n${runDir}`); for (const v of record.verify) console.log(`  ${v.code === 0 ? "PASS" : "FAIL"} ${v.cmd}`); return record.status === "verified" || record.status === "staged" || record.status === "applied" ? 0 : 1; }
  if (cmd === "queue" && arg) {
    const q = JSON.parse(fs.readFileSync(arg, "utf8")); const base = path.dirname(path.resolve(arg)); let failed = 0;
    for (const item of q.packets || []) {
      const file = path.isAbsolute(item.file) ? item.file : fs.existsSync(path.resolve(item.file)) ? path.resolve(item.file) : path.join(base, path.basename(item.file));
      const { record } = await runPacket(loadPacket(file), { model, apply: flag("--apply"), numCtx, timeoutMs, workspace, out });
      console.log(`${record.status.padEnd(11)} ${record.packet}  files=${record.files.length}${record.refused.length ? ` refused=${record.refused.length}` : ""}`);
      if (!["verified", "staged", "applied"].includes(record.status)) { failed++; if (!flag("--continue")) { console.log("stopped on the first failed packet (STD-005 R5); pass --continue to keep going"); break; } }
    }
    return failed ? 1 : 0;
  }
  console.log("usage: forge models | estimate <packet> | prompt <packet> | run <packet> [--model M] [--apply] [--num-ctx N] [--timeout S] | queue <queue.json> [--apply] [--continue] | verify <packet>");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message || e); process.exit(1); });
}
