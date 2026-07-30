// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Receiver-correct direct `.call` for stable named function declarations.
 *
 * A named FunctionDeclaration is emitted as a plain Wasm function. Its own
 * `this` reads the ambient `__current_this` slot, but the legacy
 * `fn.call(thisArg, ...args)` path evaluated and discarded `thisArg` before
 * calling that exact function. This module reserves one exact-target
 * trampoline whose ABI is `(externref thisArg, ...targetParams) ->
 * targetResults`.
 *
 * The live-receiver arm saves/installs/restores `__current_this`. Restoration
 * is exception-safe: catch_all restores the prior receiver and rethrows the
 * original exception. A null receiver uses the pre-existing unbound exact call
 * instead, so this narrow fast path does not redefine the legacy nullish case.
 */
import { ts } from "../ts-api.js";
import type { FuncHandle, Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { bodyReferencesOwnThis } from "./helpers/body-references-own-this.js";
import { addFuncType } from "./registry/types.js";
import { ensureCurrentThisGlobal } from "./statements/nested-declarations.js";

interface NamedThisCallTarget {
  readonly trampolineFuncIdx: FuncHandle;
}

interface CachedTrampoline {
  readonly funcIdx: FuncHandle;
  readonly func: WasmFunction;
}

const trampolineCache = new WeakMap<CodegenContext, WeakMap<WasmFunction, CachedTrampoline>>();

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function checkerProvesNonNullish(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.length > 0 && type.types.every(checkerProvesNonNullish);
  const refused =
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.Never |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void;
  return (type.flags & refused) === 0;
}

function receiverIsAdmitted(ctx: CodegenContext, fctx: FunctionContext, receiver: ts.Expression): boolean {
  const inner = unwrap(receiver);
  // Acorn's exact wrappers use `finishNodeAt.call(this, ...)`. A body whose
  // own `this` is live reads the receiver installed by the enclosing method
  // dispatch. The trampoline still runtime-splits a null value to the legacy
  // unbound call, so a detached/nullish reach does not enter the fast arm.
  if (inner.kind === ts.SyntaxKind.ThisKeyword) return fctx.readsCurrentThis === true;
  return checkerProvesNonNullish(ctx.checker.getTypeAtLocation(inner));
}

function resolveDeclaration(ctx: CodegenContext, callee: ts.Identifier): ts.FunctionDeclaration | undefined {
  const symbol = ctx.checker.getSymbolAtLocation(callee);
  if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) !== 0) return undefined;
  const bodies = (symbol.declarations ?? []).filter(
    (decl): decl is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(decl) &&
      decl.body !== undefined &&
      decl.name?.text === callee.text &&
      decl.asteriskToken === undefined &&
      !decl.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword),
  );
  const declaration = bodies.length === 1 ? bodies[0] : undefined;
  // This slice only has an exact allocator identity for unique source-file
  // declarations. Nested declarations can shadow a top-level function with
  // the same funcMap key; name equality is not declaration identity.
  if (!declaration || declaration.parent !== declaration.getSourceFile()) return undefined;
  return declaration;
}

function declarationOwnsHandle(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  targetFuncIdx: FuncHandle,
): boolean {
  const registry = ctx.programAbiSourceCallables;
  const identity = registry?.identityContext;
  const unitId = identity?.unitIdByDeclaration.get(declaration);
  return (
    unitId !== undefined &&
    identity?.declarationByUnitId.get(unitId) === declaration &&
    registry?.handleForUnit(unitId) === targetFuncIdx
  );
}

function callTarget(targetFuncIdx: FuncHandle, paramCount: number): Instr[] {
  const body: Instr[] = [];
  for (let i = 0; i < paramCount; i++) body.push({ op: "local.get", index: i + 1 });
  body.push({ op: "call", funcIdx: targetFuncIdx });
  return body;
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, "_");
}

