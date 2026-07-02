// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Static eval inlining (#1163).
 *
 * When the argument to `eval(...)` is a compile-time-constant string (a string
 * literal, template literal with no substitutions, or a `+` concatenation of
 * the above), we parse that string as a Script and splice its statements into
 * the current function at compile time — no runtime eval is required.
 *
 * This replaces the dynamic `__extern_eval` host-import call (#1006) for the
 * common literal-argument case.  Per ECMA-262 §19.2.1 PerformEval, the last
 * value produced by the evaluated script becomes the result of the call; if
 * the script does not produce a value (e.g., a var declaration only),
 * `undefined` is returned.
 *
 * Non-literal arguments and parse failures fall through to the existing
 * dynamic-eval path.
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { hoistFunctionDeclarations } from "../statements/nested-declarations.js";
import { hoistLetConstWithTdz, hoistVarDeclarations } from "../index.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression, compileStatement } from "../shared.js";
import { emitUndefined } from "./late-imports.js";
import { emitFuncRefAsClosure } from "../closures.js";

/**
 * Synthetic file name for the foreign `SourceFile` an inlined `eval("<literal>")`
 * body is parsed into (see `inlineStaticEval` below). The TypeScript checker has
 * NO bindings for nodes in this file, so `getSymbolAtLocation` returns
 * `undefined` for every identifier — symbol-presence cannot be used to classify
 * resolvability inside an eval body. Consumers that rely on that oracle (e.g.
 * the unresolvable-`delete` flip in typeof-delete.ts, #2726 group (a)) must
 * detect and skip eval-body nodes via this sentinel.
 */
export const EVAL_SOURCE_FILENAME = "<eval>.ts";

/**
 * Recursively resolve a compile-time-constant string from an expression.
 * Returns the string value, or null if the expression is not a constant.
 */
export function resolveConstantString(expr: ts.Expression): string | null {
  // Unwrap parentheses: ("foo") / (("foo"))
  let e: ts.Expression = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;

  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    return e.text;
  }

  // String-literal concatenation: "a" + "b", possibly chained.
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveConstantString(e.left);
    if (left === null) return null;
    const right = resolveConstantString(e.right);
    if (right === null) return null;
    return left + right;
  }

  return null;
}

/**
 * Try to inline `eval("<constant>")` at compile time.
 *
 * Returns:
 *   - InnerResult (ValType or null) on success — caller treats this as the
 *     compiled call result and does NOT invoke the dynamic-eval fallback.
 *   - undefined if the call is not eligible (non-literal arg, parse errors,
 *     etc.) — caller should fall through to the dynamic-eval path.
 *
 * On success we always push a single externref value onto the stack (the
 * result of the inlined script, coerced to externref to match eval's `any`
 * return type).  When the inlined code is statically unreachable (the last
 * statement is a throw, etc.) we return `null` so the caller knows no value
 * was produced.
 */
export function tryStaticEvalInline(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (expr.arguments.length === 0) return undefined;

  const src = resolveConstantString(expr.arguments[0]!);
  if (src === null) return undefined;

  // Evaluate any additional arguments for side effects, then drop them.
  // Per §19.2.1, eval only looks at its first argument, but extra args must
  // still be evaluated (they could throw).
  for (let ai = 1; ai < expr.arguments.length; ai++) {
    const t = compileExpression(ctx, fctx, expr.arguments[ai]!);
    if (t !== null) fctx.body.push({ op: "drop" });
  }

  // Parse the eval source as a Script with parent pointers set so the
  // nested codegen paths (which walk upward via node.parent) work.
  const sf = ts.createSourceFile(
    EVAL_SOURCE_FILENAME,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.JS,
  );

  // If the parse produced diagnostics we're looking at malformed eval source.
  // Real JS would throw SyntaxError at runtime — for now, fall through to the
  // dynamic path so the host can signal the error correctly.  `parseDiagnostics`
  // is an internal field on SourceFile, so access it through a cast.
  const parseDiag = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiag && parseDiag.length > 0) {
    return undefined;
  }

  const stmts = sf.statements;

  // Empty program — eval returns undefined.
  if (stmts.length === 0) {
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  // Scan the parsed AST for node kinds we cannot safely lower from a foreign
  // SourceFile.  The TypeScript checker has no bindings for nodes created via
  // `ts.createSourceFile`, so anything that requires static type information
  // to compile correctly (function/arrow/class expressions, for-of loops that
  // need iterator types, etc.) would silently mis-compile.  When we detect
  // such a node we bail out and let the dynamic `__extern_eval` path handle
  // the call — correctness first, inlining is a best-effort fast path.
  if (!allNodesInlineSupported(sf)) {
    return undefined;
  }

  // Hoist var / function declarations into the enclosing function scope
  // before compiling any statements.  `let`/`const` enter the block scope
  // in source order (handled by compileVariableStatement itself).
  try {
    hoistVarDeclarations(ctx, fctx, stmts);
    hoistLetConstWithTdz(ctx, fctx, stmts);
    hoistFunctionDeclarations(ctx, fctx, stmts);
  } catch {
    // If hoisting blows up (e.g. the checker can't type a foreign node),
    // fall back to the dynamic-eval path.
    return undefined;
  }

  // Compile all but the last statement for side effects.
  const lastIdx = stmts.length - 1;
  for (let i = 0; i < lastIdx; i++) {
    compileStatement(ctx, fctx, stmts[i]!);
  }

  const last = stmts[lastIdx]!;

  // ExpressionStatement — the expression's value is the eval result.
  if (ts.isExpressionStatement(last)) {
    const t = compileExpression(ctx, fctx, last.expression);
    if (t === null) {
      // Unreachable (e.g. the expression compiled to a throw).
      return null;
    }
    if (t.kind !== "externref") {
      coerceType(ctx, fctx, t, { kind: "externref" });
    }
    return { kind: "externref" };
  }

  // Non-expression last statement (throw, var, if, etc.) — compile it and
  // push `undefined` as the eval result.  A throw statement compiles to a
  // `throw` op which leaves the block polymorphic, so the trailing
  // `undefined` push is still well-formed (it's dead code after throw, but
  // keeps the stack types consistent from the caller's perspective).
  compileStatement(ctx, fctx, last);
  emitUndefined(ctx, fctx);
  return { kind: "externref" };
}

