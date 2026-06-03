/**
 * #1261 — eval tiering: classify a module's eval usage into 5 tiers at
 * compile time so downstream optimization passes (#1262–#1265) apply exactly
 * the deopt overhead each tier requires — and nothing more.
 *
 * This pass is READ-ONLY. It computes the module-wide worst-case tier; it does
 * not change codegen. Optimization gating on the result lands in follow-ups.
 *
 * | Tier | Condition                                   |
 * |------|---------------------------------------------|
 * | 1    | No `eval` anywhere in the module            |
 * | 2    | Only `eval("<static literal>")` sites       |
 * | 3    | Indirect eval `(0, eval)(...)` (global)     |
 * | 4    | Direct eval, strict mode                     |
 * | 5    | Direct eval, sloppy mode                      |
 *
 * The module tier is the maximum (worst) tier across all eval sites.
 * TypeScript and ESM are always strict, so TS/ESM sources never reach tier 5.
 */

import ts from "typescript";
import { resolveConstantString } from "./expressions/eval-inline.js";

export enum EvalTier {
  /** No eval anywhere — full optimization. */
  NoEval = 1,
  /** Only static-literal eval — inlined at compile time (#1163). */
  StaticLiteral = 2,
  /** Indirect eval — affects global scope only; locals unaffected. */
  Indirect = 3,
  /** Direct eval, strict mode — locals stay unboxed, no function replacement. */
  DirectStrict = 4,
  /** Direct eval, sloppy mode — full boxing + mutable funcref globals. */
  DirectSloppy = 5,
}

/** Per-site classification, before the static-literal refinement. */
type EvalCallKind = "direct" | "indirect" | "none";

/**
 * Resolve whether an identifier named `eval` refers to the global `eval`
 * intrinsic (declared only in `.d.ts`) rather than a local shadow. Mirrors the
 * `isGlobalEvalIdentifier` heuristic in expressions/calls.ts so this pass and
 * the call-site lowering agree on what counts as a real eval.
 */
function isGlobalEvalIdentifier(ident: ts.Identifier, checker: ts.TypeChecker): boolean {
  const sym = checker.getSymbolAtLocation(ident);
  if (!sym) return true; // unresolved → assume global eval
  const decls = sym.declarations;
  if (!decls || decls.length === 0) return true;
  return decls.every((d) => d.getSourceFile().isDeclarationFile);
}

/**
 * Classify a single call expression's callee shape as a direct/indirect/none
 * eval call. Mirrors `classifyEvalCallExpression` in expressions/calls.ts.
 */
function classifyEvalCall(expr: ts.CallExpression, checker: ts.TypeChecker): EvalCallKind {
  if (expr.questionDotToken) return "none";
  let callee: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;

  // Direct form: eval(src)
  if (ts.isIdentifier(callee) && callee.text === "eval") {
    return isGlobalEvalIdentifier(callee, checker) ? "direct" : "none";
  }

  // Indirect form: (0, eval)(src) — comma expression whose right side is `eval`.
  if (
    ts.isBinaryExpression(callee) &&
    callee.operatorToken.kind === ts.SyntaxKind.CommaToken &&
    ts.isIdentifier(callee.right) &&
    callee.right.text === "eval"
  ) {
    return isGlobalEvalIdentifier(callee.right, checker) ? "indirect" : "none";
  }

  return "none";
}

/**
 * Whether the source file is strict-mode code. TypeScript modules (any file
 * with an import/export) and ESM are always strict; a `"use strict"` prologue
 * directive forces strict on a script. `.ts`/`.tsx`/`.mts` files are strict by
 * construction. Only a plain sloppy-mode script (`.js`/`.cjs` with no module
 * markers and no directive) is non-strict.
 */
function isStrictModeSource(sf: ts.SourceFile): boolean {
  // `externalModuleIndicator` and `scriptKind` are internal SourceFile fields
  // not exposed on the public type; access them through a narrow cast.
  const internal = sf as ts.SourceFile & {
    externalModuleIndicator?: ts.Node;
    scriptKind?: ts.ScriptKind;
  };

  // A module (has import/export, or impliedNodeFormat ESM) is always strict.
  if (internal.externalModuleIndicator !== undefined) return true;
  if (sf.impliedNodeFormat === ts.ModuleKind.ESNext) return true;

  // TypeScript source kinds are strict by construction.
  switch (internal.scriptKind) {
    case ts.ScriptKind.TS:
    case ts.ScriptKind.TSX:
      return true;
    default:
      break;
  }

  // `.mts` / `.mjs`-as-ESM resolved formats.
  const fileName = sf.fileName.toLowerCase();
  if (fileName.endsWith(".ts") || fileName.endsWith(".tsx") || fileName.endsWith(".mts") || fileName.endsWith(".mjs")) {
    return true;
  }

  // Script: strict only with a "use strict" prologue directive.
  return hasUseStrictPrologue(sf.statements);
}

/** Detect a `"use strict"` directive prologue at the head of a statement list. */
function hasUseStrictPrologue(stmts: ts.NodeArray<ts.Statement>): boolean {
  for (const stmt of stmts) {
    if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
      if (stmt.expression.text === "use strict") return true;
      continue; // another directive in the prologue — keep scanning
    }
    break; // first non-directive statement ends the prologue
  }
  return false;
}

/** Map a per-site eval classification to its tier within a given strict-mode context. */
function tierForSite(expr: ts.CallExpression, kind: Exclude<EvalCallKind, "none">, strict: boolean): EvalTier {
  if (kind === "indirect") {
    // Indirect eval is always global-scope only; a static literal is still
    // inlined (#1163), so a literal-arg indirect eval is tier 2.
    return resolveConstantString(expr.arguments[0] ?? (undefined as unknown as ts.Expression)) !== null
      ? EvalTier.StaticLiteral
      : EvalTier.Indirect;
  }
  // Direct eval.
  if (expr.arguments.length > 0 && resolveConstantString(expr.arguments[0]!) !== null) {
    return EvalTier.StaticLiteral;
  }
  return strict ? EvalTier.DirectStrict : EvalTier.DirectSloppy;
}

/**
 * Classify a module's eval usage into its worst-case tier. Read-only.
 *
 * Returns `EvalTier.NoEval` when the module contains no real eval call.
 */
export function classifyEvalTier(sourceFile: ts.SourceFile, checker: ts.TypeChecker): EvalTier {
  const strict = isStrictModeSource(sourceFile);
  let tier: EvalTier = EvalTier.NoEval;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = classifyEvalCall(node, checker);
      if (kind !== "none") {
        const siteTier = tierForSite(node, kind, strict);
        if (siteTier > tier) tier = siteTier;
      }
    }
    if (tier < EvalTier.DirectSloppy) {
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(sourceFile, visit);

  return tier;
}
