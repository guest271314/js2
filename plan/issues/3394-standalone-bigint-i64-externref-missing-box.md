---
id: 3394
title: "standalone: bigint (i64) value reaches externref coercion via extern.convert_any instead of __box_bigint — invalid Wasm (~59 tests)"
status: ready
sprint: current
created: 2026-07-18
updated: 2026-07-18
priority: high
feasibility: hard
reasoning_effort: high
model: fable
task_type: bugfix
area: codegen, type-coercion
language_feature: bigint
goal: standalone-mode
umbrella: 2039
related: [2039, 2044, 1644]
test262_bucket: standalone-invalid-wasm
test262_count: 59
es_edition: multi
---

# #3394 — bigint i64→externref: missing `__box_bigint` box (child of #2039)

## Bucket

- **Records:** 59 (largest child of #2039's 203-row live invalid-Wasm bucket)
- **Validator signature (normalized):**
  `extern.convert_any[0] expected type (shared) anyref, found <i64-producer> of type i64`
  Variants by i64 producer: `array.get` (51, all Temporal), `i64.const` (1,
  BigInt literal), and `call[0] expected externref, found local.get of type
i64` / `call_ref` (BigInt/Set/Map argument passing).
- **Area distribution:** Temporal:51, String:3, Map:2, Set:2, Object:1.
- **3 sample tests:**
  - `test/built-ins/Object/create/properties-arg-to-object-bigint.js`
    (`extern.convert_any … found i64.const of type i64` — cleanest non-Temporal repro)
  - `test/built-ins/Temporal/Instant/prototype/toString/timezone-wrong-type.js`
    (`extern.convert_any … found array.get of type i64`)
  - `test/built-ins/String/prototype/padStart/fill-string-non-strings.js`

## Reproduced on current main

Confirmed live (not a stale-baseline ghost) via the triage probe on the merge
base of the #2039 triage branch:

```
INVALID [built-ins/Object/create/properties-arg-to-object-bigint.js]:
  Compiling function #52:"test" failed:
  extern.convert_any[0] expected type shared anyref, found i64.const of type i64 @+28614
INVALID [built-ins/Temporal/Instant/prototype/toString/timezone-wrong-type.js]:
  Compiling function #54:"test" failed:
  extern.convert_any[0] expected type shared anyref, found array.get of type i64 @+32506
```

## Root cause

`coerceType(from, to)` in `src/codegen/type-coercion.ts` **already has a correct
i64→externref arm** (line ~2001) that routes a bigint-branded i64 through
`__box_bigint`:

```ts
// src/codegen/type-coercion.ts:2001
if (from.kind === "i64" && to.kind === "externref") {
  addUnionImports(ctx);
  if (from.bigint) {
    const boxBigIdx = ctx.funcMap.get("__box_bigint");
    if (boxBigIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: boxBigIdx });
      return;
    }
  }
  // … __box_number fallback …
}
```

The failing tests never reach that arm. The value on the stack **is** an i64,
but the `from` ValType handed to `coerceType` is a **ref type**, so the
ref→externref arm (line ~2035) runs and emits a raw `extern.convert_any` on an
i64 operand → invalid Wasm.

So this is a **ValType-propagation bug at the bigint producer**, not in
`coerceType`. Two producer sites lose the `{kind:"i64", bigint:true}` typing:

1. **BigInt literal / `BigInt(x)` in an `any`/externref context** (`via
i64.const`, `via call_ref`): the literal is emitted as i64 but the
   expression's static ValType is resolved as `any`→ref, so the boundary
   coercion sees a ref.
2. **i64-array element read** (`via array.get`, all 51 Temporal rows): Temporal
   internals store bigint fields in an i64-typed WasmGC array; the `array.get`
   yields i64 but the element ValType propagated to the consuming coercion is
   the array's declared element type resolved as a ref, not i64.

Note: this is a **different** signature from the #2039 §"Attribution" i64 bucket
(that was `call[0] expected i64, found extern.convert_any` — a late-import
index-shift bystander landing on `__box_bigint`). This bucket is the **inverse**
direction (`extern.convert_any expected anyref, found i64`) and IS genuinely a
bigint ValType/boxing bug. #1644 (BigInt-brand) is relevant; #2044 tracks the
i64-brand ValType decision surface.

## Implementation Plan

### Changes

**File: `src/codegen/type-coercion.ts`**

- The receiving arm is correct — do NOT change lines 2001–2024. The fix is to
  ensure the value arrives typed `{kind:"i64", bigint:true}`.

**Producer 1 — bigint literal / `BigInt()` in an externref/any target:**

- Find where a `ts.BigIntLiteral` and the `BigInt(...)` call expression set the
  emitted ValType (grep `BigIntLiteral`, `"bigint"`, `bigint: true` in
  `src/codegen/expressions.ts` and the checker/oracle type mapping). The
  producer must tag the result ValType with `bigint: true` so the enclosing
  `coerceType(..., externref)` at the argument/store boundary takes the :2001
  arm.
- Resolve the bigint-ness via `ctx.oracle` (NOT the raw checker). The
  i64-vs-ref ValType question is a wasm-lowering question that legitimately
  sits above `ctx.oracle`; grant `oracle-ratchet-allow:` only if a raw
  `ts.Type` bigint check is genuinely unavoidable.

**Producer 2 — i64-array element read (the 51 Temporal rows):**

- Grep the array-element read lowering (`array.get` emission in
  `src/codegen/property-access.ts` / array indexing in `expressions.ts`). When
  the array's element type is i64 **and** brand-bigint, propagate
  `{kind:"i64", bigint:true}` as the read's result ValType so the consuming
  externref coercion boxes via `__box_bigint`.

### Wasm IR pattern (target)

```wasm
;; bigint value → externref (correct)
local.get $bigval        ;; i64
call $__box_bigint       ;; (i64) -> externref
;; NOT: extern.convert_any  (illegal on i64)
```

### Edge cases

- Native (unbranded) `type i64 = number`: must keep `__box_number` path
  (f64.convert_i64_s + box) — do NOT route through `__box_bigint`. Gate on
  `from.bigint`.
- Host mode: `__box_bigint`/`__box_number` are host imports; the arm already
  handles the `funcMap.get` miss with a `ref.null.extern` fallback — leave it.
- If `__box_bigint` genuinely cannot be provided in standalone (no bigint
  runtime), the correct behavior is a **loud refusal** (#1888), never an
  invalid `extern.convert_any`. Confirm `__box_bigint` is registered on the
  standalone path before boxing; refuse if absent.

### Test files to verify

- `test/built-ins/Object/create/properties-arg-to-object-bigint.js` (i64.const)
- `test/built-ins/Temporal/Instant/prototype/toString/timezone-wrong-type.js` (array.get)
- Add a regression test `tests/issue-3394-bigint-box.test.ts` (standalone + wasi
  - host-guard): a bigint value flowing into an `any`/externref parameter must
    compile to valid Wasm.

## Acceptance criteria

- The 59 bucket rows compile to valid Wasm (or refuse loudly if bigint runtime
  is unavailable) — no `extern.convert_any … found i64` remains.
- No host-mode regression; `type i64 = number` native path unchanged.
- Equivalence tests green.
