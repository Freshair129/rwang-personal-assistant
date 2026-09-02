//! Host-only boundary for the Desktop Alpha Spotlight entry point.
//!
//! The authoritative file index remains in `spotlight.mjs`.  This module does
//! not read the filesystem, spawn a process, or accept a path/id from the
//! webview.  It only focuses the already-loaded local UI and, for an explicitly
//! allowlisted command, asks that UI to update its own search field.
//!
//! Keeping this boundary small lets the Tauri host provide a native shortcut
//! without moving the security-sensitive index implementation before there is
//! a Rust/Node parity test suite.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewWindow};
use url::Url;

pub const MAIN_WINDOW_LABEL: &str = "main";
pub const SPOTLIGHT_DIALOG_ID: &str = "spotlightDialog";
pub const SPOTLIGHT_INPUT_ID: &str = "spotlightInput";

/// Keep this list intentionally small.  Opening/revealing a path and starting
/// a reindex remain Node-side operations behind the existing local-only HTTP
/// API; they are not native commands exposed to the webview.
pub const SPOTLIGHT_ALLOWED_COMMANDS: &[&str] = &["focus", "search", "close"];

/// Queries are UI input, not a transport for arbitrary JavaScript or paths.
/// The limit also keeps an accidental paste from creating a very large IPC
/// payload.
pub const MAX_QUERY_CHARS: usize = 256;

pub const SPOTLIGHT_INDEX_MODE: &str = "existing-node-sidecar";
pub const FULL_INDEX_PORT_STATUS: &str = "deferred";
pub const FULL_INDEX_PORT_RATIONALE: &str =
    "Keep spotlight.mjs as the canonical index until Rust parity tests cover root, reparse, identity, and opener policy.";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpotlightCommand {
    Focus,
    Search,
    Close,
}

/// Parse a command at the IPC edge.  Do not normalize or partially match this
/// value: a typo or a future command must fail closed until it is reviewed and
/// added to the explicit allowlist.
pub fn parse_spotlight_command(value: &str) -> Option<SpotlightCommand> {
    match value {
        "focus" => Some(SpotlightCommand::Focus),
        "search" => Some(SpotlightCommand::Search),
        "close" => Some(SpotlightCommand::Close),
        _ => None,
    }
}

pub fn is_allowed_spotlight_command(value: &str) -> bool {
    parse_spotlight_command(value).is_some()
}

/// The Tauri webview is intentionally pinned to the exact sidecar origin.  A
/// separate helper makes the navigation policy reusable by `main.rs` without
/// coupling it to the Spotlight implementation itself.
pub fn is_allowed_spotlight_url(url: &Url, port: u16) -> bool {
    if port == 0 {
        return false;
    }

    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(port)
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && matches!(url.path(), "/" | "/index.html")
}

fn validate_query(command: SpotlightCommand, query: Option<&str>) -> Result<Option<&str>, String> {
    match command {
        SpotlightCommand::Search => {
            let query = query.ok_or_else(|| "search requires a query".to_owned())?;
            if query.chars().count() > MAX_QUERY_CHARS {
                return Err(format!("search query exceeds {MAX_QUERY_CHARS} characters"));
            }
            if query.chars().any(char::is_control) {
                return Err("search query contains a control character".to_owned());
            }
            Ok(Some(query))
        }
        SpotlightCommand::Focus | SpotlightCommand::Close => {
            if query.is_some() {
                return Err("query is only accepted for the search command".to_owned());
            }
            Ok(None)
        }
    }
}

fn js_quote(value: &str) -> String {
    // JSON string escaping is valid JavaScript string escaping and keeps the
    // query data out of the executable portion of the eval script. Escape the
    // two historical JavaScript line-separator hazards as well; this keeps the
    // contract safe on older embedded WebView2 runtimes.
    serde_json::to_string(value)
        .expect("string serialization cannot fail")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// Build one of three fixed DOM operations.  The only dynamic value is a JSON
/// encoded search string; no path, shell command, or arbitrary script is
/// accepted here.
pub fn build_spotlight_script(
    command: SpotlightCommand,
    query: Option<&str>,
) -> Result<String, String> {
    let query = validate_query(command, query)?;
    let dialog_id = js_quote(SPOTLIGHT_DIALOG_ID);
    let input_id = js_quote(SPOTLIGHT_INPUT_ID);

    match command {
        SpotlightCommand::Focus => Ok(format!(
            r#"(() => {{
  const dialog = document.getElementById({dialog_id});
  if (!dialog) return;
  if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
  document.getElementById({input_id})?.focus();
}})();"#,
        )),
        SpotlightCommand::Search => {
            let query = js_quote(query.expect("search query was validated"));
            Ok(format!(
                r#"(() => {{
  const dialog = document.getElementById({dialog_id});
  if (!dialog) return;
  if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
  const input = document.getElementById({input_id});
  if (!input) return;
  input.value = {query};
  input.dispatchEvent(new Event("input", {{ bubbles: true }}));
  input.focus();
}})();"#,
            ))
        }
        SpotlightCommand::Close => Ok(format!(
            r#"(() => {{
  const dialog = document.getElementById({dialog_id});
  if (dialog?.open) dialog.close();
}})();"#,
        )),
    }
}

