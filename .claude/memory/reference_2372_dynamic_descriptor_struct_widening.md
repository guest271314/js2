---
name: reference_2372_dynamic_descriptor_struct_widening
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#2372 ("receiver representation" / TL called it #1630) real root cause: NOT a broad
receiver-forcing pre-pass. On current main + the banked #2371 `__obj_define_from_desc`,
a `const o: any = {}` receiver ALREADY builds a `$Object`; define+read-back composes on
it. The ONLY broken cell: `const o: any = {}` (explicit `any` annotation + empty literal)
targeted by a DYNAMIC (variable, not inline-literal) `Object.defineProperty` → read-back 0.

Mechanism: `collectEmptyObjectWidening` + `collectPropsFromStatements`
(`src/codegen/declarations.ts`) widen the receiver to a typed anon struct on ANY
`Object.defineProperty(o,"x",desc)`. That struct fast path (struct.set on define,
struct.get on read) is only SOUND for an inline-literal descriptor. For a dynamic
descriptor the pre-pass can't statically resolve, it STILL registers the struct, but
standalone routes the define to native `__obj_define_from_desc` ($Object runtime). Write
lands in $Object, read-back lowers to struct.get on the struct → 0. (WAT confirms receiver
built as `struct.new N / extern.convert_any`.)

Fix (4 files, ~25 LOC, gated `ctx.standalone`): new `ctx.dynamicDescriptorWidenVars`
poison set; `collectPropsFromStatements` adds varName when `!isObjectLiteralExpression
(descArg)`; `collectEmptyObjectWidening` `continue`s (skips struct registration) for
poisoned vars → receiver stays $Object, write+read consistent. Host/gc/wasi untouched.

Verification technique that mattered: WAT byte-diff against the **#2371 base** (not
plain upstream/main — #2371 adds a helper that shifts every call-target funcIdx by +1,
which looks like a diff but isn't). Diff against the SAME base that has the dependency,
or you get false "DIFFERS". Inline-only defineProperty, class-instance field (#1673),
plain literal, plain write/read all byte-identical → minimal blast radius.

Lesson (generalizes the [[feedback_verify_fix_in_git_not_narrative]] discipline): re-ground
a "hard architect-scale representation change" against current main BEFORE designing — the
substrate often moved (the #2162b pattern) and the real wall is a narrow fast-path
mis-fire, not the feared broad re-typing.

SECOND half (the descriptor): #2372 has TWO symmetric representation halves. The receiver
fix alone flipped ~0 on the real test262 shape because the DESCRIPTOR (`var desc = {...}`,
un-annotated) is also a closed struct, and __obj_define_from_desc runs ToPropertyDescriptor
over it as a $Object (ref.test $Object) → struct desc = "not an object" → spurious TypeError
§10.1.6 trap. Fix: `emitDescriptorStructReify` in object-ops.ts emitDefinePropertyDescRuntime
— when descType is a typed struct, reify to a fresh $Object (per static field struct.get +
coerceType→externref + __extern_set), INLINE by-name late-imports (#2190-safe), skip when
already externref. Measured +38 flips / 0 reg on built-ins/Object/defineProperty/15.2.3.6-3-*.

HARNESS-FAITHFULNESS lesson (correct ≠ flips, the TL gate that paid off): a local test262
flip-measurement harness MUST mirror the production runner or it reads a false 0. Required:
(1) compile with `fileName:'test.js', allowJs:true, skipSemanticDiagnostics:true` — else
TS-strict warnings on propertyHelper.js make r.success=false for EVERY file (false 0/N);
(2) instantiate with a REAL `buildImports(r.imports, undefined, r.stringPool)` import object,
NOT `{}` — standalone modules still pull a few env imports via assert/closures, and `{}`
throws "Import #0 env: module is not an object". Pass = instantiate without throw (negative
metadata inverts). Measure BASE vs FIX with a per-file pass-set DIFF to prove 0 regressions.
