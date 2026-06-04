// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #682 / #1539 — Standalone RegExp engine (pure WasmGC, no JS host).
 *
 * #682 landed a reduced literal-substring `.test` (a `{pattern, flags}` struct
 * matched via `indexOf>=0`). #1539 Phase 2a replaces that with a real
 * backtracking VM: the pattern is compiled to flat `i32` bytecode at compile
 * time (`regex/{parse,compile}.ts`) and interpreted by `__regex_run`
 * (`native-regex.ts`). The literal-substring case is now the `CHAR`-only
 * degenerate path of the VM. See the issue's "Implementation Notes (sd-1539)".
 *
 * Phase 2a slice: `RegExp` literals / `new RegExp(staticPattern, staticFlags)`
 * and `RegExp.prototype.test`. Dynamic patterns, `.exec`/`.match`/`.search`/
 * `.replace`/`.split`, and fancy features stay narrowed refusals citing the
 * later phase.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { reportError } from "./context/errors.js";
import { allocLocal } from "./context/locals.js";
import { ensureNativeStringHelpers, nativeStringType } from "./native-strings.js";
import { ensureRegexSearch, i32ArrayLiteralInstrs, regexI32ArrayType } from "./native-regex.js";
import {
  parseFlags,
  RegexUnsupportedError,
  RE_FLAG_G,
  RE_FLAG_I,
  RE_FLAG_M,
  RE_FLAG_S,
  RE_FLAG_Y,
} from "./regex/bytecode.js";
import { compilePattern, RepeatTooLargeError } from "./regex/compile.js";
import type { InnerResult } from "./shared.js";
import { compileExpression } from "./shared.js";
import { compileStringLiteral } from "./string-ops.js";

export const STANDALONE_REGEXP_ABI_VERSION = 1;

export const STANDALONE_REGEXP_ENGINE_KIND = "quickjs-libregexp" as const;
export const STANDALONE_REGEXP_SUBSET_ENGINE_KIND = "native-literal-substring" as const;

export type StandaloneRegExpEngineKind =
  | typeof STANDALONE_REGEXP_ENGINE_KIND
  | typeof STANDALONE_REGEXP_SUBSET_ENGINE_KIND;

export interface StandaloneRegExpAbiFunction {
  /**
   * Function name expected in the generated module. These are in-module
   * symbols, not `env` JS-host imports.
   */
  name: string;
  params: readonly ValType[];
  results: readonly ValType[];
}

export interface StandaloneRegExpEngineConfig {
  kind: StandaloneRegExpEngineKind;
  abiVersion: typeof STANDALONE_REGEXP_ABI_VERSION;
  functions: typeof STANDALONE_REGEXP_ABI;
}

export interface StandaloneRegExpEngineState {
  standaloneRegExpEngine?: StandaloneRegExpEngineConfig | null;
}

const I32 = { kind: "i32" } as const satisfies ValType;

/**
 * Minimal ABI boundary for the first native engine slice. Lowering code should
 * only query this contract after #1474's refusal gate is opened.
 */
export const STANDALONE_REGEXP_ABI = {
  compile: {
    name: "__re_compile",
    params: [I32, I32, I32],
    results: [I32],
  },
  exec: {
    name: "__re_exec",
    params: [I32, I32, I32, I32],
    results: [I32],
  },
  free: {
    name: "__re_free",
    params: [I32],
    results: [],
  },
  groupStart: {
    name: "__re_group_start",
    params: [I32, I32],
    results: [I32],
  },
  groupEnd: {
    name: "__re_group_end",
    params: [I32, I32],
    results: [I32],
  },
} as const satisfies Record<string, StandaloneRegExpAbiFunction>;

export function quickJsLibRegexpEngineConfig(): StandaloneRegExpEngineConfig {
  return {
    kind: STANDALONE_REGEXP_ENGINE_KIND,
    abiVersion: STANDALONE_REGEXP_ABI_VERSION,
    functions: STANDALONE_REGEXP_ABI,
  };
}

