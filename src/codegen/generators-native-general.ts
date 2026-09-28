// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#680) Statement-level desugarings that let the native generator planner
 * (`generators-native.ts`) lower a yield sitting in an EXPRESSION-STATEMENT
 * operator position it has no expression continuation for. Standalone/WASI
 * only — the JS-host lane keeps its eager buffer (byte-identical).
 *
 * Every rewrite here is exact because the statement's completion value is
 * discarded:
 *
 *   `A, B;`          ≡  `A; B;`                       (§13.16 — left then right)
 *   `A && B;`        ≡  `if (A) B;`                   (§13.13 — B only when ToBoolean(A))
 *   `A || B;`        ≡  `if (!A) B;`
 *   `A ? B : C;`     ≡  `if (A) B; else C;`           (§13.14)
 *
 * The condition operand `A` must be yield-free (a yield there would need the
 * condition's value to survive a suspension, which the branch terminator does
 * not model); `??` is not rewritten (its test is `A === undefined || A ===
 * null`, not ToBoolean). These are the shapes minified bundles use for
 * conditional yields — prettier's `o(s) && (yield s)` and `yield n, u.push(n)`.
 *
 * The rewritten statements are synthetic `ExpressionStatement`s wrapping the
 * ORIGINAL operand nodes, so checker queries on the operands still resolve;
 * the wrappers get the source range and parent of the statement they replace
 * so diagnostics keep a location.
 */
import { ts } from "../ts-api.js";
import { nodeContainsYield } from "./generators-native-ast-scan.js";

export type YieldStatementDesugaring =
  | { kind: "sequence"; statements: ts.Statement[] }
  | {
      kind: "if";
      condition: ts.Expression;
      negate: boolean;
      thenStatements: ts.Statement[];
      elseStatements: ts.Statement[] | undefined;
    };

function unwrapParens(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

function containsYield(expr: ts.Expression): boolean {
  return ts.isYieldExpression(expr) || nodeContainsYield(expr);
}

function synthStatement(expr: ts.Expression, origin: ts.Statement): ts.Statement {
  const stmt = ts.factory.createExpressionStatement(unwrapParens(expr));
  ts.setTextRange(stmt, origin);
  (stmt as { parent?: ts.Node }).parent = origin.parent;
  return stmt;
}

/**
 * The desugaring of `stmt`, or `undefined` when it is not one of the shapes
 * above (or the rewrite would not help: no yield in a deferred operand).
 */
export function desugarYieldExpressionStatement(stmt: ts.Statement): YieldStatementDesugaring | undefined {
  if (!ts.isExpressionStatement(stmt)) return undefined;
  const root = unwrapParens(stmt.expression);
  if (!containsYield(root)) return undefined;
  if (ts.isBinaryExpression(root)) {
    const op = root.operatorToken.kind;
    if (op === ts.SyntaxKind.CommaToken) {
      return { kind: "sequence", statements: [synthStatement(root.left, stmt), synthStatement(root.right, stmt)] };
    }
    if (
      (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) &&
      !containsYield(root.left)
    ) {
      return {
        kind: "if",
        condition: root.left,
        negate: op === ts.SyntaxKind.BarBarToken,
        thenStatements: [synthStatement(root.right, stmt)],
        elseStatements: undefined,
      };
    }
    return undefined;
  }
  if (ts.isConditionalExpression(root) && !containsYield(root.condition)) {
    return {
      kind: "if",
      condition: root.condition,
      negate: false,
      thenStatements: [synthStatement(root.whenTrue, stmt)],
      elseStatements: [synthStatement(root.whenFalse, stmt)],
    };
  }
  return undefined;
}
