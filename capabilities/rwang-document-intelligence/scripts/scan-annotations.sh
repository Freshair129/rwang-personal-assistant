#!/usr/bin/env bash
# RWANG Annotation Scanner (Unix/macOS/Git Bash)
# Scans source files for @req, @spec, @designs, @tested annotations,
# plain requirement ID references (FR-xxx, NFR-xxx, SDD-xxx, etc.),
# Mermaid annotations (%% @req / %% @spec / %% @diagram_type in .mmd),
# and test-spec frontmatter (req/spec/test_type in .test.md)
#
# Usage:
#   ./scan-annotations.sh [ROOT_PATH] [FORMAT]
#   FORMAT: json (default) or table
#
# Example:
#   ./scan-annotations.sh /path/to/project table

set -euo pipefail

ROOT_PATH="${1:-.}"
FORMAT="${2:-json}"

# Resolve to absolute path
ROOT_PATH="$(cd "$ROOT_PATH" && pwd)"

# File extensions to scan
EXTENSIONS="ts,tsx,js,jsx,py,go,java,rs,cs"

# Build the include flags for grep
INCLUDE_FLAGS=""
IFS=',' read -ra EXT_ARRAY <<< "$EXTENSIONS"
for ext in "${EXT_ARRAY[@]}"; do
    INCLUDE_FLAGS="$INCLUDE_FLAGS --include=*.$ext"
done

# Directories to skip
EXCLUDE_DIRS="--exclude-dir=node_modules --exclude-dir=__pycache__ --exclude-dir=.venv --exclude-dir=venv --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=.next --exclude-dir=coverage"

# Temp files for results
STRUCTURED_FILE=$(mktemp)
UNSTRUCTURED_FILE=$(mktemp)
trap 'rm -f "$STRUCTURED_FILE" "$UNSTRUCTURED_FILE"' EXIT

# Requirement ID pattern: flat (FR-001) plus 5-driven (FR-a01001, FEAT-a01)
REQ_ID_ERE='(FR-[a-z][0-9]{5}|FEAT-[a-z][0-9]{2}|(FR|NFR|SDD|SEC|AI-AGT|AI-ETH|BR|AC|DR|IR)-[0-9]{3})'

# Scan for structured annotations in code
grep -rn $INCLUDE_FLAGS $EXCLUDE_DIRS -E '@(req|spec|designs|tested)\s+' "$ROOT_PATH" > "$STRUCTURED_FILE" 2>/dev/null || true

# Scan Mermaid diagram annotations (.mmd): %% @req / %% @spec / %% @diagram_type / %% @id
grep -rn --include='*.mmd' $EXCLUDE_DIRS -E '^[[:space:]]*%%[[:space:]]*@(req|spec|diagram_type|id)[[:space:]]+' "$ROOT_PATH" >> "$STRUCTURED_FILE" 2>/dev/null || true

# Scan test-spec frontmatter (.test.md): id: / req: / spec: / test_type:
grep -rn --include='*.test.md' $EXCLUDE_DIRS -E '^(id|req|spec|test_type)[[:space:]]*:' "$ROOT_PATH" >> "$STRUCTURED_FILE" 2>/dev/null || true

# Scan doc frontmatter identity (name-only filename mode): id: FEAT-a01
grep -rn --include='*.md' --exclude='*.test.md' $EXCLUDE_DIRS -E '^id[[:space:]]*:[[:space:]]*[A-Za-z0-9:_.-]+[[:space:]]*$' "$ROOT_PATH" >> "$STRUCTURED_FILE" 2>/dev/null || true

# Scan for unstructured requirement references
grep -rn $INCLUDE_FLAGS $EXCLUDE_DIRS -E "$REQ_ID_ERE" "$ROOT_PATH" > "$UNSTRUCTURED_FILE" 2>/dev/null || true

