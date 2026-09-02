#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs::create_dir_all;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, TcpListener, TcpStream};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
#[cfg(feature = "autostart")]
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[allow(dead_code)]
mod spotlight_bridge;

const DEFAULT_READY_TIMEOUT: Duration = Duration::from_secs(30);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(100);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(350);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(7);
const DESKTOP_NONCE_BYTES: usize = 32;
const MAX_HEALTH_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_PORT_ATTEMPTS: usize = 3;
const TRAY_ICON_ID: &str = "main";
const TRAY_SHOW_ID: &str = "show-rwang";
const TRAY_SPOTLIGHT_ID: &str = "open-spotlight";
const TRAY_QUIT_ID: &str = "quit-rwang";
const SPOTLIGHT_SHORTCUT: &str = "Ctrl+Shift+Space";

#[derive(Debug)]
struct HostError(String);

impl HostError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for HostError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for HostError {}

type HostResult<T> = Result<T, Box<dyn Error>>;
type HmacSha256 = Hmac<Sha256>;

#[derive(Debug)]
enum RuntimeSignal {
    Ready { port: u16 },
    Fatal { message: String },
    Output { stream: &'static str, line: String },
}

#[derive(Debug)]
enum NodeProgram {
    Portable(PathBuf),
    System,
}

impl NodeProgram {
    fn describe(&self) -> String {
        match self {
            Self::Portable(path) => format!("portable Node at {}", path.display()),
            Self::System => "system node (development fallback)".to_owned(),
        }
    }

