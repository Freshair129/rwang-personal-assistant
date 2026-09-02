---
name: rwang-self-audit
description: Run RWANG's read-only self-audit against the current repository. Use when checking whether its documentation, annotations, or document graph are current before a change or release.
---

# RWANG self-audit

Run this skill before claiming that RWANG's own document intelligence workflow is healthy.

## Scope and safety

- Default to read-only inspection.
- Do not create or overwrite `docs/.doc-graph.json`, reports, or annotations unless the user explicitly requests an update.
- Treat scanner output as candidate traceability evidence, not an approval or canonical record.
- Report unavailable artifacts and parse failures clearly; do not infer graph coverage from a successful script exit alone.

## Procedure

1. Confirm the current repository root and whether `docs/.doc-graph.json` exists.
2. Parse-check `scripts/scan-annotations.ps1` with Windows PowerShell.
3. Run the scanner in table mode:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scan-annotations.ps1 -Path . -Format table
   ```

4. If a document graph exists, run the drift detector with a representative changed path through `TOOL_INPUT`; otherwise report that drift impact cannot be determined.
5. Summarize scanned files, structured and unstructured annotations, graph availability, and any stale-document candidates.

## Completion standard

The audit is complete only when the parser check and scanner run both succeed, and the report explicitly states whether a document graph was available for drift analysis.
