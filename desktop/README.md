# RWANG (อาหวัง) Windows desktop shell

This directory defines the desktop packaging contract for the Tauri v2 shell.
The Rust host lives in `../src-tauri`; `runtime/entrypoint.mjs` is the small
Node lifecycle launcher used by that host.

## Development

From the repository root, install a Tauri v2 CLI and run the desktop project
with the normal Tauri command. A debug build can use the checked-out
`server.mjs` and the system `node` executable when
`desktop/runtime/node/node.exe` has not been supplied yet. The release
staging contract pins the portable sidecar to official Node v24.20.0.

## Packaging contract

The bundle places application resources below `<resource-dir>/rwang/`, with a
portable Node runtime at `<resource-dir>/rwang/runtime/node/node.exe`. Run
`pnpm desktop:runtime` to acquire the pinned official Node v24.20.0 archive and
verify its SHA-256 and LICENSE, then run `pnpm desktop:stage` before a
production bundle is built. The portable runtime and dependency tree must be
shipped together; the Rust host never relies on the installed application's
current working directory.

Startup chooses an ephemeral free loopback port, passes it as
`OLLAMA_CENTER_PORT`, starts the absolute launcher/server paths, captures the
line-delimited JSON `ready`/`fatal` protocol, and waits for `GET /api/health`
with a bounded timeout. Only then does it create the webview at
`http://127.0.0.1:<port>/`.

The app is single-instance. A second launch focuses the first `main` window.
On exit the host gives the Node process a bounded graceful termination window
and then uses a forceful fallback if necessary. Frontend capabilities remain
minimal: there is no shell or filesystem capability; the host owns process and
resource operations.
