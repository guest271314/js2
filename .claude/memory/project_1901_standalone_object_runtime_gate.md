---
name: project-1901-standalone-object-runtime-gate
description: The open-object runtime ($Object/__new_plain_object/__extern_get) is emitted ONLY under ctx.standalone, NOT ctx.wasi (late-imports.ts gate); #1901 fix + 2 follow-ons
metadata:
  node_type: memory
  type: project
  originSessionId: bd85f78e-e46f-4c52-b752-d9a8f971f948
---

The Wasm-native open-object runtime (`ensureObjectRuntime` →
`$Object`/`$PropMap`/`$PropEntry` + `__new_plain_object` / `__extern_get` /
`__extern_set`, object-runtime.ts) is emitted as native defined functions
**only under `ctx.standalone`, NOT under `ctx.wasi`**. The gate is
`src/codegen/expressions/late-imports.ts` (`if (ctx.standalone &&
OBJECT_RUNTIME_HELPER_NAMES.has(name)) { ensureObjectRuntime(ctx); … }`) —
wasi was deliberately left on the host-import object machinery (#1472 Phase B:
"WASI is intentionally NOT routed here yet … until the standalone path is
proven"). So any new object-runtime consumer must be gated to `ctx.standalone`;
under wasi `ensureLateImport` for those names returns undefined and the caller
must decline.

**#1901 (PR #1241, 2026-06-05)** fixed the standalone closed-struct→externref
string-key MEMBER READ (`function g(o:any){return o.x}` ← `g({x:9})` was 0 +
invalid Wasm) via **construction-time `$Object` routing** in
`src/codegen/literals.ts`: a non-empty object literal in an any/unknown/object
contextual type (data props / shorthand / spread only — no accessors / methods
/ computed-symbol keys) is built as an open `$Object` via `__extern_set` at
construction instead of a closed struct. The any-context test **mirrors the
existing empty-`{}` branch's `isAnyContext` check verbatim** (R2 guard: a
concrete struct type keeps the closed-struct fast path, byte-identical).
**Gated to `ctx.standalone`** — gc/host + wasi verified byte-identical to main.

**Two follow-ons carved out of #1901 (NOT done):**
1. **wasi object-runtime extension** — lift the `late-imports.ts`
   `ctx.standalone`-only gate to include `ctx.wasi`, AFTER fixing a
   **pre-existing** `__str_flatten` "expected (ref null 5)" type mismatch
   inside `__extern_get`'s emitted body under native-strings (present on main
   whenever a closed-struct-only wasi program emits `__extern_get`).
2. **#124 ToPrimitive-off-`$Object` dispatch** — `(o as number)` / `String(o)`
   must LOCATE a stored `valueOf`/`toString` on the `$Object` and invoke it via
   `__apply_closure`. Does NOT "fall out for free" from #1901: even a
   closure-valued `{valueOf:()=>7}` data prop (which routes to `$Object`) still
   returns NaN. Depends on **S6b method-as-value wrapping** (a method/closure
   stored on `$Object` with `this`=externref `$Object`, distinct from
   `emitObjectMethodAsClosure`'s structTypeIdx-parameterized path).

Related: [[project-native-generator-iterator-shapes]], [[project_next_session]].
