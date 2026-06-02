#!/bin/sh
# PostToolUse hook: provision new worktrees with shared heavyweight deps.
#
# Wired on `git worktree add`; also safe to run manually. Delegates to the
# repo script so agent worktrees, Codex worktrees, and test worktrees share the
# same behavior.

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/provision-worktree-deps.sh"

if [ -x "$SCRIPT" ]; then
  exec "$SCRIPT"
fi

if [ -f "$SCRIPT" ]; then
  exec sh "$SCRIPT"
fi

echo "[provision-worktree] missing $SCRIPT; skipping"
exit 0
