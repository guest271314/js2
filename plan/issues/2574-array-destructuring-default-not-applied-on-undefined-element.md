---
id: 2574
title: "array destructuring default not applied when the element value is `undefined` (standalone)"
status: done
assignee: ttraenkler/sd-3
sprint: 64
created: 2026-06-21
updated: 2026-06-21
completed: 2026-06-21
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: destructuring, defaults
goal: standalone-mode
related: [2040, 2545, 2568]
origin: "2026-06-21 sd-3 — found while root-causing #2040 cluster A. Orthogonal to the #2040 _isSameValue codegen bug."
---

# #2574 — array-destructuring default not applied on an `undefined` element

## Problem

Per ES §8.5.3 (IteratorBindingInitialization, `SingleNameBinding` with an
Initializer), the default is applied when the bound value is `undefined` — NOT
only when the iterator is `done`. In standalone mode the default is skipped when
the element value is explicitly `undefined`:

```ts
const [a = 9] = [undefined];   // standalone: a === NaN   expected: a === 9
```

Compare (both already correct on main):

```ts
const [a = 9] = [5];   // a === 5   ✓
const [a = 9] = [];    // a === 9   ✓ (done → default)
```

So the missing arm is specifically: element present in the iterator but its
value is `undefined` ⇒ apply the default.

## Repro (current main, `--target standalone`)

```ts
export function test(): number { const [a = 9] = [undefined as any]; return a; }
// actual: NaN   expected: 9
```

## Suggested approach

In the array-destructuring element lowering (`src/codegen/destructuring-params.ts`
and/or the decl path in `statements/destructuring.ts`), the default-application
guard must fire on `value === undefined`, not only on iterator-`done`. The
`done`-only path already works; widen the predicate to
`done || value === undefined` (the §8.5.3 "If v is undefined" step), then apply
the Initializer. Scope to array binding patterns with a default; object-pattern
defaults (§8.5.4) already cover the `undefined` case — verify both.

## Root cause (sd-3, 2026-06-21) — PINPOINTED to the f64-tuple `__box_number(sentinel)`

The bug is NOT the destructuring default predicate (that fires on `undefined`
correctly). It is **narrow to the single-element array literal**, and the chain is:

1. `[undefined]` (single element) compiles to a **1-field TUPLE struct
   `{_0: f64}`** whose `_0` holds the **sNaN "undefined" SENTINEL**
   `0x7FF00000DEADC0DE` (the f64 undefined marker). `[1,2,…]`/multi-element take a
   different (vec) path, which is why ONLY the single-element form fails. Typed
   `(number|undefined)[]`, a function-return array, and FUNCTION PARAMS all work —
   they don't hit this tuple-struct path.
2. The binding `a` is `externref` (it can hold the default `9` or the value), so
   the tuple-struct destructuring reads `struct.get {_0} → f64 sentinel` then
   **`__box_number(sentinel)`** → a plain NaN **NUMBER** externref.
