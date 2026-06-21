---
name: project_2358_pr3_to_primitive_nonobject_arm
description: "#2358/#1917/#10 PR-3 handoff — __to_primitive non-$Object arm (class instances + $Vec arrays) — design, root cause, late-funcidx discipline"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#2358/#1917/#10 PR-3 (the next slice after PR-1 #1697 MERGED + PR-2 #1709 queued). One focused `__to_primitive` runtime-helper change covering TWO deferred surfaces that share the same root.

**Root cause (both):** `__to_primitive` (object-runtime.ts ~2074) gates on `ref.test objectTypeIdx` and returns the input UNCHANGED on a miss → caller `__unbox_number` → null. It misses BOTH (a) a nominal CLASS-instance struct (any-typed param: `function g(x:any){return x*2}` with `new C()` where `class C{valueOf(){...}}`), and (b) a `$Vec` ARRAY (`Number([42] as any)` → builds $Vec → extern.convert_any → __to_primitive → unbox → null; #10). The PR-2 materialize path CANNOT touch either: a class stores methods as `ClassName_<m>(self)` funcs not struct fields, and an array has no object fields to copy.

**Why ONE slice:** both are "make `__to_primitive` reduce a non-$Object input." Add a non-$Object arm after the `ref.test objectTypeIdx` miss:
- **CLASS arm:** route to the existing `__call_valueOf` / `__call_toString` dispatchers (emitted by `emitToPrimitiveMethodExports`, index.ts:3826/4094-4095). They already `ref.cast` the class struct + call `ClassName_valueOf` — host-free, present in the standalone class case (verified). Apply the §7.1.1.1 valueOf→toString ordering + TypeError fallthrough around them.
- **ARRAY arm:** detect `$Vec` (is-array), reduce via array→toString (join ",") → ToNumber. `__extern_toString` likely already does vec→string (the #2160 native array-join lowering merged); confirm and reuse.

**CRITICAL late-funcidx discipline (#2043/#2191 class):** `emitToPrimitiveMethodExports` runs at FINALIZE (index.ts:1722/5321), AFTER `__to_primitive` is built in `ensureObjectRuntime`. So `__to_primitive` must reference `__call_valueOf`/`__call_toString` by a forward funcidx resolved BY NAME via `ctx.funcMap.get(...)` AFTER the last `flushLateImportShifts`/`addUnionImports` — NEVER a captured pre-shift idx (that's exactly the bug I root-caused in #2191/7ae5c5df4 and the [[reference_no_rebuild_helper_body_at_finalize]] family). May need a forward-declared funcidx slot patched at finalize, or move the dispatcher emission earlier.

**Guardrails:** hard floor-gate standalone HW (no breach); WAT byte-diff the existing $Object ToPrimitive path + hot static `*`/`-` unchanged; reuse #1917 engine (keep `check-coercion-sites.mjs` flat); helpers by name. Re-measure: `Number([42])`→42, `Number([1,2])`→NaN, class-instance any-param `x*2`/`x-1`/`+x` correct. See [[project_2358_toprimitive_nominal_struct_path]].