    fn command(&self) -> &Path {
        match self {
            Self::Portable(path) => path,
            // The value is only used with Command::new.  It is deliberately not
            // treated as a resource path; packaged builds must resolve Portable.
            Self::System => Path::new("node"),
        }
    }
}

#[derive(Debug)]
struct RuntimePaths {
    node: NodeProgram,
    launcher: PathBuf,
    server: PathBuf,
    working_dir: PathBuf,
    resource_root: PathBuf,
    data_dir: PathBuf,
    workspace_dir: PathBuf,
    capability_dir: PathBuf,
}

impl RuntimePaths {
    fn resolve(app: &AppHandle) -> HostResult<Self> {
        let resource_dir = make_absolute(app.path().resource_dir()?);
        let project_root = make_absolute(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."));

        // The resource destination is intentionally stable (`rwang/...`) so
        // startup does not depend on the process current directory or on a
        // platform-specific bundle layout.  The additional candidates keep
        // unpacked bundles and older local bundle layouts usable.
        let resource_launcher = first_file([
            resource_dir.join("rwang/entrypoint.mjs"),
            resource_dir.join("rwang/runtime/entrypoint.mjs"),
            resource_dir.join("entrypoint.mjs"),
            resource_dir.join("runtime/entrypoint.mjs"),
        ]);
        let resource_server = first_file([
            resource_dir.join("rwang/server.mjs"),
            resource_dir.join("rwang/runtime/server.mjs"),
            resource_dir.join("server.mjs"),
            resource_dir.join("runtime/server.mjs"),
        ]);
        let resource_node = first_file([
            resource_dir.join("rwang/runtime/node/node.exe"),
            resource_dir.join("rwang/runtime/node/node"),
            resource_dir.join("runtime/node/node.exe"),
            resource_dir.join("runtime/node/node"),
            resource_dir.join("rwang/node.exe"),
            resource_dir.join("node.exe"),
            resource_dir.join("rwang/node"),
            resource_dir.join("node"),
        ]);

        if let (Some(launcher), Some(server), Some(node)) =
            (resource_launcher, resource_server, resource_node)
        {
            let working_dir = server
                .parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| HostError::new("packaged server has no parent directory"))?;
            let roots = resolve_roots(app, &working_dir, &resource_dir, None, false)?;
            return Ok(Self {
                node: NodeProgram::Portable(node),
                launcher,
                server,
                working_dir,
                resource_root: roots.resource_root,
                data_dir: roots.data_dir,
                workspace_dir: roots.workspace_dir,
                capability_dir: roots.capability_dir,
            });
        }

        // A source checkout is intentionally runnable before a portable Node
        // archive is supplied.  This branch is compiled into debug builds only;
        // a release bundle without its runtime fails closed with a clear error.
        if cfg!(debug_assertions) {
            let launcher = project_root.join("desktop/runtime/entrypoint.mjs");
            let server = project_root.join("server.mjs");
            if launcher.is_file() && server.is_file() {
                let roots =
                    resolve_roots(app, &project_root, &project_root, Some(&project_root), true)?;
                return Ok(Self {
                    node: NodeProgram::System,
                    launcher,
                    server,
                    working_dir: project_root,
                    resource_root: roots.resource_root,
                    data_dir: roots.data_dir,
                    workspace_dir: roots.workspace_dir,
                    capability_dir: roots.capability_dir,
                });
            }
        }

        Err(Box::new(HostError::new(format!(
            "RWANG runtime is incomplete: expected portable Node and entrypoint under {}",
            resource_dir.display()
        ))))
    }
}

#[derive(Debug)]
struct RuntimeRoots {
    resource_root: PathBuf,
    data_dir: PathBuf,
    workspace_dir: PathBuf,
    capability_dir: PathBuf,
}

fn resolve_roots(
    app: &AppHandle,
    resource_root: &Path,
    fallback_workspace_root: &Path,
    source_root: Option<&Path>,
    development: bool,
) -> HostResult<RuntimeRoots> {
    // Desktop mutable state is intentionally isolated from the browser/PWA
    // data root.  Both can run at once, so sharing queue/config files would
    // introduce cross-process write races.
    let data_dir = make_absolute(app.path().app_local_data_dir()?.join("data"));
    create_dir_all(&data_dir)?;

    let workspace_dir = std::env::var_os("RWANG_WORKSPACE_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .map(make_absolute)
        .unwrap_or_else(|| {
            if development {
                fallback_workspace_root.to_path_buf()
            } else {
                app.path()
                    .document_dir()
                    .map(make_absolute)
                    .unwrap_or_else(|_| fallback_workspace_root.to_path_buf())
            }
        });

    // In a source checkout capabilities live at the repository root.  A
    // packaged resource uses the same relative path below its rwang root.
    let packaged_capability = resource_root.join("capabilities/rwang-document-intelligence");
    let capability_dir = if packaged_capability.is_dir() {
        packaged_capability
    } else if let Some(source_root) = source_root {
        source_root.join("capabilities/rwang-document-intelligence")
    } else {
        packaged_capability
    };

    Ok(RuntimeRoots {
        resource_root: resource_root.to_path_buf(),
        data_dir,
        workspace_dir,
        capability_dir,
    })
}

struct RuntimeState {
    port: u16,
    child: Mutex<Option<Child>>,
    shutdown_started: AtomicBool,
}

impl RuntimeState {
    fn new(port: u16, child: Child) -> Self {
        Self {
            port,
            child: Mutex::new(Some(child)),
            shutdown_started: AtomicBool::new(false),
        }
    }

    fn shutdown(&self) {
        if self.shutdown_started.swap(true, Ordering::SeqCst) {
            return;
        }
        println!("RWANG desktop host: stopping sidecar on port {}", self.port);
        let Ok(mut child_guard) = self.child.lock() else {
            return;
        };
        if let Some(mut child) = child_guard.take() {
            terminate_child(&mut child);
        }
    }
}

impl Drop for RuntimeState {
    fn drop(&mut self) {
        if let Ok(mut child_guard) = self.child.lock() {
            if let Some(mut child) = child_guard.take() {
                terminate_child(&mut child);
            }
        }
    }
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());

    #[cfg(feature = "autostart")]
    let builder = builder.plugin(
        tauri_plugin_autostart::Builder::new()
            .app_name("RWANG")
            .build(),
    );

    let app = builder
        .setup(|app| setup(app))
        .build(tauri::generate_context!())
        .expect("error while building RWANG");

    app.run(|app: &AppHandle<Wry>, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            let state = app.state::<RuntimeState>();
            if !state.shutdown_started.swap(true, Ordering::SeqCst) {
                api.prevent_exit();
                if let Ok(mut child_guard) = state.child.lock() {
                    if let Some(mut child) = child_guard.take() {
                        terminate_child(&mut child);
                    }
                }
                // Trigger a second ExitRequested event.  The second event
                // is allowed through, so Tauri can finish its normal exit.
                app.exit(0);
            }
        }
        RunEvent::Exit => {
            app.state::<RuntimeState>().shutdown();
        }
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == spotlight_bridge::MAIN_WINDOW_LABEL => {
            // Keep the host and sidecar alive while the tray remains available.
            // Explicit Quit from the tray still follows ExitRequested below.
            api.prevent_close();
            if let Some(window) = app.get_webview_window(spotlight_bridge::MAIN_WINDOW_LABEL) {
                if let Err(error) = window.hide() {
                    eprintln!("RWANG window: hide-to-tray failed: {error}");
                }
            }
        }
        _ => {}
    })
}

