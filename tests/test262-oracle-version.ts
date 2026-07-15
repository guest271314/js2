/**
 * test262-oracle-version.ts — single source of truth for the conformance
 * ORACLE VERSION (#2096).
 *
 * The "oracle" is the verdict logic that decides pass/fail/CE for a test262
 * row: error classification (`classifyError`), negative-test expectation
 * matching, and the error-type precision the runner demands (e.g. the #1945
 * trap-vs-TypeError upgrade). When that logic tightens, rows that used to
 * read `pass` flip to `fail`/`compile_error` for the SAME compiler output.
 * Those flips are oracle skew, not code regressions.
 *
 * Every result row (`recordResult`) and every merged report/baseline JSON
 * is stamped with this version. `scripts/diff-test262.ts` refuses to diff a
 * baseline against a candidate whose oracle_version differs (the comparison
 * would be apples-to-oranges and the regression gate would fire on skew),
 * unless `ORACLE_REBASE=1` is set — which is how the #1945 flip PR (and any
 * future oracle change) re-seeds the baseline at the new version.
 *
 * ── HOW TO BUMP ──────────────────────────────────────────────────────────
 * When you tighten the oracle (change classifyError / negative-expectation
 * matching / required error precision in a way that flips existing rows):
 *   1. Bump ORACLE_VERSION below (increment the integer).
 *   2. Note the change in ORACLE_VERSION_HISTORY.
 *   3. Land the change as a single PR run with ORACLE_REBASE=1 so the diff
 *      gate accepts the cross-version comparison and promote-baseline
 *      re-seeds the committed baseline at the new version.
 * After that PR merges, every post-flip PR diffs same-version → same-version
 * and the gate measures only code changes again.
 *
 * The version is an opaque monotonic integer — it is NOT the compiler
 * version or a date. Two runs with the same ORACLE_VERSION are guaranteed to
 * apply identical verdict logic, so their rows are directly comparable.
 */
export const ORACLE_VERSION = 4;

/**
 * Append-only log of what each oracle version means. Newest last.
 */
export const ORACLE_VERSION_HISTORY: ReadonlyArray<{ version: number; note: string }> = [
  {
    version: 1,
    note:
      "Baseline oracle as of #2096. Error classification per classifyError + " +
      "negative-test expectation matching as shipped before the #1945 error-type upgrade.",
  },
  {
    version: 2,
    note:
      "#3086 honest vacuity re-baseline. Extends the #2463 vacuity scorer from " +
      "the GLOBAL total-vacuity check (harness wrapper invoked + __assert_count " +
      "=== 1, i.e. zero asserts anywhere) to PER-CALLBACK partial vacuity: a " +
      "would-be pass is scored `vacuous` (fail) when a testWith*Constructors " +
      "wrapper was invoked and EVERY attempted callback invocation contributed " +
      "zero asserts (the dropped-dispatch / dead-callback class of #2939/#2940/" +
      "#3083) — even when setup asserts elsewhere kept __assert_count > 1. This " +
      "reclassifies previously-vacuous 'passes' to honest fails (owner-approved " +
      "regression). Landed with ORACLE_REBASE (forward-monotonic bump auto-" +
      "rebases in diff-test262.ts) so the guards treat the cross-policy diff as " +
      "a re-baseline; promote-baseline re-seeds host+standalone baselines at v2.",
  },
  {
    version: 3,
    note:
      "#3187 error_category classifier split. classifyError previously binned " +
      "'… is not a function' (missing builtin/runtime feature) and 'No dependency " +
      "provided for …' (the compiler's DI diagnostic) as wasm_compile, inflating " +
      "the genuine invalid-Wasm bucket ~3.4× (~448 → ~87 default-lane). Splits out " +
      "three honest buckets: missing_builtin ('\\bis not a function\\b'), " +
      "missing_dependency ('No dependency provided'), and harness_shape ('no test " +
      "export'), while wasm_compile is narrowed to 'invalid Wasm binary|Compiling " +
      "function'. LABEL-ONLY: zero pass/fail flips (net_per_test 0). The " +
      "regression-gate bucket diff is label-noise; landed with ORACLE_REBASE so " +
      "the guards treat the cross-policy relabel as a re-baseline.",
  },
  {
    version: 4,
    note:
      "#3285 assert_throws error-type precision (slice 1). transformAssertThrows " +
      "previously discarded the expected error constructor (args[0]): " +
      "`assert.throws(TypeError, fn)` became a bare `assert_throws(fn)` that only " +
      "checked 'did anything throw', so a codegen bug throwing the WRONG error " +
      "type (e.g. RangeError where the spec mandates TypeError) read as a false " +
      "pass. The runner now threads the expected type through — " +
      "`assert_throws(ErrorCtor, fn)` verifies the caught error MATCHES the " +
      "expected type (`e instanceof ErrorCtor`, `.name` fallback for host-opaque " +
      "shapes) before counting a pass. This reclassifies previously-inflated " +
      "false-passes to honest fails (owner-approved per #3285 acceptance " +
      "criteria — the drop is the correct signal, not a regression). NOTE: because " +
      "the synthetic harness/preamble compiles INTO the wasm, this shim change " +
      "alters wasm_sha for every assert.throws test, so the reclassified flips " +
      "register as wasm-CHANGE regressions — the #3086 forward-bump auto-rebase " +
      "excuses only SAME-wasm oracle-skew flips, so this re-baseline needs a " +
      "promote-baseline/force-refresh at v4 to seed the new-policy floor (the " +
      "oracle bump alone does not clear the #1668/#3086 wasm-change guards). NOTE: " +
      "the #3003 verdict-oracle-bump gate did NOT flag this change — its " +
      "VERDICT_SIGNAL_RE only matches `status:` verdict-literal assignments, not " +
      "verdict-tightening inside the assert_throws/assert_throwsAsync shim body; " +
      "that false-negative is a follow-up gate-hardening item for a future window.",
  },
];
