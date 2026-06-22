// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1917 Step 1 — the single JS-semantic coercion engine (ToString first).
 *
 * Background: the §7.1.17 ToString matrix was hand-rolled across the WasmGC
 * backend — the host `+`-concat operand coercion, the host template span loop,
 * the standalone/native `+`-concat operand, the native template span loop, and
 * the `String(x)` lowering each re-implemented the same value→string cascade.
 * A fix to one copy was structurally invisible to the others (the June-2026
 * bug corpus: #2005/#2006/#1998/#2074 — all fixed per-copy, but the *next*
 * divergence had nowhere to be caught). This module is the §5 single home those
 * sites delegate to; the #2108 drift gate ratchets the per-file vocabulary
 * counts down as each site migrates. See
 * plan/log/analysis-2026-06/03-coercion-engine-spec.md and the Implementation
 * Plan in plan/issues/1917-single-coercion-engine.md.
 *
 * Scope of THIS module right now: `emitToString` for the **expression-based**
 * ToString sites (an operand already on the value stack, classified from its
 * compiled `ValType` + static TS type). It is a faithful, behaviour-neutral
 * consolidation of those copies — each caller keeps its exact hint, output
 * type, and dynamic tail; the engine just owns the one cascade they shared.
 *
 * Deliberately NOT in this module yet (later #1917 increments):
 *   - the array-`join` `elemToStr` builder (operates on a raw array *slot*, not
 *     a compiled expression, and is `$Hole`-aware) — folds in only once
 *     `emitToString` grows a slot-source variant;
 *   - `emitToNumber` / `emitToBoolean` / `emitToPrimitive` / equality (Steps
 *     2-5).
 *
 * Representation-level (ValType→ValType) conversions still go through Step 0's
 * `coercionPlan` (coercion-plan.ts); this module is the JS-semantic layer on
 * top and never re-hand-rolls a box/unbox row.
 */
import { isBooleanType, isStringType } from "../checker/type-mapper.js";
import type { ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { noJsHost } from "./expressions/helpers.js";
import { nativeStringType } from "./index.js";
import { ensureAnyToStringHelper } from "./native-strings.js";
import {
  compileExpression,
  compileStringLiteral,
  ensureLateImport,
  flushLateImportShifts,
} from "./shared.js";
import { coerceType, tryStructToString } from "./type-coercion.js";

/**
 * The three coercion modes the backend dispatches over. Derived once from the
 * three ad-hoc spellings that exist today so callers stop re-testing them.
 *
 *   - `"standalone"`        — `noJsHost(ctx)` (--target wasi / standalone): pure
 *     Wasm, native `$AnyString` strings, no JS host bridge.
 *   - `"native-strings-host"` — `ctx.nativeStrings` with a JS host present:
 *     native `$AnyString` strings but the host `__extern_*` bridge is available.
 *   - `"js-host"`           — classic externref `wasm:js-string` strings.
 */
export type CoercionMode = "js-host" | "native-strings-host" | "standalone";

export function coercionMode(ctx: CodegenContext): CoercionMode {
  if (noJsHost(ctx)) return "standalone";
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0)
    return "native-strings-host";
  return "js-host";
}

/** True when the active mode represents strings as a native `$AnyString` GC ref. */
function isNativeStringMode(mode: CoercionMode): boolean {
  return mode === "standalone" || mode === "native-strings-host";
}

/**
 * The ToString hint, distinguishing the genuinely-different per-context spec
 * operations the matrices encode for a struct/ref operand:
 *   - `"string"`  — ToString proper (§7.1.17): a template span (`` `${obj}` ``)
 *     and `String(obj)` walk @@toPrimitive("string")/toString.
 *   - `"default"` — the `+` operator's ToPrimitive(default) (valueOf-first,
 *     §7.1.1.1 / #2022): `obj + ""` must use `valueOf`. Only differs from
 *     `"string"` on the struct/ref arm.
 */
export type ToStringHint = "string" | "default";

/**
 * Emit `ToString(operand)` for an operand that has ALREADY been compiled to the
 * top of the value stack with ValType `valType` and static TS type `tsType`.
 *
 * This is the consolidated cascade the expression-based ToString copies shared:
 *   void            → "undefined"
 *   i32 boolean     → "true"/"false"          (emitBoolToString)
 *   f64/i32/i64     → number_toString          (numeric stringify)
 *   externref null  → "null"
 *   externref undef → "undefined"
 *   externref str   → passthrough (already a string)
 *   externref other → __extern_toString / __extern_to_string_default (by hint)
 *   ref/ref_null    → tryStructToString → $__any_to_string  (native)
 *                     coerceType(hint) / __extern_to_string_default (host)
 *
 * Returns the ValType left on the stack (externref in js-host mode, a native
 * `ref $AnyString` in native/standalone mode), or `null` for the void arm where
 * a string literal was pushed (callers treat both as "a string is on the stack").
 *
 * Each caller passes its own `hint` so the per-context policy (template "string"
 * vs `+` "default") is preserved byte-for-byte.
 *
 * NOTE on Symbol: §7.1.17 ToString(Symbol) throws TypeError. The callers guard
 * that BEFORE compiling the operand (`tryThrowOnSymbolStringCoercion`), because
 * the throw must short-circuit operand evaluation; the engine assumes a
 * non-symbol operand on the stack.
 */
export function emitToString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  valType: ValType | null,
  tsType: ts.Type,
  hint: ToStringHint,
): ValType {
  const mode = coercionMode(ctx);
  const native = isNativeStringMode(mode);

  // ── void → "undefined" ──
  if (!valType) {
    pushStringLiteral(ctx, fctx, "undefined");
    return native ? nativeStringType(ctx) : { kind: "externref" };
  }

  // ── string-typed ref passthrough (native modes only — a native string-typed
  //    substitution is already an $AnyString/NativeString ref) ──
  if (
    native &&
    (valType.kind === "ref" || valType.kind === "ref_null") &&
    isStringType(tsType)
  ) {
    return valType;
  }

  // ── i32 boolean → "true"/"false" ──
  // Honour the boolean brand on the ValType (#2016/#2030: i32 predicates carry
  // `boolean: true`) as well as the static TS type.
  if (
    valType.kind === "i32" &&
    (isBooleanType(tsType) || (valType as { boolean?: true }).boolean)
  ) {
    emitBoolToString(ctx, fctx);
    return native ? nativeStringType(ctx) : { kind: "externref" };
  }

  // ── f64 / i32 / i64 → number_toString ──
  if (
    valType.kind === "f64" ||
    valType.kind === "i32" ||
    valType.kind === "i64"
  ) {
    const toStrIdx = ctx.funcMap.get("number_toString");
    if (valType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
    else if (valType.kind === "i64")
      fctx.body.push({ op: "f64.convert_i64_s" });
    if (toStrIdx !== undefined)
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
    if (native) {
      // number_toString returns an externref wrapping a native string; convert
      // it back to a native `ref $AnyString`.
      emitNativeStringRefFromExternref(ctx, fctx);
      return nativeStringType(ctx);
    }
    return { kind: "externref" };
  }

  // ── externref ──
  if (valType.kind === "externref") {
    const isNull = (tsType.flags & ts.TypeFlags.Null) !== 0;
    const isUndef =
      (tsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
    if (isNull) {
      fctx.body.push({ op: "drop" });
      pushStringLiteral(ctx, fctx, "null");
      return native ? nativeStringType(ctx) : { kind: "externref" };
    }
    if (isUndef) {
      fctx.body.push({ op: "drop" });
      pushStringLiteral(ctx, fctx, "undefined");
      return native ? nativeStringType(ctx) : { kind: "externref" };
    }
    if (isStringType(tsType)) {
      // A real string externref — already concat-ready.
      return { kind: "externref" };
    }
    // Dynamic externref (boxed string / any / $Object) → runtime ToString.
    // The default-hint host tail (`__extern_to_string_default`, the #2022
    // valueOf-first `+` policy) applies ONLY in js-host mode. In native modes
    // the dynamic-externref operand always routes through `__extern_toString`
    // (the native `+`-concat and template callers both used the string-hint
    // tail there regardless of `+` vs template), then back to a native ref.
    const importName =
      !native && hint === "default"
        ? "__extern_to_string_default"
        : "__extern_toString";
    const toStrIdx = ensureLateImport(
      ctx,
      importName,
      [{ kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    const finalIdx = ctx.funcMap.get(importName) ?? toStrIdx;
    if (finalIdx !== undefined)
      fctx.body.push({ op: "call", funcIdx: finalIdx });
    if (native) {
      emitNativeStringRefFromExternref(ctx, fctx);
      return nativeStringType(ctx);
    }
    return { kind: "externref" };
  }

  // ── struct / ref / ref_null ──
  if (valType.kind === "ref" || valType.kind === "ref_null") {
    if (native) {
      // #2007 — a compile-time-resolvable object struct with its own
      // @@toPrimitive/toString dispatches that (OrdinaryToPrimitive, hint
      // "string"); otherwise the $__any_to_string tag dispatcher.
      if (tryStructToString(ctx, fctx, valType)) {
        return nativeStringType(ctx);
      }
      const anyToStrIdx = ensureAnyToStringHelper(ctx);
      fctx.body.push({ op: "call", funcIdx: anyToStrIdx });
      return nativeStringType(ctx);
    }
    // js-host: hint decides ToString(string) vs ToPrimitive(default). The `+`
    // path (#2022) converts via the default-hint host helper; templates /
    // String() walk @@toPrimitive("string")/toString through coerceType.
    if (hint === "default") {
      coerceType(ctx, fctx, valType, { kind: "externref" });
      const toStrIdx = ensureLateImport(
        ctx,
        "__extern_to_string_default",
        [{ kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      const finalIdx =
        ctx.funcMap.get("__extern_to_string_default") ?? toStrIdx;
      if (finalIdx !== undefined)
        fctx.body.push({ op: "call", funcIdx: finalIdx });
      return { kind: "externref" };
    }
    coerceType(ctx, fctx, valType, { kind: "externref" }, "string");
    return { kind: "externref" };
  }

  // Unknown kind — leave on stack (should not happen for a string context).
  return valType;
}

/**
 * Compile `operand` then emit `ToString(operand)`. The expression-based
 * convenience wrapper for the `+`-concat / String() callers. Symbol guarding is
 * the caller's responsibility (must short-circuit before operand evaluation).
 */
export function compileAndEmitToString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.Expression,
  tsType: ts.Type,
  hint: ToStringHint,
): ValType {
  const valType = compileExpression(ctx, fctx, operand);
  return emitToString(ctx, fctx, valType, tsType, hint);
}

/**
 * Emit a string literal in the active mode. `compileStringLiteral` is already
 * mode-agnostic (a native `$AnyString` constant in native/standalone mode, an
 * externref string-constant in js-host mode) — exactly what every migrated
 * caller used via its own `pushStringConstant`/`compileStringLiteral` call.
 */
function pushStringLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  value: string,
): void {
  compileStringLiteral(ctx, fctx, value);
}

// emitBoolToString and emitNativeStringRefFromExternref live in string-ops.ts
// and are not exported (string-ops.ts imports this module, so a direct import
// here would be a cycle). They are bound lazily by string-ops.ts at module load.
let boolToStringEmitter:
  | ((ctx: CodegenContext, fctx: FunctionContext) => void)
  | undefined;
let nativeStringRefFromExternrefEmitter:
  | ((ctx: CodegenContext, fctx: FunctionContext) => void)
  | undefined;

export function registerStringHelperEmitters(emitters: {
  boolToString: (ctx: CodegenContext, fctx: FunctionContext) => void;
  nativeStringRefFromExternref: (
    ctx: CodegenContext,
    fctx: FunctionContext,
  ) => void;
}): void {
  boolToStringEmitter = emitters.boolToString;
  nativeStringRefFromExternrefEmitter = emitters.nativeStringRefFromExternref;
}

function emitBoolToString(ctx: CodegenContext, fctx: FunctionContext): void {
  if (!boolToStringEmitter)
    throw new Error("coercion-engine: bool-to-string emitter not registered");
  boolToStringEmitter(ctx, fctx);
}

function emitNativeStringRefFromExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
): void {
  if (!nativeStringRefFromExternrefEmitter) {
    throw new Error(
      "coercion-engine: native-string-ref emitter not registered",
    );
  }
  nativeStringRefFromExternrefEmitter(ctx, fctx);
}