/**
 * Walk the parsed eval AST and return false if it contains any node kind that
 * requires TypeScript checker bindings (or binding analysis) we can't provide
 * for foreign nodes.  Currently: function/arrow/class expressions and
 * declarations, for-of loops, yield/await, and dynamic import.  The check is
 * conservative — unsupported constructs simply fall through to runtime eval.
 */
export function allNodesInlineSupported(node: ts.Node): boolean {
  let ok = true;
  const visit = (n: ts.Node): void => {
    if (!ok) return;
    switch (n.kind) {
      // (#2923) Still bail — these need checker bindings the foreign
      // `ts.createSourceFile` lacks, and their codegen THROWS on a binding-less
      // node (an internal error that would fail the whole compile, worse than a
      // clean fall-through to the dynamic path):
      //   - function/arrow EXPRESSIONS + class declarations/expressions resolve
      //     their signature/heritage via the checker (`Cannot read 'escapedName'`).
      //   - yield/await/import/export are out of scope for a Script eval body.
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.ClassExpression:
      case ts.SyntaxKind.YieldExpression:
      case ts.SyntaxKind.AwaitExpression:
      case ts.SyntaxKind.ImportDeclaration:
      case ts.SyntaxKind.ExportDeclaration:
      case ts.SyntaxKind.ExportAssignment:
        ok = false;
        return;
      // (#2923) `for-of` / `for-in` are liftable ONLY when the iterable is a
      // literal whose iteration needs no checker-resolved iterator type — an
      // array/string literal (for-of) or an object/array literal (for-in). A
      // general iterable (a Map/Set/user iterator, or a bare identifier whose
      // type the foreign SourceFile can't resolve) keeps bailing to the dynamic
      // path. When the iterable IS a literal we fall through to recurse into the
      // loop body (which may itself contain a bail node).
      case ts.SyntaxKind.ForOfStatement: {
        if (!isLiftableForOfIterable((n as ts.ForOfStatement).expression)) {
          ok = false;
          return;
        }
        n.forEachChild(visit);
        return;
      }
      case ts.SyntaxKind.ForInStatement: {
        if (!isLiftableForInIterable((n as ts.ForInStatement).expression)) {
          ok = false;
          return;
        }
        n.forEachChild(visit);
        return;
      }
      // FunctionDeclaration falls through to `default` → hoisted +
      // signature-tolerant (see compileNestedFunctionDeclaration, #2923). Nested
      // bail nodes inside its body are still caught by the recursion.
      default:
        n.forEachChild(visit);
    }
  };
  node.forEachChild(visit);
  return ok;
}

/** Unwrap parens to the underlying expression. */
function unwrapParens(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  return x;
}

/**
 * (#2923) A `for-of` iterable is liftable in a foreign eval body when it is an
 * array literal or a string literal — their iteration lowers with no
 * checker-resolved iterator type.
 */
