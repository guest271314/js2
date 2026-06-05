// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#1888 S5b — accessor live get/set) Reserve/fill drivers that let the
 * Wasm-native open-`$Object` property runtime (`object-runtime.ts`) invoke a
 * stored accessor `$get` / `$set` closure with the original receiver bound as
 * `this`, under `--target standalone`.
 *
 * ## Why a reserve/fill driver (the funcIdx-ordering problem)
 * `__extern_get` / `__extern_set` are emitted lazily by `ensureObjectRuntime`
 * during expression compilation, but the closure-method dispatchers they need to
 * call — `__call_fn_method_0` (getter, arity 0) / `__call_fn_method_1` (setter,
 * arity 1) — are emitted in FINALIZE (`emitClosureMethodCallExportN`, index.ts),
 * AFTER the object runtime exists, and only when a closure of that arity exists
 * in the module. So `__extern_get` / `__extern_set` cannot bake a `call
 * <__call_fn_method_N funcIdx>` at the time they are emitted.
 *
 * The fix mirrors the proven #1719 CPR read-drive pattern
 * (`reserveProtoIteratorDriver` / `fillProtoIteratorDriver` in
 * `proto-override.ts`): at object-runtime-emit time we reserve two placeholder
 * funcs (`__call_accessor_get` / `__call_accessor_set`) whose funcIdx is fixed by
 * append position and registered in `funcMap`; the accessor arms emit a plain
 * `call <reserved funcIdx>`. In post-processing, AFTER the closure-method
 * dispatchers are registered, `fillAccessorDrivers` fills the placeholder bodies
 * with a thin wrapper around `__call_fn_method_0` / `__call_fn_method_1`. Routing
 * through `funcMap` (not a raw number) is load-bearing: `shiftLateImportIndices`
 * patches the `funcMap` entry and every emitted `call` by the same delta, so a
 * late-import index shift never desyncs the reservation (#329 / #1899 contract).
 *
 * ## Receiver semantics (§6.2.5.5 Get / §10.1.5.3 OrdinarySetWithOwnDescriptor)
 * The getter/setter is called with `this` = the ORIGINAL receiver (the Reference
 * base), not the proto-chain holder where the accessor was found.
 * `__call_fn_method_N` threads its leading `thisVal` arg as `this` via the
 * `__current_this` module global (#1636-S1) — exactly the receiver semantics the
 * accessor protocol requires. The `__extern_get`/`__extern_set` arms pass their
 * original `obj` param (local 0), NOT the proto-walk cursor, as `recv`.
 */
import type { Instr, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";

/** Reserved name for the accessor-get driver (arity-0 getter wrapper). */
export const CALL_ACCESSOR_GET = "__call_accessor_get";
/** Reserved name for the accessor-set driver (arity-1 setter wrapper). */
export const CALL_ACCESSOR_SET = "__call_accessor_set";

/**
 * Reserve the `__call_accessor_get` driver placeholder and return its funcIdx.
 *
 * Signature: `(externref recv, externref getter) -> externref`.
 * The body is left as a bare `unreachable` and filled by `fillAccessorDrivers`
 * in post-processing. The reservation must run while `ensureObjectRuntime` is
 * emitting `__extern_get`, so the append-position funcIdx is stable before any
 * accessor arm emits its `call`.
 *
 * Idempotent: a second call returns the already-reserved funcIdx.
 */
export function reserveAccessorGetDriver(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(CALL_ACCESSOR_GET);
  if (existing !== undefined) return existing;
  const sigIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$call_accessor_get_type",
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  const placeholder: WasmFunction = {
    name: CALL_ACCESSOR_GET,
    typeIdx: sigIdx,
    locals: [],
    // Placeholder; filled by fillAccessorDrivers in post-processing. A bare
    // `unreachable` keeps the stub valid (externref result) if the fill is ever
    // skipped (no arity-0 closure ⇒ no real getter installed ⇒ driver unused).
    body: [{ op: "unreachable" } as Instr],
    exported: false,
  };
  ctx.mod.functions.push(placeholder);
  ctx.funcMap.set(CALL_ACCESSOR_GET, funcIdx);
  ctx.accessorGetDriverReserved = true;
  return funcIdx;
}

/**
 * Reserve the `__call_accessor_set` driver placeholder and return its funcIdx.
 *
 * Signature: `(externref recv, externref setter, externref value) -> ()`.
 * Setters return no value (the assignment expression result is the RHS, handled
 * at the call site), so the driver result type is empty. Body filled by
 * `fillAccessorDrivers`. Idempotent.
 */
export function reserveAccessorSetDriver(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(CALL_ACCESSOR_SET);
  if (existing !== undefined) return existing;
  const sigIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
    "$call_accessor_set_type",
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  const placeholder: WasmFunction = {
    name: CALL_ACCESSOR_SET,
    typeIdx: sigIdx,
    locals: [],
    // Placeholder; filled by fillAccessorDrivers. Bare `unreachable` is a valid
    // empty-result stub when the fill is skipped (no arity-1 closure in module).
    body: [{ op: "unreachable" } as Instr],
    exported: false,
  };
  ctx.mod.functions.push(placeholder);
  ctx.funcMap.set(CALL_ACCESSOR_SET, funcIdx);
  ctx.accessorSetDriverReserved = true;
  return funcIdx;
}

/**
 * Fill the reserved accessor driver bodies in post-processing, AFTER
 * `emitClosureMethodCallExportN(0)` / `(1)` have registered
 * `__call_fn_method_0` / `__call_fn_method_1` in `funcMap`. Each driver is a
 * thin wrapper that forwards to the matching closure-method dispatcher, reusing
 * the proven re-entrancy-safe `__current_this` install/restore (#1636-S1)
 * instead of duplicating funcref-type dispatch inside the object runtime:
 *
 *   __call_accessor_get(recv, getter) = return __call_fn_method_0(recv, getter)
 *   __call_accessor_set(recv, setter, value) =
 *       __call_fn_method_1(recv, setter, value)  ; drop result
 *
 * No-op when the corresponding driver was never reserved (no accessor arm
 * needs it). When the driver WAS reserved but the matching dispatcher was never
 * emitted (no closure of that arity exists — so no real getter/setter closure
 * could have been installed either), the body is filled with a valid fallback
 * (return-undefined for get; bare return for set) so the module still verifies —
 * mirrors `fillProtoIteratorDriver`'s null fallback.
 */
export function fillAccessorDrivers(ctx: CodegenContext): void {
  if (ctx.accessorGetDriverReserved) {
    const driverIdx = ctx.funcMap.get(CALL_ACCESSOR_GET);
    if (driverIdx !== undefined) {
      const driverFn = ctx.mod.functions[driverIdx - ctx.numImportFuncs];
      if (driverFn) {
        const callMethod0 = ctx.funcMap.get("__call_fn_method_0");
        if (callMethod0 === undefined) {
          // No arity-0 closure dispatcher — the getter driver is unreachable
          // from any live accessor arm in that case (no arity-0 closure ⇒ no
          // getter closure installed), but keep a valid body so the module
          // verifies: return undefined (null externref).
          driverFn.body = [{ op: "ref.null.extern" } as Instr];
        } else {
          driverFn.body = [
            { op: "local.get", index: 0 } as Instr, // recv (bound as `this`)
            { op: "local.get", index: 1 } as Instr, // getter closure
            { op: "call", funcIdx: callMethod0 } as Instr,
            // getter result (externref) stays on the stack as the return value
          ];
        }
      }
    }
  }

  if (ctx.accessorSetDriverReserved) {
    const driverIdx = ctx.funcMap.get(CALL_ACCESSOR_SET);
    if (driverIdx !== undefined) {
      const driverFn = ctx.mod.functions[driverIdx - ctx.numImportFuncs];
      if (driverFn) {
        const callMethod1 = ctx.funcMap.get("__call_fn_method_1");
        if (callMethod1 === undefined) {
          // No arity-1 closure dispatcher — setter driver unreachable; empty
          // body (bare return via implicit fallthrough) verifies for () result.
          driverFn.body = [];
        } else {
          driverFn.body = [
            { op: "local.get", index: 0 } as Instr, // recv (bound as `this`)
            { op: "local.get", index: 1 } as Instr, // setter closure
            { op: "local.get", index: 2 } as Instr, // value argument
            { op: "call", funcIdx: callMethod1 } as Instr,
            // __call_fn_method_1 returns an externref result; the setter's
            // return value is discarded per §10.1.5.3 (Set ignores it).
            { op: "drop" } as Instr,
          ];
        }
      }
    }
  }
}
