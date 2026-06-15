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

/**
 * Mangle a method name + arg count into the reserved dispatcher export/funcMap
 * name. (#2151 Slice 2) The arity is part of the key so `o.m()` and `o.m(a,b)`
 * get distinct dispatchers with the right number of externref arg params.
 */
function dispatcherName(methodName: string, arity: number): string {
  return `__call_m_${methodName}_${arity}`;
}

/**
 * Reserve (or fetch) the closed-struct dispatcher `__call_m_<name>_<arity>`
 * funcIdx with a placeholder body. The real body is built by
 * {@link fillClosedMethodDispatch} at finalize. Idempotent; records the
 * (method name, arity) pair in `ctx.closedMethodDispatchNames` (encoded as
 * `<name>/<arity>`). Returns the reserved funcIdx.
 *
 * The dispatcher signature is `(recv: externref, arg0..arg{arity-1}: externref)
 * -> externref`; the call site coerces each argument to externref before the
 * call, and the fill side coerces each back to the method's declared param type.
 *
 * Only meaningful under `ctx.standalone || ctx.wasi` — callers gate on that.
 */
export function reserveClosedMethodDispatch(ctx: CodegenContext, methodName: string, arity = 0): number {
  const name = dispatcherName(methodName, arity);
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  // Register the open-$Object fallback-arm dependencies NOW (during
  // compilation), not at fill time — adding funcs/globals/imports at FINALIZE
  // would shift baked call/global indices (the addUnionImports hazard the
  // reserve-then-fill pattern exists to avoid). `fillClosedMethodDispatch` then
  // only READS funcMap. `ensureObjVecBuilders` pulls in the object runtime +
  // `__objvec_new`/`__objvec_push`/`__extern_method_call`; the method-name
  // string constant is materialized for the fallback
  // `__extern_method_call(recv, "<name>", [args…])`.
  ensureObjVecBuilders(ctx);
  addStringConstantGlobal(ctx, methodName);

  // Signature: (recv, arg0..arg{arity-1}) all externref → externref.
  const params: ValType[] = Array.from({ length: arity + 1 }, () => ({ kind: "externref" }) as ValType);
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }], `$closed_method_dispatch_type_${arity}`);
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
  (ctx.closedMethodDispatchNames ??= new Set<string>()).add(`${methodName}/${arity}`);
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
  // (#2151 Slice 2) externref→primitive unbox helpers for arg coercion (read
  // only; registered at reserve time via addUnionImports).
  const unboxNumIdx = ctx.funcMap.get("__unbox_number");
  const unboxBoolIdx = ctx.funcMap.get("__unbox_boolean");

  for (const key of names) {
    // key is `<methodName>/<arity>` (#2151 Slice 2). Split from the LAST `/` so
    // method names containing `/` (none in practice) wouldn't corrupt the arity.
    const slash = key.lastIndexOf("/");
    const methodName = slash >= 0 ? key.slice(0, slash) : key;
    const arity = slash >= 0 ? Number.parseInt(key.slice(slash + 1), 10) || 0 : 0;
    const dispIdx = ctx.funcMap.get(dispatcherName(methodName, arity));
    if (dispIdx === undefined) continue;
    const dispFn = mod.functions[dispIdx - ctx.numImportFuncs];
    if (!dispFn) continue;

    // Param layout of the dispatcher: local 0 = recv (externref), locals
    // 1..arity = the externref args, local (arity+1) = the `any` temp (anyref).
    const anyLocalIdx = arity + 1;

    // Collect every closed struct with a `<Struct>_<methodName>` method whose
    // signature is `(this, arg0..arg{arity-1})` — i.e. `1 + arity` params (param
    // 0 = the receiver struct). Skip wrapper/internal carriers.
    const entries: { typeIdx: number; funcIdx: number; paramTypes: ValType[]; resultType: ValType }[] = [];
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
      // Must be `this` + exactly `arity` declared params.
      if (funcType.params.length !== 1 + arity) continue;
      const resultType: ValType = funcType.results.length > 0 ? funcType.results[0]! : { kind: "externref" };
      // Declared param types of the args (skip param 0 = `this`).
      const paramTypes = funcType.params.slice(1);
      entries.push({ typeIdx, funcIdx, paramTypes, resultType });
    }

    // Bottom arm: open-$Object fallback via
    // __extern_method_call(recv, name, [arg0..arg{arity-1}]). The args are pushed
    // onto a fresh $ObjVec so the open-object runtime reads them by index.
    const methodCallIdx = ctx.funcMap.get("__extern_method_call");
    const objVecNewIdx = ctx.funcMap.get("__objvec_new");
    const objVecPushIdx = ctx.funcMap.get("__objvec_push");
    let current: Instr[];
    if (methodCallIdx !== undefined && objVecNewIdx !== undefined && (arity === 0 || objVecPushIdx !== undefined)) {
      const argVec: Instr[] = [];
      if (arity > 0 && objVecPushIdx !== undefined) {
        // vec = __objvec_new(); for each arg: __objvec_push(vec, argi); then vec.
        const vecTmp = anyLocalIdx + 1; // an extra local for the arg vec
        argVec.push({ op: "call", funcIdx: objVecNewIdx } as Instr);
        argVec.push({ op: "local.set", index: vecTmp } as Instr);
        for (let a = 0; a < arity; a++) {
          argVec.push({ op: "local.get", index: vecTmp } as Instr);
          argVec.push({ op: "local.get", index: 1 + a } as Instr);
          argVec.push({ op: "call", funcIdx: objVecPushIdx } as Instr);
        }
        argVec.push({ op: "local.get", index: vecTmp } as Instr);
      } else {
        argVec.push({ op: "call", funcIdx: objVecNewIdx } as Instr);
      }
      current = [
        { op: "local.get", index: 0 } as Instr,
        ...stringConstantExternrefInstrs(ctx, methodName),
        ...argVec,
        { op: "call", funcIdx: methodCallIdx } as Instr,
      ];
    } else {
      current = [{ op: "ref.null.extern" } as Instr];
    }

    // Build the type-switch from the bottom up: nest each struct arm.
    for (const entry of entries) {
      const callAndCoerce: Instr[] = [
        { op: "local.get", index: anyLocalIdx } as Instr,
        { op: "ref.cast", typeIdx: entry.typeIdx } as Instr, // `this`
      ];
      // Push each arg coerced from externref to the method's declared param type.
      // Args arrive as externref (the call site boxes them); the method wants
      // its declared types. Inline the unbox (we're building a raw Instr[], not
      // via fctx, so we can't call coerceType): f64 ← __unbox_number, i32-boolean
      // ← __unbox_boolean, i32 ← __unbox_number + trunc, ref ← any.convert_extern
      // + guarded cast. The unbox helpers are registered at reserve time.
      for (let a = 0; a < arity; a++) {
        const want = entry.paramTypes[a] ?? { kind: "externref" };
        callAndCoerce.push({ op: "local.get", index: 1 + a } as Instr);
        if (want.kind === "f64") {
          if (unboxNumIdx !== undefined) callAndCoerce.push({ op: "call", funcIdx: unboxNumIdx } as Instr);
          else callAndCoerce.push({ op: "drop" } as Instr, { op: "f64.const", value: 0 } as Instr);
        } else if (want.kind === "i32") {
          if ((want as { boolean?: true }).boolean && unboxBoolIdx !== undefined) {
            callAndCoerce.push({ op: "call", funcIdx: unboxBoolIdx } as Instr);
          } else if (unboxNumIdx !== undefined) {
            callAndCoerce.push({ op: "call", funcIdx: unboxNumIdx } as Instr);
            callAndCoerce.push({ op: "i32.trunc_sat_f64_s" } as Instr);
          } else {
            callAndCoerce.push({ op: "drop" } as Instr, { op: "i32.const", value: 0 } as Instr);
          }
        } else if (want.kind === "ref" || want.kind === "ref_null") {
          // externref → GC ref: any.convert_extern then guarded ref.cast.
          callAndCoerce.push({ op: "any.convert_extern" } as Instr);
          callAndCoerce.push({ op: "ref.cast", typeIdx: (want as { typeIdx: number }).typeIdx } as Instr);
        }
        // externref param: arg is already externref — no coercion.
      }
      callAndCoerce.push({ op: "call", funcIdx: entry.funcIdx } as Instr);
      // Box-coerce the result back to externref.
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
        { op: "local.get", index: anyLocalIdx } as Instr,
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
      { op: "local.set", index: anyLocalIdx } as Instr,
      ...current,
    ];

    const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    // The open-$Object fallback for arity>0 needs an extra arg-vec local.
    if (arity > 0 && objVecNewIdx !== undefined && objVecPushIdx !== undefined) {
      locals.push({ name: "__argvec", type: { kind: "externref" } });
    }
    dispFn.locals = locals;
    dispFn.body = body;
    void (dispFn as WasmFunction);
  }
}