fn setup(app: &mut tauri::App) -> HostResult<()> {
    let runtime = RuntimePaths::resolve(app.handle())?;
    println!(
        "RWANG desktop host: {}, launcher={}, server={}",
        runtime.node.describe(),
        runtime.launcher.display(),
        runtime.server.display()
    );

    let (port, child) = start_sidecar(&runtime)?;

    let webview_url = format!("http://127.0.0.1:{port}/").parse()?;
    let state = RuntimeState::new(port, child);
    app.manage(state);

    let window_result = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(webview_url))
        .title("RWANG (อาหวัง)")
        .inner_size(1280.0, 800.0)
        .min_inner_size(960.0, 640.0)
        .resizable(true)
        .visible(false)
        .on_navigation(move |url| is_allowed_navigation(url, port))
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny)
        .build();
    let window = match window_result {
        Ok(window) => window,
        Err(error) => {
            app.state::<RuntimeState>().shutdown();
            return Err(Box::new(error));
        }
    };
    if let Err(error) = window.show() {
        app.state::<RuntimeState>().shutdown();
        return Err(Box::new(error));
    }
    if let Err(error) = window.set_focus() {
        app.state::<RuntimeState>().shutdown();
        return Err(Box::new(error));
    }

    if let Err(error) = setup_tray(app) {
        app.state::<RuntimeState>().shutdown();
        return Err(error);
    }
    register_global_shortcut(app.handle());
    #[cfg(feature = "autostart")]
    maybe_enable_autostart(app.handle());

    println!("{{\"event\":\"ready\",\"port\":{port}}}");
    Ok(())
}

fn setup_tray(app: &mut tauri::App) -> HostResult<()> {
    let show_item = MenuItem::with_id(app, TRAY_SHOW_ID, "Show RWANG", true, None::<&str>)?;
    let spotlight_item = MenuItem::with_id(
        app,
        TRAY_SPOTLIGHT_ID,
        "Spotlight",
        true,
        Some(SPOTLIGHT_SHORTCUT),
    )?;
    let quit_item = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &spotlight_item, &quit_item])?;
    let tray = app
        .tray_by_id(TRAY_ICON_ID)
        .ok_or_else(|| HostError::new("RWANG system tray icon was not created"))?;
    tray.set_menu(Some(menu))?;
    tray.on_menu_event(|app, event| handle_tray_menu(app, event));
    Ok(())
}

fn handle_tray_menu(app: &AppHandle<Wry>, event: MenuEvent) {
    match event.id().0.as_str() {
        TRAY_SHOW_ID => show_main_window(app),
        TRAY_SPOTLIGHT_ID => focus_spotlight_window(app),
        TRAY_QUIT_ID => app.exit(0),
        _ => {}
    }
}

fn show_main_window(app: &AppHandle<Wry>) {
    let Some(window) = app.get_webview_window(spotlight_bridge::MAIN_WINDOW_LABEL) else {
        eprintln!("RWANG tray: main window is not available");
        return;
    };
    if let Err(error) = window.unminimize() {
        eprintln!("RWANG tray: restore main window failed: {error}");
    }
    if let Err(error) = window.show() {
        eprintln!("RWANG tray: show main window failed: {error}");
    }
    if let Err(error) = window.set_focus() {
        eprintln!("RWANG tray: focus main window failed: {error}");
    }
}

fn focus_spotlight_window(app: &AppHandle<Wry>) {
    let Some(window) = app.get_webview_window(spotlight_bridge::MAIN_WINDOW_LABEL) else {
        eprintln!("RWANG Spotlight: main window is not available");
        return;
    };
    if let Err(error) = spotlight_bridge::focus_spotlight_window(&window) {
        eprintln!("RWANG Spotlight: focus failed: {error}");
    }
}

