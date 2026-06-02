// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #682 — Standalone RegExp native-engine ABI scaffold.
 *
 * This module owns the standalone RegExp backend contract. The QuickJS
 * libregexp ABI remains the target for broad ECMAScript parity; the current
 * implementation also exposes a deliberately reduced in-module literal
 * substring engine so basic `.test()` forms can run without a JS host.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { reportError } from "./context/errors.js";
import { allocLocal } from "./context/locals.js";
import { ensureNativeStringHelpers, nativeStringType } from "./native-strings.js";
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
const REGEXP_META_CHARS = new Set(["^", "$", "\\", ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|"]);
const ESCAPABLE_LITERAL_CHARS = new Set(["/", "\\", "^", "$", ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|"]);

type PatternDecodeResult = { ok: true; literal: string } | { ok: false; reason: string };

function reportStandaloneRegExpUnsupported(ctx: CodegenContext, node: ts.Node, detail: string): void {
  reportError(
    ctx,
    node,
    `Codegen error: standalone RegExp literal-substring backend does not support ${detail} (#682/#1474). ` +
      "Use a plain static pattern with no flags, or recompile without --target standalone.",
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

function decodeStandaloneLiteralPattern(pattern: string): PatternDecodeResult {
  let literal = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const escaped = pattern[++i];
      if (escaped === undefined) {
        return { ok: false, reason: "a trailing escape in the pattern" };
      }
      if (ESCAPABLE_LITERAL_CHARS.has(escaped)) {
        literal += escaped;
        continue;
      }
      if (escaped === "n") {
        literal += "\n";
        continue;
      }
      if (escaped === "r") {
        literal += "\r";
        continue;
      }
      if (escaped === "t") {
        literal += "\t";
        continue;
      }
      return { ok: false, reason: `escape \\${escaped}` };
    }
    if (REGEXP_META_CHARS.has(ch)) {
      return { ok: false, reason: `metacharacter ${JSON.stringify(ch)}` };
    }
    literal += ch;
  }
  return { ok: true, literal };
}

function ensureStandaloneRegExpStruct(ctx: CodegenContext): number {
  const existing = ctx.structMap.get(STANDALONE_REGEXP_STRUCT_NAME);
  if (existing !== undefined) return existing;

  const typeIdx = ctx.mod.types.length;
  const fields = [
    { name: "pattern", type: nativeStringType(ctx), mutable: false },
    { name: "flags", type: { kind: "i32" } as ValType, mutable: false },
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

function emitStandaloneRegExpStruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  literalPattern: string,
): ValType | null {
  const typeIdx = ensureStandaloneRegExpStruct(ctx);
  const patternType = compileStringLiteral(ctx, fctx, literalPattern);
  if (!patternType) return null;
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "struct.new", typeIdx });
  return { kind: "ref", typeIdx };
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
  if (flags !== "") {
    reportStandaloneRegExpUnsupported(ctx, node, `flags ${JSON.stringify(flags)}`);
    return null;
  }
  const decoded = decodeStandaloneLiteralPattern(pattern);
  if (!decoded.ok) {
    reportStandaloneRegExpUnsupported(ctx, node, decoded.reason);
    return null;
  }
  return emitStandaloneRegExpStruct(ctx, fctx, decoded.literal);
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

  const argType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
  const argIsString =
    (argType.flags & ts.TypeFlags.StringLike) !== 0 ||
    ((argType.flags & ts.TypeFlags.Object) !== 0 && argType.getSymbol()?.getName() === "String");
  if (!argIsString) {
    reportStandaloneRegExpUnsupported(ctx, expr.arguments[0]!, "RegExp.prototype.test argument coercion");
    return null;
  }

  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf");
  if (flattenIdx === undefined || indexOfIdx === undefined) {
    reportError(ctx, expr, "Codegen error: standalone RegExp backend missing native string helpers (#682).");
    return null;
  }

  const regexpType = compileExpression(ctx, fctx, propAccess.expression);
  let storedRegexpType = regexpType;
  if (regexpType?.kind === "externref") {
    const typeIdx = ensureStandaloneRegExpStruct(ctx);
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx } as Instr);
    storedRegexpType = { kind: "ref", typeIdx };
  }
  if (!isStandaloneRegExpValue(ctx, storedRegexpType)) {
    reportStandaloneRegExpUnsupported(
      ctx,
      propAccess.expression,
      "RegExp values not created by this standalone backend",
    );
    return null;
  }

  const regexpLocal = allocLocal(fctx, `__re_${fctx.locals.length}`, storedRegexpType);
  fctx.body.push({ op: "local.set", index: regexpLocal });

  const inputType = compileExpression(ctx, fctx, expr.arguments[0]!, nativeStringType(ctx));
  if (inputType?.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({ op: "call", funcIdx: flattenIdx });
  const inputLocal = allocLocal(fctx, `__re_input_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ctx.nativeStrTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: inputLocal });

  fctx.body.push({ op: "local.get", index: regexpLocal });
  if (storedRegexpType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({ op: "struct.get", typeIdx: storedRegexpType.typeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "call", funcIdx: flattenIdx });
  const patternLocal = allocLocal(fctx, `__re_pattern_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ctx.nativeStrTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: patternLocal });

  fctx.body.push({ op: "local.get", index: inputLocal });
  fctx.body.push({ op: "local.get", index: patternLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "call", funcIdx: indexOfIdx });
  fctx.body.push({ op: "i32.const", value: -1 });
  fctx.body.push({ op: "i32.gt_s" });
  return { kind: "i32" };
}
