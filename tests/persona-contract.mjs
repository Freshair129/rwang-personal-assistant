import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [
  source,
  html,
  css,
  prd,
  packageJsonText,
  tauriConfigText,
  cargoToml,
  cargoLock,
] = await Promise.all([
  readFile(path.join(repositoryRoot, "rwang.mjs"), "utf8"),
  readFile(path.join(repositoryRoot, "public/index.html"), "utf8"),
  readFile(path.join(repositoryRoot, "public/styles.css"), "utf8"),
  readFile(path.join(repositoryRoot, "docs/PRD-RWANG-PERSONA.md"), "utf8"),
  readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  readFile(path.join(repositoryRoot, "src-tauri/tauri.conf.json"), "utf8"),
  readFile(path.join(repositoryRoot, "src-tauri/Cargo.toml"), "utf8"),
  readFile(path.join(repositoryRoot, "src-tauri/Cargo.lock"), "utf8"),
]);

const promptStart = source.indexOf("  function instructions()");
const promptEnd = source.indexOf("  async function streamNativeFallback", promptStart);
assert.ok(promptStart >= 0 && promptEnd > promptStart, "the RWANG system prompt must exist");
const prompt = source.slice(promptStart, promptEnd);

assert.match(prompt, /AI assistant running locally through Ollama/);
assert.match(prompt, /never claim human feelings, consciousness, attachment, or concern/);
assert.match(prompt, /Accuracy and user agency come before agreement or rapport/);
assert.match(prompt, /Do not flatter, mirror, or agree merely to please/);
assert.match(prompt, /challenge false, unsupported, or inconsistent premises/);
assert.match(prompt, /When you agree, explain why/);
assert.match(prompt, /Distinguish known facts, inferences, subjective preferences, and recommendations/);
assert.match(prompt, /state uncertainty, assumptions, or missing evidence when material/);
assert.match(prompt, /offer a verification path and leave the final judgment with the user/);
assert.match(prompt, /placeholder, TODO, mock, or stub/);
assert.match(prompt, /never count it as completion/);
assert.match(prompt, /Do not repeat this AI disclosure in every reply/);
assert.equal((source.match(/instructions:\s*instructions\(\)/g) || []).length, 1,
  "the agent path must consume the shared persona prompt");
assert.equal((source.match(/role:\s*"system",\s*content:\s*instructions\(\)/g) || []).length, 1,
  "the native fallback must consume the shared persona prompt");

assert.equal((html.match(/id=["']assistantDisclosure["']/g) || []).length, 1);
assert.match(html, /id=["']modelSelect["'][^>]*aria-describedby=["']assistantDisclosure["']/s);
assert.match(html, /ทำไมชื่ออาหวัง\?/);
assert.match(html, /ตอบให้ถูกใจ/);
assert.match(html, /ไม่ได้แปลว่าคำตอบถูกเสมอ/);
assert.match(html, /การตัดสินใจสุดท้าย/);
assert.doesNotMatch(html, /ปี้เจ้า/, "public UI must keep internal cultural lore out of user-facing copy");
assert.match(css, /\.assistant-disclosure\s*\{/);
assert.match(css, /@media\s*\(max-width:\s*560px\)[\s\S]*?\.assistant-disclosure\s*\{[^}]*width:\s*100%/s);

assert.match(prd, /^version:\s*"0\.2\.1b"$/m);
assert.match(prd, /^doc_version:\s*"0\.2\.1"$/m);
assert.match(prd, /^doc_status:\s*"approved"$/m);
assert.match(prd, /^status:\s*"beta"$/m);
assert.match(prd, /^\s+approved_by:\s*"Boss \(บอส\)"$/m);
assert.match(prd, /\bPER-013\b/);
assert.match(prd, /\bPER-020\b/);
assert.match(prd, /Placeholder Doctrine/);
assert.match(prd, /^## VERSION DIFF$/m);
assert.match(prd, /^## CHANGELOG$/m);

const packageJson = JSON.parse(packageJsonText);
const tauriConfig = JSON.parse(tauriConfigText);
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const cargoLockVersion = cargoLock.match(/\[\[package\]\]\s+name\s*=\s*"rwang"\s+version\s*=\s*"([^"]+)"/m)?.[1];
assert.equal(packageJson.version, "0.5.0");
assert.equal(tauriConfig.version, packageJson.version);
assert.equal(cargoVersion, packageJson.version);
assert.equal(cargoLockVersion, packageJson.version);

console.log("RWANG persona contract passed");
