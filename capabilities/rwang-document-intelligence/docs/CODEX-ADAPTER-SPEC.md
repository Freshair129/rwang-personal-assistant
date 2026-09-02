---
title: "RWANG Codex Adapter"
status: "implemented"
version: "1.0.1"
updated: "2026-08-10"
owner: "GPIC Team"
---

# RWANG Codex Adapter

## Purpose

Expose RWANG's existing documentation-intelligence skills to Codex while preserving the Claude Code plugin as a separate host integration.

## Scope

- Add a valid `.codex-plugin/plugin.json` pointing at the existing `skills/` directory.
- Add `rwang-self-audit` for explicit, read-only self-audit.
- Repair Windows PowerShell parsing of the annotation scanner.
- Repair the Claude hook manifest shape.

## Non-goals

- No MCP server, background service, marketplace registration, or automatic write/approval behavior.
- No direct knowledge promotion, canonical-ID assignment, or unrestricted graph traversal.
- No automatic PostToolUse equivalent in Codex.

## Host behavior

Claude Code retains its explicit `PostToolUse` drift hook. Codex invokes `rwang-self-audit` explicitly; it reports candidate evidence and requires user authorization for any write.

## Acceptance criteria

1. Windows PowerShell parses and runs `scripts/scan-annotations.ps1`.
2. `claude plugin validate .` succeeds.
3. The Codex plugin manifest passes the Codex plugin validator.
4. The Codex self-audit skill performs no write by default.
