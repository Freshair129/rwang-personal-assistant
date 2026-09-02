Run `pnpm desktop:runtime` to acquire the pinned official Node v24.20.0
Windows x64 archive. The helper verifies both the archive SHA-256 and the
extracted `node.exe` digest, and copies the official `LICENSE` into this
directory. The binary is intentionally not committed to the repository. The
Rust host looks for it at the packaged destination
`<resource-dir>/rwang/runtime/node/node.exe`.