export function nativeLiteralRegExpEngineConfig(): StandaloneRegExpEngineConfig {
  return {
    kind: STANDALONE_REGEXP_SUBSET_ENGINE_KIND,
    abiVersion: STANDALONE_REGEXP_ABI_VERSION,
    functions: STANDALONE_REGEXP_ABI,
  };
}

export function getStandaloneRegExpEngine(state: StandaloneRegExpEngineState): StandaloneRegExpEngineConfig | null {
  return state.standaloneRegExpEngine ?? null;
}

export function hasStandaloneRegExpEngine(state: StandaloneRegExpEngineState): boolean {
  return getStandaloneRegExpEngine(state) !== null;
}

const STANDALONE_REGEXP_STRUCT_NAME = "__StandaloneRegExp";
function reportStandaloneRegExpUnsupported(ctx: CodegenContext, node: ts.Node, detail: string): void {
  reportError(
    ctx,
    node,
    `Codegen error: standalone RegExp engine does not support ${detail} (#1539 Phase 2a). ` +
      "Use a supported pattern/flag set, or recompile without --target standalone.",
  );
}

function stripStaticWrapper(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = (
      expr as
        | ts.ParenthesizedExpression
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.SatisfiesExpression
        | ts.NonNullExpression
    ).expression;
  }
  return expr;
}

function isStaticStandaloneRegExpCreation(ctx: CodegenContext, expr: ts.Expression): boolean {
  const unwrapped = stripStaticWrapper(expr);
  if (unwrapped.kind === ts.SyntaxKind.RegularExpressionLiteral) return true;
  if (ts.isNewExpression(unwrapped)) {
    const callee = stripStaticWrapper(unwrapped.expression);
    return ts.isIdentifier(callee) && isGlobalRegExpIdentifier(ctx, callee);
  }
  if (ts.isCallExpression(unwrapped) && !unwrapped.questionDotToken) {
    const callee = stripStaticWrapper(unwrapped.expression);
    return ts.isIdentifier(callee) && isGlobalRegExpIdentifier(ctx, callee);
  }
  return false;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.AmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarEqualsToken ||
    kind === ts.SyntaxKind.CaretEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

function isSameSymbolIdentifier(ctx: CodegenContext, expr: ts.Expression, sym: ts.Symbol): boolean {
  const unwrapped = stripStaticWrapper(expr);
  return ts.isIdentifier(unwrapped) && ctx.checker.getSymbolAtLocation(unwrapped) === sym;
}

function assignmentTargetContainsSymbol(ctx: CodegenContext, target: ts.Expression, sym: ts.Symbol): boolean {
  const unwrapped = stripStaticWrapper(target);
  if (ts.isIdentifier(unwrapped)) return ctx.checker.getSymbolAtLocation(unwrapped) === sym;
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements.some((element) => {
      if (ts.isOmittedExpression(element)) return false;
      if (ts.isSpreadElement(element)) return assignmentTargetContainsSymbol(ctx, element.expression, sym);
      return assignmentTargetContainsSymbol(ctx, element, sym);
    });
  }
  if (ts.isObjectLiteralExpression(unwrapped)) {
    return unwrapped.properties.some((prop) => {
      if (ts.isShorthandPropertyAssignment(prop)) return ctx.checker.getSymbolAtLocation(prop.name) === sym;
      if (ts.isPropertyAssignment(prop)) return assignmentTargetContainsSymbol(ctx, prop.initializer, sym);
      if (ts.isSpreadAssignment(prop)) return assignmentTargetContainsSymbol(ctx, prop.expression, sym);
      return false;
    });
  }
  return false;
}

