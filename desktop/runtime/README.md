---
version: "0.2.0b"
created_at: "2026-09-03T02:33:20+07:00,RWANG,3a6657caf0519f54b8bee05658f3047856e64b65"
last_update: "2026-09-04T06:02:32+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "desktop-runtime"
  scope: "Tauri host and Node sidecar"
  doc_type: "core-directive"
  target_product_version: "0.5.0"
---

# RWANG desktop runtime contract

The Tauri host owns the installed desktop lifecycle and starts
`entrypoint.mjs` as a child process. The staged resource layout is:

```text
<resource-dir>/rwang/entrypoint.mjs
<resource-dir>/rwang/server.mjs
<resource-dir>/rwang/rwang.mjs
<resource-dir>/rwang/remote.mjs
<resource-dir>/rwang/spotlight.mjs
<resource-dir>/rwang/document-intelligence.mjs
<resource-dir>/rwang/public/...
<resource-dir>/rwang/node_modules/...
<resource-dir>/rwang/runtime/node/node.exe
```

The portable Node v24.20.0 executable, archive digest, executable digest, and
LICENSE are verified by the acquisition and staging pipeline. The Rust host
resolves the executable and JavaScript entrypoint to absolute paths before
spawning them. A debug source checkout may use system Node; a release bundle
with an incomplete portable runtime fails closed.

## Configuration and workspace consent

The browser/PWA command `pnpm start` may load the repository `.env`. A packaged
Tauri app does not parse or bundle that file. Desktop configuration therefore
comes from host-owned values and environment variables inherited by the Tauri
process; `.env.example` documents variable names but is not an installed
desktop configuration file.

The host always owns and overrides these child values:

```text
RWANG_RESOURCE_DIR=<verified staged resource root>
RWANG_DATA_DIR=%LOCALAPPDATA%\com.freshair129.rwang\data
RWANG_WORKSPACE_DIR=<resolved workspace below>
RWANG_CAPABILITY_DIR=<verified bundled capability root>
RWANG_HOST=127.0.0.1
OLLAMA_CENTER_PORT=<selected ephemeral port>
RWANG_DESKTOP=1
RWANG_DESKTOP_NONCE=<host-generated secret>
RWANG_SERVER_ENTRYPOINT=<absolute bundled server.mjs>
```

In a debug source checkout, the repository root remains the default workspace.
In a packaged build, the no-configuration default is the empty app-owned
`%LOCALAPPDATA%\com.freshair129.rwang\workspace` directory, which is a sibling
of `data`. RWANG never silently promotes Documents to an agent workspace.

Selecting another workspace requires an explicitly inherited
`RWANG_WORKSPACE_DIR`. It must name an absolute existing directory or startup
fails. This environment override is the current operator-consent boundary;
there is no desktop folder picker yet. Spotlight personal-root indexing is a
separate disclosed feature and does not grant agent workspace access.

## Readiness proof

The host generates a fresh 32-byte operating-system-random nonce encoded as 64
lowercase hexadecimal characters. It passes the nonce only through the child
environment. The nonce must never appear in a URL, command-line argument,
`ready`/`fatal` output, health body, or log.

For every desktop readiness probe, the host sends a fresh 32-byte challenge in
`x-rwang-desktop-challenge`. The server returns
`HMAC-SHA256(nonce, challenge)` in `x-rwang-desktop-proof`; both launchers use a
constant-time comparison and also require HTTP 200 plus the JSON identity
`{"service":"rwang","ready":true}`. Missing or invalid challenges fail with
HTTP 401 in desktop mode. This proves readiness to the host; it is not a
general authorization mechanism for every application API.

After verification, the launcher emits line-delimited lifecycle events without
the nonce:

```json
{"event":"ready","port":43127}
{"event":"fatal","message":"..."}
```

## Window and process lifecycle

- Closing the main window with **X** hides it to the tray. The host and sidecar
  intentionally remain alive.
- **Show RWANG**, the Spotlight shortcut, or a second app launch restores and
  focuses the same window.
- **Tray > Quit** or process exit begins shutdown exactly once. The Rust host
  sends `{"event":"shutdown"}` over the child's private stdin so Node can run
  its real SIGTERM cleanup.
- The host waits up to seven seconds. If the child has not exited, Windows uses
  `taskkill /PID <child> /T /F` as a bounded process-tree fallback, then waits
  for the child handle. `RuntimeState` and its `Drop` implementation provide an
  idempotent final cleanup path.

Tests and release checks must use **Tray > Quit** when asserting sidecar exit;
closing the window is not an application exit.

## Shortcut and autostart

`Ctrl+Shift+Space` is registered by the Rust host and focuses the existing
Spotlight dialog. Registration failure is non-fatal because another application
may own the shortcut.

Autostart is default-off. The default Cargo feature set is empty and normal
artifacts do not register autostart. A separately reviewed build must be
compiled with `--features autostart`, and even that build enables registration
only when the Tauri process inherits `RWANG_ENABLE_AUTOSTART=1` (or
`true`/`yes`). There is no settings toggle in this release.

## Capability and navigation boundary

The frontend capability remains exactly `core:default`; no shell or filesystem
plugin is packaged or exposed. The WebView is pinned to the exact selected
`http://127.0.0.1:<port>` origin, including its same-origin pages, queries, and
fragments. Other schemes, hosts, ports, user-info, and all new-window requests
are rejected by the host.

## Verification

```powershell
node tests/tauri-contract.mjs
node tests/desktop-health.mjs
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml --features autostart
```

## VERSION DIFF

| From | To | Change |
|---|---|---|
| 0.1.0b beta | 0.2.0b beta | Corrected workspace consent, nonce proof, window shutdown, shortcut, autostart, and `.env` contracts |
| Product 0.5.0 | Product 0.5.0 | No product version change |

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-03 | beta | Initial portable sidecar runtime contract | 3a6657c | RWANG |
| 0.2.0b | 2026-09-04 | beta | Align installed configuration, safe workspace default, authenticated readiness, and real lifecycle behavior | ba1200d | RWANG |
