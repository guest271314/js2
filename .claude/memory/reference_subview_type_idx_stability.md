---
name: reference_subview_type_idx_stability
description: "New WasmGC struct types whose idx must survive hoist-vs-body passes must be reserved in the up-front type-init phase, not registered on-demand"
metadata:
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

When a codegen feature needs a **binding's local type** to carry a freshly-added
WasmGC struct type (e.g. the `$__subview` for TypedArray subarray-aliasing, #2357/#47),
on-demand registration via `getOrRegister<Foo>Type` during function compilation does
**NOT** give a stable type index: the compiler numbers types across **two passes**
(an early measuring/import-discovery pass that sizes hoisted locals via
`inferLetConstInitializerWasmType`, then the final emit pass). A type registered
on-demand lands at a *different* index in each pass, so the hoisted local and the
emitted `struct.new` disagree → reads/`.length` silently return 0.

**Do NOT "fix" this by eagerly registering inside `getOrRegisterVecType`** — that
shifts every downstream type index, so `resolveWasmType(Uint8Array)` resolves a plain
`new Uint8Array()` to the *new* type (verified: the parent array itself got built as a
`$__subview`). Index-shifting is too fragile (same class as the #2079 / addUnionImports
late-import shift hazard).

**Correct fix:** reserve the new struct type slots in the **deterministic up-front
type-init phase** — a stable point like the linear-u8 reservation (`reserveLinearU8AllocType`,
`index.ts` ~1035) or where `$__vec_base` / native-string / box structs register. A slot
reserved there gets the identical index in both passes, so inference + element-access +
lowering all agree.

Two more lessons that completed #2357/#47 (all merged — full subarray aliasing works,
zero hot-path cost):

1. **Source the binding's local type at the REAL variable-declaration site, not only the
   TDZ-hoist pre-pass.** A `let s = a.subarray(...)` binding is allocated by
   `compileVariableStatement` (`statements/variables.ts` ~590, the `wasmType` chain ending
   in `localTypeForDeclaration`), NOT by the `walkStmtForLetConst` TDZ hoist — that path was
   never reached. Add the special-case arm in the `variables.ts` chain, mirroring the
   existing `standaloneRegExpMatchArrayType` arm.

2. **A 3-field view struct must be discriminated BEFORE the 2-field vec / tuple-struct
   check.** Element read (`property-access.ts` `compileElementAccessBody`) and write
   (`expressions/assignment.ts` `compileElementAssignment`) both gate the vec path on
   exactly `{length,data}` 2 fields; a 3-field `$__subview {length,data,byteOffset}` is
   false for that, so the tuple/`__extern_get` fallback eats it. Put the
   `isSubviewTypeIdx(ctx, typeIdx)` arm right after `typeDef` resolves, before that check.
   Also: an element-assignment is an expression — re-push the stored value (else a caller
   `drop` underflows the stack), and Wasm `select` returns the FIRST operand when the
   condition is TRUE (so `max(end-begin,0)` needs `i32.ge_s`, not `lt_s`).

Compile-time discrimination = `receiver.typeIdx === ctx.<foo>TypeIdx` (or
`isSubviewTypeIdx`), so the plain hot path takes ZERO extra instructions — verify with a
WAT-diff of a plain `for(i) a[i]` loop (should show only `array.get_u`, no `ref.test`).

See [[reference_no_rebuild_helper_body_at_finalize]] for the related late-shift
invariant, and `plan/issues/2357` for the full #47 write-up.
