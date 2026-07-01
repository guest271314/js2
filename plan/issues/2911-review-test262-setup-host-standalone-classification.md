---
id: 2911
title: "Review: test262 setup + host-vs-standalone classification and pass-rate computation"
status: in-review
priority: medium
sprint: current
created: 2026-07-01
feasibility: medium
task_type: review
area: tooling
goal: developer-experience
related: [2910, 2774, 2636, 2097, 2912, 2913, 2914]
---

# #2911 — Review the test262 setup + host/standalone classification & pass rates

**Audit task (execute it — produce findings, don't just fix piecemeal).** Verify
that the test262 pipeline is set up correctly and that tests are classified into
**JS-host** vs **standalone** pass rates accurately and consistently.

## Scope — answer each with evidence
1. **Runner setup.** How test262 runs end-to-end: `pnpm run test:262` /
   `tests/test262-runner.ts` / `scripts/test262-worker.mjs`, the sharded CI
   (`test262-sharded.yml`), worker recycling, skip filters
   (eval/with/Proxy/SharedArrayBuffer/Temporal/…), and how a per-test verdict
   (`pass`/`fail`/`compile_error`/`skip`) is decided. Flag any verdict heuristics
   that can mislabel (e.g. the warning→pass path #2898 hit; the in-process
   batch-scanner cross-test-state false positives; negative/early-error tests).
2. **Host vs standalone modes.** How the SAME test is run in **JS-host** mode
   (host imports) vs **standalone** mode (`--target wasi`/pure-wasm, no JS
   runtime). Where each result is recorded and how the two are kept in sync
   (`build-standalone-cli.mjs`, `build-test262-report.mjs`,
   `test262-standalone-report.json`, `test262-standalone-editions.json`,
   `check-standalone-highwater.mjs`, the #2097 absolute standalone floor).
3. **Classification correctness.** Are tests classified into host/standalone
   pass rates on a sound axis? Is a test that is host-only (uses a host import
   with no standalone fallback) counted correctly in the standalone denominator,
   or does it deflate/inflate the standalone rate? Cross-check against #2910's
   edition/feature classification work — do the standalone editions
   (`test262-standalone-editions.json`) use the same classifier?
4. **Pass-rate math.** Denominators (skip in/out?), dedup (the baseline has
   duplicate records — e.g. `eval-gtbndng-indirect-update-dflt.js` appears
   twice; does that double-count?), and whether host + standalone totals are
   over the same population so they're comparable.
5. **Baseline & staleness.** The committed summary vs the fetched JSONL vs the
   separate `loopdive/js2wasm-baselines` repo; `check-baseline-floor-staleness`;
   how stale the numbers can get and whether the dashboard reflects current main.

## Deliverable
- A written findings section appended to this issue (or a short
  `docs/` note linked here): what's correct, what's wrong/misleading, and
  concrete recommendations.
- File **follow-up issues** (via `claim-issue.mjs --allocate`) for each concrete
  defect found (e.g. double-counting, host-only-in-standalone-denominator,
  classifier divergence), tagged `sprint: current`.
- If a fix is small + safe, it may be done inline; larger fixes → follow-up
  issues routed appropriately.

## Acceptance
- Each scope item (1–5) answered with file:line evidence.
- Any real defect either fixed (small) or filed as a follow-up issue.
- A clear statement of whether the reported host + standalone pass rates are
  trustworthy and comparable, with the caveats enumerated.

---

## Findings (review 2026-07-01)

Audited on `origin/main` @ `a84fe6e80447` (+ fetched HEAD `e63f677`). Evidence is
`file:line` against the tree at review time. Follow-up defects filed: **#2912,
#2913, #2914**.

### Architecture in one paragraph (so the evidence reads cleanly)

The authoritative runner is the sharded CI matrix
(`.github/workflows/test262-sharded.yml:428-434`): the **same** 57 chunk files
(`tests/test262-chunk*.test.ts` → `runTest262Chunk`, `tests/test262-shared.ts:450`)
run under **two targets** — `gc` (JS-host, `result_prefix: test262`) and
`standalone` (`result_prefix: test262-standalone`). `test262-shared.ts` forks the
unified worker `scripts/test262-worker.mjs`, passing `target: TEST262_TARGET`
(`tests/test262-shared.ts:803`), which decides each per-test verdict. The
`merge-report` job concatenates the shard JSONLs and runs
`scripts/build-test262-report.mjs` once per lane
(`.github/workflows/test262-sharded.yml:601-635`). `tests/test262-vitest.test.ts`
is a **secondary** two-phase (precompile-cache) runner, not the CI path; it
mirrors the same verdict logic.

### 1. Runner setup — verdict heuristics

**Correct / sound:**
- Positive-test verdict is a real signal: `test()` must return `1`
  (`scripts/test262-worker.mjs:1318`, `ret === 1 ? "pass" : "fail"`); `wrapTest`
  makes the harness return 1 only when assertions hold.
- Worker recycling is thorough: prototype-poison restore + realm-canary drift
  detection request a fork recycle (`scripts/test262-worker.mjs:503-784, 1428-1627`),
  and the pool retries poison-class verdicts in a clean fork
  (`tests/test262-shared.ts:826-964`). This is the right defense against the
  in-process cross-test-state contamination the review flagged.
- `instantiate`-time throws are correctly split: `CompileError`/`LinkError` →
  `compile_error`+`malformed_wasm` hard-error bucket; a start-function throw →
  `fail` (`scripts/test262-worker.mjs:1247-1281`, `tests/test262-vitest.test.ts:730-751`).
- Skip filters are narrow and each carries an issue reference
  (`tests/test262-runner.ts:324-397`); proposals are excluded by default and
  counted separately, not silently dropped.

**Wrong / misleading — DEFECT (→ #2912):** negative `phase:parse|early|resolution`
tests are recorded **pass on ANY compile error**. The intended error-code gate is
dead code: `scripts/test262-worker.mjs:1150` is `status: hasEarlyError ? "pass" :
"pass"` (both arms identical), and `tests/test262-vitest.test.ts:616-624` has the
same `if (hasEarlyError) …pass… else …pass…` shape. `ES_EARLY_ERRORS` and
`hasEarlyError` are computed and thrown away; the runner never checks the test's
`negative.type`. This inflates the negative-test pass population equally on both
lanes.

**Misleading — warning→pass (caveat, tracked under #2855/#2898):** the verdict
gate blocks only on `severity === "error"` (`scripts/test262-worker.mjs:1103`),
so a compile that emits **warnings** proceeds to execute. Because the IR/codegen
fallback demotes non-hard failures to warnings
(`src/codegen/index.ts:1054`, `severity: hard ? "error" : "warning"`), a
miscompiled test that still returns `1` can be scored pass. #2898's own
resolution documents a negative test that "only 'passed' incidentally via the
runner's warning→pass heuristic." Not separately filed — it is the exact thing
#2855 (retire IR fallback demotion) is chartered to remove; noted here and cross-
referenced from #2912.

### 2. Host vs standalone modes

**Correct:** the two lanes are produced from the **same population** (same chunk
files, same `shouldSkip`) under different `TEST262_TARGET`
(`.github/workflows/test262-sharded.yml:428-451`). Each lane's rows carry a
`host_import_leak_class` computed by the worker
(`scripts/test262-worker.mjs:803-826`) so the report can tell host-satisfied
passes from host-free ones. The standalone report headlines on the **honest**
metric `host_free_pass = status==="pass" && !host_import_leak_class`
(`scripts/build-test262-report.mjs:844`, #2879), and the #2097 absolute floor
keys on the same field (`scripts/check-standalone-highwater.mjs:28` reads
`full_summary.host_free_pass`; highwater is fresh — `host_free_pass: 15043`,
`generated_at 2026-06-30`). This is a sound design: a leaky (host-dependent) pass
under `--target standalone` is credited as `leaky_pass`, not as standalone
conformance.

### 3. Classification correctness

**Sound axis, one real divergence.** Host↔standalone is split on a sound axis
(same tests, different target, honest host-free crediting — see item 2). A
host-only test does **not** deflate/inflate unfairly: under standalone it either
fails to compile (counted in `total`) or passes-but-leaky (in `total`, excluded
from `host_free_pass`), so it stays in the shared denominator without being
mis-credited.

**DEFECT (→ #2914):** the **per-edition** standalone numbers use a *different*
pass definition than the standalone headline. Per #2636 the standalone editions
file is produced by running the host classifier over the standalone JSONL
(`scripts/run-pages-build.mjs:47-63`, `generate-editions.ts --results …standalone-current.jsonl`),
but `scripts/generate-editions.ts` counts raw `status === "pass"`
(`normalizeStatus`, lines 457-461) and its record type has no
`host_import_leak_class` (lines 487-493) — no host-free notion at all. So the
landing-page standalone **donut** shows host-free while the standalone **edition
slider** shows leaky-inflated per-edition rates. The edition *classifier*
(es5id/es6id/features/path) is shared and fine; the divergence is purely the
pass definition. (#2910, cited by this review as the classifier cross-check, has
no issue file on `origin/main` or the review branch — only referenced in
`related:`; treated as "no divergent second classifier exists," the single
classifier is `generate-editions.ts`.)

### 4. Pass-rate math

**Denominators — correct:** `build-test262-report.mjs` cleanly separates
`standard`/`annex_b` (official headline) from `proposal`
(`scripts/build-test262-report.mjs:856-865, 897-926`); skips are counted but
excluded from `compilable`. Host and standalone totals are over the same
population → **comparable in principle**.

**DEFECT (→ #2913): duplicate rows are double-counted.** `build-test262-report.mjs`
does `statuses.total++` / `statuses[status]++` per record with **no dedup**
(`scripts/build-test262-report.mjs:846`; no `seen` set anywhere in `main()`),
and `generate-editions.ts` buckets per-record with no dedup either. Measured on
the committed baselines 2026-07-01:
- host `test262-current.jsonl`: 48,142 rows / 48,088 distinct files → **54
  duplicate rows**, ALL in `language/module-code`, **27 with disagreeing
  statuses** (`compile_error` on one row, `fail` on the other for the same file).
- `test262-standalone-results.jsonl`: 48,117 rows / 48,088 distinct → **29 dups**.

`findTestFiles` returns each file once (`tests/test262-runner.ts:2630-2644`) and
each category is iterated once (`tests/test262-shared.ts:456-470`) — so this is a
double-**write** (most likely the retry path `tests/test262-shared.ts:826-964`,
which the code even warns can double-write at lines 766-774), not enumeration.
Magnitude ~0.1% of the denominator, but it makes the headline **non-deterministic**
(the duplicated row's status depends on retry timing).

### 5. Baseline & staleness

**Correct machinery:** the committed host summary
`benchmarks/results/test262-current.json` is fresh (`baseline_sha 20474543…`,
`generated_at 2026-06-30T23:50Z`, 33,147/43,135). The staleness self-check
watches **both** floors in the baselines repo
(`scripts/check-baseline-floor-staleness.mjs:215-216`,
`test262-standalone-current.json` + `test262-current.json`), counting only
test262-relevant commits, threshold 25, exit-2-on-breach without ever promoting
(sound: never blocks on uncertainty). The authoritative JSONL is fetched fresh
from `loopdive/js2wasm-baselines` (`scripts/fetch-baseline-jsonl.mjs`), not the
committed blob.

**Caveat (not separately filed):** the **committed** standalone report in the main
repo is stale and mislabeled — `benchmarks/results/test262-standalone-report.json`
symlinks a 2026-06-16 file with an **empty `baseline_sha`** and `summary.pass =
20274` (a raw-pass number, ~2 weeks behind the host summary and inconsistent with
the fresh highwater's host-free 15043/official 14694). It is a fallback, not the
dashboard's live source (#2636 has the Pages build fetch fresh standalone JSONL),
but it is a stale, easily-misread artifact in-tree. Overlaps existing
staleness/deploy issues (#1880, #1885); flagged here rather than re-filed.

### Overall verdict

**The reported host + standalone pass rates are broadly trustworthy and
comparable, with three enumerated caveats.**

- **Comparable?** Yes — both lanes run the identical test population under the
  same skip filter and are aggregated by the same report builder; standalone is
  credited honestly on `host_free_pass`, and the #2097 floor guards it. The
  host/standalone split is on a sound axis.
- **Exactly trustworthy?** Not to the last ~0.1–0.5%. Three defects make the
  numbers slightly optimistic and/or non-deterministic, in priority order:
  1. **#2912** — negative parse/early tests pass on any compile error (dead
     error-code gate); inflates the negative population on **both** lanes.
     Needs a **PO decision** (tighten-and-re-baseline vs. document the lenient
     policy + delete dead code) → this issue is left `in-review`.
  2. **#2914** — standalone per-edition slider counts leaky passes while the
     donut/floor count host-free; the two standalone surfaces disagree.
  3. **#2913** — duplicate result rows are double-counted (no dedup in the
     report/editions builders); makes the headline non-deterministic.
- None of the three breaks host↔standalone comparability (they hit both lanes
  symmetrically, or only the standalone *edition* sub-view). The core headline
  (host 76.8%, standalone host-free ~34% official) is directionally sound.
