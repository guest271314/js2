---
id: 2862
title: "Standalone: ToPrimitive throws 'Cannot convert object to primitive value' for built-in exotics + inherited valueOf/toString"
status: ready
created: 2026-06-30
updated: 2026-06-30
priority: high
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2860, 1900, 2358, 2638, 1910]
umbrella: 2860
architect_spec: candidate
---

# Standalone: ToPrimitive incomplete for built-in exotics + inherited methods

## Problem

In `--target standalone`, converting many objects to a primitive throws
`TypeError: Cannot convert object to primitive value` where js-host succeeds.

### Impact (measured 2026-06-30)

**2,039 standalone-only failures** carry this signature (the single largest
error signature in the gap). Of these, **728 are "pure"** (no host-import leak —
ToPrimitive is the sole blocker; the rest also leak a generator/promise/symbol
import and additionally need their carrier). By category among the 2,039:
Object 476, TypedArray 304, language/expressions 293, String 189, RegExp 125,
Array 88, DataView 43, Set/Map/Iterator/Function ~80.

Note: the proximate throw is often in **harness** code (`assert.sameValue`/
`String(x)` formatting a value), so flipping these also depends on the value's
own representation reaching a primitive.

## Root cause

The Wasm-native `__to_primitive` engine (`src/codegen/object-runtime.ts:2011`,
#1900/#2358/#2638) implements §7.1.1.1 OrdinaryToPrimitive over the standalone
runtime, with arms for:
- non-objects → unchanged
- `$__vec_base` (arrays) → `__array_to_primitive_string` (#2358)
- nominal class structs → `__class_to_primitive` valueOf/toString dispatch (#2638)
- `$Object` wrapper internal slot (`new Number/String/Boolean`) → slot value (#1910)
- `$Object` own-prop `valueOf`/`toString` via `__extern_get` + call, with a
  `"[object Object]"` default when `toString` is missing.

It falls to the `throwTypeError()` (object-runtime.ts:2278) when **none** match.
The misses are:

1. **Built-in exotic instances not modeled as `$Object`/`$Vec`/class-struct** —
   TypedArray views, DataView, ArrayBuffer, RegExp, boxed wrappers backed by a
   nominal runtime struct. These reach the non-`$Object` arm (line 2192), miss
   `ref.test $__vec_base` and `__class_to_primitive` (no user valueOf/toString
   dispatcher), and return **unchanged** → caller's `__unbox_number`/string
   coercion then fails, or a later ToPrimitive throws.
2. **`$Object` instances whose `valueOf`/`toString` are INHERITED** (on a
   prototype, not own) — `__extern_get(obj, "toString")` only reads OWN props in
   standalone (the prototype chain / `Object.prototype.toString` is not
   materialized), so both probes miss. For the **number/default** hint the
   `"[object Object]"` default is only supplied on the `toString` arm
   (`defaultObjectToStringOnMissing`), and `valueOf` missing returns nothing →
   falls through to throw.

## Implementation Plan

This is substrate-scale; **tagged `architect_spec: candidate`** — wants a design
pass on the value-representation classifier before coding. Sketch:

### A. Built-in exotic → primitive arm (object-runtime.ts ~line 2196, the
`!ref.test $Object` block)
- After the `$__vec_base` and `__class_to_primitive` arms, add a
  brand-dispatch over the built-in nominal structs (TypedArray view structs,
  DataView, RegExp, ArrayBuffer). Each has a spec'd OrdinaryToPrimitive result:
  - TypedArray / Array-like → `Array.prototype.toString` style join (reuse the
    `__array_to_primitive_string` reservation pattern, array-to-primitive.ts).
  - RegExp → `RegExp.prototype.toString` (`"/source/flags"`) — native string.
  - DataView/ArrayBuffer → inherit `Object.prototype.toString` → `"[object DataView]"`/`"[object ArrayBuffer]"`.
- Use the reserve-placeholder-funcIdx + fill-in-post-processing discipline
  (array-to-primitive.ts / class-to-primitive.ts) since these helpers depend on
  carriers registered AFTER `__to_primitive`.

### B. Default Object.prototype.toString for the number/default hint
(object-runtime.ts:2138 `tryOrdinaryMethod`)
- When BOTH `valueOf` and `toString` own-prop probes miss on a `$Object`, supply
  the `"[object Object]"` default on the **final** probe regardless of hint
  (today only the `toString`-arm default fires). Spec: a plain object with no own
  valueOf/toString uses `Object.prototype.{valueOf,toString}`; valueOf returns
  the object (not primitive) so toString wins → `"[object Object]"`. So: if both
  own probes miss, return `"[object Object]"` rather than throwing. The throw
  must remain reachable ONLY when a present `toString`/`valueOf` returns an
  object (the genuine §7.1.1.1 TypeError — keep the existing return-if-primitive
  guard so a present-but-object-returning method still throws).

### Edge cases / regression guards
- A user object with `Symbol.toPrimitive` must still take precedence (that path
  is handled before `__to_primitive` in the coercion engine — verify it isn't
  short-circuited by the new exotic arm).
- `new Number(5)` etc. wrapper slot (line 2240) must still win over the new
  default-toString arm (order preserved).
- Confirm the genuine §7.1.1.1 TypeError tests still throw:
  `test/.../Symbol.toPrimitive/*returns-object*`, ordinary toString/valueOf
  returning an object.

## Test plan

Standalone fail/CE → pass:
- `test/built-ins/TypedArray/prototype/**` (toLocaleString, join via ToPrimitive)
- `test/built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-*` (object formatting)
- `test/built-ins/Iterator/prototype/drop|take/**`
- `test/built-ins/RegExp/prototype/test/S15.10.6.3*`
- `test/language/expressions/**` ToPrimitive coercions

Validate full `merge_group` + standalone high-water. Expect the **728 pure**
to flip directly; re-measure the leak-bucket residual after #2864-#2867 land.
Zero host-mode regression (all arms `ctx.standalone`).
