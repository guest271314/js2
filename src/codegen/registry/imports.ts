// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Import/global registry ownership for the backend.
 *
 * This module owns low-level Wasm import registration plus the global-index
 * fixups required when late import globals are inserted during codegen.
 */
import type { Import, Instr, TagDef } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { buildStrictHostImportError, isHostImportAllowed } from "../host-import-allowlist.js";
import { addFuncType } from "./types.js";

/**
 * Register an import (`module.name`) on the current module.
 *
 * Under `ctx.strictNoHostImports` (auto-on for `--target wasi`, controllable
 * via `--no-host-imports` / `--allow-host-imports` on the CLI; see #1524),
 * any `env`-module import that is not on the dual-mode allowlist
 * (`src/codegen/host-import-allowlist.ts`) is rejected with a structured
 * compile error referencing the tracking issue. The error is pushed onto
 * `ctx.errors`; the import itself is silently dropped to avoid producing a
 * module that references a nonexistent function index. Downstream code that
 * attempts to `call` the dropped function will fail validation if the
 * caller did not check `result.success` before consuming the binary.
 *
 * `wasi_snapshot_preview1` imports are always allowed; they are the canonical
 * WASI ABI, not JS-host bindings.
 *
 * `wasm:js-string` / `string_constants` are JS-host bindings but are usually
 * not requested under strict mode because `nativeStrings` is auto-enabled.
 * If they ARE requested under strict mode, the gate rejects them with a
 * dedicated error pointing the user at the nativeStrings option.
 */
export function addImport(ctx: CodegenContext, module: string, name: string, desc: Import["desc"]): void {
  if (ctx.strictNoHostImports) {
    const decision = isHostImportAllowed(module, name);
    if (!decision.allowed) {
      const message = buildStrictHostImportError(module, name);
      ctx.errors.push({ message, line: 0, column: 0 });
      // Skip registration. The caller will record a stale funcMap index if
      // it tries to look the import up by name; `result.success` will be
      // false thanks to the error above, and downstream emit/link will
      // refuse to produce a final binary.
      return;
    }
  }
  ctx.mod.imports.push({ module, name, desc });
  if (desc.kind === "func") {
    // #1666: Adding a func import shifts the function index space — every
    // already-emitted `call`/`return_call`/`ref.func` that targets a *module*
    // function (index >= numImportFuncs at the time it was emitted) is now off
    // by one. `addStringConstantGlobal` has done this fixup for *globals* since
    // #1174; func imports added after module functions already exist (e.g.
    // `finalizeUnifiedCollector` emits the native-string helpers, then adds
    // `__make_callback` / `number_toString*` / `__call_*`) left helper bodies
    // pointing at the wrong callee, producing modules that fail validation
    // ("call[k] expected type <T>, found <U>" inside `__str_flatten`/
    // `__str_to_extern`).
    //
    // Only fix up here when NOT inside a deferred late-import batch: the
    // `ensureLateImport`/`flushLateImportShifts` path (body compilation) sets
    // `ctx.pendingLateImportShift` BEFORE calling addImport and does its own
    // single batched shift, so an eager shift here would double-shift.
    const threshold = ctx.numImportFuncs;
    ctx.funcMap.set(name, ctx.numImportFuncs);
    ctx.numImportFuncs++;
    if (ctx.pendingLateImportShift === null && !ctx.suppressFuncIndexFixup && ctx.mod.functions.length > 0) {
      fixupModuleFuncIndices(ctx, threshold, 1);
    }
  }
  if (desc.kind === "global") {
    ctx.numImportGlobals++;
  }
}

/**
 * #1666: Shift every `call`/`return_call`/`ref.func` index that targets a
 * module function (index >= `threshold`) up by `delta`, after a func import is
 * inserted at `threshold`. Mirrors `fixupModuleGlobalIndices` but for the
 * function index space. Also shifts `funcMap` (skipping import names), export
 * descriptors, table element segments, and declared func refs.
 *
 * The import that was just registered has its funcMap entry at `threshold`;
 * it is an import name, so the import-name filter below skips it (it must not
 * be re-shifted).
 */
