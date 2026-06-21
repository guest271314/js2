---
name: project_2358_toprimitive_nominal_struct_path
description: "#2358 standalone __to_primitive nominal-struct gap — true root cause, repro re-measure, and the tractable emitAnyAdd-static-reduce fix"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#2358 (re-scoped #50/#1917): standalone native `__to_primitive` over typed (nominal) object structs.

**Spec drift found (2026-06-18, sdev-toprimitive).** The spec repro table (`plan/issues/2358-standalone-toprimitive-nominal-object-structs.md`, on upstream/main — NOT origin/main, which was stale) is partly OUTDATED. Re-measured on upstream/main 955552ecc:
- `({valueOf:()=>4} as any) + 1` → **5 (CORRECT now)**, `1+obj` → 5, `obj+obj` → 7, `function f(x:any){return x*2}` → 84 — all PASS. The `as any` cast at the literal forces the **dynamic `$Object`** representation (`__new_plain_object`/`__obj_insert`), which `__to_primitive` already reduces.
- Still BROKEN: `const o={valueOf:()=>4}; (o as any)+1` → **null** (o is a typed local → NOMINAL struct, NOT `$Object`); `class C{valueOf(){return 9}}; (new C() as any)+1` → null; `Number([1])` → null (#10).

**Root cause (structural).** A typed object literal compiles to a bare anonymous WasmGC struct e.g. `(type $__anon_0 (struct (field $valueOf (mut eqref))))` — NO proto, NO brand, NO shared supertype, each shape a distinct top-level type (NOT `sub` of anything). `__to_primitive` (`object-runtime.ts:2074`) gates on `ref.test objectTypeIdx` ($Object only) and returns the input unchanged on a miss → caller `__unbox_number(object)` → null/NaN. The STATIC `*`/`-` path works because `coerceType` ref(struct)→f64 (`type-coercion.ts:1723`) reads `ctx.typeIdxToStructName`/`ctx.structFields`/`${name}_valueOf` at COMPILE time with the concrete typeIdx — erased once coerced to externref.

**Tractable proving-PR fix (additive, NOT the spec's brand/RTTI Option A).** In `emitAnyAdd` (`binary-ops.ts:2845`), operands are compiled via `compileExpression(...,{externref})` at ~2863/2870 — `lType`/`rType` STILL carry the concrete `{kind:"ref",typeIdx}` BEFORE the `coerceType(...externref)` at 2866/2876 erases it. So: when an operand is a known nominal struct with static valueOf/@@toPrimitive, run the static ToPrimitive(default) reduction (reuse the coerceType ref-struct→f64 / hint engine) to a primitive, THEN box — instead of bare `extern.convert_any` (the no-hint arm at `type-coercion.ts:1573`). Confines change to emitAnyAdd operand-prep; `*`/`-` never enter emitAnyAdd so stay byte-identical; no struct-layout/brand change; reuses #1917 engine.

The spec's Option A (shared-supertype brand + ref.test + brand→funcidx table) is the GENERAL fix for ALL externref boundaries (any-typed params, `Number(obj)` reduction) but requires re-declaring every object-literal struct as `sub` of a brand supertype — touches the hot static path; genuinely architect-scale. The emitAnyAdd static-reduce closes `+`-with-typed-object without it. See [[project_toprimitive_nominal_struct_gap]].

**PR-1 #1697** (emitAnyAdd static-reduce, typed-LOCAL `+`) landed via merge queue. **PR-2 #1709** (any-PARAMETER object-literal valueOf) chose a LIGHTER approach than the brand-supertype, tech-lead-approved: `materializeStructAsDynamicObject` (literals.ts) reifies an object-literal struct carrying a valueOf/@@toPrimitive/toString FIELD into a dynamic `$Object` (via `__new_plain_object`+`__extern_set`) AT the ref-struct→externref coercion (type-coercion.ts no-hint arm, where the typeIdx is still known), so the working `__to_primitive($Object)` path reduces it. Exposed via a `shared.ts` fn-pointer indirection (`registerMaterializeStructAsObject`) to break the type-coercion→literals cycle. NO struct-layout/brand change → hot static path byte-identical. Brand-supertype only needed for nominal `===` IDENTITY across an any round-trip, which ToPrimitive/arithmetic don't need.

**DEFERRED after PR-2** (smaller follow-up slices): (1) CLASS-instance any-param — methods are `ClassName_<m>(self)` funcs NOT struct fields, so the field-copy materializer can't carry them; needs them closure-wrapped onto the `$Object`; class structs already have `$__shape_brand` + an exported `__call_<m>` partial mechanism. (2) `Number([array])`/#10 (array→primitive). Pre-existing-on-main gaps (NOT regressions, confirmed via same-base diff): any-param PLAIN-object field read + `typeof` both return 0/null on main.
