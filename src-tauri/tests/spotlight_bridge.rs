#![allow(dead_code)]

#[path = "../src/spotlight_bridge.rs"]
mod spotlight_bridge;

use spotlight_bridge::build_spotlight_focus_script;

#[test]
fn host_focus_bridge_is_fixed_and_cannot_carry_frontend_data() {
    let script = build_spotlight_focus_script();
    assert!(script.contains(r#"getElementById("spotlightButton")"#));
    assert!(script.contains("button.hidden"));
    assert!(script.contains("button.disabled"));
    assert!(script.contains("button.click()"));
    assert!(!script.contains("showModal"));
    assert!(!script.contains("spotlightDialog"));
    assert!(!script.contains("spotlightInput"));
    assert!(!script.contains("fetch("));
    assert!(!script.contains("invoke("));
    assert!(!script.contains("__TAURI__"));
}