fn register_global_shortcut(app: &AppHandle<Wry>) {
    let result = app
        .global_shortcut()
        .on_shortcut(SPOTLIGHT_SHORTCUT, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                focus_spotlight_window(app);
            }
        });
    if let Err(error) = result {
        eprintln!("RWANG warning: global shortcut {SPOTLIGHT_SHORTCUT} unavailable: {error}");
    }
}

#[cfg(feature = "autostart")]
fn maybe_enable_autostart(app: &AppHandle<Wry>) {
    let requested = std::env::var("RWANG_ENABLE_AUTOSTART")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
        .unwrap_or(false);
    if !requested {
        return;
    }
    if let Err(error) = app.autolaunch().enable() {
        eprintln!("RWANG warning: autostart could not be enabled: {error}");
    }
}

fn start_sidecar(runtime: &RuntimePaths) -> HostResult<(u16, Child)> {
    let timeout = readiness_timeout();
    let desktop_nonce = generate_desktop_nonce()?;
    let mut last_error: Option<Box<dyn Error>> = None;

    for attempt in 0..MAX_PORT_ATTEMPTS {
        let port = pick_free_loopback_port()?;
        let (mut child, signals) = spawn_runtime(runtime, port, &desktop_nonce)?;
        match wait_for_readiness(&mut child, port, &desktop_nonce, signals, timeout) {
            Ok(()) => return Ok((port, child)),
            Err(error) => {
                terminate_child(&mut child);
                let collision = !port_is_free(port);
                if collision && attempt + 1 < MAX_PORT_ATTEMPTS {
                    eprintln!(
                        "RWANG sidecar port {port} was claimed during startup; retrying ({}/{})",
                        attempt + 1,
                        MAX_PORT_ATTEMPTS
                    );
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| {
        Box::new(HostError::new(
            "RWANG sidecar could not choose a free loopback port",
        ))
    }))
}

fn pick_free_loopback_port() -> io::Result<u16> {
    // Binding to port zero lets Windows select a currently free ephemeral port.
    // Keep the listener alive only for the selection window; the child server
    // binds immediately afterwards and readiness probing handles any collision.
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    if port == 0 {
        return Err(io::Error::new(
            io::ErrorKind::AddrNotAvailable,
            "OS returned an invalid loopback port",
        ));
    }
    Ok(port)
}

fn port_is_free(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
}

fn make_absolute(path: PathBuf) -> PathBuf {
    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map(|current| current.join(&path))
            .unwrap_or(path)
    };
    simplify_node_path(absolute)
}

fn simplify_node_path(path: PathBuf) -> PathBuf {
    // Tauri may return Windows extended-length paths (`\\?\C:\...`).
    // dunce strips that prefix only when the resulting legacy path is safe;
    // ambiguous/long UNC paths remain verbatim instead of weakening path
    // identity or containment checks.
    dunce::simplified(&path).to_path_buf()
}

fn first_file<const N: usize>(candidates: [PathBuf; N]) -> Option<PathBuf> {
    candidates
        .into_iter()
        .map(simplify_node_path)
        .find(|candidate| candidate.is_file())
}

fn spawn_runtime(
    runtime: &RuntimePaths,
    port: u16,
    desktop_nonce: &str,
) -> HostResult<(Child, Receiver<RuntimeSignal>)> {
    let mut command = Command::new(runtime.node.command());
    command
        // Both paths are absolute by construction.  This avoids resolving a
        // server from a mutable process cwd in an installed Windows bundle.
        .arg(&runtime.launcher)
        .current_dir(&runtime.working_dir)
        .env("OLLAMA_CENTER_PORT", port.to_string())
        .env("RWANG_HOST", "127.0.0.1")
        .env("RWANG_DESKTOP", "1")
        .env("RWANG_DESKTOP_NONCE", desktop_nonce)
        .env("RWANG_SERVER_ENTRYPOINT", &runtime.server)
        .env("RWANG_RESOURCE_DIR", &runtime.resource_root)
        .env("RWANG_DATA_DIR", &runtime.data_dir)
        .env("RWANG_WORKSPACE_DIR", &runtime.workspace_dir)
        .env("RWANG_CAPABILITY_DIR", &runtime.capability_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = command.spawn().map_err(|error| {
        Box::new(HostError::new(format!(
            "failed to start {}: {error}",
            runtime.node.describe()
        ))) as Box<dyn Error>
    })?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_child(&mut child);
            return Err(Box::new(HostError::new("Node stdout pipe was not created")));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_child(&mut child);
            return Err(Box::new(HostError::new("Node stderr pipe was not created")));
        }
    };
    let (sender, receiver) = mpsc::channel();
    spawn_output_reader(stdout, "stdout", sender.clone());
    spawn_output_reader(stderr, "stderr", sender);
    Ok((child, receiver))
}

