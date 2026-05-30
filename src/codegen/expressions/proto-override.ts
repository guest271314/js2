// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#1719 CPR — compiled prototype record) Write-arm: capture
 * `Array.prototype[Symbol.iterator] = fn` / `Array.prototype.values = fn` into
 * `ctx.protoOverrides` so array destructuring / for-of / spread can drive the
 * override at the observation boundary (§7.4.2 GetIterator, §8.5.2
 * IteratorBindingInitialization).
 *
 * The override has no compiled landing spot today (the LHS `Array.prototype` is a
 * builtin with no struct), so the assignment is silently dropped (#1719 root
 * cause). Here we instead lift the RHS closure, root it in a fresh `mut externref`
 * module global so DCE can't drop it (it is only referenced from the table, not
 * the wasm body), and record `{globalIdx}` keyed by proto-owner token (`"Array"`)
 * + well-known member key (`"@@iterator"` / `"values"`). The read-drive sites
 * (`destructuring.ts`, `loops.ts`, spread) `global.get` the closure and call it
 * with the array as `this` via `__call_fn_method_0`.
 *
 * Gated on the S1 brand `ctx.arrayIteratorMaybeOverridden` (set by the
 * `sourceOverridesArrayIterator` pre-scan) so a module without any
 * `Array.prototype` iterator override never enters this path — byte-identical.
 */
import { ts } from "../../ts-api.js";
import type { Instr } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { nextModuleGlobalIdx } from "../registry/imports.js";
import { compileArrowAsClosure, resolveComputedKeyExpression } from "../shared.js";

/** Canonical proto-owner token for `Array.prototype`. */
const ARRAY_PROTO_TOKEN = "Array";

/**
 * Map a `Array.prototype[<key>]` / `Array.prototype.<key>` assignment target to
 * the canonical CPR member key (`"@@iterator"` for `Symbol.iterator`, `"values"`
 * for `.values`), or `undefined` when it is not a recognised iterator override.
 */
function arrayProtoOverrideKey(ctx: CodegenContext, target: ts.Expression): string | undefined {
  // Element access: Array.prototype[Symbol.iterator]
  if (ts.isElementAccessExpression(target)) {
    if (!isArrayPrototype(target.expression)) return undefined;
    const key = resolveComputedKeyExpression(ctx, target.argumentExpression);
    if (key === "@@iterator" || key === "Symbol(Symbol.iterator)") return "@@iterator";
    if (key === "values") return "values";
    return undefined;
  }
  // Property access: Array.prototype.values
  if (ts.isPropertyAccessExpression(target)) {
    if (!isArrayPrototype(target.expression)) return undefined;
    if (target.name.text === "values") return "values";
    return undefined;
  }
  return undefined;
}

/**
 * (#1719 CPR) AST-only predicate (no `ctx`) for the module-init statement filter:
 * true when `target` is `Array.prototype[Symbol.iterator]` / `Array.prototype.values`,
 * so the override assignment is kept in `__module_init` instead of being dropped.
 * Matches the LHS shape recognised by `sourceOverridesArrayIterator`.
 */
export function isArrayProtoIteratorAssignTarget(target: ts.Expression): boolean {
  if (ts.isElementAccessExpression(target)) {
    if (!isArrayPrototype(target.expression)) return false;
    const arg = target.argumentExpression;
    // `Array.prototype[Symbol.iterator]` — Symbol.iterator is a property access
    // `Symbol.iterator`; accept it structurally (the precise key resolves later).
    if (
      ts.isPropertyAccessExpression(arg) &&
      ts.isIdentifier(arg.expression) &&
      arg.expression.text === "Symbol" &&
      arg.name.text === "iterator"
    ) {
      return true;
    }
    // `Array.prototype["values"]`
    if (ts.isStringLiteral(arg) && arg.text === "values") return true;
    return false;
  }
  if (ts.isPropertyAccessExpression(target)) {
    return isArrayPrototype(target.expression) && target.name.text === "values";
  }
  return false;
}

/** True when `e` is exactly `Array.prototype`. */
function isArrayPrototype(e: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(e) &&
    e.name.text === "prototype" &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "Array"
  );
}

/**
 * If `target = value` is an `Array.prototype` iterator override, capture the
 * lifted RHS closure into `ctx.protoOverrides` (rooted in a module global) and
 * return `true` (the caller must NOT fall through to the normal element/property
 * assignment). Returns `false` (no-op) for every other assignment — byte-identical.
 *
 * Leaves the override closure externref on the stack as the assignment's value
 * (an assignment expression evaluates to its RHS).
 */
export function maybeCaptureArrayProtoOverride(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.Expression,
  value: ts.Expression,
): boolean {
  if (!ctx.arrayIteratorMaybeOverridden) return false;
  const memberKey = arrayProtoOverrideKey(ctx, target);
  if (memberKey === undefined) return false;
  // Only a function/arrow RHS is a drivable override (a non-callable value would
  // make GetIterator throw "not a function" — out of scope for the fast path).
  if (!ts.isFunctionExpression(value) && !ts.isArrowFunction(value)) return false;

  // Lift the RHS closure (handles `function*` generators). Leaves the closure
  // value (a ref to the closure struct) on the stack.
  const closureType = compileArrowAsClosure(ctx, fctx, value);
  if (!closureType) return false;

  // Root the closure in a fresh `mut externref` module global so it survives DCE
  // and the read-drive can `global.get` it. Convert the closure ref → externref.
  const globalIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: `__array_proto_${memberKey === "@@iterator" ? "iterator" : memberKey}_override`,
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" } as Instr],
  });
  // Stack: [closure-ref]. Convert to externref (if not already) and tee into the
  // global, leaving the externref on the stack as the assignment value.
  if (closureType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" } as Instr);
  }
  fctx.body.push({ op: "global.set", index: globalIdx } as Instr);
  fctx.body.push({ op: "global.get", index: globalIdx } as Instr);

  // Record into protoOverrides (funcIdx/funcTypeIdx unused by the global-driven
  // path; kept 0/-1 placeholders for the table shape).
  let inner = ctx.protoOverrides.get(ARRAY_PROTO_TOKEN);
  if (!inner) {
    inner = new Map();
    ctx.protoOverrides.set(ARRAY_PROTO_TOKEN, inner);
  }
  inner.set(memberKey, { funcIdx: 0, funcTypeIdx: -1, globalIdx });
  return true;
}

/**
 * Returns the rooted override-closure global index for the Array `@@iterator`
 * override (the CPR drive consults this), or `undefined` when no override was
 * captured. `values` is treated as an alias for `@@iterator` per §23.1.3.36
 * (`Array.prototype.values` IS `Array.prototype[@@iterator]`), so either capture
 * drives array iteration.
 */
export function arrayIteratorOverrideGlobalIdx(ctx: CodegenContext): number | undefined {
  const inner = ctx.protoOverrides.get(ARRAY_PROTO_TOKEN);
  if (!inner) return undefined;
  const entry = inner.get("@@iterator") ?? inner.get("values");
  return entry?.globalIdx;
}
