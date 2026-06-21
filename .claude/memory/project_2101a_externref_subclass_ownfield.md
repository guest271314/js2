---
name: project_2101a_externref_subclass_ownfield
metadata: 
  node_type: memory
  type: project
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#2101a R5 (PR #1775, 2026-06-19) — standalone own fields on externref-backed Error subclasses.

**The real bug (measure-first corrected the spec):** `class A extends Error { code = 0; constructor(m){ super(m); this.code = 42 } }` TRAPPED construction in standalone — NOT silent-0 as the #1472 R5 spec assumed. An Error subclass instance IS the parent `$Error_struct` externref (a vestigial `$A` user struct is registered for bookkeeping but the instance is never an `$A`). `this.code = 42` lowered as `ref.cast $A` on the `$Error_struct` receiver → ref.test false → null receiver → TypeError throw at construction. So `.code`, `.message`, AND `instanceof Error` ALL trapped. A subclass with NO own field worked fine. The fix RESTORES message+instanceof.

**Rep (signed off, implemented):** `$Error_struct` (error-types.ts `getOrRegisterErrorStructType`) gains a trailing `$props` fieldIdx 5 — an **externref** holding an open `$Object` (externref, NOT `ref null $Object`, to dodge the forward type-ref since `$Object` registers lazily, maybe after `$Error_struct`). Only ONE `struct.new $Error_struct` site exists (`emitWasiErrorConstructor`) — it supplies `ref.null.extern`. Own-field WRITE (assignment.ts `compilePropertyAssignment`, gated `ctx.standalone && ctx.classExternrefBackedSet.has(typeName)`): cast self→`(ref $Error_struct)` ONCE into a typed local (repeated any.convert_extern/ref.cast round-trips caused a validation error — cast once, reuse), read `$props`, lazy-alloc `__new_plain_object()` if null + write back, then `__extern_set(props, key, box(value))`. Own-field READ (property-access.ts, before the struct-field block): `__extern_get(self.$props, key)`; message/name/stack keep the upstream Error fast-path (~L2227).

**Deferred (NOT a rep defect):** `class D extends A {}` where the field is on ancestor A and D has only an IMPLICIT derived ctor: `new D().code` stays 0 — the implicit `D_new` threads super() through `__new_<Error>` and never runs A's ctor body (where `this.code=42` lives). That's the #2188 multi-level ctor-body-threading gap (TaskList #48), orthogonal to storage. Once A's body runs, the field lands. Direct + self-declared subclass fields + multi-field all work.

See [[reference_no_rebuild_helper_body_at_finalize]], [[project_type_index_shift_and_deadelim]] (struct-field add shifts no funcidx but must register all fields from the start).