function bindingHasWrites(ctx: CodegenContext, decl: ts.VariableDeclaration, sym: ts.Symbol): boolean {
  let hasWrite = false;
  const visit = (node: ts.Node): void => {
    if (hasWrite) return;

    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      assignmentTargetContainsSymbol(ctx, node.left, sym)
    ) {
      hasWrite = true;
      return;
    }

    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      isSameSymbolIdentifier(ctx, node.operand, sym)
    ) {
      hasWrite = true;
      return;
    }

    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      assignmentTargetContainsSymbol(ctx, node.initializer, sym)
    ) {
      hasWrite = true;
      return;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(decl.getSourceFile(), visit);
  return hasWrite;
}

function isTrustedBackendCreatedRegExpBinding(
  ctx: CodegenContext,
  decl: ts.VariableDeclaration,
  sym: ts.Symbol,
): boolean {
  if (!decl.initializer || !isStaticStandaloneRegExpCreation(ctx, decl.initializer)) return false;
  if (!ts.isVariableDeclarationList(decl.parent)) return false;
  if ((decl.parent.flags & ts.NodeFlags.Const) !== 0) return true;
  return !bindingHasWrites(ctx, decl, sym);
}

function isKnownBackendCreatedRegExpReceiver(ctx: CodegenContext, expr: ts.Expression): boolean {
  const unwrapped = stripStaticWrapper(expr);
  if (isStaticStandaloneRegExpCreation(ctx, unwrapped)) return true;
  if (!ts.isIdentifier(unwrapped)) return false;

  const sym = ctx.checker.getSymbolAtLocation(unwrapped);
  if (!sym) return false;
  const decls = sym?.getDeclarations() ?? [];
  return decls.some((decl) => ts.isVariableDeclaration(decl) && isTrustedBackendCreatedRegExpBinding(ctx, decl, sym));
}

export function isGlobalRegExpIdentifier(ctx: CodegenContext, ident: ts.Identifier): boolean {
  if (ident.text !== "RegExp") return false;
  const sym = ctx.checker.getSymbolAtLocation(ident);
  return isDeclarationFileOnlySymbol(sym);
}

function isDeclarationFileOnlySymbol(sym: ts.Symbol | undefined): boolean {
  if (!sym) return true;
  const decls = sym.getDeclarations();
  if (!decls || decls.length === 0) return true;
  return decls.every((decl) => decl.getSourceFile().isDeclarationFile);
}

export function isGlobalRegExpType(type: ts.Type): boolean {
  const sym = type.getSymbol();
  return sym?.getName() === "RegExp" && isDeclarationFileOnlySymbol(sym);
}

function staticStringValue(ctx: CodegenContext, expr: ts.Expression): string | null | undefined {
  const unwrapped = stripStaticWrapper(expr);
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text;
  }
  if (ts.isIdentifier(unwrapped) && unwrapped.text === "undefined") {
    const type = ctx.checker.getTypeAtLocation(unwrapped);
    if ((type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) {
      return undefined;
    }
  }
  return null;
}

/**
 * The `$NativeRegExp` struct (#1539). Holds the flags bitfield, the
 * capture-group count, the compiled bytecode program, the class table, and the
 * source pattern string. Field order is load-bearing — codegen reads by
 * `fieldIdx`.
 *
 * NOTE: field[1] must NOT be a ref-to-array. `getArrTypeIdxFromVec` (in
 * registry/types.ts) is a *structural* heuristic that classifies any struct
 * whose field[1] is a ref-to-array as a "vec struct", which makes
 * `coerceType` ref→externref attach `__make_iterable` (a JS host import). With
 * the array fields at slots 0/1 that misfires and breaks standalone purity
 * (#682's struct dodged this by having `flags:i32` at field[1]); putting the
 * i32 scalars first keeps the struct off that heuristic.
 */
const RE_FIELD_FLAGS = 0;
const RE_FIELD_NGROUPS = 1;
const RE_FIELD_PROG = 2;
const RE_FIELD_CLASS_TABLE = 3;
const RE_FIELD_SOURCE = 4;

