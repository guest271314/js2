// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachChild, ts } from "../ts-api.js";

/** Conservatively collect writes in the function-like enclosing a lifted closure. */
export function collectOuterWrites(
  fn:
    | ts.FunctionDeclaration
    | ts.ArrowFunction
    | ts.FunctionExpression
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
): Set<string> {
  const writes = new Set<string>();
  let outer: ts.Node | undefined = fn.parent;
  while (
    outer &&
    !ts.isFunctionDeclaration(outer) &&
    !ts.isFunctionExpression(outer) &&
    !ts.isArrowFunction(outer) &&
    !ts.isMethodDeclaration(outer) &&
    !ts.isGetAccessorDeclaration(outer) &&
    !ts.isSetAccessorDeclaration(outer) &&
    !ts.isSourceFile(outer)
  ) {
    outer = outer.parent;
  }
  if (!outer || !("body" in outer) || !outer.body) return writes;
  const body = outer.body as ts.Node;
  const visit = (node: ts.Node): void => {
    if (node === fn) return;
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsToken ||
        (op >= ts.SyntaxKind.PlusEqualsToken && op <= ts.SyntaxKind.CaretEqualsToken)
      ) {
        if (ts.isIdentifier(node.left)) writes.add(node.left.text);
      }
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const op = node.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        if (ts.isIdentifier(node.operand)) writes.add(node.operand.text);
      }
    }
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
  return writes;
}

/** Allocate shared storage before control flow can create an accessor capture. */
export function isCapturedByOrdinaryDescriptor(declaration: ts.VariableDeclaration, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(declaration.name)) return false;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (!symbol) return false;
  let owner: ts.Node | undefined = declaration.parent;
  while (owner && !ts.isFunctionLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
  if (!owner || !("body" in owner) || !owner.body) return false;
  let captured = false;
  const visit = (node: ts.Node, nested: boolean, descriptor: boolean): void => {
    if (captured) return;
    const isClosure = ts.isFunctionLike(node);
    const inDescriptor =
      descriptor ||
      ((ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
        ts.isObjectLiteralExpression(node.parent));
    if (nested && inDescriptor && ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
      captured = true;
      return;
    }
    forEachChild(node, (child) => visit(child, nested || isClosure, inDescriptor));
  };
  visit(
    owner.body as ts.Node,
    false,
    (ts.isGetAccessorDeclaration(owner) || ts.isSetAccessorDeclaration(owner)) &&
      ts.isObjectLiteralExpression(owner.parent),
  );
  return captured;
}