3. The default check uses **`__extern_is_undefined`** (deliberately, NOT
   `ref.is_null`, so JS `null` doesn't fire the default). A `__box_number(sentinel)`
   is a NUMBER, not undefined → `__extern_is_undefined` returns 0 → the default
   never fires → `a` keeps the NaN.

**WAT-confirmed:** `(func $test … i64.const 0x7FF00000DEADC0DE; f64.reinterpret;
struct.new 34 (the {_0:f64} tuple); … struct.get 34 0; call $__box_number;
call $__extern_is_undefined; (if … default …))` — the box loses the sentinel's
undefined-ness before the check.

**Exact fix site:** the **tuple-struct fast path** in
`destructuring-params.ts` (the arm that reads `_0…_n` and routes through
`emitDefaultValueCheck` / `emitNestedBindingDefault`, ~lines 854-891). When an
f64 tuple field that feeds an EXTERNREF binding-with-default is the sNaN
sentinel, it must box to a real `undefined` externref (`emitUndefined`), NOT
`__box_number`. (`boxToExternref` at ~line 237 is the per-element boxer but lacks
`fctx`; the tuple-field box is a separate site.)

**Substrate caveat — STANDALONE undefined representation:** `__get_undefined` /
`__extern_is_undefined` are host imports; in `nativeStrings`/standalone
`emitUndefined` degrades to `ref.null.extern` (null), which the
`__extern_is_undefined` predicate (correctly) does NOT treat as undefined. So a
clean standalone fix may need a **native undefined externref** (or to special-case
the sentinel directly in the f64 tuple path BEFORE boxing — i.e. check
`i64.reinterpret_f64 == sentinel` on the f64 _0 field and branch to the default
arm before the `__box_number`/`__extern_is_undefined` round-trip). The
sentinel-on-the-raw-f64 approach avoids the externref-undefined gap entirely and
is the recommended fix. sd-3 attempted the `boxToExternref` locus but it sits on
the VEC-conversion path, not the tuple path — the tuple-field box is the right
site.

## FINAL localization (sd-3) — the box is at ARRAY-LITERAL construction, not destructuring

Tracing further: `[undefined as any]` has element type `any`, so the single-element
literal compiles to a tuple `{_0: externref}` (NOT `{_0: f64}`), and `_0` is
populated with **`__box_number(sentinel)`** AT LITERAL-CONSTRUCTION time. So the
sentinel is boxed to a NaN-number externref BEFORE destructuring ever reads it —
`emitDefaultValueCheck` then takes its EXTERNREF arm (`emitExternrefDefaultCheck`
→ `__extern_is_undefined`), which correctly says "not undefined" for a number box.

So the canonical fix is at **array-literal element compilation**: an `undefined`
element (or the f64 sentinel) must be stored as a real `undefined` externref
(`emitUndefined`), NOT `__box_number(sentinel)`. Equivalently, the destructuring
externref default check could recognize the boxed sentinel — but fixing the
literal is cleaner and benefits every consumer (`arr[0]`, spread, etc.).

**Standalone substrate note (unchanged):** in `nativeStrings`/standalone there is
no host `undefined`; `emitUndefined` → `ref.null.extern`. Since the default check
uses `__extern_is_undefined` (not `ref.is_null`), a null won't fire the default
either. So a fully-correct STANDALONE fix needs a native undefined externref the
predicate recognizes, OR the array-literal `undefined` element must be tracked so
the destructuring uses the f64-sentinel (raw) default check instead of the
externref one. This makes #2574 partly a standalone-undefined-substrate item — the
JS-host lane is the easy half (`emitUndefined` at the literal); standalone needs
the native-undefined or sentinel-tracking design.

3 fix loci were tried and reverted (boxToExternref vec-loop; equality dispatch;
tuple f64 arm) — none matched the literal-construction box site. The above is the
correct site; documented for a focused session.

## Acceptance criteria

- `const [a = 9] = [undefined]` → `a === 9` standalone; host unchanged.
- `const [a = 9] = [5]` / `const [a = 9] = []` stay correct (no regression).
- Object-pattern default-on-undefined verified.

## FIX (sd-3, 2026-06-21) — at the destructuring READ, not the literal

The earlier "fix at array-literal construction" hypothesis was WRONG. The literal
IS correct: `[undefined]` (single element) compiles to a tuple `{_0: f64}` whose
`_0` correctly holds the f64 sNaN "undefined" sentinel `0x7FF00000DEADC0DE` (the
`compileTupleLiteral` f64-undefined-like arm, `literals.ts:2624`). The bug is in
the **array-destructuring READ** (`destructureParamArray`'s tuple-struct fast
path, `destructuring-params.ts:~1516`): for `const [a = 9] = …` the binding local
`a` is a WIDER type than the f64 field (e.g. `externref`/`f64` mismatch via the
`number`-binding boxing), so the read did `struct.get _0` (f64 sentinel) →
`coerceType(f64 → localType)` (which `__box_number`s the sentinel into a NaN
NUMBER) → THEN `emitNestedBindingDefault` checked `__extern_is_undefined` on the
boxed number → false → default never fired → `a` kept NaN.

**Fix:** when the tuple FIELD is `f64` (sentinel-carrying), the BINDING local is a
different type, and there is a default, run `emitDefaultValueCheck` on the **RAW
f64 field** FIRST (its sNaN-sentinel arm correctly detects undefined and applies
the default as f64), THEN coerce the resolved f64 to the local type. The sentinel
is consumed before the lossy box. Value-present and no-default paths keep the
existing coerce — byte-identical.

**Validation:** 7 scoped tests (`tests/issue-2574.test.ts`) pass; broad standalone
sweep over variable/for-of/arrow-function/function `dstr` ary-ptrn categories
**+4, 0 regressions**; hard-error gate OK; the destructuring regression suites
(#1016/#1024 sentinel-default) green.

**Out of scope (pre-existing, separate):** STRING-default array destructuring
(`const [a="x"] = […]`) is broken for BOTH present and undefined values on
`origin/main` (a different `$AnyString`-field path, not the f64 sentinel) — not
caused by this change. The standalone `undefined`-vs-`null` externref conflation
(`emitUndefined` → `ref.null.extern`) is unchanged; this fix sidesteps it by
keeping the f64-sentinel check on the raw field.