function ensureStandaloneRegExpStruct(ctx: CodegenContext): number {
  const existing = ctx.structMap.get(STANDALONE_REGEXP_STRUCT_NAME);
  if (existing !== undefined) return existing;

  const i32ArrIdx = regexI32ArrayType(ctx);
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32ArrIdx };
  const typeIdx = ctx.mod.types.length;
  const fields = [
    { name: "flags", type: { kind: "i32" } as ValType, mutable: false },
    { name: "nGroups", type: { kind: "i32" } as ValType, mutable: false },
    { name: "prog", type: i32ArrRef, mutable: false },
    { name: "classTable", type: i32ArrRef, mutable: false },
    { name: "source", type: nativeStringType(ctx), mutable: false },
  ];
  ctx.mod.types.push({
    kind: "struct",
    name: STANDALONE_REGEXP_STRUCT_NAME,
    fields,
  });
  ctx.structMap.set(STANDALONE_REGEXP_STRUCT_NAME, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, STANDALONE_REGEXP_STRUCT_NAME);
  ctx.structFields.set(STANDALONE_REGEXP_STRUCT_NAME, fields);
  return typeIdx;
}

/**
 * Compile a static pattern+flags to bytecode and emit a `$NativeRegExp` struct
 * on the stack. Out-of-subset patterns / flags surface as a clean
 * #1539-phased compile error (the narrowed refusal).
 */
function emitStandaloneRegExpStruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: string,
  flags: string,
  node: ts.Node,
): ValType | null {
  let flagBits: number;
  try {
    flagBits = parseFlags(flags);
  } catch (e) {
    reportStandaloneRegExpUnsupported(ctx, node, describeRegexError(e, `flags ${JSON.stringify(flags)}`));
    return null;
  }
  // Supported flags: g (global), i (case-insensitive, ASCII fold), y (sticky),
  // m (multiline — `^`/`$` at line boundaries, #1539 Phase 2c), and s (dotAll —
  // `.` matches line terminators, #1539 Phase 2c). The unicode `u`/`v`
  // (code-point semantics) and indices `d` flags remain deferred (Phase 2d).
  const SUPPORTED_FLAGS = RE_FLAG_G | RE_FLAG_I | RE_FLAG_Y | RE_FLAG_M | RE_FLAG_S;
  const refusedFlags = flagBits & ~SUPPORTED_FLAGS;
  if (refusedFlags !== 0) {
    reportStandaloneRegExpUnsupported(ctx, node, `flags ${JSON.stringify(flags)} (u/v/d are #1539 Phase 2d)`);
    return null;
  }

  let compiled;
  try {
    compiled = compilePattern(pattern, flagBits);
  } catch (e) {
    if (e instanceof RegexUnsupportedError || e instanceof RepeatTooLargeError) {
      reportStandaloneRegExpUnsupported(ctx, node, e.message);
      return null;
    }
    throw e;
  }

  const typeIdx = ensureStandaloneRegExpStruct(ctx);
  // field 0: flags
  fctx.body.push({ op: "i32.const", value: compiled.flags });
  // field 1: nGroups
  fctx.body.push({ op: "i32.const", value: compiled.nGroups });
  // field 2: prog (ref array<i32>)
  for (const instr of i32ArrayLiteralInstrs(ctx, compiled.prog)) fctx.body.push(instr);
  // field 3: classTable (ref array<i32>)
  for (const instr of i32ArrayLiteralInstrs(ctx, compiled.classTable)) fctx.body.push(instr);
  // field 4: source string
  const srcType = compileStringLiteral(ctx, fctx, pattern, node);
  if (!srcType) return null;
  fctx.body.push({ op: "struct.new", typeIdx });
  return { kind: "ref", typeIdx };
}

/** Extract a readable detail from a thrown regex error for diagnostics. */
function describeRegexError(e: unknown, fallback: string): string {
  if (e instanceof RegexUnsupportedError || e instanceof RepeatTooLargeError) return e.message;
  if (e instanceof Error) return e.message;
  return fallback;
}

