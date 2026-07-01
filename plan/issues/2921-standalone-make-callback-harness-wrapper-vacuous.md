---
id: 2921
title: "standalone: __make_callback sole-leak is the harness-wrapper (testWith*Constructors / assert.throws) graceful-fallback + vacuous pass — NOT a TypedArray HOF gap (sub-front 4 of #2903 yields 0)"
status: in-progress
sprint: current
priority: high
feasibility: hard
reasoning_effort: max
task_type: research+bugfix
area: codegen
language_feature: closures, typed-arrays, test262-harness
goal: host-independence
assignee: ttraenkler/dev-callback
related: [2903, 2879, 2075]
created: 2026-07-02
updated: 2026-07-02
origin: "2026-07-02 __make_callback sole-leak-front measurement (dev-callback). Verified on origin/main @ 4d5287afc, target standalone, merged report run 28491700781."
---

# #2921 — `env::__make_callback` sole-leak: measured root cause

## TL;DR

The leak-front task assumed the 1,364 standalone sole-`__make_callback` passes
are flippable to host-free by giving **TypedArray HOF methods native bodies**
(sub-front 4 of #2903). **Measured, that yield is ZERO.** All 601 TypedArray
sole-leak files leak the import from the **test262 harness wrapper**
(`testWith*Constructors(function(TA){…})`) via the compiler's *graceful-fallback
for unknown functions* path — not from any HOF method. Worse, those wrapper
callbacks are **never invoked** (graceful fallback returns `ref.null.extern`),
so the entire test body is dead code and the 601 "passes" are **vacuous**.

The import-gate hypothesis from the original brief (gate registration in
`collectUsedExternImports`, #2405 pattern) is **disproven** — the import is
genuinely *referenced* (`WebAssembly.instantiate(binary, {})` rejects on
`Import #0 "env"`), consistent with merged research #2903 ("Not a finalize-time
unused-import prune… the import is referenced").

## Measurement (origin/main @ 4d5287afc, `target: standalone`)

Source: merged report run `28491700781`, standalone lane.

- Sole-leak set (`status==pass`, `imports==["env::__make_callback"]`): **1,364**;
  `__make_callback` total touches: **5,572**. (Matches the brief exactly.)
- By category: **TypedArray\* 601** (348 TypedArray + 253 TypedArrayConstructors),
  **Temporal 707**, Iterator 18, other 38.

### Sub-front 4 (TypedArray HOF native bodies) flippable yield = 0

Scanned all 601 TypedArray sole-leak sources + live-traced the leak sites
through the real runner (`runTest262File(..., "standalone")`):

- **601/601** contain the `testWith*Constructors(function…)` harness wrapper.
- Live trace of `TypedArray/prototype/every/BigInt/callbackfn-returns-abrupt.js`:
  - leak site A = the `function(TA, makeCtorArg){…}` wrapper →
    `compileArrowAsCallback` from **`calls.ts:13393`** ("graceful fallback for
    unknown functions"): `testWithBigIntTypedArrayConstructors` is not resolved
    in `funcMap`, so the call compiles its args for side-effect and returns null.
  - leak site B = `assert.throws(T, function(){…})` (205/601) →
    closed-method dispatch **`calls.ts:11624`**.
  - **Neither leak site is a TypedArray HOF callback.**
- Only ~202/601 even *call* a HOF method (forEach 31, reduce/reduceRight 27 each,
  from 25, filter/map 12, of/every/some/find… ≤10). The other 399 use non-HOF
  methods (slice/fill/reverse/indexOf/ctors). But the import is **module-scoped**:
  it disappears only if NO callback in the module takes the host path — and the
  wrapper always does. So native HOF bodies remove **zero** imports here.

### Correctness: these are VACUOUS passes

Injected `throw new Error('WRAPPER_RAN')` as the first statement of the wrapper
body; the standalone binary **ran to completion without throwing** — the wrapper
callback is never invoked, so every assertion in the test body is dead code. The
601 "passes" test nothing.

Implication: the *correct* fix (make `testWithTypedArrayConstructors` compile as
an invokable user function and actually drive its callback) would execute the
dead bodies, and many would then genuinely **fail** (BigInt element semantics,
detached-buffer paths) — converting leaky-passes to real fails. Net headline
pass count is negative short-term; it makes the metric honest and surfaces the
real gaps.

## What is NOT the fix (disproven here + in #2903)

- **Not** a TypedArray HOF native-body PR (sub-front 4) — yields 0 host-free
  flips for the sole-leak set.
- **Not** a `collectCallbackImports` predicate tightening / finalize-time unused
  import prune — the import is referenced; pruning breaks the binary.

## Actual root cause / next lever

The sole-leak driver is the **harness-wrapper callback** taking the host
`__make_callback` path via graceful-fallback (`calls.ts:13393`) and never being
invoked. Open questions for the re-scoped effort:

1. Why is `testWith*Constructors` (defined in the prepended `testTypedArray.js`
   include) not resolved as an invokable user function in `funcMap`? (compile
   failure of the harness body? forward-reference? var-assigned fn?)
2. Once invoked, is fixing it net-positive on conformance, or does it convert a
   large block of vacuous passes to real fails (needs a corpus OUTPUT diff vs
   js-host before shipping)?
3. Same pattern likely covers much of the 707 Temporal sole-leaks (255 use
   test/helper wrappers, 420 use other closures).

## Status

Escalated to tech lead 2026-07-02: sub-front 4 yield = 0 (< the 300 build-gate),
paused before building, awaiting re-scope decision. Import-gate hypothesis
disproven. Claim held, worktree clean.
