---
id: 1988
title: "__any_add on object/array operands skips ToPrimitive entirely — 1 + {} → NaN, [] + [] → 0"
status: done
completed: 2026-06-15
sprint: 62
created: 2026-06-10
updated: 2026-06-15
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [1938, 1997, 1998]
origin: "2026-06-10 spec-conformance sweep (equality agent): verified on main"
---

# #1988 — any + with ref-tagged operands returns NaN/0 instead of ToPrimitive result

## Problem

```ts
const o: any = {}; const a: any = []; const a12: any = [1,2];
String(1 + o) + "|" + String(a + a) + "|" + String(a12 + 1)
```

| expr | wasm | node |
|------|------|------|
| `1 + {}` | NaN | `1[object Object]` |
| `[] + []` | 0 | `""` |
| `[1,2] + 1` | NaN | `1,21` |

`"" + a12` works only because a string-literal operand routes through
`compileStringBinaryOp` instead.

## Root cause

`src/codegen/any-helpers.ts:515-560` — `__any_add` has only i32-add and
f64-add branches (comment: "Otherwise: trap (string concat via any not
supported yet)"); ref-tagged operands (tags 5/6) fall into `__any_to_f64`
(any-helpers.ts:466-505) which returns the raw `f64val` field for refs.
§13.15.3 ApplyStringOrNumericBinaryOperator requires ToPrimitive on both
operands first (valueOf/toString/Array.prototype.join via toString).

## Fix direction

Extend `__any_add` (or pre-dispatch in binary-ops) so ref-tagged operands
go through the ToPrimitive helper, then string-concat if either primitive
is a string. Sibling of #1938 which covers runtime *strings* in `__any_add`
— fix both in one pass if practical.

## Acceptance criteria

- All three repros match Node
- `{valueOf(){return 2}} + 1` → 3 (once #1989 dispatch is also correct)

## Dupe check

#1938 covers the same mechanism for runtime strings only; objects/arrays
needing ToPrimitive not mentioned there. Filed as sibling with `related`.

## Resolution (2026-06-15)

Host/gc mode was already correct (routes `+` through `__host_add`). The defect
was the standalone / pure-WasmGC path. Two `+` lowerings exist depending on the
operand representation:

- **`emitAnyAdd`** (`src/codegen/binary-ops.ts`) — externref operands (the path
  actually taken for `f(a: any, b: any)` in standalone). It decided
  string-concat-vs-numeric by testing `__typeof_string` on the **raw** operands,
  so an object/array operand (not a string) wrongly took the numeric arm → NaN.
  Fixed by first reducing both operands through the native `__to_primitive`
  (default hint) and testing stringness on the **primitives** — an object/array
  reduces to its `toString` string, forcing §13.15.3 concatenation.
- **`__any_add`** (`src/codegen/any-helpers.ts`) — the tagged-union `$AnyValue`
  helper (built only in standalone/fast mode). Added a §13.15.3 string-concat
  arm: when either operand tag ∈ {5 string, 6 object/array ref}, ToString both
  (via `__extern_toString` / the `__any_to_string` tag dispatcher) and
  `__str_concat`, boxing the result as tag 5; otherwise the original i32/f64
  numeric arm.

Two supporting fixes made the result observable in standalone:

- `__any_to_string` (`src/codegen/native-strings.ts`) now recognises a
  `__box_number_struct` externref (how a standalone `any` number is carried) and
  formats it via `number_toString`, instead of falling to "[object Object]".
- The `$AnyValue` → native-string unbox (`src/codegen/type-coercion.ts`) read
  `refval` (field 3) for every GC-ref target; a tag-5 string lives in
  `externval` (field 4), so the read deref'd null. It now reads `externval` for
  native-string targets.

### Verified (tests/issue-1988.test.ts, 10/10)

- Host: `1 + {}`, `{} + 1`, `{} + {}`, `[] + []`, `[1,2] + 1`, numeric — all
  match Node.
- Standalone: `1 + {}` → length 16, `{} + {}` → length 30, string+string any →
  length 2, and `f(a,b)=a+b` emits **zero host imports**.

### Out of scope / residual

- **Standalone array-element joins** (`[1,2] + 1` → "1,21") still resolve the
  array operand's `toString` via the Phase-1 "[object Object]" fallback rather
  than `join`. That is the array-toString-via-join path owned by **#1997/#1998**
  (now done); once their join lands for the `any`-receiver path the standalone
  array concat follows automatically. Host mode already matches Node.
- `any === stringLiteral` content comparison is a separate open gap and is
  intentionally not used by these tests.
- `{valueOf(){return 2}} + 1` → 3 still depends on user-defined `valueOf`
  dispatch (**#1989**).
