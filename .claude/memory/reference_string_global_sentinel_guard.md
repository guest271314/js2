---
name: reference_string_global_sentinel_guard
description: "Standalone -1 string-global sentinel — guard global.get sites with stringConstantExternrefInstrs, not just !== undefined"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

Recurring bug class (#51, #1888, #1623, #2043): in **nativeStrings/standalone** mode (`--target wasi`), `addStringConstantGlobal` records a **-1 sentinel** in `ctx.stringGlobalMap` (the literal is materialized inline; there is no host `string_constants` global). Any codegen site that does `ctx.stringGlobalMap.get(x)` then `fctx.body.push({op:"global.get", index})` and guards only `!== undefined` will bake `global.get -1` — the `-1` passes the `!== undefined` check. The emitter (`src/emit/binary.ts` `vIdx`/`failIndex`) rejects it at serialize time: `Codegen error: global index out of range — -1 (valid: [0, N))`.

**Fix pattern**: route the key/name materialization through `stringConstantExternrefInstrs(ctx, value)` (from `src/codegen/native-strings.ts`). It emits an inline NativeString externref under standalone and the host `global.get` only when a real import global exists (`strIdx >= 0`) — host/GC behaviour-identical. Always call `addStringConstantGlobal(ctx, value)` first (registers the constant), then push the helper's instrs.

Sites fixed in #51 (PR #1688): `expressions/identifiers.ts` (instanceof `<BuiltinCtor>` name — the shared test262-harness producer via `obj instanceof Function/Object` in `callbackfn`), `expressions/calls.ts` (Object.create descriptor keys, both loops), `literals.ts` (object-literal data-property key via `__extern_set`), `statements/loops.ts` (for-of object-destructure targets, for-in member-target + standalone fallback keys, for-of `{...rest}` excluded-keys). Already-correct exemplars to copy: `destructuring-params.ts` (#1623) and the accessor-key path in `literals.ts` (#1888).

Debugging technique that found the producer: patch `compiler.ts` just before `emitBinaryWithSourceMap` to walk every function body (recursing into `then`/`else`/`body`/`catches`) and log any `global.get` with `index < 0`, its function name, and nearby `sourcePos` + surrounding instructions. The preceding `call funcIdx` (resolved via `mod.functions[idx-numImportFuncs].name` or `mod.imports`) identifies the lowering. test262 crashes at `L2:1` mean the producer is in the injected harness/shim, not the test body. See [[project_toprimitive_nominal_struct_gap]] for another standalone-mode dynamic-object gap.
