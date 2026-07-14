// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1886 linear-Uint8Array arena marking/reset helpers.
 *
 * Linear-safe buffers do not escape their lexical scope, so allocations made
 * inside a loop iteration or helper function can reuse the same arena range on
 * the next iteration/call. This keeps the zero-copy path from growing linear
 * memory for every short-lived I/O frame.
 */
import type { Instr } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { isLinearU8RepresentableNew } from "./linear-uint8-signatures.js";

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isAccessor(node) ||
    ts.isConstructorDeclaration(node)
  );
}

export function containsLinearU8Allocation(ctx: CodegenContext, node: ts.Node | undefined): boolean {
  const linear = ctx.linearUint8;
  if (!node || !linear) return false;
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (child !== node && isFunctionLike(child)) return;
    if (
      ts.isVariableDeclaration(child) &&
      ts.isIdentifier(child.name) &&
      child.initializer &&
      ts.isNewExpression(child.initializer) &&
      ts.isIdentifier(child.initializer.expression) &&
      child.initializer.expression.text === "Uint8Array" &&
      isLinearU8RepresentableNew(ctx, child.initializer)
    ) {
      const sym = ctx.checker.getSymbolAtLocation(child.name);
      if (sym && linear.safeBindings.has(sym)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

export function emitLinearU8ArenaMark(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name = "__linu8_arena_mark",
): number | undefined {
  if (!ctx.wasi || ctx.linearU8ArenaGlobalIdx === undefined) return undefined;
  const markLocal = allocLocal(fctx, `${name}_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "global.get", index: ctx.linearU8ArenaGlobalIdx });
  fctx.body.push({ op: "local.set", index: markLocal });
  return markLocal;
}

export function linearU8ArenaResetInstrs(ctx: CodegenContext, markLocalIdx: number | undefined): Instr[] {
  if (markLocalIdx === undefined || ctx.linearU8ArenaGlobalIdx === undefined) return [];
  return [
    { op: "local.get", index: markLocalIdx },
    { op: "global.set", index: ctx.linearU8ArenaGlobalIdx },
  ];
}

export function emitLinearU8ArenaReset(
  ctx: CodegenContext,
  fctx: FunctionContext,
  markLocalIdx: number | undefined,
): void {
  fctx.body.push(...linearU8ArenaResetInstrs(ctx, markLocalIdx));
}
