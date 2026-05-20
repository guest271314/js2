---
id: 1521
title: "test262 CI speedup: cross-PR cache sharing + path-scoped test selection"
status: ready
priority: high
reasoning_effort: medium
feasibility: medium
sprint: 52
---

## Problem

test262 CI takes ~25 min per PR. With 70+ concurrent PRs each triggering 16 parallel shards,
the CI queue becomes a bottleneck. Two independent improvements can cut per-PR CI time
significantly for narrowly-scoped PRs.

## Improvement 1: Cross-PR cache sharing via per-entry bundle hash

**Current state:**
- GHA cache key: `test262-cache-v2-{hashFiles(src/**/*.ts,...)}-chunk-{N}`
- When src changes (every PR), the entire chunk cache is busted
- The next PR starts cold, recompiling all 43k tests from scratch
- Each cache entry (`{test-hash}.json/wasm`) has no compiler version field —
  so we can't safely restore old caches and selectively recompile stale entries

**Fix:**
1. In `scripts/test262-worker.mjs`: add `bundle_hash` field to each cache entry
   (computed once per worker start from `scripts/compiler-bundle.mjs` sha256)
2. In `tests/test262-runner.ts`: when loading a cache entry, if `bundle_hash` ≠
   current bundle hash, treat the entry as a cache miss (recompile)
3. In `test262-sharded.yml` and `test262-differential.yml`: add loose restore-keys:
   ```yaml
   restore-keys: |
     test262-cache-v2-${{ hashFiles('src/**/*.ts',...) }}-
     test262-cache-v2-
   ```
   This restores from any recent cache as a warm start. Stale entries are individually
   recompiled (step 2 above). Fresh entries from unchanged tests are reused immediately.

**Expected speedup:** A PR that changes `src/codegen/statements.ts` would only recompile
tests that were affected by that change. Unaffected tests hit cache → ~5-10x fewer
compilations for narrowly-scoped PRs.

## Improvement 2: Path-scoped test selection in Test262 Differential

**Current state:**
All 16 shards run all 43k tests for every PR touching `src/**`.

**Fix:**
Add a `detect-scope` job before the shards in `test262-differential.yml`:
```yaml
detect-scope:
  runs-on: ubuntu-latest
  outputs:
    test_filter: ${{ steps.scope.outputs.test_filter }}
    scope_desc: ${{ steps.scope.outputs.scope_desc }}
  steps:
    - uses: actions/checkout@v5
      with: { fetch-depth: 0 }
    - id: scope
      run: |
        changed=$(gh pr diff ${{ github.event.pull_request.number }} --name-only | grep '^src/' | sort -u)
        filter=""
        # Map src files → test categories (coarse-grained)
        echo "$changed" | grep -q 'codegen/generators' && filter="$filter|language/generators"
        echo "$changed" | grep -q 'codegen/async'      && filter="$filter|language/statements/for-await"
        echo "$changed" | grep -q 'codegen/class'      && filter="$filter|language/class"
        echo "$changed" | grep -q 'codegen/regexp'     && filter="$filter|built-ins/RegExp"
        echo "$changed" | grep -q 'codegen/string'     && filter="$filter|built-ins/String"
        echo "$changed" | grep -q 'codegen/iterator'   && filter="$filter|built-ins/Iterator"
        echo "$changed" | grep -q 'codegen/proxy'      && filter="$filter|built-ins/Proxy|built-ins/Reflect"
        echo "$changed" | grep -q 'codegen/date'       && filter="$filter|built-ins/Date"
        echo "$changed" | grep -q 'codegen/array'      && filter="$filter|built-ins/Array"
        echo "$changed" | grep -q 'codegen/map\|codegen/set' && filter="$filter|built-ins/Map|built-ins/Set"
        echo "$changed" | grep -q 'codegen/wasi\|codegen/node\|codegen/browser' && filter=""
        # Core files that affect everything → no filter (run all)
        echo "$changed" | grep -qE 'codegen/(expressions|index|statements|type-coercion)\.ts' && filter=""
        # Strip leading pipe
        filter="${filter#|}"
        if [ -z "$filter" ]; then
          echo "test_filter=" >> "$GITHUB_OUTPUT"
          echo "scope_desc=all tests" >> "$GITHUB_OUTPUT"
        else
          echo "test_filter=$filter" >> "$GITHUB_OUTPUT"
          echo "scope_desc=filtered: $filter" >> "$GITHUB_OUTPUT"
        fi
```

Pass `TEST262_PATH_FILTER` env var to each shard from `detect-scope.outputs.test_filter`.

In `tests/test262-runner.ts`: honour `TEST262_PATH_FILTER` — skip tests whose path
doesn't match any pipe-separated pattern. Apply the filter early (before compile) so
even cache lookup is skipped for filtered-out tests.

**Expected speedup:** A PR touching only `src/codegen/regexp.ts` runs
~3k tests instead of 43k → ~14x fewer tests, ~14x faster CI.

## Implementation notes

- Improvement 1 is safe and unconditional. Implement first.
- Improvement 2: core-file changes (expressions.ts, index.ts, statements.ts,
  type-coercion.ts) must run all tests (no filter). This prevents false negatives.
- The filter is advisory — false negatives (missed regressions) are possible for
  complex cross-cutting changes. Document in workflow comments.
- Test the bundle_hash computation: use `sha256(compiler-bundle.mjs content)` or
  the GHA `${{ hashFiles(...) }}` output passed as an env var to the shard runner.

## Acceptance criteria

1. A PR touching only `src/codegen/regexp.ts` triggers CI that runs <5k tests (not 43k)
2. A PR touching `src/codegen/expressions.ts` still runs all 43k tests (safety fallback)
3. Two back-to-back PRs with different src changes share cache entries for unaffected tests
4. No false-negative regressions in a validation run against main baseline
5. Per-PR CI wall time for a regexp-scoped PR drops from ~25 min to <5 min

## Files to modify

- `scripts/test262-worker.mjs` — add `bundle_hash` to cache entry
- `tests/test262-runner.ts` — bundle hash validation on cache load + TEST262_PATH_FILTER support  
- `.github/workflows/test262-sharded.yml` — loose restore-keys
- `.github/workflows/test262-differential.yml` — detect-scope job + loose restore-keys + pass filter
