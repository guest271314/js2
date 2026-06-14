// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2151 — standalone any-receiver method dispatch over CLOSED object-literal
 * structs.
 *
 * Under `--target standalone` / `--target wasi` an object literal `{ m(){…} }`
 * compiles to a **closed nominal WasmGC struct** (a distinct type whose methods
 * are emitted as `<__anon_N>_<m>(structRef, …args)` funcs, with the struct as
 * the `this` param). The any-receiver method-call fallback
 * (`compileCallExpression`, calls.ts) routes through the native
 * `__extern_method_call`, which only handles the OPEN `$Object` open-hash-map
 * receiver (`ref.test $Object`); a closed struct fails that test and falls to
 * the `ref.null.extern` arm, so `o.m()` silently returns `undefined`/0 and the
 * method never runs (the standalone analog of the JS-host #2015 bug).
 *
 * Fix: a per-method-name **closed-struct dispatcher** `__call_m_<name>` that
 * type-switches over every closed struct having `<Struct>_<name>`:
 *
 *   __call_m_<name>(recv: externref) -> externref
 *     any = any.convert_extern(recv)
 *     if ref.test S1: ref.cast S1; call S1_<name>; <box-coerce>
 *     elif ref.test S2: …
 *     else: __extern_method_call(recv, "<name>", emptyObjVec)   ;; open $Object fallback
 *
 * The struct is passed as the method's first param ⇒ `this` is threaded for
 * free, so `this.x` works. Result is box-coerced to externref (f64/i32 →
 * __box_number, ref → extern.convert_any) so the call site sees a uniform
 * externref.
 *
 * Reserve-then-fill (#1719): the dispatcher is reserved at the call site (where
 * the method name is a static string) with a placeholder `unreachable` body, and
 * filled at FINALIZE by {@link fillClosedMethodDispatch} — after every
 * object-literal struct and its `<Struct>_<name>` funcs are registered.
 *
 * Slice 1 scope: ZERO-arg method calls (covers `next()`, `getx()`, the iterator
 * protocol, and the bulk of test262 any-method patterns). Methods invoked with
 * arguments fall through to the existing path (the dispatcher is not used).
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjVecBuilders } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";

/** Mangle a method name into the reserved dispatcher export/funcMap name. */
function dispatcherName(methodName: string): string {
  return `__call_m_${methodName}`;
}

/**
 * Reserve (or fetch) the closed-struct dispatcher `__call_m_<name>` funcIdx with
 * a placeholder body. The real body is built by {@link fillClosedMethodDispatch}
 * at finalize. Idempotent; records the method name in
 * `ctx.closedMethodDispatchNames`. Returns the reserved funcIdx.
 *
 * Only meaningful under `ctx.standalone || ctx.wasi` — callers gate on that.
 */
export function reserveClosedMethodDispatch(ctx: CodegenContext, methodName: string): number {
  const name = dispatcherName(methodName);
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  // Register the open-$Object fallback-arm dependencies NOW (during
  // compilation), not at fill time — adding funcs/globals/imports at FINALIZE
  // would shift baked call/global indices (the addUnionImports hazard the
  // reserve-then-fill pattern exists to avoid). `fillClosedMethodDispatch` then
  // only READS funcMap. `ensureObjVecBuilders` pulls in the object runtime +
  // `__objvec_new`/`__extern_method_call`; the method-name string constant is
  // materialized for the fallback `__extern_method_call(recv, "<name>", [])`.
  ensureObjVecBuilders(ctx);
  addStringConstantGlobal(ctx, methodName);

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$closed_method_dispatch_type");
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name,
    typeIdx,
    locals: [],
    // Placeholder; filled by fillClosedMethodDispatch. `unreachable` keeps the
    // stub valid (externref result) if the fill is ever skipped.
    body: [{ op: "unreachable" } as Instr],
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  (ctx.closedMethodDispatchNames ??= new Set<string>()).add(methodName);
  return funcIdx;
}

/**
 * Fill every reserved `__call_m_<name>` dispatcher body at FINALIZE. Mirrors
 * `fillApplyClosure` (object-runtime.ts). Must run AFTER all object-literal
 * struct types and their `<Struct>_<name>` method funcs are registered, and
 * after `addUnionImports` (so `__box_number`/`__box_boolean` exist) — i.e. in
 * the same finalize phase as `emitStructFieldGetters`/`emitIteratorMethodExport`.
 * No-op when no dispatcher was reserved.
 */
