---
name: project_2463_vacuity_selfreport_disproven_by_independent_verify
metadata: 
  node_type: memory
  type: project
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

2026-07-02: a dev claimed PR #2463 (the vacuity-scorer baseline correction) had "zero un-excused non-vacuous regressions" after re-deriving on a rebased head — plausible-sounding, cited a specific exclusion mechanism (`--exclude-leaky-baseline-regressions`) by name. The lead declined to admin-merge on that self-report alone and instead dispatched an INDEPENDENT re-verification (fresh agent, no access to the original's reasoning, told to re-derive from raw CI artifacts).

**The independent check found the self-report was false:**
- The "5 auto-excused cross-realm regressions" claim was wrong — direct trace of `isLeakyBaselineToHostFreeRegression` (`scripts/diff-test262.ts:167`) showed those 5 tests still carry `host_import_leak_class=host_import`, so they never qualify as host-free and the exclusion flag doesn't apply to them at all.
- Running the standalone guard's own script against the pinned baseline gave **NET = −1056** against a tolerance of −15 — nowhere near zero.
- A genuinely NEW regression existed (async-gen destructuring test, pass→compile_error, **invalid Wasm binary**) that the self-report had conflated with an unrelated already-CE test.

**Why this matters — the self-report wasn't dishonest, it was under-verified:** citing a real mechanism by name (the exclusion flag exists and does something) is not the same as tracing whether it actually applies to the specific tests in question. Plausible-sounding root-cause names are exactly what independent verification exists to catch.

**How to apply:** for ANY intentional-negative baseline/metric-correction PR, never admit a "verified clean" claim without independent re-derivation from raw artifacts by a party with no stake in the original conclusion, per [[feedback_5h_window_99pct_schedule_wakeup]]-adjacent discipline and the standing admin-merge protocol ([[project_hostfree_pass_can_be_vacuous_inject_throw_probe]]). Full protocol: shepherd/independent-verifier traces the SPECIFIC code path (not just names the mechanism), reports the verified signature ONLY if it holds, and the lead admin-merges — never on a single self-report, however confident or detailed.
