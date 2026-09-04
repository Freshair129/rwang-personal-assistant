import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadText(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function main() {
  const [
    tauriConfigText,
    capabilityText,
    cargoText,
    rustText,
    spotlightText,
    buildScriptText,
    iconValidationText,
    entrypointText,
    appText,
    spotlightDocs,
    runtimeDocs,
    pngIcon,
    icoIcon,
  ] = await Promise.all([
    loadText("src-tauri/tauri.conf.json"),
    loadText("src-tauri/capabilities/default.json"),
    loadText("src-tauri/Cargo.toml"),
    loadText("src-tauri/src/main.rs"),
    loadText("src-tauri/src/spotlight_bridge.rs"),
    loadText("src-tauri/build.rs"),
    loadText("src-tauri/icon_validation.rs"),
    loadText("desktop/runtime/entrypoint.mjs"),
    loadText("public/app.js"),
    loadText("docs/spotlight-native-boundary.md"),
    loadText("desktop/runtime/README.md"),
    readFile(path.join(repositoryRoot, "src-tauri", "icons", "icon.png")),
    readFile(path.join(repositoryRoot, "src-tauri", "icons", "icon.ico")),
  ]);
  const tauriConfig = JSON.parse(tauriConfigText);
  const capability = JSON.parse(capabilityText);

  assert.equal(tauriConfig.app.withGlobalTauri, false, "the webview must not receive global Tauri APIs");
  assert.deepEqual(tauriConfig.app.windows, [], "the main window must be created by the controlled host");
  assert.equal(tauriConfig.build.frontendDist, "../public");
  assert.equal(tauriConfig.app.trayIcon.iconPath, "icons/icon.png");
  assert.deepEqual(
    tauriConfig.bundle.icon,
    ["icons/icon.png", "icons/icon.ico"],
    "the bundle must require the checked-in branded PNG and Windows ICO",
  );
  const bundledResources = tauriConfig.bundle.resources || {};
  assert.deepEqual(
    Object.keys(bundledResources),
    ["../desktop/stage/rwang/"],
    "bundle must consume only the validated staged runtime tree",
  );
  assert.equal(bundledResources["../desktop/stage/rwang/"], "rwang/");

  assert.deepEqual(
    [...pngIcon.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "icon.png must have the PNG signature",
  );
  assert.equal(pngIcon.subarray(12, 16).toString("ascii"), "IHDR", "icon.png must start with IHDR");
  assert.ok(pngIcon.readUInt32BE(16) >= 128, "icon.png must be at least 128 pixels wide");
  assert.ok(pngIcon.readUInt32BE(20) >= 128, "icon.png must be at least 128 pixels high");

  assert.equal(icoIcon.readUInt16LE(0), 0, "icon.ico reserved header must be zero");
  assert.equal(icoIcon.readUInt16LE(2), 1, "icon.ico must declare the icon resource type");
  const icoImageCount = icoIcon.readUInt16LE(4);
  assert.ok(icoImageCount > 0, "icon.ico must contain at least one image");
  assert.ok(icoIcon.length >= 6 + icoImageCount * 16, "icon.ico must contain every directory entry");

  assert.match(buildScriptText, /validate_png\(&source_icon\)/);
  assert.match(buildScriptText, /validate_ico\(&source_ico\)/);
  assert.ok(
    buildScriptText.indexOf("validate_png(&source_icon)") < buildScriptText.indexOf("tauri_build::try_build"),
    "build.rs must validate the PNG before invoking tauri-build",
  );
  assert.ok(
    buildScriptText.indexOf("validate_ico(&source_ico)") < buildScriptText.indexOf("tauri_build::try_build"),
    "build.rs must validate the ICO before invoking tauri-build",
  );
  assert.match(iconValidationText, /png::Decoder::new/);
  assert.match(iconValidationText, /reader\.next_frame\(&mut pixels\)/,
    "the PNG gate must decode the complete image payload");
  assert.match(iconValidationText, /width\s*<\s*128\s*\|\|\s*height\s*<\s*128/);
  assert.match(iconValidationText, /ico::IconDir::read/);
  assert.match(iconValidationText, /entry\.decode\(\)/,
    "the ICO gate must decode every directory entry");
  assert.match(iconValidationText, /largest_dimension\s*<\s*128/);
  assert.doesNotMatch(
    buildScriptText,
    /(?:fs::write|File::create|OpenOptions|write_all|copy\s*\(|OUT_DIR|fallback|placeholder|generate[_-]?icon)/i,
    "build.rs must validate checked-in icons without generating fallbacks or writing source files",
  );

  assert.deepEqual(capability.windows, ["main"]);
  assert.deepEqual(capability.permissions, ["core:default"], "desktop capability must remain minimal");
  const capabilityLower = capabilityText.toLowerCase();
  assert.equal(capabilityLower.includes("shell"), false, "shell permission must not be exposed to the webview");
  assert.equal(capabilityLower.includes("filesystem"), false, "filesystem permission must not be exposed to the webview");
  assert.equal(capabilityLower.includes('"fs"'), false, "fs permission must not be exposed to the webview");
  assert.doesNotMatch(cargoText, /tauri-plugin-(?:shell|fs)/i, "shell/fs plugins must not be packaged");
  assert.match(cargoText, /tauri-plugin-global-shortcut\s*=\s*"2"/);
  assert.match(cargoText, /\[build-dependencies\][\s\S]*ico\s*=\s*"0\.5"[\s\S]*png\s*=\s*"0\.17"/,
    "build.rs must use real PNG and ICO decoders");
  assert.match(cargoText, /\[features\][\s\S]*?default\s*=\s*\[\]/, "autostart must be absent from default features");
  assert.match(cargoText, /autostart\s*=\s*\["dep:tauri-plugin-autostart"\]/);

  assert.match(rustText, /tauri_plugin_single_instance::init/);
  assert.match(cargoText, /dunce\s*=\s*"1"/);
  assert.match(cargoText, /getrandom\s*=\s*"0\.2/);
  assert.match(rustText, /getrandom::getrandom/);
  assert.match(rustText, /dunce::simplified/);
  assert.match(rustText, /fn simplify_node_path/);
  assert.match(rustText, /DESKTOP_NONCE_BYTES:\s*usize\s*=\s*32/);
  assert.match(rustText, /generate_desktop_nonce/);
  assert.match(rustText, /window\.set_focus\(\)/, "second launches must focus the existing window");
  assert.match(rustText, /window\.unminimize\(\)/, "restoring a hidden window must unminimize it");
  assert.match(rustText, /pick_free_loopback_port\(\)/);
  assert.match(rustText, /TcpListener::bind\(\(Ipv4Addr::LOCALHOST, 0\)\)/);
  assert.match(rustText, /WebviewUrl::External\(webview_url\)/);
  assert.match(rustText, /format!\("http:\/\/127\.0\.0\.1:\{port\}\/"\)/);
  assert.doesNotMatch(rustText, /0\.0\.0\.0|\[::\]/, "desktop host must not expose a wildcard listener");
  assert.doesNotMatch(rustText, /\.navigate\(|navigate_to|load_url|set_url/, "navigation must stay on the fixed local origin");

  assert.match(rustText, /let resource_dir = make_absolute\(app\.path\(\)\.resource_dir\(\)\?\)/);
  assert.match(
    rustText,
    /let roots = resolve_roots\(app, &working_dir, &resource_dir, None, false\)\?/,
    "packaged resources must resolve from the server parent (rwang/) root",
  );
  assert.match(rustText, /resource_root: roots\.resource_root/);
  assert.match(rustText, /let application_root = make_absolute\(app\.path\(\)\.app_local_data_dir\(\)\?\)/);
  assert.match(rustText, /let data_dir = application_root\.join\("data"\)/, "desktop state must use isolated local app data");
  assert.doesNotMatch(rustText, /\.app_data_dir\(\)/, "desktop state must not use roaming app data");
  assert.doesNotMatch(rustText, /\.document_dir\(\)/, "packaged desktop must not silently grant Documents as the workspace");
  assert.match(rustText, /create_dir_all\(&data_dir\)/);
  assert.match(rustText, /let workspace_dir = application_root\.join\("workspace"\)/);
  assert.match(rustText, /workspace_dir\.is_absolute\(\)/);
  assert.match(rustText, /workspace_dir\.is_dir\(\)/);
  assert.match(rustText, /RWANG_WORKSPACE_DIR must be an absolute existing directory/);
  assert.match(rustText, /RWANG_RESOURCE_DIR/);
  assert.match(rustText, /RWANG_DATA_DIR/);
  assert.match(rustText, /RWANG_WORKSPACE_DIR/);
  assert.match(rustText, /RWANG_CAPABILITY_DIR/);
  assert.match(rustText, /\.current_dir\(&runtime\.working_dir\)/);
  assert.match(rustText, /\.arg\(&runtime\.launcher\)/);
  for (const variable of [
    "OLLAMA_CENTER_PORT",
    "RWANG_HOST",
    "RWANG_SERVER_ENTRYPOINT",
    "RWANG_DESKTOP_NONCE",
    "RWANG_RESOURCE_DIR",
    "RWANG_DATA_DIR",
    "RWANG_WORKSPACE_DIR",
    "RWANG_CAPABILITY_DIR",
  ]) {
    assert.match(rustText, new RegExp(`\\.env\\(\\"${variable}\\"`), `${variable} must be host-owned`);
  }

  assert.match(rustText, /RunEvent::ExitRequested/);
  assert.match(rustText, /RunEvent::WindowEvent/);
  assert.match(rustText, /WindowEvent::CloseRequested/);
  assert.match(rustText, /api\.prevent_close\(\)/, "window close must be intercepted");
  assert.match(rustText, /window\.hide\(\)/, "window close must hide to the tray");
  assert.match(rustText, /TRAY_QUIT_ID => app\.exit\(0\)/, "tray Quit must use app exit");
  assert.match(rustText, /spotlight_bridge::focus_spotlight_window/);
  assert.match(rustText, /SPOTLIGHT_SHORTCUT:\s*&str\s*=\s*"Ctrl\+Shift\+Space"/);
  assert.match(rustText, /tauri_plugin_global_shortcut::Builder::new\(\)\.build\(\)/);
  assert.match(rustText, /ShortcutState::Pressed[\s\S]*focus_spotlight_window\(app\)/);
  assert.doesNotMatch(rustText, /(?:generate_handler!|\.invoke_handler\s*\()/, "host UX must not add webview IPC handlers");
  assert.doesNotMatch(spotlightText, /#\[tauri::command\]|\bAppHandle\b|\.invoke\s*\(/, "Spotlight must remain a host-only focus helper");
  assert.doesNotMatch(spotlightText, /(?:std::fs|std::process|Command::new|PathBuf|tauri_plugin_shell)/, "Spotlight bridge must not read files or spawn processes");
  const focusScriptStart = spotlightText.indexOf("const SPOTLIGHT_FOCUS_SCRIPT");
  const focusScriptEnd = spotlightText.indexOf("pub fn build_spotlight_focus_script", focusScriptStart);
  assert.ok(focusScriptStart >= 0 && focusScriptEnd > focusScriptStart, "Spotlight fixed focus script must be identifiable");
  const focusScript = spotlightText.slice(focusScriptStart, focusScriptEnd);
  assert.match(focusScript, /getElementById\("spotlightButton"\)/);
  assert.match(focusScript, /button\.hidden[\s\S]*button\.disabled[\s\S]*button\.click\(\)/,
    "the host must enter the canonical UI handler through the visible enabled button");
  assert.doesNotMatch(focusScript, /showModal|spotlightDialog|spotlightInput/,
    "the host bridge must not bypass openSpotlight initialization and guards");
  assert.match(appText, /function openSpotlight\(\)[\s\S]*spotlightIsLocal\(\)[\s\S]*settingsDialog[\s\S]*spotlightResults\s*=\s*\[\][\s\S]*renderSpotlightEmpty[\s\S]*refreshSpotlightStatus/s,
    "the canonical UI handler must retain access/settings guards and state initialization");
  assert.match(appText, /spotlightButton"\)\.addEventListener\("click", openSpotlight\)/,
    "the button clicked by the host must stay wired to openSpotlight");
  assert.match(rustText, /terminate_child\(&mut child\)/);
  assert.match(rustText, /SHUTDOWN_GRACE/);
  assert.match(rustText, /taskkill/);
  assert.match(rustText, /\.stdin\(Stdio::piped\(\)\)/, "sidecar control must use stdin");
  assert.match(rustText, /request_stdin_shutdown/);
  assert.match(rustText, /event\\\":\\\"shutdown/);
  assert.match(rustText, /\.stdout\(Stdio::null\(\)\)/, "fallback taskkill output must be suppressed");
  assert.match(rustText, /\.stderr\(Stdio::null\(\)\)/, "fallback taskkill errors must be suppressed");
  assert.match(rustText, /\.args\(\["\/PID".*"\/T", "\/F"\]\)/s);
  assert.match(rustText, /\.on_navigation\(move \|url\| is_allowed_navigation\(url, port\)\)/);
  assert.match(rustText, /port\s*!=\s*0[\s\S]*url\.scheme\(\)\s*==\s*"http"/);
  assert.match(rustText, /url\.host_str\(\) == Some\("127\.0\.0\.1"\)/);
  assert.match(rustText, /url\.port\(\) == Some\(port\)/);
  assert.match(rustText, /\.on_new_window\([^;]+NewWindowResponse::Deny/s, "new windows must not escape the sidecar origin");
  assert.match(rustText, /MAX_PORT_ATTEMPTS/);
  assert.match(rustText, /port_is_free\(port\)/);
  assert.match(cargoText, /hmac\s*=\s*"0\.12/);
  assert.match(cargoText, /sha2\s*=\s*"0\.10/);
  assert.match(rustText, /HmacSha256/);
  assert.match(rustText, /x-rwang-desktop-challenge/);
  assert.match(rustText, /x-rwang-desktop-proof/);
  assert.match(rustText, /verify_desktop_proof/);
  assert.match(rustText, /verify_slice/);
  assert.doesNotMatch(rustText, /x-rwang-desktop-nonce/);
  assert.match(rustText, /status_code != 200/);
  assert.match(rustText, /payload\.get\("service"\)/);
  assert.match(rustText, /payload\.get\("ready"\)/);
  assert.match(rustText, /json_ready && probe_http\(port, desktop_nonce\)/);
  assert.match(rustText, /ensure_child_running\(child\)\?;\s*if json_ready && probe_http/s);
  assert.match(rustText, /if json_ready && probe_http[\s\S]*?ensure_child_running\(child\)\?;/);
  assert.match(rustText, /SHUTDOWN_GRACE: Duration = Duration::from_secs\((?:[5-9]|[1-9][0-9]+)\)/);
  assert.match(rustText, /#\[cfg\(feature = "autostart"\)\][\s\S]*fn maybe_enable_autostart/);
  assert.match(rustText, /RWANG_ENABLE_AUTOSTART/);
  assert.match(rustText, /\.unwrap_or\(false\)/, "autostart must remain opt-in even in feature builds");

  assert.match(entrypointText, /path\.isAbsolute\(serverEntrypoint\)/);
  assert.match(entrypointText, /RWANG_DESKTOP_NONCE/);
  assert.match(entrypointText, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(entrypointText, /http:\/\/127\.0\.0\.1:\$\{port\}/);
  assert.match(entrypointText, /randomBytes\(32\)\.toString\("hex"\)/);
  assert.match(entrypointText, /x-rwang-desktop-challenge/);
  assert.match(entrypointText, /x-rwang-desktop-proof/);
  assert.match(entrypointText, /createHmac\("sha256"/);
  assert.match(entrypointText, /timingSafeEqual/);
  assert.doesNotMatch(entrypointText, /x-rwang-desktop-nonce/);
  assert.match(entrypointText, /response\.status === 200/);
  assert.match(entrypointText, /health\?\.service === "rwang"/);
  assert.match(entrypointText, /health\?\.ready === true/);
  assert.match(entrypointText, /emit\("ready"/);
  assert.match(entrypointText, /emit\("fatal"/);
  assert.match(entrypointText, /readline\.createInterface/);
  assert.match(entrypointText, /event !== "shutdown"/);
  assert.match(entrypointText, /process\.emit\("SIGTERM"\)/, "Windows must dispatch graceful SIGTERM listeners");
  assert.match(entrypointText, /process\.kill\(process\.pid, "SIGTERM"\)/);
  assert.match(entrypointText, /releaseControlInput/);
  assert.doesNotMatch(entrypointText, /https?:\/\/(?!127\.0\.0\.1)/, "runtime probe must stay loopback-only");

  assert.match(spotlightDocs, /not registered through\s+`invoke_handler`/);
  assert.match(spotlightDocs, /Ctrl\+Shift\+Space/);
  assert.match(spotlightDocs, /paths, queries, and fragments are allowed/);
  assert.match(runtimeDocs, /does not parse or bundle that file/);
  assert.match(runtimeDocs, /never silently promotes Documents/);
  assert.match(runtimeDocs, /32-byte operating-system-random nonce/);
  assert.match(runtimeDocs, /Tray > Quit/);
  assert.match(runtimeDocs, /waits up to seven seconds/);
  assert.match(runtimeDocs, /Autostart is default-off/);

  console.log("RWANG Tauri desktop contract tests passed");
}

await main();
