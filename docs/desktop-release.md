---
version: "0.1.0b"
created_at: "2026-09-03T02:33:20+07:00,Freshair129,3a6657caf0519f54b8bee05658f3047856e64b65"
last_update: "2026-09-04T06:02:32+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "desktop-release"
  scope: "windows-release-gate"
  doc_type: "core-directive"
  language: "en"
  change_risk: "MEDIUM"
---

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
pnpm test:desktop-package
pnpm test:model-selector-layout
pnpm test:desktop-contract
git diff --check
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml --features autostart
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
pwsh -NoLogo -NoProfile -File scripts/acquire-node-runtime.ps1 -ReplaceExisting
pwsh -NoLogo -NoProfile -File scripts/stage-desktop-runtime.ps1 -ReplaceExisting
```

`scripts/node-runtime.json` pins official Node v24.20.0 `win-x64` and its
archive and executable SHA-256 values. Acquisition verifies the archive from
nodejs.org, checks the extracted executable and version, and copies the same
distribution's `LICENSE`. Staging verifies the executable again, materializes
production dependencies without junctions, and writes a SHA-256 manifest. No
CI-installed Node fallback or checked-in binary is accepted. Both scripts use
the .NET SHA-256 implementation rather than relying on a shell module. In CI,
the workflow invokes each script directly from an explicit PowerShell 7
(`pwsh`) step; `pnpm desktop:stage` remains the developer-shell wrapper.

## Building an unsigned NSIS artifact

The workflow runs on `windows-latest` for pull requests and `main` pushes. A
release artifact job runs only when either:

1. a tag matching `v*` is pushed; or
2. a maintainer manually starts the workflow with the `build_release` input set
   to `true`.

The release job executes:

```powershell
pnpm install --frozen-lockfile
pnpm check
pwsh -NoLogo -NoProfile -File scripts/acquire-node-runtime.ps1 -ReplaceExisting
pwsh -NoLogo -NoProfile -File scripts/stage-desktop-runtime.ps1 -ReplaceExisting
pnpm test:security
pnpm test:desktop-package
pnpm test:model-selector-layout
pnpm test:desktop-contract
git diff --check
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml --features autostart
cargo test --manifest-path src-tauri/Cargo.toml
pnpm exec tauri build --bundles nsis
```

It requires exactly one generated `RWANG_*_x64-setup.exe`, copies that installer
with `SHA256SUMS.txt` into one Actions artifact named `RWANG-desktop-<ref>`, and
recomputes the copied file's SHA-256 before upload. No software bill of
materials is generated in this release slice; reviewers must not treat an empty
or synthetic document as supply-chain evidence. Reviewers must download the
artifact from the workflow run and publish it through the approved release
process themselves.

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
expected. Use **Tray > Quit** and confirm the sidecar and capture indicators exit;
closing the window with X only hides the app and is not an exit.

Release evidence is valid only on the exact packaged loopback origin. The page
does not enforce a route ACL: on a non-loopback browser/PWA origin it reports
`FAIL` and skips MediaPipe probes, but server binding remains the access boundary.

## Checksum verification

After downloading an Actions artifact, verify the installer before signing or
installing it:

```powershell
$installers = @(Get-ChildItem -LiteralPath . -Filter "RWANG_*_x64-setup.exe" -File)
if ($installers.Count -ne 1) { throw "Expected exactly one RWANG installer" }
$stream = [IO.File]::OpenRead($installers[0].FullName)
try {
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally { $sha256.Dispose() }
} finally { $stream.Dispose() }
$actual = "$hash  $($installers[0].Name)"
$recorded = (Get-Content -LiteralPath .\SHA256SUMS.txt -Raw).Trim()
if ($actual -ne $recorded) { throw "Installer checksum does not match SHA256SUMS.txt" }
```

Compare the installer hash with the matching line in `SHA256SUMS.txt`.
Keep the workflow run URL and commit SHA with the release
review record.

## Clean-machine status and manual release gate

The hosted `windows-latest` job is a build and source gate on a machine that
already has developer tooling. It is not evidence that the installer works on a
clean consumer machine. Desktop Alpha remains blocked from production release
until both manual rows below have recorded evidence:

- Manual Windows 11 x64 VM gate: verify checksum, install without Node/pnpm/Rust/Git, launch, exercise health/chat/media, quit through the tray without an orphan sidecar, upgrade, uninstall, and rollback.
- Manual Windows 10 x64 VM gate: run the same checklist on the minimum Windows 10 build that the project explicitly declares supported.

Record the OS build number, artifact SHA-256, installer version, timestamp, and
pass/fail result. Seed a sentinel file in the desktop data root before upgrade
and uninstall; the release does not pass unless it remains intact. This manual
evidence is not currently produced by GitHub Actions.

## Rollback and browser fallback

The desktop data root is
`%LOCALAPPDATA%\com.freshair129.rwang\data`, including user configuration, queue
state, logs, and other runtime data. It is intentionally isolated from the
browser/source state at `%LOCALAPPDATA%\RWANG\data`. Before rollback, stop RWANG,
copy the desktop data root to a timestamped backup, uninstall the failing build,
install the last-known-good signed NSIS artifact whose checksum was recorded,
then verify health, configuration, and queue state. Do not delete either data
root as a troubleshooting step unless the operator has an explicit backup and
approval.

For a developer machine that already has a source checkout, the browser/PWA
path remains available throughout Desktop Alpha:

```powershell
pnpm start
# or use Start RWANG.cmd
```

An installed consumer machine must not be assumed to have pnpm or a source
tree; its rollback path is the last-known-good installer. Auto-update and
automatic rollback are intentionally outside this release slice.

## Version Diff

| From | To | Change |
|---|---|---|
| Unversioned | 0.1.0b | Correct checksum naming and equality, remove synthetic supply-chain output, and make manual VM/rollback status explicit |
| Product 0.5.0 | Product 0.5.0 | Release process correction only; no product version bump |

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-04 | beta | Align the Windows release guide with CI, checksum, clean-machine, and rollback reality | ba1200d | RWANG |
