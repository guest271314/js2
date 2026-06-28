#!/bin/bash
# PostToolUse hook: auto-format files after Edit/Write
# Runs prettier on the modified file to prevent formatting drift.

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
if [ -z "$FILE" ]; then
  exit 0
fi

# Only format supported file types
case "$FILE" in
  *.ts|*.js|*.mjs|*.json|*.html|*.css)
    npx prettier --write "$FILE" 2>/dev/null
    ;;
esac

# Forward-sync the rolling sprint queue (#2751): when an issue file is edited,
# keep its team-TaskList entry in lockstep (create/update if `sprint: current`).
# Incremental single-issue path — fast; never fails the edit.
case "$FILE" in
  */plan/issues/*.md)
    REPO_ROOT="${CLAUDE_PROJECT_DIR:-/workspace}" \
      node "${CLAUDE_PROJECT_DIR:-/workspace}/scripts/sync-current-tasklist.mjs" \
      --issue "$FILE" --quiet 2>/dev/null || true
    ;;
esac

exit 0