/// Execute a safe command against an existing webview.  This helper is the
/// host-side hook for a future native/global shortcut and is deliberately
/// separate from the Tauri IPC command below.
pub fn execute_spotlight_command(
    window: &WebviewWindow,
    command: SpotlightCommand,
    query: Option<&str>,
) -> Result<(), String> {
    let script = build_spotlight_script(command, query)?;
    window
        .show()
        .map_err(|error| format!("show Spotlight window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("focus Spotlight window: {error}"))?;
    window
        .eval(script)
        .map_err(|error| format!("evaluate Spotlight UI command: {error}"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotlightBridgeResponse {
    pub ok: bool,
    pub command: SpotlightCommand,
    pub index_mode: &'static str,
    pub full_index_port: &'static str,
    pub full_index_port_rationale: &'static str,
}

/// Tauri IPC entry point.  It has no shell/filesystem capability and only
/// invokes the three fixed DOM operations above.  Search/open/reveal/reindex
/// continue to use the existing local-only Node API and opaque result ids.
#[tauri::command]
pub fn spotlight_command(
    app: AppHandle,
    command: String,
    query: Option<String>,
) -> Result<SpotlightBridgeResponse, String> {
    let command = parse_spotlight_command(&command)
        .ok_or_else(|| format!("unsupported Spotlight command: {command}"))?;
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "RWANG main window is not available".to_owned())?;
    execute_spotlight_command(&window, command, query.as_deref())?;
    Ok(SpotlightBridgeResponse {
        ok: true,
        command,
        index_mode: SPOTLIGHT_INDEX_MODE,
        full_index_port: FULL_INDEX_PORT_STATUS,
        full_index_port_rationale: FULL_INDEX_PORT_RATIONALE,
    })
}

/// Host-side convenience hook for a native shortcut.  Calling this from Rust
/// does not grant the webview shell or filesystem access.
pub fn focus_spotlight_window(window: &WebviewWindow) -> Result<(), String> {
    execute_spotlight_command(window, SpotlightCommand::Focus, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(value: &str) -> Url {
        Url::parse(value).expect("test URL must parse")
    }

    #[test]
    fn command_allowlist_is_exact() {
        for command in SPOTLIGHT_ALLOWED_COMMANDS {
            assert!(is_allowed_spotlight_command(command));
        }
        for command in [
            "",
            "FOCUS",
            "open",
            "open-file",
            "reindex",
            "shell",
            "focus ",
        ] {
            assert!(!is_allowed_spotlight_command(command));
            assert!(parse_spotlight_command(command).is_none());
        }
    }

    #[test]
    fn url_allowlist_requires_exact_loopback_origin_and_page_path() {
        let port = 43127;
        assert!(is_allowed_spotlight_url(
            &parsed("http://127.0.0.1:43127/"),
            port
        ));
        assert!(is_allowed_spotlight_url(
            &parsed("http://127.0.0.1:43127/index.html"),
            port
        ));
        for value in [
            "http://127.0.0.1:43128/",
            "https://127.0.0.1:43127/",
            "http://localhost:43127/",
            "http://127.0.0.1.evil.example:43127/",
            "http://user:pass@127.0.0.1:43127/",
            "http://127.0.0.1:43127/?next=https://evil.example",
            "http://127.0.0.1:43127/#external",
            "http://127.0.0.1:43127/api/spotlight/search",
        ] {
            assert!(
                !is_allowed_spotlight_url(&parsed(value), port),
                "unexpectedly allowed {value}"
            );
        }
        assert!(!is_allowed_spotlight_url(
            &parsed("http://127.0.0.1:43127/"),
            0
        ));
    }

    #[test]
    fn scripts_are_fixed_and_query_is_json_encoded() {
        let script = build_spotlight_script(
            SpotlightCommand::Search,
            Some(r#"quote"; document.body.innerHTML = "pwned";"#),
        )
        .expect("safe query should build");
        assert!(script.contains("dispatchEvent"));
        assert!(script.contains("spotlightInput"));
        assert!(!script.contains("document.body.innerHTML = \"pwned\";"));
        assert!(build_spotlight_script(SpotlightCommand::Focus, Some("unexpected")).is_err());
        assert!(build_spotlight_script(SpotlightCommand::Close, Some("unexpected")).is_err());
        assert!(build_spotlight_script(SpotlightCommand::Search, None).is_err());
        assert!(build_spotlight_script(SpotlightCommand::Search, Some("line\nfeed")).is_err());
    }

    #[test]
    fn query_length_is_bounded() {
        let query = "x".repeat(MAX_QUERY_CHARS + 1);
        assert!(build_spotlight_script(SpotlightCommand::Search, Some(&query)).is_err());
    }
}