fn spawn_output_reader<R>(reader: R, stream: &'static str, sender: Sender<RuntimeSignal>)
where
    R: Read + Send + 'static,
{
    let _ = thread::Builder::new()
        .name(format!("rwang-node-{stream}"))
        .spawn(move || {
            for line in BufReader::new(reader).lines() {
                let Ok(line) = line else { break };
                if let Some(signal) = parse_runtime_signal(&line) {
                    let _ = sender.send(signal);
                }
                let _ = sender.send(RuntimeSignal::Output { stream, line });
            }
        });
}

fn parse_runtime_signal(line: &str) -> Option<RuntimeSignal> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    let event = value
        .get("event")
        .or_else(|| value.get("type"))
        .or_else(|| value.get("status"))
        .and_then(Value::as_str)?
        .trim()
        .to_ascii_lowercase();
    match event.as_str() {
        "ready" => Some(RuntimeSignal::Ready {
            port: value
                .get("port")
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())?,
        }),
        "fatal" | "error" => Some(RuntimeSignal::Fatal {
            message: value
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| value.get("error").and_then(Value::as_str))
                .or_else(|| {
                    value
                        .get("error")
                        .and_then(|error| error.get("message"))
                        .and_then(Value::as_str)
                })
                .unwrap_or("Node runtime reported a fatal error")
                .to_owned(),
        }),
        _ => None,
    }
}

fn wait_for_readiness(
    child: &mut Child,
    port: u16,
    desktop_nonce: &str,
    signals: Receiver<RuntimeSignal>,
    timeout: Duration,
) -> HostResult<()> {
    let deadline = Instant::now() + timeout;
    let mut json_ready = false;
    loop {
        loop {
            match signals.try_recv() {
                Ok(RuntimeSignal::Ready { port: ready_port }) if ready_port == port => {
                    json_ready = true;
                }
                Ok(RuntimeSignal::Ready { .. }) => {}
                Ok(RuntimeSignal::Fatal { message }) => {
                    return Err(Box::new(HostError::new(format!(
                        "Node runtime fatal: {message}"
                    ))));
                }
                Ok(RuntimeSignal::Output { stream, line }) => {
                    if stream == "stderr" {
                        eprintln!("[node:{stream}] {line}");
                    } else {
                        println!("[node:{stream}] {line}");
                    }
                }
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
            }
        }

        // Keep the NDJSON ready signal as part of the lifecycle protocol, but
        // require the challenge/proof-bound, identity-checked health response
        // as the authoritative readiness proof.
        // Check liveness immediately before probing and again immediately
        // after a successful probe. This closes the short race where a child
        // exits after emitting ready while another local listener answers the
        // health request.
        ensure_child_running(child)?;
        if json_ready && probe_http(port, desktop_nonce) {
            ensure_child_running(child)?;
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(Box::new(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "RWANG runtime readiness timed out after {} ms",
                    timeout.as_millis()
                ),
            )));
        }
        thread::sleep(READY_POLL_INTERVAL);
    }
}