# Remove structured annotation lines from unstructured results
if [ -s "$STRUCTURED_FILE" ]; then
    # Get line identifiers from structured results
    STRUCTURED_LINES=$(awk -F: '{print $1":"$2}' "$STRUCTURED_FILE" | sort -u)
    TEMP_UNSTRUCTURED=$(mktemp)
    while IFS= read -r line; do
        LINE_ID=$(echo "$line" | awk -F: '{print $1":"$2}')
        if ! echo "$STRUCTURED_LINES" | grep -qF "$LINE_ID"; then
            echo "$line"
        fi
    done < "$UNSTRUCTURED_FILE" > "$TEMP_UNSTRUCTURED"
    mv "$TEMP_UNSTRUCTURED" "$UNSTRUCTURED_FILE"
fi

# Count results
STRUCTURED_COUNT=$(wc -l < "$STRUCTURED_FILE" | tr -d ' ')
UNSTRUCTURED_COUNT=$(wc -l < "$UNSTRUCTURED_FILE" | tr -d ' ')
TOTAL=$((STRUCTURED_COUNT + UNSTRUCTURED_COUNT))

# Count unique requirement IDs
ALL_IDS=$(cat "$STRUCTURED_FILE" "$UNSTRUCTURED_FILE" | grep -oE "$REQ_ID_ERE" | sort -u)
UNIQUE_ID_COUNT=$(echo "$ALL_IDS" | grep -c . || echo 0)

# Count files scanned
FILE_COUNT=$(find "$ROOT_PATH" \( -name "*.ts" -o -name "*.tsx" -o -name "*.py" -o -name "*.go" -o -name "*.java" -o -name "*.rs" -o -name "*.cs" -o -name "*.mmd" -o -name "*.test.md" \) \
    -not -path "*/node_modules/*" \
    -not -path "*/__pycache__/*" \
    -not -path "*/.venv/*" \
    -not -path "*/.git/*" \
    -not -path "*/dist/*" \
    -not -path "*/build/*" \
    -not -path "*/.next/*" | wc -l | tr -d ' ')

# Count files with references
FILES_WITH_REFS=$(cat "$STRUCTURED_FILE" "$UNSTRUCTURED_FILE" | awk -F: '{print $1}' | sort -u | wc -l | tr -d ' ')

if [ "$FORMAT" = "json" ]; then
    echo "{"
    echo "  \"generated_by\": \"rwang:scan-annotations\","
    echo "  \"generated_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
    echo "  \"root_path\": \"$ROOT_PATH\","
    echo "  \"summary\": {"
    echo "    \"files_scanned\": $FILE_COUNT,"
    echo "    \"files_with_refs\": $FILES_WITH_REFS,"
    echo "    \"structured_count\": $STRUCTURED_COUNT,"
    echo "    \"unstructured_count\": $UNSTRUCTURED_COUNT,"
    echo "    \"total_annotations\": $TOTAL,"
    echo "    \"unique_req_ids\": $UNIQUE_ID_COUNT"
    echo "  }"
    echo "}"
else
    echo ""
    echo "=== RWANG Annotation Scan Report ==="
    echo "Root: $ROOT_PATH"
    echo "Files scanned: $FILE_COUNT"
    echo "Files with references: $FILES_WITH_REFS"
    echo "Structured annotations (@req, @spec, etc.): $STRUCTURED_COUNT"
    echo "Unstructured references (# FR-xxx): $UNSTRUCTURED_COUNT"
    echo "Unique requirement IDs: $UNIQUE_ID_COUNT"
    echo ""

    if [ "$STRUCTURED_COUNT" -gt 0 ]; then
        echo "--- Structured Annotations ---"
        while IFS= read -r line; do
            FILE_LINE=$(echo "$line" | sed "s|$ROOT_PATH/||")
            echo "[S] $FILE_LINE"
        done < "$STRUCTURED_FILE"
        echo ""
    fi

    if [ "$UNSTRUCTURED_COUNT" -gt 0 ]; then
        echo "--- Unstructured References ---"
        while IFS= read -r line; do
            FILE_LINE=$(echo "$line" | sed "s|$ROOT_PATH/||")
            echo "[U] $FILE_LINE"
        done < "$UNSTRUCTURED_FILE"
        echo ""
    fi

    if [ "$TOTAL" -eq 0 ]; then
        echo "⚠ No annotations found."
    fi
fi
