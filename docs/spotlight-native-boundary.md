# Desktop Alpha Spotlight native boundary

Status: **host-only shortcut/eval bridge; full native index port deferred**.

`src-tauri/src/spotlight_bridge.rs` is intentionally a small Rust boundary. It
does not import filesystem or process APIs and it does not receive a path or a
Spotlight opaque result id. The existing `spotlight.mjs` index remains the
canonical implementation for root validation, hidden/dependency exclusions,
reparse-point rejection, identity checks, launch policy, and the local-only
HTTP API.

The bridge only supports these exact commands:

- `focus`: show the `main` window, focus it, and open the existing
  `#spotlightDialog`.
- `search`: open the dialog and dispatch an `input` event with a bounded,
  JSON-encoded query.
- `close`: close the existing dialog.

There is no native `open`, `reveal`, `reindex`, shell, or filesystem command.
Those operations continue to go through the already-reviewed Node endpoint and
its opaque result-id validation. The Tauri capability therefore remains
`core:default`; do not add `tauri-plugin-shell` or `tauri-plugin-fs` for this
slice.

## Why the full index port is deferred

Moving the index now would duplicate security-sensitive behavior that already
lives in `spotlight.mjs`. In particular, a Rust port would need parity for
canonical roots, Windows reparse/symlink handling, stale file identity,
openable-extension policy, launch rate limiting, and safe Explorer launching.
Until those behaviors have shared parity tests, two indexes would create drift
and make it unclear which result is authoritative. Desktop Alpha therefore
keeps one Node index and uses Rust only as a UI entry point. The rationale is
also returned in the bridge response through `fullIndexPortRationale` so that a
future migration cannot silently become the default.

## Coordinator integration (after the lifecycle worker is ready)

Do not copy this into `main.rs` until the sidecar/window lifecycle patch is
stable. The intended wiring is:

```rust
mod spotlight_bridge;

let app = tauri::Builder::default()
    // ... existing single-instance and setup configuration ...
    .invoke_handler(tauri::generate_handler![
        spotlight_bridge::spotlight_command,
    ])
    // ... build/run ...
```

For the existing local sidecar URL gate, call the helper from the navigation
callback with the selected ephemeral port:

```rust
.on_navigation(move |url| spotlight_bridge::is_allowed_spotlight_url(url, port))
```

The Rust host can trigger a native shortcut without exposing another webview
capability:

```rust
if let Some(window) = app.get_webview_window(spotlight_bridge::MAIN_WINDOW_LABEL) {
    spotlight_bridge::focus_spotlight_window(&window)?;
}
```

The current browser/PWA shortcut (`Ctrl/Cmd-K`) remains unchanged. A future
global shortcut plugin, if added, should call `focus_spotlight_window` and must
be reviewed separately; it is not required for this bridge slice.

## Acceptance gates

From the repository root:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test spotlight_bridge
pnpm check
pnpm test:security
git diff --check
```

The Rust tests must reject alternate ports, `localhost`, HTTPS, user-info,
query/fragment-bearing URLs, API paths, and commands such as `open`, `reveal`,
`reindex`, `shell`, and `fs`. A follow-up Windows E2E gate must verify that the
native shortcut opens the same Spotlight dialog, while file search/open remains
local-only through the Node API.