function compileStandaloneRegExpPattern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: string,
  flags: string,
  node: ts.Node,
): ValType | null {
  if (!hasStandaloneRegExpEngine(ctx)) {
    reportStandaloneRegExpUnsupported(ctx, node, "RegExp without an enabled standalone engine");
    return null;
  }
  return emitStandaloneRegExpStruct(ctx, fctx, pattern, flags, node);
}

export function compileStandaloneRegExpLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: string,
  flags: string,
  node: ts.Node,
): ValType | null {
  return compileStandaloneRegExpPattern(ctx, fctx, pattern, flags, node);
}

export function compileStandaloneRegExpConstructor(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  node: ts.Node,
): ValType | null {
  const patternArg = args[0];
  const flagsArg = args[1];

  const pattern = patternArg === undefined ? "" : staticStringValue(ctx, patternArg);
  if (pattern === null) {
    reportStandaloneRegExpUnsupported(ctx, patternArg, "dynamic constructor patterns");
    return null;
  }

  const flags = flagsArg === undefined ? "" : staticStringValue(ctx, flagsArg);
  if (flags === null) {
    reportStandaloneRegExpUnsupported(ctx, flagsArg, "dynamic constructor flags");
    return null;
  }

  return compileStandaloneRegExpPattern(ctx, fctx, pattern ?? "", flags ?? "", node);
}

function isStandaloneRegExpValue(
  ctx: CodegenContext,
  valueType: ValType | null,
): valueType is ValType & { typeIdx: number } {
  if (!valueType || (valueType.kind !== "ref" && valueType.kind !== "ref_null")) return false;
  return valueType.typeIdx === ctx.structMap.get(STANDALONE_REGEXP_STRUCT_NAME);
}

/**
 * Result of {@link emitRegexSearchCall}: locals holding the regex struct, the
 * capture-slots array, and the struct type index used to read its fields.
 */
interface RegexSearchEmission {
  /** Local holding the (non-null) `$NativeRegExp` struct ref. */
  regexpLocal: number;
  /** Local holding the populated caps array (length `2 * nGroups`). */
  capsLocal: number;
  /** The `$NativeRegExp` struct type index (== `ctx.structMap` entry). */
  structTypeIdx: number;
}

/**
 * Lower a `$NativeRegExp` receiver expression onto the stack and into a local.
 *
 * Compiles `regexpExpr`, narrowing an externref (backend-created RegExp value)
 * back to the concrete `$NativeRegExp` struct, then stores it in a fresh local.
 * Returns the local index and struct type index, or `null` after reporting a
 * narrowed refusal when the value was not created by this backend.
 */
function loadStandaloneRegExpStruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  regexpExpr: ts.Expression,
): { regexpLocal: number; structTypeIdx: number } | null {
  const regexpType = compileExpression(ctx, fctx, regexpExpr);
  let storedRegexpType = regexpType;
  if (regexpType?.kind === "externref") {
    if (!isKnownBackendCreatedRegExpReceiver(ctx, regexpExpr)) {
      reportStandaloneRegExpUnsupported(ctx, regexpExpr, "RegExp values not created by this standalone backend");
      return null;
    }
    const typeIdx = ensureStandaloneRegExpStruct(ctx);
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx } as Instr);
    storedRegexpType = { kind: "ref", typeIdx };
  }
  if (!isStandaloneRegExpValue(ctx, storedRegexpType)) {
    reportStandaloneRegExpUnsupported(ctx, regexpExpr, "RegExp values not created by this standalone backend");
    return null;
  }

  const reStructType: ValType = { kind: "ref", typeIdx: storedRegexpType.typeIdx };
  const regexpLocal = allocLocal(fctx, `__re_${fctx.locals.length}`, reStructType);
  if (storedRegexpType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({ op: "local.set", index: regexpLocal });
  return { regexpLocal, structTypeIdx: storedRegexpType.typeIdx };
}

