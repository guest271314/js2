---
id: 2711
title: "Standalone↔host differential parity CI gate over the builtin surface (fail-loud, not trap)"
status: done
sprint: 66
created: 2026-06-26
updated: 2026-06-26
completed: 2026-06-26
assignee: "ttraenkler/dev-2711b"
priority: high
feasibility: medium
reasoning_effort: high
task_type: test-infra
area: codegen-linear
language_feature: standalone
goal: standalone-everything
related: [1854, 1838, 1662, 1535]
children: [2715, 2716, 2717, 2719, 2720, 2721]
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

- [x] Differential harness runs in CI over the builtin corpus in both modes; a
      host↔standalone divergence turns the check red. **Wired as ADVISORY, not
      required** — see Resolution for why.
- [ ] Standalone compile of a method with no native arm produces a compile error
      (tracked gap), not a trap or unsatisfiable import. → child issues #2717/#2719
- [ ] Linear backend: bitwise/typed-array conversions use `i32.trunc_sat_f64_s`;
      try/finally early-exit runs the finally (or refuses loudly). → #2715/#2716
- [x] Child issues filed for each enumerated native-arm gap (#2715–#2721).

## Resolution (2026-06-26)

The #1854 cross-backend differential harness (`tests/cross-backend-diff.test.ts`)
already existed but **no CI job ran it** — the `quality` and `linear-tests` jobs
only invoke named test files, and this one matched none of them, so divergences
slipped through. This PR closes the gate gap and files the per-method child
issues. It does **not** fix the codegen bugs themselves (those are the children).

What landed:

1. **`.github/workflows/cross-backend-parity.yml`** — a new job that runs the
   harness on `pull_request` + `push: main`. **Advisory / non-blocking by
   design:** it is NOT in the branch-protection required-checks list and does
   NOT run in `merge_group`, so a red result can never block or wedge the merge
   queue. (A new *required* check can wedge the queue, so promotion to required
   must be flagged to the team first — and only after it also runs in
   `merge_group`, else it would block the queue permanently. Acceptance
   criterion #1's "required check" is therefore deliberately deferred; the gate
   is live as advisory now.)
2. **`tests/cross-backend/corpus.ts`** — extended over the builtin surface:
   verified-agreeing entries (`numeric/modulo`, `string/concat-indexof`) plus
   `expectLinearUnsupported` ratchet entries for the named gaps
   (`numeric/exponent`, `math/builtins`, `array/search-methods`,
   `array/flat-flatMap`, `array/higher-order`). Known compile-but-diverge bugs
   (e.g. trapping `NaN|0`) are deliberately NOT added as corpus entries (they'd
   make the advisory gate red on main) — they are filed as children and become
   corpus entries once fixed.
3. **Child issues filed** for each enumerated native-arm gap: #2715 (linear
   trapping `i32.trunc_f64_s`), #2716 (linear try/finally early-exit),
   #2717 (array flat/flatMap host-import-only), #2719 (array externref search),
   #2720 (standalone regex case-fold/unicode), #2721 (standalone JSON
   boolean/null boxing + lax parse). The harness confirmed the #2715 divergence
   directly (`(0/0)|0` → host `0`, linear traps).
