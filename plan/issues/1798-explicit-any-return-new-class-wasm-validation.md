---
id: 1798
title: "explicit-any return + new C() → Wasm validation failure (IR return-tail misses return-type coercion)"
status: done
sprint: 58
feasibility: medium
depends_on: []
goals: []
completed: 2026-06-03
---

# #1798 — explicit `: any` return + `new C()` → Wasm validation failure

## Problem

```ts
class C { x: number = 5; }
export function f(): any { return new C(); }
```

fails Wasm validation at instantiation:

```
type error in return[0] (expected externref, got (ref null 5))
```

The function signature correctly declares an `externref` result (TS `any` →
`externref`), but the emitted body returns the constructor's struct ref
(`(ref $C)`) without coercing it to `externref`. The inferred-return form
(no annotation) works because TS infers `C` and the function result type
becomes the struct ref — there is then no mismatch.

## Root cause (investigation)

The failing body is produced by the **IR front-end** (`experimentalIR` is on
by default in `compileSourceSync`). Dumping the IR-lowered module:

- `f` has func type result `[externref]` (correct — `resolvePositionType`
  maps `AnyKeyword → irVal externref`, `src/codegen/index.ts:438`).
- `f`'s body is `[{call C_new}, {return}]`. `C_new` returns `(ref $C)`.
  **No coercion** sits between the call result and `return`.

The defect is in `src/ir/from-ast.ts` `lowerTail()` return handling
(~line 574-578): it lowers the return expression with `cx.returnType` as an
*advisory* hint, then terminates with `return [v]` **without reconciling the
produced value's type against the declared result type**. For `new C()` the
expression honestly yields an `IrType.class` (struct ref); the externref hint
does not change that, so a `(ref $C) → externref` mismatch reaches `return`.

This is broader than `new C()`. Every `: any`-returning IR-claimed function
whose return value isn't already externref-shaped emitted invalid Wasm:

| return form              | produced | declared | pre-fix result |
|--------------------------|----------|----------|----------------|
| `return 5`               | f64      | externref| FAIL (got f64) |
| `return true`            | i32      | externref| FAIL (got i32) |
| `return new C()`         | ref $C   | externref| FAIL (got ref) |
| `return {a:1}`           | ref obj  | externref| FAIL (got ref) |
| `return "hi"`            | externref (host strings) | externref | OK |
| `return s` (string param)| externref | externref | OK |

The IR verifier (`src/ir/verify.ts`) did **not** check return-value types
against `func.resultTypes`, so the malformed body slipped past the
verify gate that normally demotes bad IR functions to legacy.

## Fix

Two changes:

1. **`src/ir/from-ast.ts` `lowerTail()` return path** — reconcile the lowered
   return value with `cx.returnType` before terminating:
   - When the declared result is `externref` and the produced value is
     reference-shaped (class / object / closure / vec ref / ref_null /
     native-string), coerce via `coerceYieldValueToExternref`
     (`extern.convert_any`). This is the real fix for `new C()` / objects.
   - When the produced value is a native scalar (`f64` / `i32`) but
     `externref` is declared, **throw a clean "not in slice" fallback** so the
     function reverts to the legacy path, which boxes numbers correctly via
     `__box_number`. The IR has no number-box primitive yet; mirroring the
     existing `lowerThrowStatement` deferral (line 4164) keeps numeric `any`
     returns working without inventing one.

2. **`src/ir/verify.ts`** — add a defense-in-depth check that every `return`
   terminator's value types are assignment-compatible with the function's
   declared `resultTypes`. A future return-type mismatch now demotes the
   function to legacy at the verify gate instead of emitting invalid Wasm.

### Why coerce rather than defer everything to legacy

The directive is to keep `new C()` on the IR path with the canonical struct
ref. `extern.convert_any` is the correct, zero-cost re-tag of any anyref
subtype to externref — it is what the legacy `coerceType` ref→externref path
emits too (`src/codegen/type-coercion.ts:1511`). The struct typeIdx the
constructor produces is already canonical (`ctx.structMap.get(className)` in
`new-super.ts:2950`); the original "fresh resolveWasmType mints a distinct
typeIdx" hypothesis was not the actual mechanism — the IR path simply omitted
the coercion. `extern.convert_any` is agnostic to the exact struct typeIdx, so
compaction/renumbering cannot break it.

## Acceptance criteria
- `function f(): any { return new C(); }` compiles, instantiates, and runs.
- Numeric / boolean `: any` returns still compile + instantiate (via legacy box).
- No equivalence-test regressions.
</content>