function isLiftableForOfIterable(expr: ts.Expression): boolean {
  const e = unwrapParens(expr);
  return ts.isArrayLiteralExpression(e) || ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e);
}

/**
 * (#2923) A `for-in` iterable is liftable when it is an object or array literal
 * — enumeration walks the literal's own keys / indices without a resolved type.
 */
function isLiftableForInIterable(expr: ts.Expression): boolean {
  const e = unwrapParens(expr);
  return ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e);
}

/**
 * (#2924) Compile-away `new Function("<params>", …, "<body>")` / the equivalent
 * `Function(...)` call form when every argument is a compile-time-constant
 * string. Slice B of the runtime-eval roadmap (§6-B / §4.4).
 *
 * Per §20.2.1.1 CreateDynamicFunction, the created function's scope is ALWAYS the
 * global environment — it never captures the caller's lexical scope. So when the
 * param list and body are constant, `new Function("a","b","return a+b")` is
 * semantically identical to compiling `function (a,b){ return a+b }` at that site
 * over GLOBAL scope. We synthesize that as a named foreign function declaration,
 * hoist it (reusing the #2923 signature-tolerant path) with the enclosing
 * `localMap` swapped for an empty one (so a body identifier that collides with a
 * caller local resolves as a global, not a capture — the no-capture invariant),
 * then materialize a first-class callable via `emitFuncRefAsClosure`.
 *
 * Returns:
 *   - InnerResult on success (a callable externref left on the stack),
 *   - undefined to fall through to the existing path (a non-constant argument,
 *     a body that isn't safely liftable, or a synthesis/parse failure — the
 *     dynamic-body case is the Tier-2 interpreter's, #2928).
 */
export function tryStaticNewFunction(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
): ValType | undefined {
  // Every argument must be a compile-time-constant string. A single non-constant
  // arg → dynamic body → fall through (Tier-2 interpreter, #2928).
  const consts: string[] = [];
  for (const a of args) {
    const s = resolveConstantString(a);
    if (s === null) return undefined;
    consts.push(s);
  }

  // §20.2.1.1.1: the LAST argument is the body; the rest form the parameter list
  // (comma-joined so `("a","b,c","…")` flattens to params a, b, c). No args →
  // `function anonymous() {}` (empty body, empty params).
  const body = consts.length > 0 ? consts[consts.length - 1]! : "";
  const paramSrc = consts.slice(0, -1).join(",");

  // A unique synthesized name; `mod.functions.length` is monotonic within a
  // compile, so two `new Function` sites never collide.
  const fnName = `__new_function_${ctx.mod.functions.length}`;
  const synthSrc = `function ${fnName}(${paramSrc}) {\n${body}\n}`;

  const sf = ts.createSourceFile(
    EVAL_SOURCE_FILENAME,
    synthSrc,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.JS,
  );
  const parseDiag = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiag && parseDiag.length > 0) {
    // Malformed params/body — real JS throws SyntaxError. Fall through to the
    // existing path rather than force a compile error (the dynamic path / stub
    // preserves current behaviour; strict SyntaxError semantics are #2928).
    return undefined;
  }
  if (sf.statements.length !== 1 || !ts.isFunctionDeclaration(sf.statements[0]!)) return undefined;
  const fnDecl = sf.statements[0] as ts.FunctionDeclaration;

  // The body must be safely liftable (no function/arrow expression, class, etc.
  // that would need checker bindings the foreign SourceFile lacks — same guard
  // as constant-string eval, #2923).
  if (!allNodesInlineSupported(fnDecl)) return undefined;

  // Hoist + compile the synthesized declaration over GLOBAL scope: swap the
  // enclosing localMap/boxedCaptures for empty ones so the capture analysis in
  // hoistFunctionDeclarations finds nothing to capture (no lexical closure over
  // caller locals, §20.2.1.1). Restore afterwards.
  const savedLocalMap = fctx.localMap;
  const savedBoxed = fctx.boxedCaptures;
  fctx.localMap = new Map();
  fctx.boxedCaptures = undefined;
  try {
    hoistFunctionDeclarations(ctx, fctx, [fnDecl]);
  } catch {
    return undefined;
  } finally {
    fctx.localMap = savedLocalMap;
    fctx.boxedCaptures = savedBoxed;
  }

  const funcIdx = ctx.funcMap.get(fnName);
  if (funcIdx === undefined) return undefined;

  // Materialize the callable value (closure struct over the funcref), then wrap
  // to externref to match `new Function`'s `any`/callable result.
  const closureRef = emitFuncRefAsClosure(ctx, fctx, fnName, funcIdx);
  if (!closureRef) {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
  if (closureRef.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  return { kind: "externref" };
}
