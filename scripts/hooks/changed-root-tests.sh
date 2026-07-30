#!/bin/sh
# Run the same changed-root-test gate locally and in CI.
#
# The full tests/*.test.ts population is too large for every commit, so this
# mirrors CI #3008: run only root test files added or modified by the branch.

set -u

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  echo "changed-root-tests: not inside a Git worktree." >&2
  exit 1
fi
cd "$repo_root" || exit 1

base_ref="${CHANGED_ROOT_TESTS_BASE:-origin/main}"
base="$(git merge-base "$base_ref" HEAD 2>/dev/null || true)"
if [ -z "$base" ]; then
  echo "changed-root-tests: cannot resolve a merge base with $base_ref." >&2
  echo "Fetch $base_ref or set CHANGED_ROOT_TESTS_BASE to a local base ref." >&2
  exit 1
fi

# Comparing the base to the working tree includes both the existing branch
# commits and the staged commit that pre-commit is about to create.
changed="$(
  git diff --name-only --diff-filter=AM "$base" -- tests/ |
    grep -E '^tests/[^/]+\.test\.ts$' |
    grep -vE '^tests/(linear-|c-abi\.|simd|test262-(chunk|vitest))' || true
)"

if [ -z "$changed" ]; then
  echo "changed-root-tests: no root test files changed."
  exit 0
fi

count="$(printf '%s\n' "$changed" | wc -l | tr -d ' ')"
if [ "$count" -gt 20 ]; then
  echo "changed-root-tests: $count root test files changed (>20); skipping the change-scoped gate."
  echo "The post-merge issue-tests detector covers mass edits."
  exit 0
fi

echo "changed-root-tests: running $count changed root test file(s):"
printf '%s\n' "$changed"

for test_file in $changed; do
  pnpm exec vitest run "$test_file" \
    --pool=forks \
    --poolOptions.forks.singleFork=true \
    --no-file-parallelism || exit 1
done
