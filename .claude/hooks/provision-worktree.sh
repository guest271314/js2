#!/bin/sh
# Provision agent worktrees with node_modules so the pre-push hooks
# (typecheck, prettier format:check, lint) actually run.
#
# Why: agent worktrees are created with `git worktree add` and come up WITHOUT
# node_modules. The pre-push hook then errors ("tsc: not found"), so agents
# `--no-verify` past it — which also skips lint-staged + format:check, so
# formatting / type drift reaches CI instead of being caught locally (see the
# #914 prettier-drift miss, 2026-05-29). Symlinking the main checkout's
# node_modules into each worktree is fast (no per-worktree install) and gives
# the worktree the SAME pinned tool versions as CI (npx-fetched versions can
# format differently).
#
# Wired as a PostToolUse hook on `git worktree add`; also safe to run manually.
# Scans all worktrees and symlinks node_modules where missing (idempotent).

MAIN="/workspace"
[ -d "$MAIN/node_modules" ] || exit 0   # nothing to share yet

# Enumerate worktrees from the main checkout; symlink node_modules where absent.
git -C "$MAIN" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | while read -r wt; do
  [ "$wt" = "$MAIN" ] && continue
  [ -d "$wt" ] || continue
  # Skip if node_modules already present (real dir OR existing symlink).
  [ -e "$wt/node_modules" ] && continue
  if ln -s "$MAIN/node_modules" "$wt/node_modules" 2>/dev/null; then
    echo "[provision-worktree] linked node_modules -> $wt"
  fi
done
exit 0
