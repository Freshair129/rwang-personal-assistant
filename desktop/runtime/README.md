# RWANG desktop runtime contract

The Tauri host starts `entrypoint.mjs` as a child process. In an installed
bundle the resource layout is:

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

`node.exe` is a portable Node v24.20.0 runtime supplied by the
packaging/release pipeline and is intentionally not checked into this
repository. The acquisition helper verifies the official archive SHA-256 and
LICENSE; the staging helper verifies the executable digest again before
creating the staged tree. The Rust host resolves both the Node executable and
the JavaScript entrypoint to absolute paths before spawning them. A debug/source
checkout may fall back to the system `node` executable while the portable
archive is absent; release staging fails closed instead.

The launcher writes one JSON object per line for lifecycle events:

```json
{"event":"ready","port":43127}
{"event":"fatal","message":"..."}
```

The host captures stdout and stderr, parses these `ready`/`fatal` events, and
also probes `GET /api/health` on the selected loopback port to support direct server
development launches. `OLLAMA_CENTER_PORT`, `RWANG_HOST`,
`RWANG_DESKTOP`, and `RWANG_SERVER_ENTRYPOINT` are host-owned environment
variables; the selected port is never fixed to 4173.

The child is terminated when the Tauri app exits. Windows first receives a
bounded non-forceful `taskkill` request (including descendants), followed by a
hard-kill fallback only if the grace period expires.

## Capability boundary

The only frontend capability is `core:default`. No `shell` or `fs` plugin is
enabled or exposed to the webview. Process spawning, resource path resolution,
readiness handling, and shutdown all stay in the Rust host. The webview is
opened at `http://127.0.0.1:<selected-port>/` and the single-instance plugin
focuses the existing `main` window when a second launch is attempted.
