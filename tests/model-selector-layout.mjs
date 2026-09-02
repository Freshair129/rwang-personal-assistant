import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [html, css, app] = await Promise.all([
  readFile(path.join(repositoryRoot, "public/index.html"), "utf8"),
  readFile(path.join(repositoryRoot, "public/styles.css"), "utf8"),
  readFile(path.join(repositoryRoot, "public/app.js"), "utf8"),
]);

const modelSelectIds = html.match(/id=["']modelSelect["']/g) || [];
assert.equal(modelSelectIds.length, 1, "the chat page must expose exactly one model selector");
const disclosureIds = html.match(/id=["']assistantDisclosure["']/g) || [];
assert.equal(disclosureIds.length, 1, "the chat page must expose exactly one assistant disclosure");

const composerStart = html.indexOf('id="composerForm"');
const composerEnd = html.indexOf("</form>", composerStart);
const modelContainer = html.indexOf('class="composer-model"');
const modelSelect = html.indexOf('id="modelSelect"');
const modelLabelEnd = html.indexOf("</label>", modelSelect);
const disclosure = html.indexOf('id="assistantDisclosure"');
assert.ok(composerStart >= 0 && composerEnd > composerStart, "the chat composer must exist");
assert.ok(modelContainer > composerEnd, "the model selector container must render below the chat composer");
assert.ok(modelSelect > modelContainer, "the model selector must stay inside its below-composer container");
assert.ok(disclosure > modelLabelEnd, "the assistant disclosure must follow the selector and stay outside its label");
assert.match(html, /id=["']modelSelect["'][^>]*aria-describedby=["']assistantDisclosure["']/s,
  "the model selector must reference the assistant disclosure");
assert.doesNotMatch(html.slice(disclosure, html.indexOf("</p>", disclosure)), /\b(?:hidden|aria-hidden|aria-live)\b/,
  "the assistant disclosure must remain visible without live announcements");

assert.match(css, /\.composer-model\s*\{[^}]*display:\s*flex[^}]*\}/s);
assert.match(css, /\.assistant-disclosure\s*\{[^}]*color:\s*var\(--muted\)[^}]*line-height:\s*1\.55[^}]*\}/s,
  "the disclosure must be visually secondary but readable");
assert.match(css, /@media[^{}]*\([^)]*max-width[^)]*\)[\s\S]*?\.composer-model\s*\{[^}]*align-items:\s*stretch[^}]*\}[\s\S]*?\.assistant-disclosure\s*\{[^}]*width:\s*100%[^}]*\}/s,
  "the below-composer selector must expand cleanly on narrow mobile screens");
assert.match(css, /@media\s*\(max-width:\s*560px\)[\s\S]*?main\s*\{[^}]*padding-bottom:\s*(?:5[4-9]|[6-9]\d)px[^}]*\}/s,
  "mobile content needs enough bottom clearance for the fixed navigation bar");
assert.match(app, /\$\("#modelSelect"\)/, "chat behavior must keep using the stable modelSelect id");

console.log("RWANG model selector layout contract passed");
