import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pagePath = path.join(rootDir, "public", "desktop-diagnostics.html");
const scriptPath = path.join(rootDir, "public", "desktop-diagnostics.js");
const docPath = path.join(rootDir, "docs", "media-parity.md");
const releaseDocPath = path.join(rootDir, "docs", "desktop-release.md");

for (const filePath of [pagePath, scriptPath, docPath, releaseDocPath]) await access(filePath);

const html = await readFile(pagePath, "utf8");
const script = await readFile(scriptPath, "utf8");
const docs = await readFile(docPath, "utf8");
const releaseDocs = await readFile(releaseDocPath, "utf8");

const syntax = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
assert.equal(syntax.status, 0, `desktop-diagnostics.js syntax failed:\n${syntax.stderr}`);

assert.match(html, /<link\s+rel="stylesheet"\s+href="\/styles\.css"\s*>/i, "diagnostic page must use same-origin styles");
assert.match(html, /<script\s+type="module"\s+src="\/desktop-diagnostics\.js"\s*><\/script>/i, "diagnostic page must use the local module");
assert.match(html, /<table\b[^>]*\bid="resultTable"/i, "diagnostic page must expose a semantic result table");
assert.match(html, /id="manualGateForm"/, "diagnostic page must expose the manual desktop gate");
assert.match(html, /<strong>ON DEVICE<\/strong><small>NO TELEMETRY<\/small>/,
  "diagnostic page must describe on-device data handling without claiming route access control");
assert.doesNotMatch(html, /LOCAL ONLY/i, "diagnostic UI must not present no-telemetry as a route ACL");
assert.match(html, /Tray &gt; Quit/, "manual gate must use tray Quit for sidecar shutdown evidence");
assert.match(html, /not an access-control boundary/i, "diagnostic UI must state the access-control limitation");
assert.doesNotMatch(html, /<style\b|\son[a-z]+\s*=/i, "diagnostic page must not use inline style or event handlers");
assert.doesNotMatch(html, /<iframe\b|<object\b|<embed\b/i, "diagnostic page must not embed an external surface");

const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/gi)].map((match) => match[1]);
assert.ok(references.length > 0, "diagnostic page should have inspectable resource references");
for (const reference of references) {
  assert.doesNotMatch(reference, /^(?:https?:)?\/\//i, `resource reference must not be remote: ${reference}`);
  assert.ok(reference === "/" || reference.startsWith("/"), `resource reference must be rooted locally: ${reference}`);
}

const activeButtons = [...html.matchAll(/<button\b([^>]*)data-media-test="([^"]+)"([^>]*)>/gi)]
  .map((match) => `${match[1]}${match[3]}`);
assert.deepEqual(
  [...html.matchAll(/data-media-test="([^"]+)"/g)].map((match) => match[1]),
  ["camera", "microphone", "display"],
  "camera, microphone, and display must each have one explicit button",
);
assert.equal(activeButtons.length, 3, "active media controls must not be duplicated");
for (const attributes of activeButtons) assert.match(attributes, /\btype="button"/i, "active media controls must not submit a form");

assert.match(script, /getUserMedia\s*\(/, "active camera/microphone request must be present");
assert.match(script, /getDisplayMedia\s*\(/, "active display request must be present");
assert.match(script, /track\.stop\s*\(\)/, "every active stream contract must stop tracks");
assert.match(script, /button\.addEventListener\("click"[\s\S]*runActiveMediaTest/, "active requests must be behind a user click handler");
assert.match(script, /stream\s*=\s*await requestMedia\(kind\);[\s\S]{0,320}stopStreamTracks\(stream\)/, "tracks must be stopped immediately after a stream resolves");

const passiveStart = script.indexOf("async function runPassiveChecks");
const requestStart = script.indexOf("async function requestMedia");
assert.ok(passiveStart >= 0 && requestStart > passiveStart, "passive checks function must exist before active request code");
const passiveBlock = script.slice(passiveStart, requestStart);
assert.doesNotMatch(passiveBlock, /\.get(?:UserMedia|DisplayMedia)\s*\(/, "passive checks must not request media permission");
assert.doesNotMatch(script, /\b(?:sendBeacon|XMLHttpRequest|WebSocket|EventSource)\b/, "diagnostic page must not upload or emit telemetry");
assert.doesNotMatch(
  script,
  /\b(?:localStorage|sessionStorage|indexedDB)\b/,
  "diagnostic results and attestations must remain in page memory",
);
assert.match(script, /method:\s*"HEAD"/, "MediaPipe probes must use header-only requests");
assert.match(script, /credentials:\s*"omit"/, "MediaPipe probes must not send origin credentials");
assert.match(script, /mode:\s*"same-origin"/, "MediaPipe probes must stay same-origin");
assert.match(script, /redirect:\s*"error"/, "MediaPipe probes must reject redirects");

const assetPaths = [...script.matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1]);
assert.ok(assetPaths.length >= 9, "MediaPipe module, WASM, and model paths must be covered");
for (const assetPath of assetPaths) assert.match(assetPath, /^\/vendor\//, `MediaPipe asset must be local: ${assetPath}`);
assert.match(script, /url\.origin\s*!==\s*window\.location\.origin/, "asset URLs must be origin checked");

assert.match(docs, /desktop-diagnostics\.html/, "manual guide must link the diagnostics page");
assert.match(docs, /Tauri/i, "manual guide must cover Tauri");
assert.match(docs, /WebView2/i, "manual guide must cover WebView2");
assert.match(docs, /getUserMedia/i, "manual guide must explain camera/microphone permission behavior");
assert.match(docs, /getDisplayMedia/i, "manual guide must explain display permission behavior");
assert.match(docs, /หยุด|stop/i, "manual guide must explain track cleanup");
assert.match(docs, /ไม่ส่ง|ไม่.*upload|telemetry/i, "manual guide must document the no-upload contract");
assert.match(
  docs,
  /not an access-control claim/i,
  "manual guide must not misrepresent no-telemetry processing as route access control",
);
assert.match(
  docs,
  /http:\/\/127\.0\.0\.1:<selected-port>\/desktop-diagnostics\.html/,
  "desktop evidence must use the exact selected loopback sidecar origin",
);
assert.match(docs, /Close the window with \*\*X\*\*/i, "manual guide must explain hide-to-tray behavior");
assert.match(docs, /Tray > Quit/i, "manual guide must use explicit Quit for sidecar shutdown evidence");
assert.match(releaseDocs, /does not enforce a route ACL:[\s\S]*reports\s+`FAIL`[\s\S]*server binding remains the access boundary/i,
  "release guide must describe non-loopback diagnostics without claiming a route ACL");
assert.doesNotMatch(releaseDocs, /not a LAN\/mobile diagnostic endpoint/i,
  "release guide must not imply that static page availability is access controlled");

console.log("RWANG media parity static tests passed");
