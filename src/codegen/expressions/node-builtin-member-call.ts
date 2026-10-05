// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Direct CALL of a node-builtin NAMED import (#6450).
 *
 * `import { createHash } from 'node:crypto'` registers `createHash` in
 * `ctx.declaredGlobals` as a MEMBER binding of the module thunk
 * (`__node_crypto`) — see `registerNodeBuiltinImports` in
 * `extern-declarations.ts`, and the matching VALUE read in
 * `expressions/identifiers.ts` which emits
 * `__extern_get(__node_crypto(), "createHash")` (#4616, jest's `EOL`).
 *
 * The CALL position had no such arm. `compileIdentifierCall` consulted only the
 * bare-name registries, so `createHash('sha256')` resolved two different wrong
 * ways depending on what else the linked graph contained:
 *
 *   - with a same-named function anywhere in the graph, `closureMap`/`funcMap`
 *     called THAT function. Both maps are keyed by a bare identifier across the
 *     whole linked graph, so the leak is cross-MODULE and is not TS shadowing:
 *     hono's `src/utils/crypto.ts` exports `async function createHash`, and its
 *     own `crypto.test.ts` — which imports the builtin — reached the async
 *     export, whose Promise answered `update is not a function`.
 *   - with none, the ladder fell through to the graceful `ref.null.extern`
 *     default and the next property access read `update` off null.
 *
 * The fix routes the call through the same module thunk the value read uses,
 * as `__extern_method_call(__node_crypto(), "createHash", [args])`. Using the
 * method bridge rather than `__extern_get` plus a dynamic call is what binds
 * `this` to the module object, which is what `crypto.createHash` needs.
 *
 * The arm is gated on the CHECKER's binding for the call site rather than on
 * `call-identifier.ts`'s bare-name `isLocallyShadowed` /
 * `hasVisibleClosureStorage` heuristics, which the plan for this issue had
 * proposed adding on top. Those are strictly weaker here, and in the wrong
 * direction twice over: a genuine lexical or module shadow makes the checker
 * report the SHADOWING declaration, so this arm never fires and no extra guard
 * is needed; whereas a same-named binding in an unrelated module — hono's
 * `createHash` again, since `moduleGlobals` is bare-name and graph-wide — sets
 * `hasVisibleClosureStorage` and would have suppressed the import's own call,
 * defeating the fix in precisely the case it was written for.
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import { isNodeBuiltin } from "../../import-resolver.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { addStringConstantGlobal } from "../registry/imports.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { ensureLateImport } from "../shared.js";
import { emitHostMethodCallArgs } from "../host-method-args.js";
import { flushLateImportShifts } from "./late-imports.js";

const EXTERNREF: ValType = { kind: "externref" };

/**
 * Does this call site's callee binding resolve to a named import specifier of a
 * node builtin module?
 *
 * The name-keyed `declaredGlobals`/`nodeBuiltinGlobals` registration is
 * module-GRAPH wide, so a bare-name hit alone would also claim a same-named
 * user binding in a file that never imported the builtin. The binding
 * declaration the checker reports for THIS call site is the thing that decides,
 * which is why the declaration has to be an `ImportSpecifier` whose
 * `ImportDeclaration` names a node builtin.
 */
function bindingIsNodeBuiltinNamedImport(decl: ts.Declaration | undefined): boolean {
  if (decl === undefined || !ts.isImportSpecifier(decl)) return false;
  const namedImports = decl.parent;
  if (!ts.isNamedImports(namedImports)) return false;
  const importClause = namedImports.parent;
  if (!ts.isImportClause(importClause)) return false;
  const importDecl = importClause.parent;
  if (!ts.isImportDeclaration(importDecl)) return false;
  const specifier = importDecl.moduleSpecifier;
  if (!ts.isStringLiteral(specifier)) return false;
  return isNodeBuiltin(specifier.text);
}

/**
 * Compile `member(args)` where `member` is a named import of a node builtin.
 *
 * Returns `undefined` when this is not that shape (the caller keeps its own
 * dispatch ladder) or when a required host import is unavailable.
 */
export function tryCompileNodeBuiltinMemberCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  funcName: string,
  calleeBindingDecl: ts.Declaration | undefined,
): ValType | undefined {
  // Node builtins are a JS-host-only surface: `registerNodeBuiltinImports`
  // errors out under WASI rather than emitting a `__node_*` thunk, so there is
  // nothing to call in the standalone lane.
  if (ctx.wasi) return undefined;
  if (!ctx.nodeBuiltinGlobals.has(funcName)) return undefined;
  const member = ctx.declaredGlobals.get(funcName)?.member;
  if (member === undefined) return undefined;
  if (!bindingIsNodeBuiltinNamedImport(calleeBindingDecl)) return undefined;

  // Register every host dependency before emitting anything: a late import
  // shifts function indices, so the index reads below must happen after the
  // flush (the #1719 reserve-then-fill rule).
  const arrayNewIdx = ensureLateImport(ctx, "__js_array_new", [], [EXTERNREF]);
  const arrayPushIdx = ensureLateImport(ctx, "__js_array_push", [EXTERNREF, EXTERNREF], []);
  const methodCallIdx = ensureLateImport(ctx, "__extern_method_call", [EXTERNREF, EXTERNREF, EXTERNREF], [EXTERNREF]);
  addStringConstantGlobal(ctx, member);
  flushLateImportShifts(ctx, fctx);
  const resolvedNewIdx = ctx.funcMap.get("__js_array_new") ?? arrayNewIdx;
  const resolvedPushIdx = ctx.funcMap.get("__js_array_push") ?? arrayPushIdx;
  const resolvedMethodCallIdx = ctx.funcMap.get("__extern_method_call") ?? methodCallIdx;
  if (resolvedNewIdx === undefined || resolvedPushIdx === undefined || resolvedMethodCallIdx === undefined) {
    return undefined;
  }
  // Re-read the module thunk's own index for the same reason.
  const moduleThunkIdx = ctx.declaredGlobals.get(funcName)?.funcIdx;
  if (moduleThunkIdx === undefined) return undefined;

  fctx.body.push({ op: "call", funcIdx: resolvedNewIdx });
  const argsLocal = allocLocal(fctx, `__nodebuiltin_args_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.set", index: argsLocal });
  emitHostMethodCallArgs(ctx, fctx, expr, argsLocal, "__js_array_push", resolvedPushIdx);

  fctx.body.push({ op: "call", funcIdx: moduleThunkIdx });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, member));
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: resolvedMethodCallIdx });
  return EXTERNREF;
}
