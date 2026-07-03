---
id: 3024
title: "codegen: invalid Wasm binary emission residual — default (JS-host) lane (~131 fails, externref/f64 type-mismatch emitter bugs)"
status: ready
sprint: current
created: 2026-07-03
updated: 2026-07-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: codegen-correctness
goal: correctness
test262_category: language/expressions/object/dstr, built-ins/AsyncFromSyncIteratorPrototype, language/expressions/in
test262_ce: 131
related: []
---

# #3024 — invalid Wasm binary emission residual (default lane)

## Source

Default (JS-host) lane test262 harvest, 2026-07-03
(`.test262-cache/test262-current.jsonl`, run `20260703-092808`). **131**
official tests compile to a Wasm module that fails validation. Unlike the
several `standalone-invalid-wasm-*` issues already tracked (#2039, #2878,
#2934 — all standalone-target-specific), this bucket is on the **default
`gc` target**, so it's a distinct residual not covered by those.

## Breakdown by validator error

| reason | count |
|---|--:|
| `call[N]` expected `(ref null T)`, found other | 14 |
| `struct.new` — not enough args | 11 |
| `local.set` expected `(ref null T)` | 7 |
| `fN.ne`/`fN.trunc` expected `fN`, found `externref` | 13 (7+6) |
| `array.set` type error inside `__vec_from_extern` | (part of remainder) |
| other/remainder | ~76 |

Failing function names cluster around `test` (64 — top-level test body),
`testCompoundAssignment` (11), `__closure_*` (async-gen closures),
`__vec_from_extern_*`, `__obj_meth_tramp_*` (object-method trampolines).
Root cause is an externref-vs-f64/ref-null type mismatch at emit time in (a)
async-generator destructuring, (b) compound assignment operators, (c) the
"vec from extern" array-materialization helper.

## Sample failing files

- `language/expressions/object/dstr/async-gen-meth-ary-ptrn-rest-ary-elision.js`
- `built-ins/AsyncFromSyncIteratorPrototype/next/for-await-next-rejected-promise-close.js`
- `language/expressions/in/private-field-rhs-non-object.js`

## Suggested approach

1. Start with `testCompoundAssignment` (11 fails, single named function) —
   smallest, most concentrated sub-bucket; likely one type-coercion bug in
   compound-assignment codegen (`x += y` where `x`/`y` cross the
   externref/f64 boundary).
2. `__vec_from_extern_*` `array.set` type errors — check the element-type
   assumed by the array-materialization helper against the actual value
   representation of the source (likely a boxed-any vs. typed-element
   mismatch, similar in shape to the already-fixed #2379
   `new-array-n-boxed-any-elem-rep`).
3. Async-gen destructuring `__closure_*` failures — trace one repro through
   `-O0` unoptimized output (`--target gc` with binaryen disabled) to see
   the exact instruction sequence at the reported `call[N]`/`local.set` site.

## Acceptance criteria

- `wasm-validate`-class compile errors on the default `gc` target drop
  materially below the 131 recorded here.
- No regression in the standalone-lane invalid-Wasm counts (#2039/#2878/#2934)
  — this issue is scoped to the default target only.

---

## Banked root-cause: the `testCompoundAssignment` / numeric-operator sub-bucket (sr-interp, 2026-07-03)

Measure-first reduction of the **11-fail `testCompoundAssignment`** cluster (and,
by shared mechanism, the **`fN.ne`/`fN.trunc` expected fN found externref** rows,
13). Verified on default `gc` lane (`compile(src, {})`, `WebAssembly.compile`).

### Minimal repro (default gc lane → invalid Wasm)
```ts
export function test(): number { var x = 3; x = x * eval("var x = 2;"); return x; }
// → f64.mul[0] expected type f64, found local.tee of type externref
```
`x *= eval("var x = 2;")` fails identically (compound-assign desugars to `x = x * …`).

### Discriminators (why the bucket is narrow — all verified)
| variant | result |
|---|---|
| `x * eval("var x = 2;")` (same-name var-declaring eval) | **INVALID** |
| `x * eval("var y = 2;")` (different name) | VALID |
| `x * eval("2")` (eval, no var-decl) | VALID |
| `x += eval("var x = 2;")` (`+` / `+=`) | VALID |
| `eval("var x = 2;"); x *= 4;` (eval as separate stmt) | VALID |
| `x * e()` where `e():any` (any RHS, no eval) | VALID |

So the trigger is precisely: a **non-strict direct `eval` that declares a `var` of
the SAME name** as a numeric local used as an operand of a **numeric-only**
operator (`*`,`-`,`/`,`%`; unary `fN.ne`/`fN.trunc`). `+`/`+=` is immune (its
string-or-number lowering coerces the operand); a separate-statement eval is
immune (only the operand of the SAME expression is mis-typed).

### Root cause (representation vs static-type DESYNC)
`eval("var x = …")` promotes the binding `x`'s **slot** to `externref` (the
dynamic / eval-reachable representation, so the eval can read/redefine it), while
the TS checker still types `x` as `number`. The numeric-operator codegen emits a
raw `local.get`/`local.tee` of the externref slot but treats the operand as `f64`
(its static type), so **no `externref → f64` coercion is inserted** and it bakes
`f64.mul`/`f64.ne`/… directly on an externref → `expected fN, found externref`.

### Fix LOCATION (verified by elimination — turnkey)
- **NOT `compileBinaryNumeric`** (binary-ops.ts ~156): it `return null`s on the
  `any` guard (L169) because the eval RHS is typed `any`, so the multiply is NOT
  emitted there. I applied the slot-type-trust fix there and it did **not** change
  the repro — confirming the emit is elsewhere. (Reverted; do not re-attempt there.)
- **The emit is in the general `compileBinaryExpression`** (binary-ops.ts ~254,
  the mixed `number × any` arithmetic path — note the pre-existing "the receiver
  `id` is typed `number`/`any`, so the operand's *TS* type…" desync comment at
  ~L1141). The fix mirrors the **`in`-operator precedent** (binary-ops.ts
  ~L605-618, "Trust the ACTUAL slot type: if the receiver is an identifier whose
  local slot is externref/anyref…"): before emitting the numeric op, if an
  identifier operand's **actual** `fctx` slot type is `externref`/`anyref` (even
  though its TS type is `number`), route it through the existing
  `externref → f64` coercion (`coerceType(…, {kind:"f64"}, "number")`).

### Blast radius (why this is banked, not landed, at 4% budget)
This is a **shared desync class**, not one operator: the same "static type says
`number`, slot is `externref` (eval-promoted / dynamically boxed)" mismatch is the
likely root of the issue's other rows — `fN.ne`/`fN.trunc` externref (13),
`local.set expected (ref null T)` (7), and possibly `call[N] expected (ref null T)`
(14). A root fix (make identifier compilation report the true slot type, or coerce
at every numeric consumer) would clear multiple buckets but is **broad-impact
codegen** requiring full test262 CI validation — not safe to land + verify at 4%
budget. Banked as a turnkey next step; the `in`-operator precedent makes the
localized `compileBinaryExpression` fix low-risk for a fresh window.

### Not started (roll forward)
- The `__vec_from_extern_*` `array.set` bucket and async-gen `__closure_*` buckets
  (issue's approach steps 2–3) are un-investigated here.