fn readiness_timeout() -> Duration {
    let millis = std::env::var("RWANG_DESKTOP_READY_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_READY_TIMEOUT.as_millis() as u64)
        .clamp(1_000, 120_000);
    Duration::from_millis(millis)
}

fn ensure_child_running(child: &mut Child) -> HostResult<()> {
    if let Some(status) = child.try_wait()? {
        return Err(Box::new(HostError::new(format!(
            "Node runtime exited before readiness ({})",
            format_exit_status(status)
        ))));
    }
    Ok(())
}

fn generate_desktop_nonce() -> HostResult<String> {
    generate_hex_token::<DESKTOP_NONCE_BYTES>()
}

fn generate_hex_token<const N: usize>() -> HostResult<String> {
    let mut bytes = [0_u8; N];
    getrandom::getrandom(&mut bytes).map_err(|error| {
        Box::new(HostError::new(format!(
            "failed to generate random desktop readiness token: {error}"
        ))) as Box<dyn Error>
    })?;

    Ok(encode_hex(&bytes))
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn probe_http(port: u16, desktop_nonce: &str) -> bool {
    let Ok(challenge) = generate_hex_token::<DESKTOP_NONCE_BYTES>() else {
        return false;
    };
    let address = (IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let Ok(mut stream) = TcpStream::connect_timeout(&address.into(), CONNECT_TIMEOUT) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(CONNECT_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CONNECT_TIMEOUT));
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-rwang-desktop-challenge: {challenge}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 1024];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => {
                response.extend_from_slice(&buffer[..size]);
                if response.len() > MAX_HEALTH_RESPONSE_BYTES {
                    let _ = stream.shutdown(Shutdown::Both);
                    return false;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) =>
            {
                let _ = stream.shutdown(Shutdown::Both);
                return false;
            }
            Err(_) => {
                let _ = stream.shutdown(Shutdown::Both);
                return false;
            }
        }
    }
    let _ = stream.shutdown(Shutdown::Both);

    let Some((proof, payload)) = parse_health_response(&response) else {
        return false;
    };
    if !verify_desktop_proof(desktop_nonce, &challenge, &proof) {
        return false;
    }
    payload.get("service").and_then(Value::as_str) == Some("rwang")
        && payload.get("ready").and_then(Value::as_bool) == Some(true)
}

fn parse_health_response(response: &[u8]) -> Option<(String, Value)> {
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")?;
    let headers = String::from_utf8_lossy(&response[..header_end]);
    let status_code = headers
        .lines()
        .next()?
        .split_ascii_whitespace()
        .nth(1)?
        .parse::<u16>()
        .ok()?;
    if status_code != 200 {
        return None;
    }

    let proof = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("x-rwang-desktop-proof")
            .then(|| value.trim().to_owned())
    })?;

    let raw_body = &response[header_end + 4..];
    let chunked = headers.lines().any(|line| {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        name.trim().eq_ignore_ascii_case("transfer-encoding")
            && value
                .split(',')
                .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"))
    });
    let body = if chunked {
        decode_chunked_body(raw_body)?
    } else if let Some(length) = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    }) {
        raw_body.get(..length)?.to_vec()
    } else {
        raw_body.to_vec()
    };
    Some((proof, serde_json::from_slice(&body).ok()?))
}

fn verify_desktop_proof(secret_hex: &str, challenge_hex: &str, proof_hex: &str) -> bool {
    let Some(secret) = decode_hex_32(secret_hex) else {
        return false;
    };
    let Some(challenge) = decode_hex_32(challenge_hex) else {
        return false;
    };
    let Some(proof) = decode_hex_32(proof_hex) else {
        return false;
    };
    let Ok(mut mac) = HmacSha256::new_from_slice(&secret) else {
        return false;
    };
    mac.update(&challenge);
    // `verify_slice` uses the HMAC crate's constant-time comparison rather
    // than an ordinary string/byte equality check.
    mac.verify_slice(&proof).is_ok()
}

fn decode_hex_32(value: &str) -> Option<[u8; DESKTOP_NONCE_BYTES]> {
    if value.len() != DESKTOP_NONCE_BYTES * 2 {
        return None;
    }
    let mut decoded = [0_u8; DESKTOP_NONCE_BYTES];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        decoded[index] = (hex_digit(pair[0])? << 4) | hex_digit(pair[1])?;
    }
    Some(decoded)
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn decode_chunked_body(mut encoded: &[u8]) -> Option<Vec<u8>> {
    let mut decoded = Vec::new();
    loop {
        let line_end = encoded.windows(2).position(|window| window == b"\r\n")?;
        let size = std::str::from_utf8(&encoded[..line_end])
            .ok()?
            .split(';')
            .next()?
            .trim();
        let size = usize::from_str_radix(size, 16).ok()?;
        encoded = &encoded[line_end + 2..];
        if size == 0 {
            return Some(decoded);
        }
        let chunk_end = size.checked_add(2)?;
        if encoded.len() < chunk_end || &encoded[size..chunk_end] != b"\r\n" {
            return None;
        }
        decoded.extend_from_slice(&encoded[..size]);
        encoded = &encoded[chunk_end..];
    }
}

fn is_allowed_navigation(url: &url::Url, port: u16) -> bool {
    // Keep the webview on the exact sidecar origin.  Requiring an explicit
    // port and rejecting user-info prevents lookalike or credential-bearing
    // URLs from passing a host-only check.
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(port)
        && url.username().is_empty()
        && url.password().is_none()
}

