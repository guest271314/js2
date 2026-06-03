# Harvest Test262 Errors

Analyze the latest test262 run results, cross-reference with existing issues, and create new issues for unaddressed error patterns.

There are **two independent test262 lanes** — harvest each separately and never
mix their counts (they are distinct conformance metrics on different targets):

| Lane | Target flags | Results JSONL | Categories JSON | Goal tag |
|------|--------------|---------------|-----------------|----------|
| **Default (JS-host)** | `gc` target, host imports allowed | `benchmarks/results/test262-current.jsonl` | `benchmarks/results/test262-categories.json` | (default) |
| **Standalone** | `--target standalone` `--no-host-imports`, `nativeStrings` | `benchmarks/results/test262-standalone-current.jsonl` | `benchmarks/results/test262-standalone-categories.json` | `goal: standalone-mode` |

The standalone lane measures pure-Wasm conformance (no JS runtime). Its failures
are dominated by **host-import leaks** — features that silently fall back to a JS
host import in the default lane but are *refused* in standalone mode. The
standalone records carry an extra classifier field, `host_import_leak_class`,
that the default lane does not.

## Steps

Run the lane-agnostic steps (1–7) once per lane, against that lane's JSONL +
categories file, then emit the two summary tables (step 8).

1. Find the latest test262 results JSONL for the lane:
   - **Default lane**: `benchmarks/results/test262-current.jsonl` (committed
     baseline). If running fresh locally, the runner writes
     `benchmarks/results/test262-results.jsonl`; if empty, find the largest file
     in `benchmarks/results/runs/`.
   - **Standalone lane**: `benchmarks/results/test262-standalone-current.jsonl`
     (committed baseline). To regenerate locally:
     `TEST262_TARGET=standalone bash scripts/run-test262-vitest.sh`.
   - Rebuild the categories rollup if needed:
     - Default: `node scripts/build-test262-report.mjs`
     - Standalone: `node scripts/build-test262-report.mjs --target standalone`
       (writes `test262-standalone-categories.json`).

2. Parse all results and categorize errors:
   - **Compile errors**: group by pattern (undefined .kind, stack underflow, local.set mismatch, struct error, call mismatch, missing import, stack fallthrough, unsupported, missing property, yield outside gen, await outside async, etc.)
   - **Runtime failures**: group by pattern (returned wrong with assert info, null pointer deref, timeout, illegal cast, array OOB, unreachable, uncaught exception)
   - **Standalone lane only — bucket on `host_import_leak_class`** (this is the
     primary signal for standalone, ahead of the compile/runtime split):
     - `proxy` → #1472 (Proxy without host)
     - `regexp` → #1474 (RegExp literals/constructor refused standalone)
     - `json` → #1599 (standalone JSON parser/stringifier)
     - `dynamic-object-property` → dynamic property access lowering
     - `bigint` → BigInt standalone path (#1349/#1644 family)
     - `generic-iterator` → standalone iterator protocol
     - `host-import-refusal` → the #1524 host-import gate refusing a feature with
       no standalone fallback yet (catch-all; route to the most specific
       sub-bucket above before falling back to this)
   - For each pattern, count occurrences and collect 3 sample file paths

3. Cross-reference with existing issues:
   - Read issue files in `plan/issues/`
   - Match error patterns to existing issue titles/descriptions
   - **Standalone lane**: standalone issues carry `goal: standalone-mode` and sit
     under umbrella **#1781**. Match `host_import_leak_class` buckets to the
     per-class issues listed in step 2 first.
   - Mark each pattern as: ADDRESSED (`status: done`), IN PROGRESS (`status: ready` / `in-progress` / `in-review`), or NEW

4. For NEW patterns with >50 occurrences:
   - Create issue files in `plan/issues/` with next available number
   - Include: priority (based on count), sample files, root cause analysis, suggested fix
   - **Standalone-lane issues**: set `goal: standalone-mode` and link the umbrella
     #1781 in `related:`.
   - Update `plan/issues/backlog/backlog.md`

5. For ADDRESSED patterns where count INCREASED vs the issue's original count:
   - Flag as potential regression
   - Add a note to the issue file

6. (per lane) Collect the lane's pattern/count/status rows for the summary.

7. Repeat steps 1–6 for the other lane.

8. Output **two separate** summary tables — never sum across lanes:

   **Default (JS-host) lane:**
   ```
   Pattern | Count | Status | Issue #
   --------|-------|--------|--------
   null deref | 2,560 | #663 done | regression?
   assert.throws | 4,738 | #695 open | tracked
   ...
   ```

   **Standalone lane** (lead with `host_import_leak_class`):
   ```
   Leak class / Pattern | Count | Status | Issue #
   ---------------------|-------|--------|--------
   regexp | 1,210 | #1474 ready | tracked (umbrella #1781)
   json | 540 | #1599 in-progress | tracked
   proxy | 330 | #1472 ready | tracked
   ...
   ```

9. Commit all new/updated issue files with a descriptive message.

Always check `free -h` before running to ensure enough memory. Never delete test data.