/**
 * Emit the shared `__regex_search(...)` call sequence used by `.test`,
 * `String.prototype.search`, and (later) the capture-array methods.
 *
 * `regexpExpr` is the `$NativeRegExp` source; `inputExpr` is the subject string.
 * The search always starts at index 0 (`search`/`test` ignore `lastIndex` for
 * the non-global/non-sticky case; sticky-at-0 is honored). On return the i32
 * match flag (1/0) is left on the stack and the populated caps array is
 * available via the returned `capsLocal`. Returns `null` after reporting a
 * narrowed refusal if the regex value was not backend-created.
 */
function emitRegexSearchCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  regexpExpr: ts.Expression,
  inputExpr: ts.Expression,
): RegexSearchEmission | null {
  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  if (flattenIdx === undefined) {
    reportError(ctx, regexpExpr, "Codegen error: standalone RegExp backend missing native string helpers (#682).");
    return null;
  }
  const searchIdx = ensureRegexSearch(ctx);
  const i32Arr = regexI32ArrayType(ctx);
  const strTypeIdx = ctx.nativeStrTypeIdx;

  // --- the compiled $NativeRegExp struct ---
  const loaded = loadStandaloneRegExpStruct(ctx, fctx, regexpExpr);
  if (loaded === null) return null;
  const { regexpLocal, structTypeIdx } = loaded;

  // --- input: flatten the subject string ---
  const inputType = compileExpression(ctx, fctx, inputExpr, nativeStringType(ctx));
  if (inputType?.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({ op: "call", funcIdx: flattenIdx });
  const inputLocal = allocLocal(fctx, `__re_input_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: strTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: inputLocal });

  // caps = array.new_default(2 * nGroups)
  const capsLocal = allocLocal(fctx, `__re_caps_${fctx.locals.length}`, { kind: "ref", typeIdx: i32Arr });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_NGROUPS });
  fctx.body.push({ op: "i32.const", value: 2 });
  fctx.body.push({ op: "i32.mul" });
  fctx.body.push({ op: "array.new_default", typeIdx: i32Arr } as Instr);
  fctx.body.push({ op: "local.set", index: capsLocal });

  // sticky = (flags & RE_FLAG_Y) != 0
  const stickyLocal = allocLocal(fctx, `__re_sticky_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_FLAGS });
  fctx.body.push({ op: "i32.const", value: RE_FLAG_Y });
  fctx.body.push({ op: "i32.and" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.ne" });
  fctx.body.push({ op: "local.set", index: stickyLocal });

  // __regex_search(prog, classTable, 2*nGroups, inData, inOff, inLen, 0, sticky, caps)
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_PROG });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_CLASS_TABLE });
  // nSlots = 2 * nGroups
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_NGROUPS });
  fctx.body.push({ op: "i32.const", value: 2 });
  fctx.body.push({ op: "i32.mul" });
  // input data / off / len
  fctx.body.push({ op: "local.get", index: inputLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }); // data
  fctx.body.push({ op: "local.get", index: inputLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }); // off
  fctx.body.push({ op: "local.get", index: inputLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }); // len
  // startIdx = 0 (test/search ignore lastIndex for non-global/non-sticky;
  // sticky-at-0 is honored). The i32 match flag is left on the stack.
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.get", index: stickyLocal });
  fctx.body.push({ op: "local.get", index: capsLocal });
  fctx.body.push({ op: "call", funcIdx: searchIdx });
  return { regexpLocal, capsLocal, structTypeIdx };
}

/** True when `argExpr`'s static type is string-like (or a String wrapper). */
function isStringLikeArg(ctx: CodegenContext, argExpr: ts.Expression): boolean {
  const argType = ctx.checker.getTypeAtLocation(argExpr);
  return (
    (argType.flags & ts.TypeFlags.StringLike) !== 0 ||
    ((argType.flags & ts.TypeFlags.Object) !== 0 && argType.getSymbol()?.getName() === "String")
  );
}