function fixupModuleFuncIndices(ctx: CodegenContext, threshold: number, delta: number): void {
  const visitedArrays = new WeakSet<Instr[]>();
  function shiftFuncIndices(instrs: Instr[]): void {
    if (visitedArrays.has(instrs)) return;
    visitedArrays.add(instrs);
    for (const instr of instrs) {
      if ("funcIdx" in instr && typeof (instr as any).funcIdx === "number") {
        if ((instr as any).funcIdx >= threshold) {
          (instr as any).funcIdx += delta;
        }
      }
      const a = instr as any;
      if (a.body && Array.isArray(a.body)) shiftFuncIndices(a.body);
      if (a.then && Array.isArray(a.then)) shiftFuncIndices(a.then);
      if (a.else && Array.isArray(a.else)) shiftFuncIndices(a.else);
      if (a.catches && Array.isArray(a.catches)) {
        for (const c of a.catches) {
          if (Array.isArray(c.body)) shiftFuncIndices(c.body);
        }
      }
      if (a.catchAll && Array.isArray(a.catchAll)) shiftFuncIndices(a.catchAll);
    }
  }

  for (const func of ctx.mod.functions) {
    shiftFuncIndices(func.body);
  }
  if (ctx.currentFunc) {
    shiftFuncIndices(ctx.currentFunc.body);
    for (const sb of ctx.currentFunc.savedBodies) shiftFuncIndices(sb);
  }
  for (const parentFctx of ctx.funcStack) {
    shiftFuncIndices(parentFctx.body);
    for (const sb of parentFctx.savedBodies) shiftFuncIndices(sb);
  }
  for (const pb of ctx.parentBodiesStack) {
    shiftFuncIndices(pb);
  }
  for (const lb of ctx.liveBodies) {
    shiftFuncIndices(lb);
  }
  if (ctx.pendingInitBody) {
    shiftFuncIndices(ctx.pendingInitBody);
  }
  // Global initializer expressions can carry ref.func (e.g. method-closure
  // globals); shift those too.
  for (const g of ctx.mod.globals) {
    if (g.init) shiftFuncIndices(g.init);
  }

  // Shift funcMap entries for defined functions. Import entries keep their
  // (already-correct) indices. The just-added import name is an import entry
  // and is skipped by the import-name filter.
  const importNames = new Set<string>();
  for (const imp of ctx.mod.imports) {
    if (imp.desc.kind === "func") importNames.add(imp.name);
  }
  for (const [n, idx] of ctx.funcMap) {
    if (importNames.has(n)) continue;
    if (idx >= threshold) ctx.funcMap.set(n, idx + delta);
  }

  // Shift export descriptors.
  for (const exp of ctx.mod.exports) {
    if (exp.desc.kind === "func" && exp.desc.index >= threshold) {
      exp.desc.index += delta;
    }
  }
  // Shift table element segments.
  for (const elem of ctx.mod.elements) {
    if (elem.funcIndices) {
      for (let i = 0; i < elem.funcIndices.length; i++) {
        if (elem.funcIndices[i]! >= threshold) {
          elem.funcIndices[i]! += delta;
        }
      }
    }
  }
  // Shift declared func refs.
  if (ctx.mod.declaredFuncRefs.length > 0) {
    ctx.mod.declaredFuncRefs = ctx.mod.declaredFuncRefs.map((idx) => (idx >= threshold ? idx + delta : idx));
  }
  // Shift the Wasm start function index (#907) if the defined function it
  // points at moved.
  if (ctx.mod.startFuncIdx !== undefined && ctx.mod.startFuncIdx >= threshold) {
    ctx.mod.startFuncIdx += delta;
  }
}

