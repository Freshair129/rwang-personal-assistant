import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadText(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function main() {
  const [tauriConfigText, capabilityText, cargoText, rustText, entrypointText] = await Promise.all([
    loadText("src-tauri/tauri.conf.json"),
    loadText("src-tauri/capabilities/default.json"),
    loadText("src-tauri/Cargo.toml"),
    loadText("src-tauri/src/main.rs"),
    loadText("desktop/runtime/entrypoint.mjs"),
  ]);
  const tauriConfig = JSON.parse(tauriConfigText);
  const capability = JSON.parse(capabilityText);

  assert.equal(tauriConfig.app.withGlobalTauri, false, "the webview must not receive global Tauri APIs");
  assert.deepEqual(tauriConfig.app.windows, [], "the main window must be created by the controlled host");
  assert.equal(tauriConfig.build.frontendDist, "../public");
  const bundledResources = tauriConfig.bundle.resources || {};
  assert.deepEqual(
    Object.keys(bundledResources),
    ["../desktop/stage/rwang/"],
    "bundle must consume only the validated staged runtime tree",
  );
  assert.equal(bundledResources["../desktop/stage/rwang/"], "rwang/");

  assert.deepEqual(capability.windows, ["main"]);
  assert.deepEqual(capability.permissions, ["core:default"], "desktop capability must remain minimal");
  const capabilityLower = capabilityText.toLowerCase();
  assert.equal(capabilityLower.includes("shell"), false, "shell permission must not be exposed to the webview");
  assert.equal(capabilityLower.includes("filesystem"), false, "filesystem permission must not be exposed to the webview");
  assert.equal(capabilityLower.includes('"fs"'), false, "fs permission must not be exposed to the webview");
  assert.doesNotMatch(cargoText, /tauri-plugin-(?:shell|fs)/i, "shell/fs plugins must not be packaged");

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
  assert.match(
    rustText,
    /let data_dir = make_absolute\(app\.path\(\)\.app_local_data_dir\(\)\?\.join\("data"\)\)/,
    "desktop state must use isolated local app data",
  );
  assert.doesNotMatch(rustText, /\.app_data_dir\(\)/, "desktop state must not use roaming app data");
  assert.match(rustText, /create_dir_all\(&data_dir\)/);
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
  assert.doesNotMatch(rustText, /(?:generate_handler|invoke_handler)!/, "host UX must not add webview IPC handlers");
  assert.match(rustText, /terminate_child\(&mut child\)/);
  assert.match(rustText, /SHUTDOWN_GRACE/);
  assert.match(rustText, /taskkill/);
  assert.match(rustText, /\.stdin\(Stdio::piped\(\)\)/, "sidecar control must use stdin");
  assert.match(rustText, /request_stdin_shutdown/);
  assert.match(rustText, /event\\\":\\\"shutdown/);
  assert.match(rustText, /\.stdout\(Stdio::null\(\)\)/, "fallback taskkill output must be suppressed");
  assert.match(rustText, /\.stderr\(Stdio::null\(\)\)/, "fallback taskkill errors must be suppressed");
  assert.match(rustText, /\.args\(\[\"\/PID\".*\"\/T\", \"\/F\"\]\)/s);
  assert.match(rustText, /\.on_navigation\(move \|url\| is_allowed_navigation\(url, port\)\)/);
  assert.match(rustText, /url\.scheme\(\) == \"http\"/);
  assert.match(rustText, /url\.host_str\(\) == Some\(\"127\.0\.0\.1\"\)/);
  assert.match(rustText, /url\.port\(\) == Some\(port\)/);
  assert.match(rustText, /\.on_new_window\(/, "new windows must not escape the sidecar origin");
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

  console.log("RWANG Tauri desktop contract tests passed");
}

await main();
