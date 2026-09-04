//! Host-only entry point for the existing Node-backed Spotlight UI.
//!
//! The authoritative index, opaque result ids, root validation, and safe file
//! opener remain in `spotlight.mjs`. This module has no WebView IPC command and
//! accepts no path, result id, query, or arbitrary script from the frontend.

use tauri::WebviewWindow;

pub const MAIN_WINDOW_LABEL: &str = "main";

// This script is host-owned and contains no dynamic input. It clicks the same
// UI button as a user so public/app.js remains the single owner of local-access
// and Settings guards, state reset, status refresh, and dialog focus behavior.
// The global shortcut and tray menu therefore do not grant the WebView a native
// command, filesystem capability, or process capability.
const SPOTLIGHT_FOCUS_SCRIPT: &str = r#"(() => {
  const button = document.getElementById("spotlightButton");
  if (!button || button.hidden || button.disabled) return;
  button.click();
})();"#;

pub fn build_spotlight_focus_script() -> &'static str {
    SPOTLIGHT_FOCUS_SCRIPT
}

pub fn focus_spotlight_window(window: &WebviewWindow) -> Result<(), String> {
    window
        .unminimize()
        .map_err(|error| format!("restore Spotlight window: {error}"))?;
    window
        .show()
        .map_err(|error| format!("show Spotlight window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("focus Spotlight window: {error}"))?;
    window
        .eval(build_spotlight_focus_script())
        .map_err(|error| format!("evaluate Spotlight focus script: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focus_script_is_fixed_and_has_no_transport_or_native_bridge() {
        let script = build_spotlight_focus_script();
        assert!(script.contains(r#"getElementById("spotlightButton")"#));
        assert!(script.contains("button.hidden"));
        assert!(script.contains("button.disabled"));
        assert!(script.contains("button.click()"));
        for forbidden in [
            "fetch(",
            "XMLHttpRequest",
            "__TAURI__",
            "invoke(",
            "location",
            "window.open",
            "showModal",
            "spotlightDialog",
            "spotlightInput",
        ] {
            assert!(
                !script.contains(forbidden),
                "focus script unexpectedly contains {forbidden}"
            );
        }
    }
}