export function tryCompileStandaloneRegExpTest(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): InnerResult | undefined {
  if (!ctx.standalone || propAccess.name.text !== "test") return undefined;

  const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
  if (!isGlobalRegExpType(receiverType)) return undefined;

  if (!hasStandaloneRegExpEngine(ctx)) {
    reportStandaloneRegExpUnsupported(ctx, expr, "RegExp.prototype.test without an enabled standalone engine");
    return null;
  }
  if (expr.arguments.length !== 1) {
    reportStandaloneRegExpUnsupported(ctx, expr, "RegExp.prototype.test arities other than one string argument");
    return null;
  }

  if (!isStringLikeArg(ctx, expr.arguments[0]!)) {
    reportStandaloneRegExpUnsupported(ctx, expr.arguments[0]!, "RegExp.prototype.test argument coercion");
    return null;
  }

  // __regex_search leaves the i32 match flag (1/0) on the stack — exactly the
  // boolean `.test` returns; the caps array is discarded.
  const emitted = emitRegexSearchCall(ctx, fctx, propAccess.expression, expr.arguments[0]!);
  if (emitted === null) return null;
  return { kind: "i32" };
}

/**
 * `String.prototype.search(regexp)` in standalone mode (#1539 Phase 2b).
 *
 * Per ECMA-262 §22.1.3.13 + §22.2.6.13 (`RegExp.prototype[@@search]`): search
 * sets `lastIndex` to 0, runs `RegExpExec`, then restores `lastIndex`, returning
 * the match's `.index` or `-1` on no match. It is unaffected by the `g` flag and
 * never advances. Here the subject (string) is the receiver and the RegExp is
 * the argument: `"abc".search(/b/)`. The argument must be a backend-created
 * static RegExp; a string argument (which the spec coerces to `new RegExp(arg)`)
 * stays a narrowed refusal in standalone for this slice.
 *
 * Returns f64 (the index, or -1). `caps[0]` holds the whole-match start.
 * Never returns `VOID_RESULT`, so the type stays `ValType | null | undefined`
 * to match the `compileNativeStringMethodCall` caller contract.
 */
export function tryCompileStandaloneStringSearch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): ValType | null | undefined {
  if (!ctx.standalone || propAccess.name.text !== "search") return undefined;

  // Receiver must be string-like; argument must be a static RegExp value.
  if (!isStringLikeArg(ctx, propAccess.expression)) return undefined;
  if (expr.arguments.length !== 1) return undefined;
  const argExpr = expr.arguments[0]!;
  const argType = ctx.checker.getTypeAtLocation(argExpr);
  if (!isGlobalRegExpType(argType) && !isKnownBackendCreatedRegExpReceiver(ctx, argExpr)) {
    // Not a RegExp argument — let the generic string-method path handle the
    // string-coercion case (it refuses in standalone, citing #1474).
    return undefined;
  }

  if (!hasStandaloneRegExpEngine(ctx)) {
    reportStandaloneRegExpUnsupported(ctx, expr, "String.prototype.search without an enabled standalone engine");
    return null;
  }

  const i32Arr = regexI32ArrayType(ctx);

  // emit __regex_search(...) — leaves the i32 match flag on the stack.
  const emitted = emitRegexSearchCall(ctx, fctx, argExpr, propAccess.expression);
  if (emitted === null) return null;

  // matched ? f64(caps[0]) : -1
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "f64" } },
    then: [
      { op: "local.get", index: emitted.capsLocal },
      { op: "i32.const", value: 0 },
      { op: "array.get", typeIdx: i32Arr },
      { op: "f64.convert_i32_s" },
    ],
    else: [{ op: "f64.const", value: -1 }],
  } as Instr);
  return { kind: "f64" };
}
