// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#1888 S5c) Struct-accessor capturing-closure rework — shared C1 layer.
 *
 * ## Why
 * `Object.defineProperty(o,k,{get(){…}})` / `{ get x(){} }` on `const o:any={}`
 * route to the static-struct accessor path (#1629 S3, object-ops.ts ~958-1171),
 * which compiles `${structName}_get_${prop}` as a BARE `(this) -> result` Wasm
 * function with NO closure-capture environment. A getter/setter body that closes
 * over OUTER scope therefore reads those captures as 0 (sd-1888 root cause). S5c
 * re-represents such accessors as host-free CLOSURES (capturing env via
 * `compileArrowAsClosure`, `this` via `__current_this`), dispatched through the
 * S5b `__call_accessor_get/set` drivers at the read/write sites.
 *
 * ## Representation (arch-s5c spec, signed off by sd-1888)
 * - STORAGE: per-(struct,prop) nullable `(mut externref)` module globals
 *   `$__acc_get_<struct>_<prop>` / `$__acc_set_<struct>_<prop>` holding the boxed
 *   `$Closure` (same shape as S5b's `$PropEntry.$get/$set`). Module globals — NOT
 *   struct slots — so the closed-struct layout / #1472-R2 fast path is untouched.
 * - CAPTURE-THREADING: NOT at the call site. Captures are baked into the
 *   closure's `$self` by `compileArrowAsClosure`; `this` via `__current_this`
 *   (#1636-S1). The dispatched value IS the capture-bearing wrapper — exactly
 *   what fixes the `__call_fn_method_N` mismatch (defect-1).
 * - REGRESSION SCOPE: ONLY the `Object.defineProperty` struct arm + the
 *   object-literal-standalone arm migrate. Class-accessor emission
 *   (#459/#1680/#1681/#1605) stays on the proven bare-fn path — the read/write
 *   sites gate dispatch on `ctx.structAccessorClosure.has(key)`.
 *
 * ## Flag (land dark)
 * `S5C_STRUCT_ACCESSOR_CLOSURE` defaults **false**: C1-C5 land behind it with no
 * behavior change. Flip on once the 4 S5c RED tests pass, the 3 S5b tests stay
 * green, and GC-mode is byte-identical.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileArrowAsClosure } from "./shared.js";

/**
 * (#1888 S5c) Master gate — keep the struct-accessor closure rework DARK until
 * C1-C5 are wired + validated. Flip to `true` in the C5 PR once the S5c RED
 * tests pass and S5b/GC regression guards hold.
 */
export const S5C_STRUCT_ACCESSOR_CLOSURE = false;

/** Module-global name for a struct accessor's getter closure slot. */
export function structAccessorGetGlobalName(structName: string, propName: string): string {
  return `$__acc_get_${structName}_${propName}`;
}

/** Module-global name for a struct accessor's setter closure slot. */
export function structAccessorSetGlobalName(structName: string, propName: string): string {
  return `$__acc_set_${structName}_${propName}`;
}

/**
 * Compile a struct accessor getter/setter as a host-free CLOSURE and leave its
 * externref (capture-bearing `$Closure`, ready to box into a per-(struct,prop)
 * global) on the stack. Returns `false` when the lift could not be performed
 * (caller falls back). Mirrors the standalone branch of object-ops.ts
 * `emitAccessorFn` so the open-`$Object` S5b arm and the struct arm share one
 * lift; only the storage target differs (S5b → `__defineProperty_accessor`
 * arg; S5c struct → `global.set $__acc_get/set_…`).
 *
 * The closure's body captures outer-scope reads into its `$self` struct
 * (compileArrowAsClosure) and observes `this` via `__current_this` at invoke
 * time (#1636-S1) — so the dispatched value carries the env the bare-fn lacked.
 */
export function buildAccessorClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fn: ts.FunctionExpression | ts.ArrowFunction,
): boolean {
  const closureType = compileArrowAsClosure(ctx, fctx, fn);
  if (!closureType) return false;
  // compileArrowAsClosure leaves a closure-struct ref; the closure globals + the
  // S5b __call_accessor_get/set drivers take externref. Convert unless already so.
  if (closureType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" } as Instr);
  }
  return true;
}

/**
 * Reserve (idempotently) the per-(struct,prop) nullable `(mut externref)` module
 * global holding a struct accessor's getter or setter closure, and record it in
 * `ctx.structAccessorClosure[key]`. Returns the global index. Initialised to
 * `ref.null.extern`; the C2 define-site `global.set`s the lifted closure.
 *
 * `kind` selects the get vs set slot. Reusing an already-reserved slot (e.g. a
 * redefine of the same accessor) returns the existing index.
 */
export function ensureStructAccessorGlobal(
  ctx: CodegenContext,
  structName: string,
  propName: string,
  kind: "get" | "set",
): number {
  const key = `${structName}_${propName}`;
  let entry = ctx.structAccessorClosure.get(key);
  if (!entry) {
    entry = {};
    ctx.structAccessorClosure.set(key, entry);
  }
  const existing = kind === "get" ? entry.getGlobal : entry.setGlobal;
  if (existing !== undefined) return existing;

  const name =
    kind === "get"
      ? structAccessorGetGlobalName(structName, propName)
      : structAccessorSetGlobalName(structName, propName);
  // ABSOLUTE global index — `global.get`/`global.set` instruction operands index
  // the imported-globals space first, then defined globals. Mirror the
  // async-scheduler convention (`baseGlobalIdx = ctx.numImportGlobals +
  // ctx.mod.globals.length`, async-scheduler.ts:263). Returning the bare
  // `ctx.mod.globals.length` (relative) would mis-address when any host global
  // is imported (e.g. the string-import base under non-strict modes).
  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name,
    type: { kind: "externref" } as ValType,
    mutable: true,
    init: [{ op: "ref.null.extern" } as Instr],
  });
  if (kind === "get") entry.getGlobal = globalIdx;
  else entry.setGlobal = globalIdx;
  return globalIdx;
}
