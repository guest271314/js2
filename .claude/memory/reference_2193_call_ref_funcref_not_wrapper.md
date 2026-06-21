---
name: reference_2193_call_ref_funcref_not_wrapper
description: "#2193 PR-B call_ref `expected (ref funcType) found (ref wrapStruct)` was a missing struct.get-field-0 funcref extraction, NOT a type-renumber off-by-one"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#2193 PR-B (reflective `.call`/`.apply` on a value-materialized `$NativeProto`
member closure, e.g. `const m = Array.prototype.slice; m.call(a,1,3)`) failed
with `call_ref[0] expected (ref null N) found (ref null N-1)`.

The documented diagnosis (sdev-proxy3) was WRONG: it blamed a dead probe-wrapper
struct being removed by dead-type-elimination and shifting type indices, and
prescribed (a) skip the probe + (b) reserve the wrapper type idx up-front.

**Real cause:** the emitter pushed the **wrapper struct** as `call_ref`'s
trailing operand instead of the **funcref** from the wrapper's field 0.
`call_ref $funcType` pops `[self, ...args, (ref $funcType)]` — the last operand
must be the funcref, so the validator reported `expected (ref $funcType=N)
found (ref $wrapStruct=N-1)`. The "N vs N-1" is struct-vs-functype index
*adjacency*, not a renumber drift. Disproofs: the off-by-one persists even with
a single canonical wrapper (probe removed), and the final module + raw
type-section bytes are internally consistent (self-param correctly encodes the
struct idx). The dead-elim renumber pass and the probe are both innocent.

**Fix (calls.ts only):** before `call_ref`, do the canonical closure-call tail
(`calls-closures.ts compileClosureCall` ~138-150): `local.get` wrapper →
`struct.get structTypeIdx fieldIdx 0` → `emitGuardedFuncRefCast(funcTypeIdx)` →
`emitNullCheckThrow` → `call_ref funcTypeIdx`. Fixed in PR #1696 (commit
ebd3a34bf).

**Trap:** the result-type probe in `ensureStandaloneNativeMethodClosure`
(native-proto.ts) is LOAD-BEARING — member result types vary (RegExp.test→i32,
array methods→externref, getters→diverse). A "methods always return externref"
shortcut breaks #2175 RegExp closures (`type error in fallthru[0] expected
externref got i32`). Do not remove the probe.

Lesson: when a `call_ref`/closure-dispatch validation error names two adjacent
type indices, suspect the OPERAND SHAPE (struct-wrapper vs extracted funcref)
before the type-renumber pass. See [[reference_subview_type_idx_stability]] for
the genuinely-renumber-class bugs (those are about a type idx that must be
reserved up-front) — this was NOT one of those.
