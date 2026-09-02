# Desktop Alpha runtime staging

The Windows desktop bundle consumes one validated tree:
`desktop/stage/rwang`. `scripts/stage-desktop-runtime.ps1` copies the backend,
frontend assets, capabilities, production dependencies, and portable Node into
that tree. The output is the only Tauri resource mapping, so a build cannot
silently include a stale checkout dependency tree.

## Pinned Node input

`scripts/node-runtime.json` pins official Node v24.20.0 for `win-x64`:

```text
archive SHA-256: 6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba
node.exe SHA-256: 5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5
```

The expected archive is
`https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip`; its digest and
the extracted `node.exe` digest are recorded from the official
`https://nodejs.org/dist/v24.20.0/SHASUMS256.txt`. The archive also supplies the
`LICENSE` file that is copied into the staged runtime. The version, URL, and
both digests are source-controlled text; no executable or zip belongs in git.

Acquire the exact runtime locally or in CI with:

```powershell
pnpm desktop:runtime
# or, without pnpm:
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File scripts/acquire-node-runtime.ps1 -ReplaceExisting
```

The acquisition helper downloads only the pinned official archive, verifies its
SHA-256 before extraction, verifies `node.exe` and `node.exe --version` after
extraction, and copies `node.exe` plus `LICENSE` to the fixed
`desktop/runtime/node` directory. `-DryRun` performs no download or write. A
pre-downloaded archive can be checked with `-ArchivePath`; it is never deleted
by the helper.

## Staged tree

After acquisition, stage the release sidecar:

```powershell
pnpm desktop:stage
# equivalent direct command:
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File scripts/stage-desktop-runtime.ps1 -ReplaceExisting
```

The resulting layout is:

```text
desktop/stage/rwang/
  entrypoint.mjs
  server.mjs
  rwang.mjs
  remote.mjs
  spotlight.mjs
  document-intelligence.mjs
  package.json                 # runtime-only manifest; no devDependencies
  node_modules/                # pnpm --prod, hoisted, materialized
  public/                      # includes vendor WASM/task assets
  capabilities/
  runtime/node/node.exe        # pinned official Node v24.20.0
  runtime/node/LICENSE         # from the same official distribution
  runtime/node/node-runtime.json
  runtime-manifest.json        # stable relative paths, byte sizes, SHA-256
```

The packaged destination is `<resource-dir>/rwang/runtime/node/node.exe`.

The staging script runs
`pnpm install --prod --frozen-lockfile --ignore-scripts --node-linker=hoisted`
in an isolated work directory. It rejects junctions/symlinks and other
reparse points before materializing `node_modules`, then writes a manifest whose
paths are relative to `rwang` and whose Node fields include the verified
executable and archive digests. The script accepts explicit `-NodePath`,
`-NodeLicensePath`, and `-NodeSha256` for a controlled local fixture; real
staging requires the pinned `scripts/node-runtime.json` metadata and Node 24.

The only cleanup targets are a GUID-named work directory below
`desktop/stage` and the exact existing `desktop/stage/rwang` tree when
`-ReplaceExisting` is supplied. The stage root itself and all paths outside it
are refused.

## Tauri and package integration

`src-tauri/tauri.conf.json` maps only the validated tree:

```json
{
  "bundle": {
    "targets": ["nsis"],
    "resources": {
      "../desktop/stage/rwang/": "rwang/"
    }
  }
}
```

`package.json` exposes the deterministic lifecycle:

```json
{
  "scripts": {
    "desktop:runtime": "powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/acquire-node-runtime.ps1 -ReplaceExisting",
    "desktop:stage": "powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/stage-desktop-runtime.ps1 -ReplaceExisting",
    "desktop:build": "pnpm desktop:stage && tauri build",
    "test:desktop-package": "node tests/desktop-package.mjs"
  }
}
```

Run `desktop:runtime` before a clean release build, then `desktop:stage`; a
missing or unverified runtime fails closed. `desktop:build` deliberately does
not download a runtime implicitly, which keeps network acquisition explicit and
auditable.

## Acceptance gates

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm desktop:runtime
pnpm desktop:stage
pnpm test:security
pnpm test:desktop-package
pnpm test:model-selector-layout
pnpm test:desktop-contract
pnpm exec tauri build --no-bundle
```

For a real artifact, inspect `desktop/stage/rwang/runtime-manifest.json`,
recompute every listed SHA-256, confirm the required Node `LICENSE` and
`node-runtime.json` are present, and verify that no reparse points exist under
the staged tree before invoking the NSIS build. The staging contract test also
exercises `-DryRun` and asserts that it does not mutate an existing stage.
