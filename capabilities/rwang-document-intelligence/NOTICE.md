# RWANG Document Intelligence vendoring notice

This directory is vendored from
`https://github.com/Freshair129/rwang-plugin.git`, tag `v1.4.0`, commit
`42ef41ffff3b62dcfd88ac28780d8f0d26b1c617`.

The published Codex release asset for the same tag has SHA-256
`d93209d15b3b154327bb04d7e15452465b3743441e81d6b21fd6ccb037bc217a`.
This vendored subset was taken from the pinned Git commit because the Codex
asset omits documents referenced by the skills. See `SOURCE.json` for
machine-readable provenance. Text files are normalized to this project's
declared line endings and trailing whitespace is removed; runtime hashes cover
the normalized copies actually executed by RWANG.

RWANG applies one local security adaptation to `scripts/scan-annotations.ps1`:
directory enumeration skips exact ignored-directory names and reparse points
before recursion. This prevents dependency-cache junctions from crossing the
declared scan boundary. The adaptation is declared in `SOURCE.json` and the
executed copy remains covered by the adapter's pinned runtime SHA-256.
PowerShell source is hashed after canonical LF newline normalization so the
same reviewed text has one digest when Git materializes LF or declared CRLF.

Upstream metadata declares the package license as MIT, but the pinned upstream
revision does not currently contain a `LICENSE` file. This notice records that
discrepancy; it does not add, replace, or reinterpret an upstream license.

RWANG intentionally excludes the upstream automatic hook surface (`hooks/`)
and the release-only write helper (`scripts/bump-version.ps1`). The host adapter
exposes only explicitly allowlisted, bounded, read-only scanner and validator
actions.
