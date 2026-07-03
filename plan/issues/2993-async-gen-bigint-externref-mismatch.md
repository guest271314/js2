---
id: 2993
title: "standalone: generator-closure lowering emits i64/BigInt where externref expected → invalid-wasm CE (`__closure_3`) on BigInt generator-iterable TypedArray ctor"
status: done
sprint: 69
priority: medium
feasibility: hard
task_type: bugfix
area: codegen
language_feature: generators, closures, bigint, typed-arrays
related: [2940, 2939]
created: 2026-07-02
completed: 2026-07-02
assignee: ttraenkler/sendev-2993
origin: "2026-07-02 — discovered during #2940/PR #2463 (vacuity scorer) regression triage. Pre-existing on upstream/main, unrelated to that PR."
---

# #2993 — generator-closure lowering: i64/BigInt passed where externref expected → invalid-wasm CE

## Problem

Compiling a generator function-expression that yields **BigInt** values inside a
higher-order/harness closure produces **invalid Wasm** in the standalone
(WasmGC, `--target standalone`) lane. The generated `__closure_3` body passes an
`i64` (the lowered BigInt value) into a slot the closure/iterator plumbing
expects to be `externref`, so the module fails validation → `compile_error`
(CE), never reaching instantiation.

This is a **pre-existing** codegen bug on `upstream/main`. It is **NOT** caused
by #2940 / PR #2463 (the runner vacuity scorer) — it was surfaced only because
that PR's regression triage re-ran the full BigInt-TypedArray corpus on the
standalone lane. The test was `compile_error` on the standalone baseline and
stays `compile_error` after the PR (CE→CE, no flip). Filed separately so #2463
can admin-merge cleanly.

## Repro

`test262/test/built-ins/TypedArrayConstructors/ctors-bigint/object-arg/as-generator-iterable-returns.js`

```js
testWithBigIntTypedArrayConstructors(
  function (TA) {
    var obj = (function* () {
      yield 7n;
      yield 42n; // BigInt yields
    })();
    var typedArray = new TA(obj); // construct TA from a generator iterable
    assert.sameValue(typedArray.length, 2);
    // ...
  },
  null,
  ["passthrough"],
);
```

Compile on the standalone lane and observe the invalid-wasm rejection in the
generator closure body (`__closure_3`): an `i64`/BigInt value lands where the
closure/iterator machinery declares an `externref` parameter or field, so
WasmGC validation rejects the module.

## Suspected root cause

The generator lowering boxes/threads yielded values through the closure's
capture/result plumbing as `externref` (the generic `any` iterator-value
representation), but a BigInt yield is lowered to a native `i64` and is written
into that slot **without** the i64→externref boxing coercion (`__box_bigint` /
equivalent) that the generic path expects. Likely in the generator/closure
codegen where yielded values are stored into the iterator result struct or the
closure capture cell — the coercion to the declared `externref` slot kind is
missing for the i64/BigInt value-kind.

## Acceptance criteria

- The repro file compiles to **valid Wasm** on the standalone lane (no
  `__closure_3` invalid-wasm CE). Genuine pass/fail of the underlying TypedArray
  semantics is a separate concern — the bar here is: no invalid-wasm CE from the
  BigInt-yield generator closure.
- A scoped regression test (`tests/issue-2993.test.ts`) covering a BigInt-yield
  generator threaded through a closure/HOF on the standalone lane.
- No regression on the non-BigInt generator-iterable sibling tests.

## Notes

- Discovered in #2940/PR #2463 triage; see that issue's classification table
  (the "1 async-gen invalid-wasm" / latent `__closure_3` follow-up bullet).
- Related dynamic-closure-dispatch work: #2939.

## Resolution (2026-07-02, sendev-2993)

### Confirmed root cause (exact)

The suspected root cause was correct and the fix is a one-branch carrier
coercion. `compileYieldExpression` in `src/codegen/expressions/misc.ts` (the
**legacy / eager-buffer** yield path) dispatched the yielded value into the
generator buffer by Wasm value-kind:

- `f64` → `__gen_push_f64`
- `i32` → `__gen_push_i32`
- **everything else** → `__gen_push_ref(externref, externref)`

A `yield <bigint>` lowers to a raw `i64` (bigint-branded), which fell into the
`else` arm and was passed **unboxed** into `__gen_push_ref`'s `externref`
parameter slot. WasmGC validation rejects that (`call[1] expected type
externref, found local.get of type i64`) in the generator closure body
(`__closure_0` in the minimal repro, `__closure_3` under the full
`testTypedArray.js` harness) → `compile_error`, never instantiated.

Why only the **closure/HOF** shapes tripped it: the simple direct
`for (const v of g())` bigint generator already uses the **#2864 native
carrier** (which handles i64 host-free) and compiled fine on `main`. Only the
eager-buffer shapes — `.next().value`, and a generator threaded through a
higher-order closure like the repro — bail to the legacy host-buffer path where
this bug lived.

### Fix

Added an explicit `i64` arm in the yield dispatch that boxes the value to
externref via the existing `coerceType(i64 → externref)` before the
`__gen_push_ref` call. `coerceType` already does the right thing (#1644): a
bigint-branded i64 boxes via `__box_bigint` (round-trips as a JS bigint), a
native `type i64 = number` via `__box_number`. The push-func idx is resolved
**after** `coerceType` since that call may add late union imports (index
shifting).

### Verification

- Pre-fix: `.next().value` bigint generator + the closure/HOF repro both throw
  the `expected externref, found i64` validation CE. Post-fix both compile to
  **valid Wasm** (`WebAssembly.compile` succeeds) on the standalone lane.
- Semantic correctness of the box proven in gc mode: `.next().value` → `7`,
  direct `for-of` sum → `49` (7+42). The boxing is not just type-valid, it
  round-trips.
- **Byte-inert**: sha256 of numeric / string / object generator output and a
  non-generator sample are byte-identical to `origin/main` on both `gc` and
  `standalone` — the new arm only fires for `i64` yields.
- No regression on generator suites. (`issue-680` and `issue-1169f-7a` each
  have 3 pre-existing numeric-yield failures — identical fail counts on
  `origin/main`, untouched by this i64-only change.)
- Scoped regression test: `tests/issue-2993.test.ts` (5 cases: standalone
  validation for the closure/HOF and `.next().value` shapes, gc value
  round-trip, number-generator no-regression).

### Deliberately OUT OF SCOPE (banked, separate concerns)

These are value-semantics gaps, **not** the invalid-wasm CE this issue fixes;
the acceptance bar explicitly carves them out ("genuine pass/fail of the
underlying semantics is a separate concern"):

1. **Standalone eager-buffer bigint value round-trip.** In `standalone` the
   boxed bigint does not read back through the eager buffer (`.next().value` and
   for-of sum return `0`, not the yielded value). This is the known standalone
   value-read substrate gap (cf. the `project_standalone_any_string_value_read_substrate`
   family), pre-existing and independent of the carrier fix. A follow-up should
   extend the #2864 native carrier to bigint yields (host-free) rather than
   patching the eager buffer.
2. **Closure/HOF value threading in gc mode.** The repro's closure-threaded
   generator (`run(cb)` → `cb(obj)` → for-of) validates but returns `null` in gc
   mode — the boxed-`any` value does not thread through the closure indirection.
   Separate from the yield-carrier mismatch; would need the boxed-any generator
   value to survive the HOF/closure capture path.

Both are genuinely separate substrate work; forcing them into this fix would
mean reworking the native-carrier bigint path and the closure value-threading —
larger than the localized carrier mismatch #2993 scopes.
