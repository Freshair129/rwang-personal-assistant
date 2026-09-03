---
version: "0.2.0b"
created_at: "2026-09-03T02:33:20+07:00,RWANG,3a6657caf0519f54b8bee05658f3047856e64b65"
last_update: "2026-09-04T05:28:01+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "desktop-security"
  scope: "Spotlight host bridge and navigation"
  doc_type: "core-directive"
  target_product_version: "0.5.0"
---

# Desktop Alpha Spotlight native boundary

Status: **host-only focus bridge; the full native index port is deferred**.

## Current architecture

`spotlight.mjs` is the single authoritative implementation for the filename
index, canonical root validation, hidden/dependency exclusions, reparse-point
rejection, opaque result IDs, stale identity checks, openable-extension policy,
launch rate limiting, and safe OS launching.

`src-tauri/src/spotlight_bridge.rs` performs one fixed UI operation: restore,
show, and focus the existing `main` window, then click the existing
`#spotlightButton`. The canonical `openSpotlight()` handler in `public/app.js`
continues to own the local-access and Settings guards, stale-state reset,
empty-state render, status refresh, dialog open, and input focus. The host script
contains no dynamic query, path, result ID, or arbitrary frontend input.

The bridge is not a Tauri command and is not registered through
`invoke_handler`. The WebView receives no native Spotlight IPC, shell, or
filesystem capability. Search, reindex, and safe opening remain behind the
reviewed Node HTTP endpoints and their existing authorization and opaque-ID
checks.

## Entry points

- `Ctrl+Shift+Space` is the current Windows desktop global shortcut. A pressed
  event calls the Rust focus helper directly. If another application owns the
  shortcut, RWANG logs a warning and continues running.
- The tray **Spotlight** item calls the same host helper.
- The browser/PWA shortcut remains `Ctrl/Cmd+K` and uses the existing frontend
  behavior.

The global-shortcut plugin is host-side infrastructure. It does not add a
permission to `src-tauri/capabilities/default.json` and must not be used to
accept a path, shell command, or arbitrary script.

## Navigation boundary

`main.rs` owns the only WebView navigation policy. It permits navigation on
the exact selected sidecar origin:

```text
http://127.0.0.1:<selected-port>
```

Same-origin application paths, queries, and fragments are allowed so the main
UI, diagnostics page, API routes, and hash navigation continue to work. HTTPS,
`localhost`, another port, user-info, and lookalike hosts are rejected. New
window creation is always denied. Path-level authorization remains a server
responsibility; the host origin gate is not an API authorization mechanism.

Do not add a second Spotlight-specific URL helper. Multiple URL policies would
allow documentation and production behavior to drift.

## Why the full index port is deferred

A Rust index would need shared parity tests for canonical roots, Windows
reparse/symlink behavior, stale identity, openable extensions, launch rate
limits, and safe Explorer launching. Until those tests exist, a second index
would create two security authorities. Desktop Alpha therefore keeps Node as
the sole index/opener and Rust as a fixed focus entry point.

## Acceptance gates

From the repository root:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test spotlight_bridge
cargo test --manifest-path src-tauri/Cargo.toml
node tests/tauri-contract.mjs
pnpm check
pnpm test:security
git diff --check
```

The gates must prove that:

- no WebView `invoke_handler`, shell, or filesystem capability exists;
- the focus script contains no transport, navigation, direct dialog operation,
  or dynamic input and enters the canonical `openSpotlight()` button handler;
- the global shortcut and tray call the same host focus helper;
- same-origin paths/query/fragments are accepted while wrong scheme, host,
  port, user-info, and new windows are rejected; and
- the Node Spotlight security suite remains authoritative for search and open.

## VERSION DIFF

| From | To | Change |
|---|---|---|
| 0.1.0b beta | 0.2.0b beta | Replaced the proposed IPC/path-scoped design with the implemented host-only focus bridge and exact-origin navigation contract |
| Product 0.5.0 | Product 0.5.0 | No product version change |

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-03 | beta | Initial Desktop Alpha Spotlight bridge proposal | 3a6657c | RWANG |
| 0.2.0b | 2026-09-04 | beta | Document host-only focus, current shortcut, and one exact-origin navigation policy | uncommitted | RWANG |