export function fillClosedMethodDispatch(ctx: CodegenContext): void {
  const names = ctx.closedMethodDispatchNames;
  if (!names || names.size === 0) return;

  const mod = ctx.mod;
  const boxNumIdx = ctx.funcMap.get("__box_number");

  for (const methodName of names) {
    const dispIdx = ctx.funcMap.get(dispatcherName(methodName));
    if (dispIdx === undefined) continue;
    const dispFn = mod.functions[dispIdx - ctx.numImportFuncs];
    if (!dispFn) continue;

    // Collect every closed struct with a `<Struct>_<methodName>` 1-param method
    // (param 0 = the receiver struct). Skip wrapper/internal carriers.
    const entries: { typeIdx: number; funcIdx: number; resultType: ValType }[] = [];
    for (const [structName] of ctx.structFields) {
      const typeIdx = ctx.structMap.get(structName);
      if (typeIdx === undefined) continue;
      if (
        structName.startsWith("Wrapper") ||
        structName === "$AnyValue" ||
        structName.startsWith("__vec_") ||
        structName.startsWith("__arr_") ||
        structName.startsWith("$")
      )
        continue;

      const methodFullName = `${structName}_${methodName}`;
      const funcIdx = ctx.funcMap.get(methodFullName);
      if (funcIdx === undefined) continue;

      const funcDef = mod.functions[funcIdx - ctx.numImportFuncs];
      const funcType = funcDef ? mod.types[funcDef.typeIdx] : undefined;
      if (!funcType || funcType.kind !== "func") continue;
      // Slice 1: zero-arg-after-`this` only (the method takes just the receiver).
      if (funcType.params.length !== 1) continue;
      const resultType: ValType = funcType.results.length > 0 ? funcType.results[0]! : { kind: "externref" };
      entries.push({ typeIdx, funcIdx, resultType });
    }

    // Bottom arm: open-$Object fallback via __extern_method_call(recv, name, []).
    // Only available when the object runtime + ObjVec builders are present
    // (they are in standalone/wasi after ensureObjectRuntime). If absent, return
    // undefined so the dispatcher stays valid.
    // Both registered at reserve time (reserveClosedMethodDispatch) — read only.
    const methodCallIdx = ctx.funcMap.get("__extern_method_call");
    const objVecNewIdx = ctx.funcMap.get("__objvec_new");
    let current: Instr[];
    if (methodCallIdx !== undefined && objVecNewIdx !== undefined) {
      // __extern_method_call(recv, "<name>", __objvec_new())  — open-$Object arm.
      current = [
        { op: "local.get", index: 0 } as Instr,
        ...stringConstantExternrefInstrs(ctx, methodName),
        { op: "call", funcIdx: objVecNewIdx } as Instr,
        { op: "call", funcIdx: methodCallIdx } as Instr,
      ];
    } else {
      current = [{ op: "ref.null.extern" } as Instr];
    }

    // Build the type-switch from the bottom up: nest each struct arm.
    // local 0 = recv (param externref); local 1 = any (anyref).
    for (const entry of entries) {
      const callAndCoerce: Instr[] = [
        { op: "local.get", index: 1 } as Instr,
        { op: "ref.cast", typeIdx: entry.typeIdx } as Instr,
        { op: "call", funcIdx: entry.funcIdx } as Instr,
      ];
      if (entry.resultType.kind === "ref" || entry.resultType.kind === "ref_null") {
        callAndCoerce.push({ op: "extern.convert_any" } as Instr);
      } else if (entry.resultType.kind === "f64") {
        if (boxNumIdx !== undefined) callAndCoerce.push({ op: "call", funcIdx: boxNumIdx } as Instr);
        else callAndCoerce.push({ op: "drop" } as Instr, { op: "ref.null.extern" } as Instr);
      } else if (entry.resultType.kind === "i32") {
        callAndCoerce.push({ op: "f64.convert_i32_s" } as Instr);
        if (boxNumIdx !== undefined) callAndCoerce.push({ op: "call", funcIdx: boxNumIdx } as Instr);
        else callAndCoerce.push({ op: "drop" } as Instr, { op: "ref.null.extern" } as Instr);
      }
      // externref result: no coercion.

      current = [
        { op: "local.get", index: 1 } as Instr,
        { op: "ref.test", typeIdx: entry.typeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: callAndCoerce,
          else: current,
        } as unknown as Instr,
      ];
    }

    const body: Instr[] = [
      { op: "local.get", index: 0 } as Instr,
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: 1 } as Instr,
      ...current,
    ];

    dispFn.locals = [{ name: "__any", type: { kind: "anyref" } }];
    dispFn.body = body;
    void (dispFn as WasmFunction);
  }
}
