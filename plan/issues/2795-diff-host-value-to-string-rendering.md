---
id: 2795
title: "diff-test host path: value→string rendering — object toString/@@toPrimitive ignored + boolean prints as 1/0"
status: done
completed: 2026-06-28
sprint: 69
created: 2026-06-28
updated: 2026-07-03
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: type-coercion
goal: trustworthiness
related: [2787, 1917]
origin: "2026-06-28 — #2787 differential-corpus triage (cluster A1)"
---

# #2795 — Host-path value→string rendering: object toString/@@toPrimitive ignored; boolean → 1/0

## Problem (cluster from #2787 diff-test triage)

In the default WasmGC + JS-host `compile()` path, several idiomatic programs
render values to strings incorrectly. Common theme: when a value is coerced to
a string (explicit `String(x)` / `"" + x` / template `${x}`) or handed to the
host `console.log`, the **dynamic value-rendering path drops type fidelity**.

Three corpus programs, each a distinct sub-root-cause under the same theme:

### A — object → string coercion ignores user-defined `toString()`

`tests/differential/corpus/classes/10-toString-impl.js`

```js
class Money {
  constructor(n) {
    this.n = n;
  }
  toString() {
    return "$" + this.n;
  }
}
console.log("" + new Money(42)); // V8: $42   js2wasm: [object Object]
console.log(`val=${new Money(7)}`); // V8: val=$7 js2wasm: val=$7 (the literal part) but ${} → [object Object]
```

`ToString(object)` must run `ToPrimitive(obj, "string")` → call `obj.toString()`
(or `@@toPrimitive` / `valueOf`). The host path emits the default
`[object Object]` instead of dispatching to the instance method. (See coercion
engine #1917 — `emitToPrimitive`; this is the non-`$Object` / nominal-class arm.)

### B — `Symbol.prototype.toString()` returns `[object Object]`

`tests/differential/corpus/builtins/04-symbol.js`

```js
const s = Symbol("desc");
console.log(typeof s); // V8: symbol      js2wasm: symbol   ✓
console.log(s.toString()); // V8: Symbol(desc) js2wasm: [object Object]  ✗
console.log(s.description); // V8: desc         js2wasm: desc     ✓
```

`typeof` and `.description` work, but `Symbol.prototype.toString` is not wired —
falls through to the generic object toString.

### C — boolean value renders as `1` / `0`

`tests/differential/corpus/closures/10-mutual.js`

```js
function isEven(n) {
  return n === 0 ? true : isOdd(n - 1);
}
function isOdd(n) {
  return n === 0 ? false : isEven(n - 1);
}
console.log(isEven(10)); // V8: true  js2wasm: 1   ✗
console.log(isOdd(7)); // V8: true  js2wasm: 1   ✗
```

The boolean result reaches `console.log` as an i32/number and renders `1`
instead of `true`. Booleans lose their boolean tag when boxed to `any`/externref
for the host `console.log` import, so `ToString(boolean)` never fires.

## Repro

```bash
FORCE_COLOR=0 npx tsx scripts/diff-test.ts   # see classes/10, builtins/04, closures/10 mismatch
```

## Root cause (hypothesis)

The string-coercion / value-boxing path used when emitting `console.log` args
and `"" + obj` / `${obj}` does not consult the value's runtime type tag to pick
the correct `ToString` behaviour: nominal-class instances skip the `toString()`
dispatch, `Symbol` lacks a `toString` wiring, and booleans are boxed as numbers.
Likely a single coercion site (`type-coercion.ts` / `expressions.ts` string
coercion + the `console.log` arg-boxing helper) with three missing arms.

## Acceptance criteria

- `classes/10-toString-impl.js`, `builtins/04-symbol.js`, `closures/10-mutual.js`
  all match V8 in `scripts/diff-test.ts`.
- `String(true) === "true"`, `String(new ClassWithToString()) === <toString>`,
  `Symbol("d").toString() === "Symbol(d)"` in the host path.

## Notes

- Cheap + high-value: fundamental coercion correctness, 3 corpus programs, and
  likely overlaps many test262 ToString/ToPrimitive cases. Related coercion
  work: #1917. Possible regression of whatever wired class `toString` for
  test262 — verify against current main.

## Resolution (2026-06-28)

The triage hypothesis ("one coercion site") turned out to be three distinct
root causes. Two are fixed here; the third is a separate cluster.

### A — object → string via `+` ignored `toString()` — FIXED

Root cause was NOT a missing dispatch but a **module-START timing gap**: a
top-level `"" + new C()` runs inside the wasm `start` function, before the host
wires `setExports`. The `__extern_to_string_default` host helper runs
OrdinaryToPrimitive on the WasmGC struct via `getExports()`, which is still
`undefined` at start time, so it fell back to `[object Object]`. (The template-
literal form already worked because it dispatches `toString` in-wasm.)

Fix (`coercion-engine.ts` `emitToString`, default-hint ref arm; the two inline
ref arms in `string-ops.ts` `compileStringBinaryOp` now delegate to it): for a
statically-known nominal struct whose ONLY ToPrimitive method is `toString`
(no `valueOf`, no `@@toPrimitive`), §7.1.1.1 makes the DEFAULT hint behave
identically to the STRING hint, so dispatch `toString` **in-wasm** (START-safe).
Classes carrying `valueOf`/`@@toPrimitive` keep the host valueOf-first helper
(the #2022 ordering), so that path is byte-unchanged.

### C — boolean renders as 1/0 — FIXED

Two compounding brand-loss sites:

1. Boolean literals `true`/`false` returned a bare `{i32}` (no `boolean` brand),
   so boxing into an `any`/externref slot chose `__box_number`. Now branded
   `{i32, boolean:true}` (`expressions.ts`).
2. A boolean-returning function's i32 result lost its brand because (a) the
   func-type dedup key was brand-blind, collapsing `(…)->boolean` onto a
   previously-registered `(…)->number` signature (`registry/types.ts`), and
   (b) an implicit-any recursive **boolean** kernel was promoted to f64 by
   `inferNumericReturnTypes`. Both fixed: the dedup key now keeps branded i32
   signatures distinct, and a purely-boolean kernel promotes to a boolean-
   branded i32 (`declarations.ts`). So `getWasmFuncReturnType` hands callers a
   branded i32 and `console.log`/boxing renders `true`/`false`.

### B — `Symbol.prototype.toString()` → `[object Object]` — NOT in this cluster

`s.toString()` on a `Symbol` is a missing-builtin-method issue (Symbol method
wiring), not a value→string coercion bug. Deferred to a separate follow-up.

## Test Results

`scripts/diff-test.ts` corpus: **84 → 86 match, 0 regressions**.

- `classes/10-toString-impl` — MATCH (was `[object Object]`)
- `closures/10-mutual` — MATCH (was `1`)
- `builtins/04-symbol` — still mismatch (Symbol.toString — separate follow-up)

New tests: `tests/issue-2795.test.ts` (8 cases — object `+`-concat at START,
boolean-into-any flows incl. mutual recursion, plus numeric / valueOf-first
regression guards). Verified no regression on numeric kernels (`add` → number),
plain concat, callbacks/closures returning booleans (call_ref unaffected), and
the #2022 valueOf-first ToPrimitive path.
