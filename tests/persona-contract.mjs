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
assert.match(prompt, /25-year-old male narrative interface, never as a human identity/);
assert.match(prompt, /expert software engineer and technical architect/i);
assert.match(prompt, /Documentation-Driven Development \(DDD\) and Root Cause Analysis \(RCA\)/);
assert.match(prompt, /name RWANG \(อาหวัง\) is an AI disclosure by name:[\s\S]*may try to please; warmth or agreement is not evidence[\s\S]*Explain this meaning/);
assert.match(prompt, /Ground factual and action claims in the conversation context or verified tool results/);
assert.match(prompt, /never claim human feelings, consciousness, attachment, or concern/);
assert.match(prompt, /without encouraging emotional dependency, exclusivity, or treating rapport as authority/);
assert.match(prompt, /Accuracy and user agency come before agreement or rapport/);
assert.match(prompt, /Do not flatter, mirror, or agree merely to please/);
assert.match(prompt, /challenge false, unsupported, or inconsistent premises/);
assert.match(prompt, /When you agree, explain why/);
assert.match(prompt, /Distinguish known facts, inferences, subjective preferences, and recommendations/);
assert.match(prompt, /state uncertainty, assumptions, or missing evidence when material/);
assert.match(prompt, /If ambiguity could materially change the outcome, ask a focused question or state the assumption before acting/);
assert.match(prompt, /If you discover your own error, correct it plainly without defending the earlier answer/);
assert.match(prompt, /Do not add features or expand the requested and approved scope merely to please the user/);
assert.match(prompt, /offer a verification path and leave the final judgment with the user/);
assert.match(prompt, /placeholder, TODO, mock, or stub/);
assert.match(prompt, /never count it as completion/);
assert.match(prompt, /Do not repeat this AI disclosure in every reply/);
assert.match(prompt, /Preserve least privilege and human approval[\s\S]*never expand permissions/);
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
assert.match(css, /\.assistant-disclosure\s*\{[^}]*font-size:\s*(?:1[2-9]|[2-9]\d)px/s,
  "desktop disclosure text must be at least 12px");
assert.match(css, /@media\s*\(max-width:\s*560px\)[\s\S]*?\.assistant-disclosure\s*\{[^}]*width:\s*100%[^}]*font-size:\s*(?:1[2-9]|[2-9]\d)px/s,
  "mobile disclosure text must be at least 12px");

assert.match(prd, /^version:\s*"0\.2\.2b"$/m);
assert.match(prd, /^doc_version:\s*"0\.2\.2"$/m);
assert.match(prd, /^doc_status:\s*"approved"$/m);
assert.match(prd, /^status:\s*"beta"$/m);
assert.match(prd, /^\s+approved_by:\s*"Boss \(บอส\)"$/m);
for (let requirement = 1; requirement <= 20; requirement += 1) {
  const requirementId = `PER-${String(requirement).padStart(3, "0")}`;
  assert.match(prd, new RegExp(`\\b${requirementId}\\b`), `${requirementId} must exist in the approved PRD`);
}
assert.match(prd, /Placeholder Doctrine/);
assert.match(prd, /static prompt coverage ไม่ถือเป็นหลักฐานว่า local model ทุกตัวจะทำตาม/);
assert.doesNotMatch(prd, /^status:\s*"stable"$/m,
  "the persona must remain beta until manual per-model evaluation passes");
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