/**
 * Register a string literal as a global import from the "string_constants"
 * namespace and repair already-compiled module-global references if needed.
 *
 * In `nativeStrings` mode (auto-on for `--target wasi`), no JS host runtime
 * exists to satisfy the import, so we skip the import and just record the
 * string in `stringGlobalMap` with the sentinel `-1` (the same convention
 * used by `collectStringLiterals` finalize). Call sites that materialize a
 * string constant onto the stack must check the sentinel and use the native
 * string path (`compileNativeStringLiteral` + `extern.convert_any` for the
 * externref-typed throw payload) instead of `global.get`. (#1174)
 */
export function addStringConstantGlobal(ctx: CodegenContext, value: string): void {
  if (ctx.stringGlobalMap.has(value)) return;

  if (ctx.nativeStrings) {
    // Sentinel: no host import, materialize inline at use sites.
    ctx.stringGlobalMap.set(value, -1);
    ctx.stringLiteralMap.set(value, `__str_${ctx.stringLiteralCounter}`);
    ctx.stringLiteralValues.set(`__str_${ctx.stringLiteralCounter}`, value);
    ctx.stringLiteralCounter++;
    ctx.mod.stringPool.push(value);
    return;
  }

  const hasModuleGlobals = ctx.mod.globals.length > 0 || ctx.mod.functions.length > 0;
  const oldNumImportGlobals = ctx.numImportGlobals;

  const globalIdx = ctx.numImportGlobals;
  addImport(ctx, "string_constants", value, {
    kind: "global",
    type: { kind: "externref" },
    mutable: false,
  });
  ctx.stringGlobalMap.set(value, globalIdx);
  ctx.stringLiteralMap.set(value, `__str_${ctx.stringLiteralCounter}`);
  ctx.stringLiteralValues.set(`__str_${ctx.stringLiteralCounter}`, value);
  ctx.stringLiteralCounter++;
  ctx.mod.stringPool.push(value);

  if (hasModuleGlobals) {
    fixupModuleGlobalIndices(ctx, oldNumImportGlobals, 1);
  }
}

/** Return the absolute Wasm global index for a new module-defined global. */
export function nextModuleGlobalIdx(ctx: CodegenContext): number {
  return ctx.numImportGlobals + ctx.mod.globals.length;
}

/** Convert an absolute Wasm global index to a local module-globals array index. */
export function localGlobalIdx(ctx: CodegenContext, absIdx: number): number {
  return absIdx - ctx.numImportGlobals;
}

/**
 * Lazily register the exception tag used by throw/try-catch.
 * The tag has signature (externref) — all thrown values are externref.
 */
export function ensureExnTag(ctx: CodegenContext): number {
  if (ctx.exnTagIdx >= 0) return ctx.exnTagIdx;
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], []);
  const tagDef: TagDef = { name: "__exn", typeIdx };
  ctx.exnTagIdx = ctx.mod.tags.length;
  ctx.mod.tags.push(tagDef);
  return ctx.exnTagIdx;
}

/**
 * Fix up module-global absolute indices in all compiled function bodies when
 * new import globals are inserted after module globals already exist.
 */
