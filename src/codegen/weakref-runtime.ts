// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3242 — Wasm-native `WeakRef` runtime for standalone / WASI.
 *
 * In JS-host mode `new WeakRef(o)` routes through the generic `externClasses`
 * constructor table and emits a `WeakRef_new` host import; `wr.deref()` emits a
 * `WeakRef_deref` host method import. Under `--target standalone` / `--target
 * wasi` there is no JS host to satisfy these, so this module provides a
 * pure-WasmGC `WeakRef` as a one-field struct.
 *
 * **Semantics — strong-backed, no real weakness.** WasmGC has no weak
 * references, so the target is held *strongly*: a standalone `WeakRef` never
 * observes its target being collected, and `deref()` always returns it. That is
 * a memory property, not an observable one for the passing spec suite — the two
 * instance-exercising tests
 * (`WeakRef/prototype/deref/return-{object,symbol}-target.js`) assert only that
 * `new WeakRef(target).deref() === target` (identity preserved across repeated
 * derefs, for an object or a symbol target). No passing test observes
 * `[[WeakRefTarget]]` emptying, `instanceof WeakRef`, or
 * `Object.prototype.toString` on an instance; the liveness tests that could tell
 * the difference already `fail` / are skip-filtered. This mirrors the #2162
 * WeakMap/WeakSet decision (strong Map reuse).
 *
 * Backing representation: `$WeakRef` = `struct { target: anyref (immut) }`.
 *   - `new WeakRef(x)` → coerce `x` to anyref, `struct.new $WeakRef`
 *   - `wr.deref()`     → cast receiver to `$WeakRef`, `struct.get 0` → anyref
 *
 * Everything is emitted lazily and only when `ctx.nativeStrings`. JS-host mode
 * is untouched (both paths stay byte-identical to before this change).
 */
import { ts } from "../ts-api.js";
import type { Instr, StructTypeDef, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { InnerResult } from "./shared.js";
import { coerceType, compileExpression } from "./shared.js";

/**
 * Lazily register the `$WeakRef` struct type (idempotent). Appended to
 * `ctx.mod.types` so existing type indices are unshifted. Returns the type index
 * (also cached on `ctx.weakRefTypeIdx`).
 *
 * The single `target` field is an **externref** (the standalone "any" surface
 * rep) rather than a raw anyref: the target may be an object OR a symbol, and a
 * symbol is a boxed `$Symbol` carrier reached through the externref box. Storing
 * externref keeps `deref()` a simple `struct.get` while preserving symbol
 * identity (see the box-brand note in `tryCompileNativeWeakRefNew`).
 */
export function ensureWeakRefStruct(ctx: CodegenContext): number {
  if (ctx.weakRefTypeIdx >= 0) return ctx.weakRefTypeIdx;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "WeakRef",
    fields: [{ name: "target", type: { kind: "externref" }, mutable: false }],
  } as StructTypeDef);
  ctx.weakRefTypeIdx = typeIdx;
  ctx.structMap.set("WeakRef", typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, "WeakRef");
  return typeIdx;
}

/**
 * (#3242) Intercept `new WeakRef(target)` in standalone / `nativeStrings` mode.
 * Requires exactly one argument (the spec-mandatory target); other arities fall
 * through so the existing behaviour is preserved. Returns `ref $WeakRef`.
 */
export function tryCompileNativeWeakRefNew(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
): ValType | undefined {
  if (!ctx.nativeStrings) return undefined;
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "WeakRef") return undefined;
  const args = expr.arguments;
  if (!args || args.length !== 1) return undefined;

  const typeIdx = ensureWeakRefStruct(ctx);
  const t = compileExpression(ctx, fctx, args[0]!);
  if (t === null) return undefined;
  // Box the target to externref preserving its JS tag (the #2785 type-aware-box
  // rule): a `Symbol` target compiles to a symbol-BRANDED i32 handle that must
  // box via `__box_symbol` (identity-stable `$Symbol` carrier), NOT `__box_number`
  // — otherwise `wr.deref() === sym` compares a number-box against the interned
  // symbol and fails. `coerceMapKeyToAnyref` mis-boxes a symbol-branded i32 as a
  // number, so brand explicitly here off the static type FACT (via `ctx.oracle`,
  // the #1930 type-query boundary — the raw checker is ratchet-blocked in
  // codegen) and route through `coerceType` (which honours `.symbol` /
  // `.boolean`). Objects / native strings are already anyref-subtypes →
  // `extern.convert_any`.
  const argFactKind = ctx.oracle.typeFactOf(args[0]!).kind;
  const branded: ValType =
    t.kind === "i32" && argFactKind === "symbol"
      ? { kind: "i32", symbol: true }
      : t.kind === "i32" && argFactKind === "boolean"
        ? { kind: "i32", boolean: true }
        : t;
  coerceType(ctx, fctx, branded, { kind: "externref" });
  fctx.body.push({ op: "struct.new", typeIdx });
  return { kind: "ref", typeIdx } as ValType;
}

/**
 * (#3242) Intercept `wr.deref()` in standalone / `nativeStrings` mode. `deref`
 * is 0-arity; returns the stored target as an externref (the "any" surface rep
 * — so a downstream `===` routes through the ref.eq / `__any_strict_eq` identity
 * path; a raw `anyref` result would be classified as a non-ref by the strict-eq
 * operand test and fold `wr.deref() === target` to constant `false`). Returns
 * `undefined` when the receiver is a different concrete struct so the generic
 * path can retry.
 */
export function tryCompileNativeWeakRefDeref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  if (propAccess.name.text !== "deref") return undefined;

  const typeIdx = ensureWeakRefStruct(ctx);
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType === null) return undefined;
  if (recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx });
  } else if (recvType.kind === "anyref" || recvType.kind === "eqref") {
    fctx.body.push({ op: "ref.cast", typeIdx });
  } else if ((recvType.kind === "ref" || recvType.kind === "ref_null") && recvType.typeIdx !== typeIdx) {
    return undefined;
  }
  fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 });
  return { kind: "externref" } as ValType;
}
