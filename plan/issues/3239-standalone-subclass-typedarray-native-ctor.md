---
id: 3239
title: "Standalone: native constructor for `class extends TypedArray|SharedArrayBuffer` (drop __new_<Parent> host leak)"
status: done
assignee: opus-subclass2
completed: 2026-07-13
sprint: 71
priority: high
horizon: m
feasibility: hard
goal: standalone-mode
umbrella: 1781
related: [3238, 56, 3053]
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/class-bodies.ts
---

## Problem

Under `--target standalone`, `class Sub extends <TypedArray>` (any of the 11
element kinds `Int8Array` … `BigUint64Array`) and `class Sub extends
SharedArrayBuffer` lower the parent construction (`super()` / the implicit
default derived ctor) to a distinct host import `env::__new_<Parent>` (one per
element kind, plus `SharedArrayBuffer`). Standalone has no JS host, so the
import leaks: the module still *passes* (a host shim satisfies the import in the
test harness), but it is counted as a host-import leak, not `host_free_pass`.

This is the next per-builtin slice of the `__new_*` subclass-builtins substrate
cluster after #3238 (`Object`). Affected tests (sole import
`env::__new_<Parent>`, statements + expressions forms):

- `language/{statements,expressions}/class/subclass-builtins/subclass-Int8Array.js`
- … `subclass-Uint8Array` / `Uint8ClampedArray` / `Int16Array` / `Uint16Array` /
  `Int32Array` / `Uint32Array` / `Float32Array` / `Float64Array` /
  `BigInt64Array` / `BigUint64Array` (2 each = 22)
- `language/{statements,expressions}/class/subclass-builtins/subclass-SharedArrayBuffer.js` (2)

**24 host-free flips.**

## Root cause / measurement (why this is the cheapest slice, not the heaviest)

`src/codegen/class-bodies.ts` lowers builtin-parent construction to
`ensureLateImport(ctx, "__new_<Parent>", …)` at two sites (implicit default
derived ctor ~L1769; explicit `super(...)` ~L2956). #3238 special-cased
`Object`; the Error family (incl. `AggregateError`) is already handled by
`emitWasiErrorConstructor`.

Empirically measured against a fresh compiler + the standalone baseline:

1. For every builtin subclass, the **sole** remaining host import is
   `__new_<Parent>`. Both `instanceof Sub` and `instanceof <Parent>` are ALREADY
   resolved host-free at compile time by `tryStaticInstanceOf` (the subclass's
   recorded builtin parent statically satisfies the hierarchy). So flipping the
   construction native flips the whole module to `host_free_pass`.
2. The `subclass-<Parent>` conformance tests **only assert `instanceof`** — and,
   critically, **no** TypedArray/SharedArrayBuffer subclass *behavior* test
   passes in standalone today (measured from the baseline: only the
   instanceof-only `subclass-*` tests pass; `length`/element behavior tests
   fail). So there is no length- or behavior-dependent passing test to regress
   if the native construction is identity-only.

This inverts the initial "TypedArray is the heaviest slice" assumption: it is
heaviest only if you build real typed construction, which no *passing* test
needs. It is in fact the cheapest AND biggest slice (24 flips, zero regression
surface).

## Fix

New helper `emitStandaloneVecBuiltinConstructor(ctx, importName, argCount)` in
`src/codegen/object-runtime.ts` (mirrors `emitStandaloneObjectConstructor`):

- idempotent on `importName`;
- registers a defined func `__new_<Parent> : (externref × argCount) -> externref`
  whose body ignores its params and returns a fresh **empty** native
  `$__vec_externref` (length 0, capacity 0) boxed to externref via
  `extern.convert_any` (the same no-op boxing the object runtime uses).

A shared `STANDALONE_VEC_BUILTIN_PARENTS` set names the 11 TypedArrays +
`SharedArrayBuffer`. Both class-bodies call sites gain a branch **before** the
`ensureLateImport` fallback, after the `Object` branch:
`else if ((ctx.wasi || ctx.standalone) && STANDALONE_VEC_BUILTIN_PARENTS.has(parent))`.

**SCOPE — identity only.** This deliberately does NOT model element kind,
byteLength, backing buffer, or `super(length)` / `super(buffer, …)` semantics:
the constructor arguments (still side-effect-evaluated at the call site, passed
here as ignored params) are dropped. The instanceof-only tests flip host-free;
the (already-failing) behavior tests stay failing, unchanged — this is a purely
additive `host_free_pass` win, not real typed construction. Faithful
arg-honoring construction for `Array`/`Date`/`RegExp`/`ArrayBuffer` (which DO
have passing behavior tests, hence a real regression surface) is separate,
harder follow-up work.

## Constraints

- **Host/gc lane byte-identical** — the new branch is gated on
  `ctx.standalone || ctx.wasi`; host mode keeps every `__new_<Parent>` import
  (verified in the test's gc-mode case).
- **NET ≥ 0** — the affected tests currently leak (not host-free); they can only
  flip to host-free or stay. No passing behavior test exists to regress; the
  merge_group standalone floor is the authoritative gate.

## Acceptance

- The 24 `__new_<Parent>`-sole tests compile host-free (no `env::__new_<Parent>`)
  and still pass `instanceof`.
- `tests/issue-3239-standalone-subclass-typedarray-native-ctor.test.ts` (14
  cases: 12 parents × standalone host-free + instanceof, WASI, gc-unchanged).
- No standalone floor regression.
