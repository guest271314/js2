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
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { hoistFunctionDeclarations } from "../statements/nested-declarations.js";
import { hoistLetConstWithTdz, hoistVarDeclarations } from "../index.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression, compileStatement } from "../shared.js";
import { emitUndefined } from "./late-imports.js";

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
  //
  // A `"use strict"` directive prologue in the eval body switches on
  // strict-mode early-error + strict-name semantics (e.g.
  // `eval("'use strict'; function f(eval){}")` is a SyntaxError; assigning to
  // `eval`/`arguments` throws) that the AST splice does NOT enforce — so
  // function declarations in a strict body keep bailing to the dynamic path
  // (host eval enforces them).  See `allNodesInlineSupported` / #2923 park fix.
  const bodyIsStrict = evalBodyHasUseStrictDirective(stmts);
  if (!allNodesInlineSupported(sf, bodyIsStrict)) {
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
 *
 * `bodyIsStrict` — whether the eval Script begins with a `"use strict"`
 * directive prologue.  A strict eval body has early-error + strict-name
 * semantics the naive splice does NOT enforce, so function declarations in a
 * strict body must keep bailing to the dynamic path (see the `FunctionDeclaration`
 * case below and the #2923 park fix).
 */
function allNodesInlineSupported(node: ts.Node, bodyIsStrict: boolean): boolean {
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
      // (#2923 park fix) A function declaration is liftable ONLY when it is a
      // TOP-LEVEL statement of a SLOPPY eval Script (hoisted by
      // `hoistFunctionDeclarations`, signature-tolerant per
      // `compileNestedFunctionDeclaration`). It must keep bailing to the dynamic
      // path — which the host `__extern_eval` implements correctly — when:
      //   (A) the eval body is strict (`"use strict"` prologue): strict
      //       early-errors + strict-name rules (e.g. `function f(eval){}` /
      //       `eval = 42` are SyntaxErrors) are NOT enforced by the splice; and
      //   (B) the declaration is nested in a script-scope block / if / switch /
      //       for / label (NOT directly a Script statement, and not inside
      //       another function): AnnexB §B.3.3 Web-Legacy semantics require it to
      //       create BOTH a block binding and a hoisted var binding in the
      //       enclosing variable environment, which the splice does not do.
      // Broadening past these two guards regressed 123 test262 files (102
      // annexB/language/eval-code {direct,indirect} + 9 language/eval-code
      // block/switch + 9 language/statements/function 13.*-s / *-eval-stricteval)
      // when first landed — the merge_group park on PR #2442. A top-level sloppy
      // func decl (the #2923 win, e.g. `eval("function add(a,b){return a+b}
      // add(2,3)")`) still lifts. Nested bail nodes (arrow/class) inside a lifted
      // decl's body are still caught by the recursion below.
      case ts.SyntaxKind.FunctionDeclaration: {
        if (bodyIsStrict || funcDeclNeedsDynamicEvalPath(n as ts.FunctionDeclaration)) {
          ok = false;
          return;
        }
        n.forEachChild(visit);
        return;
      }
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
 * (#2923 park fix) Does the eval Script begin with a `"use strict"` directive
 * prologue? Per §11.2.1 a directive prologue is the leading run of
 * ExpressionStatements whose expression is a StringLiteral; `"use strict"`
 * anywhere in that run turns the body strict. A strict eval body carries
 * early-error + strict-name semantics (function `eval`/`arguments` params,
 * assignment to `eval`, …) the AST splice does not enforce, so we keep bailing
 * function declarations in such a body to the dynamic host-eval path.
 */
function evalBodyHasUseStrictDirective(stmts: ts.NodeArray<ts.Statement>): boolean {
  for (const s of stmts) {
    if (!ts.isExpressionStatement(s)) break;
    // Only a plain StringLiteral counts as a directive (a template does not).
    if (!ts.isStringLiteral(s.expression)) break;
    if (s.expression.text === "use strict") return true;
    // Some other directive (e.g. "use asm") → keep scanning the prologue.
  }
  return false;
}

/**
 * (#2923 park fix) A function declaration must fall back to the dynamic eval
 * path when it is nested in a SCRIPT-SCOPE block / if / switch / for / label
 * (AnnexB §B.3.3 Web-Legacy Block-Level Function Declaration semantics the
 * splice does not implement). It is safe (returns false) when it is either a
 * top-level statement of the eval Script (hoisted correctly) OR nested inside
 * another function's body (an ordinary nested function, compiled by that
 * function's own codegen — not eval-scope-sensitive).
 */
function funcDeclNeedsDynamicEvalPath(fn: ts.FunctionDeclaration): boolean {
  const parent = fn.parent;
  // Directly a statement of the eval Script → top-level, safe to hoist.
  if (parent && ts.isSourceFile(parent)) return false;
  // Walk up: crossing a function boundary before the SourceFile means the decl
  // lives inside another function (ordinary nested fn) → safe. Reaching the
  // SourceFile through only lexical statements (block/if/switch/for/label)
  // means it is a script-scope block-nested declaration → AnnexB-sensitive.
  let p: ts.Node | undefined = parent;
  while (p && !ts.isSourceFile(p)) {
    if (isFunctionLikeContainer(p)) return false;
    p = p.parent;
  }
  return true;
}

/** Nodes that introduce their own function scope (a lifted decl's ancestors). */
function isFunctionLikeContainer(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  );
}
