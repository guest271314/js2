# Harvest Test262 Errors

Analyze the latest test262 run results, cross-reference with existing issues, and create new issues for unaddressed error patterns.

## Data source — the `loopdive/js2wasm-baselines` repo (authoritative)

**Always harvest the full detailed run results published in
[`loopdive/js2wasm-baselines`](https://github.com/loopdive/js2wasm-baselines),
not any copy committed into the main repo.** CI (`promote-baseline` in
`test262-sharded.yml`) pushes the complete per-test results there on every merge
to `main`. The main repo no longer carries the JSONL blob (#1528); any local
`benchmarks/results/*.jsonl` is a trimmed, possibly-stale mirror — using it
under-reports the real pass rate (it read 61.5% on 2026-06-03 when the baselines
repo had 70.7%). Fetch fresh every run.

Baselines-repo file set (root of the repo, branch `main`):

| | Default (JS-host) lane | Standalone lane |
|---|---|---|
| Full results (one JSON/test) | `test262-current.jsonl` (~36 MB) | `test262-standalone-current.jsonl` (~53 MB) |
| Latest raw run | `test262-results.jsonl` | `test262-standalone-results.jsonl` |
| Summary counts | `test262-current.json` | `test262-standalone-current.json` |
| Report rollup | `test262-report.json` | `test262-standalone-report.json` |
| Trend history | `runs/index.json` (shared) | |

There are **two independent test262 lanes** — harvest each separately and never
mix their counts (they are distinct conformance metrics on different targets):

| Lane | Target flags | Goal tag |
|------|--------------|----------|
| **Default (JS-host)** | `gc` target, host imports allowed | (default) |
| **Standalone** | `--target standalone` `--no-host-imports`, `nativeStrings` | `goal: standalone-mode` |

The standalone lane measures pure-Wasm conformance (no JS runtime). Its failures
are dominated by **host-import leaks** — features that silently fall back to a JS
host import in the default lane but are *refused* in standalone mode. The
standalone records carry an extra classifier field, `host_import_leak_class`,
that the default lane does not.

## Steps

Run the lane-agnostic steps (1–7) once per lane, against that lane's JSONL +
categories file, then emit the two summary tables (step 8).

1. Fetch the latest detailed results JSONL for the lane **from the baselines
   repo** (do not trust local committed copies — see "Data source" above):
   - **Default lane** — use the existing helper, which downloads + caches to
     `.test262-cache/test262-current.jsonl` (gitignored):
     ```bash
     node scripts/fetch-baseline-jsonl.mjs --force --print-path
     ```
   - **Standalone lane** — fetch directly from the baselines repo (the helper
     only covers the default lane):
     ```bash
     curl -fsSL https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-standalone-current.jsonl \
       -o .test262-cache/test262-standalone-current.jsonl
     ```
     (or `gh api repos/loopdive/js2wasm-baselines/contents/test262-standalone-current.jsonl`
     if unauthenticated raw access is rate-limited).
   - Cross-check freshness against `runs/index.json` in the baselines repo (the
     last entry's timestamp) so you know the data isn't a stale promotion.
   - To **regenerate** a lane locally instead of fetching (slow; only when you
     need uncommitted compiler changes reflected):
     - Default: `bash scripts/run-test262-vitest.sh`
     - Standalone: `TEST262_TARGET=standalone bash scripts/run-test262-vitest.sh`
   - Build the categories rollup from the fetched JSONL if you want the
     bucketed report:
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
