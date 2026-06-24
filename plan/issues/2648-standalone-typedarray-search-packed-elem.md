---
id: 2648
title: "Standalone: TypedArray.{indexOf,lastIndexOf,includes} packed i8/i16 element CE + signedness"
status: done
completed: 2026-06-24
assignee: ttraenkler/agent-abc4cbcc1c297d4bd
sprint: 65
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: typedarray
language_feature: typedarray-methods
goal: standalone-mode
parent: 2159
related: [2159, 2593, 2644]
---

# #2648 — TypedArray search methods on packed i8/i16 elements (standalone CE + signedness)

## Problem

In `--target standalone`, `TypedArray.prototype.{indexOf,lastIndexOf,includes}`
on a **sub-32-bit** typed array (Int8/Uint8/Uint8Clamped/Int16/Uint16 — packed
`i8`/`i16` element storage) was a **hard compile error**:

```
Binary emit error: packed storage type "i8" is not valid in a value position
(only struct fields / array elements) — a packed type leaked into a
param/result/local/global
```

The IR front-end first logs a benign `[IR-FALLBACK] unknown class "Int8Array"`
and demotes to legacy codegen; the legacy `compileArray{IndexOf,LastIndexOf,
Includes}` then allocated the **search-value local** with the raw packed
`elemType` (i8/i16), which is only valid as a struct field / array element. This
is the same class of bug #2159 fixed for `.fill()`.

### Verified repros (host pass / standalone CE, main `06e1e04d68`)

| call | host | standalone (before) |
|---|---|---|
| `new Int8Array([10,11,12]).indexOf(12)` | `2` | **CE** (packed i8 in local) |
| `new Uint16Array([…]).includes(x)` | … | **CE** |
| `new Int16Array([…]).lastIndexOf(x)` | … | **CE** |

32-bit+ views (Int32/Uint32/Float32/Float64) already compiled (i32/f64 are
non-packed value types).

A **second, latent** bug surfaced once compilation was unblocked: the element
load used the legacy storage-kind signedness heuristic (i8→`get_u`,
i16→`get_s`), which is wrong for half the views — `Int8Array([-1]).indexOf(-1)`
read `255` (unsigned) and `Uint16Array([40000]).indexOf(40000)` read `-25536`
(signed), neither matching.

## Fix (`src/codegen/array-methods.ts`)

1. **Packed element in value position** — added `unpackedElemType()` (i8/i16 →
   i32, else identity) and used it for the search-value local + the search-arg
   `compileExpression` target type in all three functions. Mirrors the #2159
   `.fill()` fix; the element is loaded widened to i32 (`array.get_s/_u`) and
   compared as i32, so the value local must be i32, not the packed storage type.
2. **View-name signedness** — added `typedArraySearchSignedness()` (recovers
   `"s"/"u"` from the receiver's VIEW NAME via the existing
   `typedArrayPackedSignedness`, mirroring #2593's `typedArrayViewSignedness`)
   and `elemGetOp()` (drives `array.get_s` for Int8/Int16, `array.get_u` for
   Uint8/Uint8Clamped/Uint16; plain `array.get` for i32/f64/ref). The three
   functions now load the element with the correct, view-driven sign-extension.

No new #2108 coercion site — the search-arg coercion already routes through the
engine (`compileExpression(arg, valType)`); `check:coercion-sites` baseline
unchanged. 32-bit+ views, NaN SameValueZero (`includes`), `indexOf(NaN)→-1`
strict-eq, and plain `number[]`/externref arrays are untouched.

## Test Results

- `tests/issue-2648-typedarray-search-packed-elem.test.ts` — 30/30 pass
  (standalone + gc-mode regression guards): all 5 packed views × 3 methods
  compile + match; signed-negative (Int8/Int16) and unsigned-high
  (Uint8/Uint16) values match with correct sign-extension; not-found → -1/0;
  Int32 / Float64-NaN-SameValueZero / Float64-indexOf-NaN / plain-array
  regression guards green.
- Direct compile probes confirm `Int8Array([10,11,12]).indexOf(12)`: CE → 2;
  `Int8Array([-1]).indexOf(-1)`: -1 → 1; `Uint16Array([40000]).indexOf(40000)`:
  -1 → 1.
- tsc, lint, prettier, `check:coercion-sites`, `check:stack-balance`,
  `check:any-box-sites`, `check:codegen-fallbacks`, `check:speculative-rollback`
  all green.

## Notes on test262-row attribution

The fix removes a genuine standalone compile error and is correct for any
standalone program calling these methods on byte/short typed arrays. However,
most `built-ins/TypedArray/prototype/{indexOf,lastIndexOf,includes}` test262
rows are additionally gated on the **#1907/#1888 S6-b** substrate (the
`testWithTypedArrayConstructors` harness reads `Int8Array` /
`Int8Array.prototype.indexOf` as a *value*, which standalone refuses), so the
direct test262-row flip from this change alone is small — the value is the CE
removal + correctness for direct typed-array call sites. Lifting the per-row
gate is the separate #1907 substrate work.
