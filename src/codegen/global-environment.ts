// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Bounded GlobalEnvironmentRecord lowering shared by identifier reads, writes,
 * and deletes (#2726). Host/gc uses the current sandbox global; host-free
 * targets use the existing native `$Object` singleton.
 */
import type { ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { emitNativeGlobalThisObject } from "./array-object-proto.js";
import { popBody, pushBody } from "./context/bodies.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowReferenceError } from "./expressions/helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { isStrictContext } from "./helpers/is-strict-function.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";

export function emitGlobalEnvironmentObject(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  if (ctx.standalone || ctx.wasi) {
    return emitNativeGlobalThisObject(ctx, fctx);
  }

  const getGlobalIdx = ensureLateImport(ctx, "__get_globalThis", [], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (getGlobalIdx === undefined) return null;
  fctx.body.push({ op: "call", funcIdx: getGlobalIdx });
  return { kind: "externref" };
}

export function emitGlobalEnvironmentKey(ctx: CodegenContext, fctx: FunctionContext, name: string): void {
  addStringConstantGlobal(ctx, name);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, name));
}

export function ensureGlobalEnvironmentOperation(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: "__extern_get" | "__extern_set" | "__delete_property" | "__hasOwnProperty",
): number | undefined {
  const externref: ValType = { kind: "externref" };
  const signature =
    name === "__extern_set"
      ? { params: [externref, externref, externref], results: [] }
      : name === "__extern_get"
        ? { params: [externref, externref], results: [externref] }
        : name === "__delete_property" || name === "__hasOwnProperty"
          ? { params: [externref, externref], results: [{ kind: "i32" } satisfies ValType] }
          : { params: [], results: [] };
  const idx = ensureLateImport(ctx, name, signature.params, signature.results);
  flushLateImportShifts(ctx, fctx);
  return idx;
}

/** Read a pre-scanned sloppy implicit global, throwing when it was deleted. */
export function emitImplicitGlobalRead(ctx: CodegenContext, fctx: FunctionContext, name: string): ValType | null {
  if (!emitGlobalEnvironmentObject(ctx, fctx)) return null;
  const objectLocal = allocLocal(fctx, `__implicit_global_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objectLocal });
  const hasOwnIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__hasOwnProperty");
  const getIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_get");
  if (hasOwnIdx === undefined || getIdx === undefined) return null;

  fctx.body.push({ op: "local.get", index: objectLocal });
  emitGlobalEnvironmentKey(ctx, fctx, name);
  fctx.body.push({ op: "call", funcIdx: hasOwnIdx }, { op: "i32.eqz" });
  const saved = pushBody(fctx);
  emitThrowReferenceError(ctx, fctx, `${name} is not defined`);
  const throwBody = fctx.body;
  popBody(fctx, saved);
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwBody, else: [] });

  fctx.body.push({ op: "local.get", index: objectLocal });
  emitGlobalEnvironmentKey(ctx, fctx, name);
  fctx.body.push({ op: "call", funcIdx: getIdx });
  return { kind: "externref" };
}

/** Delete a global-object property; an absent property succeeds. */
export function emitGlobalEnvironmentDelete(ctx: CodegenContext, fctx: FunctionContext, name: string): void {
  if (!emitGlobalEnvironmentObject(ctx, fctx)) {
    fctx.body.push({ op: "i32.const", value: 1 });
    return;
  }
  emitGlobalEnvironmentKey(ctx, fctx, name);
  const deleteIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__delete_property");
  if (deleteIdx === undefined) {
    fctx.body.push({ op: "drop" }, { op: "drop" }, { op: "i32.const", value: 1 });
    return;
  }
  fctx.body.push({ op: "call", funcIdx: deleteIdx });
}

/** Whether a direct module-init member delete targets a script var/function. */
export function isNonConfigurableGlobalObjectDelete(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.Expression,
): boolean {
  if (!ts.isPropertyAccessExpression(operand) || fctx.name !== "__module_init" || ctx.sourceIsModule) return false;
  let receiver: ts.Expression = operand.expression;
  while (
    ts.isParenthesizedExpression(receiver) ||
    ts.isAsExpression(receiver) ||
    ts.isNonNullExpression(receiver) ||
    ts.isTypeAssertionExpression(receiver)
  ) {
    receiver = receiver.expression;
  }
  const isGlobalObject =
    receiver.kind === ts.SyntaxKind.ThisKeyword ||
    (ts.isIdentifier(receiver) && receiver.text === "globalThis" && !ctx.moduleGlobals.has("globalThis"));
  return (
    isGlobalObject &&
    (ctx.globalObjectVarBindings?.has(operand.name.text) || ctx.topLevelFunctionNames.has(operand.name.text))
  );
}

/** Emit the known outcome for a direct delete of a script var/function property. */
export function tryEmitNonConfigurableGlobalObjectDelete(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.DeleteExpression,
): ValType | null {
  if (!isNonConfigurableGlobalObjectDelete(ctx, fctx, expr.expression)) return null;
  if (isStrictContext(expr, ctx.inferModuleStrictArguments)) {
    fctx.body.push(
      ...buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot delete non-configurable property in strict mode", {
        flush: fctx,
      }),
    );
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  return { kind: "i32" };
}