fn format_exit_status(status: ExitStatus) -> String {
    status
        .code()
        .map(|code| format!("exit code {code}"))
        .unwrap_or_else(|| "terminated by signal".to_owned())
}

fn terminate_child(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }

    request_stdin_shutdown(child);

    let deadline = Instant::now() + SHUTDOWN_GRACE;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => break,
        }
    }

    force_kill_process_tree(child);
}

fn request_stdin_shutdown(child: &mut Child) {
    if let Some(mut stdin) = child.stdin.take() {
        // entrypoint.mjs owns the signal bridge. Closing stdin after the line
        // also wakes readline if Node is already in its shutdown path.
        let _ = stdin.write_all(b"{\"event\":\"shutdown\"}\n");
        let _ = stdin.flush();
    }
}

fn force_kill_process_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        // The normal path is the stdin protocol above. taskkill is reserved
        // for a bounded fallback and all of its output is discarded so a
        // missing/denied utility cannot leak a noisy console error.
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        let _ = child.kill();
    }
    #[cfg(windows)]
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_nonce_is_32_bytes_of_lowercase_hex() {
        let nonce = generate_desktop_nonce().expect("OS randomness should be available");
        assert_eq!(nonce.len(), DESKTOP_NONCE_BYTES * 2);
        assert!(nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    }

    #[test]
    fn health_parser_requires_http_200_and_rwang_ready_identity() {
        let response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nX-RWANG-Desktop-Proof: 0000000000000000000000000000000000000000000000000000000000000000\r\nConnection: close\r\n\r\n20\r\n{\"service\":\"rwang\",\"ready\":true}\r\n0\r\n\r\n";
        let (_, payload) = parse_health_response(response).expect("chunked JSON should parse");
        assert_eq!(
            payload.get("service").and_then(Value::as_str),
            Some("rwang")
        );
        assert_eq!(payload.get("ready").and_then(Value::as_bool), Some(true));

        let not_ready = b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 34\r\n\r\n{\"service\":\"rwang\",\"ready\":false}";
        assert!(parse_health_response(not_ready).is_none());
    }

    #[test]
    fn desktop_proof_verification_uses_secret_and_challenge() {
        let secret = "01".repeat(DESKTOP_NONCE_BYTES);
        let challenge = "ab".repeat(DESKTOP_NONCE_BYTES);
        let secret_bytes = decode_hex_32(&secret).expect("secret hex should decode");
        let challenge_bytes = decode_hex_32(&challenge).expect("challenge hex should decode");
        let mut mac = HmacSha256::new_from_slice(&secret_bytes).expect("HMAC key is valid");
        mac.update(&challenge_bytes);
        let proof = encode_hex(&mac.finalize().into_bytes());

        assert!(verify_desktop_proof(&secret, &challenge, &proof));
        let mut invalid_proof = proof.into_bytes();
        invalid_proof[0] = if invalid_proof[0] == b'0' { b'1' } else { b'0' };
        let invalid_proof = String::from_utf8(invalid_proof).expect("hex remains UTF-8");
        assert!(!verify_desktop_proof(&secret, &challenge, &invalid_proof));
        assert!(!verify_desktop_proof(
            &secret,
            &"cd".repeat(DESKTOP_NONCE_BYTES),
            &invalid_proof
        ));
    }

    #[cfg(windows)]
    #[test]
    fn node_path_simplification_handles_verbatim_drive_and_unc_paths() {
        let verbatim_drive = PathBuf::from(r"\\?\C:\RWANG\runtime\node.exe");
        assert_eq!(
            simplify_node_path(verbatim_drive),
            PathBuf::from(r"C:\RWANG\runtime\node.exe")
        );

        // dunce intentionally preserves verbatim UNC paths when stripping the
        // prefix could change their long-path or server/share semantics.
        let verbatim_unc = PathBuf::from(r"\\?\UNC\server\share\RWANG\runtime\node.exe");
        let simplified_unc = simplify_node_path(verbatim_unc.clone());
        assert!(simplified_unc.is_absolute());
        assert!(simplified_unc.to_string_lossy().starts_with(r"\\"));
        assert_eq!(simplified_unc, verbatim_unc);
    }
}