function fixupModuleGlobalIndices(ctx: CodegenContext, threshold: number, delta: number): void {
  // Dedupe per-call: an instr (or nested array node) reachable from multiple
  // top-level bodies must only be shifted once per fixup call. The `shifted`
  // Set below dedupes top-level Instr[] arrays, but nested arrays (if.then,
  // block.body, try.body, try.catches[].body, try.catchAll) can be reached
  // from multiple top-level paths (e.g. an if-then array that's also stored
  // in a saved body via a manual swap pattern). Without per-call dedup, each
  // additional reachability path applies an extra +delta, over-shifting the
  // index past the declared global range (#1302 — lodash flow.js).
  const visitedInstrs = new WeakSet<object>();
  const visitedArrays = new WeakSet<Instr[]>();
  function shiftGlobalIndices(instrs: Instr[]): void {
    if (visitedArrays.has(instrs)) return;
    visitedArrays.add(instrs);
    for (const instr of instrs) {
      if ((instr.op === "global.get" || instr.op === "global.set") && instr.index >= threshold) {
        if (!visitedInstrs.has(instr as object)) {
          visitedInstrs.add(instr as object);
          instr.index += delta;
        }
      }
      if ("body" in instr && Array.isArray((instr as any).body)) {
        shiftGlobalIndices((instr as any).body);
      }
      if ("then" in instr && Array.isArray((instr as any).then)) {
        shiftGlobalIndices((instr as any).then);
      }
      if ("else" in instr && Array.isArray((instr as any).else)) {
        shiftGlobalIndices((instr as any).else);
      }
      if ("catches" in instr && Array.isArray((instr as any).catches)) {
        for (const c of (instr as any).catches) {
          if (Array.isArray(c.body)) shiftGlobalIndices(c.body);
        }
      }
      if ("catchAll" in instr && Array.isArray((instr as any).catchAll)) {
        shiftGlobalIndices((instr as any).catchAll);
      }
    }
  }

  const shifted = new Set<Instr[]>();
  for (const func of ctx.mod.functions) {
    if (!shifted.has(func.body)) {
      shiftGlobalIndices(func.body);
      shifted.add(func.body);
    }
  }

  if (ctx.currentFunc) {
    if (!shifted.has(ctx.currentFunc.body)) {
      shiftGlobalIndices(ctx.currentFunc.body);
      shifted.add(ctx.currentFunc.body);
    }
    for (const sb of ctx.currentFunc.savedBodies) {
      if (shifted.has(sb)) continue;
      shiftGlobalIndices(sb);
      shifted.add(sb);
    }
  }

  for (const parentFctx of ctx.funcStack) {
    if (!shifted.has(parentFctx.body)) {
      shiftGlobalIndices(parentFctx.body);
      shifted.add(parentFctx.body);
    }
    for (const sb of parentFctx.savedBodies) {
      if (!shifted.has(sb)) {
        shiftGlobalIndices(sb);
        shifted.add(sb);
      }
    }
  }

  for (const pb of ctx.parentBodiesStack) {
    if (!shifted.has(pb)) {
      shiftGlobalIndices(pb);
      shifted.add(pb);
    }
  }

  if (ctx.pendingInitBody && !shifted.has(ctx.pendingInitBody)) {
    shiftGlobalIndices(ctx.pendingInitBody);
    shifted.add(ctx.pendingInitBody);
  }

  for (const g of ctx.mod.globals) {
    if (g.init) shiftGlobalIndices(g.init);
  }

  function shiftMap(map: Map<string, number>): void {
    for (const [key, idx] of map) {
      if (idx >= threshold) {
        map.set(key, idx + delta);
      }
    }
  }
  shiftMap(ctx.moduleGlobals);
  shiftMap(ctx.capturedGlobals);
  shiftMap(ctx.staticProps);
  shiftMap(ctx.protoGlobals);
  shiftMap(ctx.classObjectGlobals); // (#1395) — same shift discipline as protoGlobals
  shiftMap(ctx.methodClosureGlobals); // (#1394) — cached per-method closure globals
  shiftMap(ctx.tdzGlobals);

  for (const entry of ctx.staticInitExprs) {
    if (entry.globalIdx >= threshold) {
      entry.globalIdx += delta;
    }
  }

  if (ctx.symbolCounterGlobalIdx >= threshold) {
    ctx.symbolCounterGlobalIdx += delta;
  }
  if (ctx.wasiBumpPtrGlobalIdx >= threshold) {
    ctx.wasiBumpPtrGlobalIdx += delta;
  }
  if (ctx.argcGlobalIdx >= threshold) {
    ctx.argcGlobalIdx += delta;
  }
  if (ctx.extrasArgvGlobalIdx >= threshold) {
    ctx.extrasArgvGlobalIdx += delta;
  }
}
