---
name: reference_1629b_boxed_primitive_typeof_eq_layers
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#1629b (standalone `Object.getOwnPropertyDescriptor` attribute-flag read-back —
`d.writable`/`enumerable`/`configurable` read null/wrong) is NOT a localized GOPD
fix. It's the shared **boxed-primitive representation engine** in 3 layers, each
measured/proven on standalone:

LAYER 1 (FIXED by me, branch issue-1629b-gopd-attr-flags, commit 28f058bf5):
native `__typeof` (index.ts ~9588 registerNative) was a `ref.null.extern` STUB →
`typeof <any externref>` returned null. The `$AnyValue` operand path already used
`__any_typeof` (#2107); the externref path fell through to the stub. Fix: ref.test
ladder over the box brand (`$__box_number_struct`→"number",
`$__box_boolean_struct`→"boolean", `$BigInt`→"bigint", `$AnyString`→"string", else
"object", null "undefined"), nativeStrings-gated, returns native-string tags via
`stringConstantExternrefInstrs`. Regression-clean (27 typeof equiv assertions). Real
independent fix but does NOT flip GOPD alone.

LAYER 2 (eq engine): strict-eq between TWO boxed-primitive externrefs compares
struct IDENTITY not value. `a.f === b.g` (two boxed bools) → false; `__any_strict_eq`
(any-helpers.ts:1361) only handles `$AnyValue` tagged structs (tag 4=bool), never
reaches a `$__box_boolean_struct` read off a $Object. GOPD assertions are
`assert.sameValue(desc.writable, true)` = strict-eq, so the cluster needs this.

LAYER 3 (the deeper one): object-literal `{b:true}` boxes the boolean via
`__box_number` (WAT: `i32.const 1; call __box_number`), so `o.b` is a boxed NUMBER —
`typeof o.b`→"number". Object-literal value-boxing mis-types booleans as numbers.

Layers 2+3 are the boxed-primitive coercion/eq engine = #1917 (sdev-toprimitive
PR #1709) territory — should NOT be fragmented into a parallel GOPD lane. Lesson:
measure-first revealed GOPD's "63 fails" are engine-gated, not a read-back patch;
ship Layer 1 (typeof) solo, route 2+3 to the engine owner. See
[[reference_2372_dynamic_descriptor_struct_widening]] for the sibling descriptor-rep work.
