---
id: 2711
title: "Standalone↔host differential parity CI gate over the builtin surface (fail-loud, not trap)"
status: ready
sprint: 66
created: 2026-06-26
updated: 2026-06-26
priority: high
feasibility: medium
reasoning_effort: high
task_type: test-infra
area: codegen-linear
language_feature: standalone
goal: standalone-everything
related: [1854, 1838, 1662, 1535]
---
# #2711 — Standalone↔host differential parity CI gate

**Source:** 2026-06-26 audit. Recurring "bug factory" #4: the standalone /
linear path systematically lags the JS-host path and **fails by trapping or by
emitting an unsatisfiable late import** rather than failing loud. test262 runs
one mode, so these never surface there. Given the product direction is
**standalone-everything**, this is a release-gating class.

## Problem

Concrete divergences found (all standalone-only, host mode correct):

- `flat`/`flatMap` are host-import-only — `ensureLateImport("__array_flat"/
  "__array_flatMap")` with no `ctx.standalone` guard and no native arm
  (`array-methods.ts:8748/8790`) → **module fails to instantiate** in WASI.
- dedicated `indexOf`/`includes`/`lastIndexOf` on externref-element arrays emit
  `__host_eq`/`__same_value_zero` with no standalone branch
  (`array-methods.ts:4034/4262/8648`) → unsatisfiable import.
- linear backend bitwise operands + Uint8Array stores use trapping
  `i32.trunc_f64_s` (`codegen-linear/index.ts:3954/3201`) → `NaN|0`, `u8[i]=NaN`
  **trap** instead of ToInt32/ToUint8 wrap.
- try/`finally` with an early `return`/`break` inlines past the finally
  (`codegen-linear/index.ts:741`) → finally silently skipped.
- standalone `/i` is ASCII-only; `/u`,`/v` match per-code-unit; JSON booleans/null
  box as numbers (`json-codec-native.ts:1361`); `JSON.parse` accepts malformed
  number/`\uXXXX` grammar.

#1854 already built a **cross-backend differential harness** (done) but it is not
wired as a **CI gate over the builtin surface**, so these slip through.

## Recommendation

1. **Promote #1854's harness to a required CI gate** that runs a corpus
   (start: the builtin-method equivalence cases + a standalone-targeted sweep)
   through **both** WasmGC/host and linear/standalone and asserts identical
   observable output (`.status` + value, per project memory on `.status` not
   `.outcome`). Diverge ⇒ red.
2. **Make "unsupported in standalone" fail loud, never trap or emit an
   unsatisfiable import.** A method with no native arm must `reportError` when
   `ctx.standalone`/`wasi`, the way #1838 made linear `try/catch` refuse loudly.
   This converts silent miscompiles/instantiation failures into compile errors
   with a tracked gap.
3. File the per-method native-arm gaps (flat/flatMap, externref search, regex
   case-fold/unicode, JSON grammar, linear trunc/​finally) as child issues; this
   issue owns the **gate + fail-loud policy**, not each method.

## Acceptance criteria

- [ ] Differential harness runs in CI as a required check over the builtin corpus
      in both modes; a host↔standalone divergence fails the PR.
- [ ] Standalone compile of a method with no native arm produces a compile error
      (tracked gap), not a trap or unsatisfiable import.
- [ ] Linear backend: bitwise/typed-array conversions use `i32.trunc_sat_f64_s`;
      try/finally early-exit runs the finally (or refuses loudly).
- [ ] Child issues filed for each enumerated native-arm gap.
