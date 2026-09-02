# RWANG Windows desktop release

This document describes the Windows/Tauri release gate. The workflow is
an artifact builder and verifier; it does not publish a GitHub Release, push a
branch, or enable auto-update.

## Toolchain and local gate

Use a clean Windows developer shell with:

- Node.js v24.20.0 for the portable sidecar (the CI toolchain uses the same
  exact version);
- pnpm 11 (`11.19.0` in CI); and
- Rust stable `x86_64-pc-windows-msvc` with `rustfmt` and the Visual Studio C++
  build tools.

Run the same gates used by the Windows workflow from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm desktop:runtime
pnpm desktop:stage
pnpm test:security
pnpm test:desktop-contract
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
pnpm exec tauri build --no-bundle
```

`tauri build --no-bundle` is the pull-request/source gate. It compiles the
desktop host without producing an installer and must pass before a tag or
manual release build is considered.

## Runtime staging

The production resource layout consumes only `desktop/stage/rwang`. Before any
Rust/Tauri check, the workflow runs:

```powershell
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File scripts/acquire-node-runtime.ps1 -ReplaceExisting
pnpm desktop:stage
```

`scripts/node-runtime.json` pins official Node v24.20.0 `win-x64` and its
archive and executable SHA-256 values. Acquisition verifies the archive from
nodejs.org, checks the extracted executable and version, and copies the same
distribution's `LICENSE`. Staging verifies the executable again, materializes
production dependencies without junctions, and writes a SHA-256 manifest. No
CI-installed Node fallback or checked-in binary is accepted.

## Building an unsigned NSIS artifact

The workflow runs on `windows-latest` for pull requests and `main` pushes. A
release artifact job runs only when either:

1. a tag matching `v*` is pushed; or
2. a maintainer manually starts the workflow with the `build_release` input set
   to `true`.

The release job executes:

```powershell
pnpm install --frozen-lockfile
pnpm desktop:runtime
pnpm desktop:stage
pnpm test:security
pnpm test:desktop-contract
pnpm exec tauri build --bundles nsis
```

It uploads the generated NSIS `.exe`, `SHA256SUMS.txt`, and
`sbom-placeholder.json` as one Actions artifact named
`RWANG-desktop-<ref>`. The checksum is generated with PowerShell
`Get-FileHash -Algorithm SHA256`; the SBOM file explicitly says it is a
placeholder because no approved SBOM generator is configured yet. Reviewers
must download the artifact from the workflow run and publish it through the
approved release process themselves.

There is deliberately no signing secret, certificate, `gh release`, release
upload, or `git push` step in this workflow. The installer is unsigned and may
show a Windows SmartScreen warning. Do not distribute it as a production build;
test it in a VM/clean machine, verify `SHA256SUMS.txt`, run the media parity
manual gate at `/desktop-diagnostics.html`, and apply the organization's code
signing process before external distribution.

## Manual desktop gate

In a packaged Tauri build, open
`http://127.0.0.1:<selected-port>/desktop-diagnostics.html` and complete the
manual Tauri/WebView2 checklist. Confirm that the sidecar emits `ready`, the
health endpoint responds, the WebView uses the exact loopback origin, required
MediaPipe assets are present, and all camera/microphone/display tracks stop
immediately after each user-initiated test. Inspect DevTools Network for
same-origin requests only; no CDN, upload, beacon, WebSocket, or telemetry is
expected. Close the app and confirm the sidecar and capture indicators exit.

The page is intentionally not a LAN/mobile diagnostic endpoint. A non-loopback
origin is marked for review and skips MediaPipe probes.

## Checksum verification

After downloading an Actions artifact, verify the installer before signing or
installing it:

```powershell
Get-FileHash .\RWANG-*.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

Compare the hash for every executable with the matching line in
`SHA256SUMS.txt`. Keep the workflow run URL, commit SHA, and placeholder SBOM
with the release review record.

## Rollback and browser fallback

The installer must not delete the desktop data root
`%LOCALAPPDATA%\com.freshair129.rwang\data`, including user configuration, queue
state, logs, or other runtime data. This root is intentionally isolated from the
browser/PWA state at `%LOCALAPPDATA%\RWANG\data`. If a desktop build fails to
start, stop using that installer, retain the desktop data directory, and
reinstall the last known-good signed version. Do not delete either data root as
a troubleshooting step unless the operator has an explicit backup and approval.

The browser/PWA path remains the immediate fallback throughout Desktop Alpha:

```powershell
pnpm start
# or use Start RWANG.cmd
```

Continue operating through the browser fallback while runtime staging,
WebView2, media permissions, or installer checks are repaired. Auto-update and
automatic rollback are intentionally outside this release slice.