function ensureNamedThisCallTrampoline(
  ctx: CodegenContext,
  targetName: string,
  targetFuncIdx: FuncHandle,
  targetFunc: WasmFunction,
  params: readonly ValType[],
  results: readonly ValType[],
): FuncHandle {
  let byTarget = trampolineCache.get(ctx);
  if (!byTarget) {
    byTarget = new WeakMap();
    trampolineCache.set(ctx, byTarget);
  }
  const cached = byTarget.get(targetFunc);
  // Speculative compilation can roll module state back while the CodegenContext
  // remains alive. Accept a cache hit only while it still owns the exact
  // published function object at that stable handle.
  if (cached && definedFuncAt(ctx, cached.funcIdx) === cached.func) return cached.funcIdx;

  if (definedFuncAt(ctx, targetFuncIdx) !== targetFunc) {
    throw new Error(`named-this trampoline target changed before reserving ${targetName}`);
  }
  const targetOrdinal = ctx.mod.functions.indexOf(targetFunc);
  const helperName = `__named_this_call_${safeName(targetName)}_${targetOrdinal}`;
  const currentThisGlobalIdx = ensureCurrentThisGlobal(ctx);
  const trampolineParams: ValType[] = [{ kind: "externref" }, ...params];
  const typeIdx = addFuncType(ctx, trampolineParams, [...results], `$${helperName}_type`);
  const trampolineFuncIdx = mintDefinedFunc(ctx);
  const prevThisLocal = trampolineParams.length;
  const resultType = results[0];
  const resultLocal = resultType === undefined ? -1 : prevThisLocal + 1;
  const exactCall = callTarget(targetFuncIdx, params.length);

  const liveCall: Instr[] = [
    { op: "global.get", index: currentThisGlobalIdx },
    { op: "local.set", index: prevThisLocal },
    { op: "local.get", index: 0 },
    { op: "global.set", index: currentThisGlobalIdx },
    {
      op: "try",
      blockType: resultType === undefined ? { kind: "empty" } : { kind: "val", type: resultType },
      body: exactCall,
      catches: [],
      catchAll: [
        { op: "local.get", index: prevThisLocal },
        { op: "global.set", index: currentThisGlobalIdx },
        { op: "rethrow", depth: 0 },
      ],
    },
    ...(resultLocal < 0 ? [] : ([{ op: "local.set", index: resultLocal }] satisfies Instr[])),
    { op: "local.get", index: prevThisLocal },
    { op: "global.set", index: currentThisGlobalIdx },
    ...(resultLocal < 0 ? [] : ([{ op: "local.get", index: resultLocal }] satisfies Instr[])),
  ];

  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: resultType === undefined ? { kind: "empty" } : { kind: "val", type: resultType },
      then: callTarget(targetFuncIdx, params.length),
      else: liveCall,
    },
  ];
  const trampolineFunc: WasmFunction = {
    name: helperName,
    typeIdx,
    locals: [
      { name: "__previous_this", type: { kind: "externref" } },
      ...(resultType === undefined ? [] : [{ name: "__result", type: resultType }]),
    ],
    body,
    exported: false,
  };
  pushDefinedFunc(ctx, trampolineFuncIdx, trampolineFunc);
  byTarget.set(targetFunc, { funcIdx: trampolineFuncIdx, func: trampolineFunc });
  return trampolineFuncIdx;
}

/**
 * Resolve and reserve the narrow named `.call` target, or return undefined so
 * the existing generic lowering remains authoritative.
 */
export function resolveNamedThisCallTarget(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callee: ts.Identifier,
  targetFuncIdx: FuncHandle,
  receiver: ts.Expression,
  userArguments: readonly ts.Expression[],
): NamedThisCallTarget | undefined {
  const declaration = resolveDeclaration(ctx, callee);
  if (
    !declaration?.body ||
    ctx.liveFuncBindingGlobals?.has(callee.text) === true ||
    !declarationOwnsHandle(ctx, declaration, targetFuncIdx) ||
    declaration.parameters.some((parameter) => parameter.dotDotDotToken !== undefined) ||
    userArguments.length !== declaration.parameters.length ||
    userArguments.some((argument) => ts.isSpreadElement(argument)) ||
    (declaration.parameters[0] &&
      ts.isIdentifier(declaration.parameters[0].name) &&
      declaration.parameters[0].name.text === "this") ||
    !bodyReferencesOwnThis(declaration.body) ||
    !receiverIsAdmitted(ctx, fctx, receiver)
  ) {
    return undefined;
  }

  const targetFunc = definedFuncAt(ctx, targetFuncIdx);
  if (!targetFunc || targetFunc.name !== callee.text) return undefined;
  const signature = ctx.mod.types[targetFunc.typeIdx];
  if (
    signature?.kind !== "func" ||
    signature.params.length !== declaration.parameters.length ||
    signature.results.length > 1
  ) {
    return undefined;
  }
  const trampolineFuncIdx = ensureNamedThisCallTrampoline(
    ctx,
    callee.text,
    targetFuncIdx,
    targetFunc,
    signature.params,
    signature.results,
  );
  return { trampolineFuncIdx };
}
