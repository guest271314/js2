// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Checker-backed resolution for the deliberately narrow imported-function IR
// slice (#3214 A+B1).  This module is intentionally a leaf: it knows about
// TypeScript symbols/declarations, but not about selector or lowering state.
// Both the selector and the overlay planner consume the same resolver so a
// call cannot be selected under one alias interpretation and lowered under
// another.

import { ts } from "../ts-api.js";

export interface IrResolvedFunctionTarget {
  /** Canonical flat key used by the legacy declaration/funcMap pipeline. */
  readonly targetName: string;
  readonly declaration: ts.FunctionDeclaration;
}

export interface IrImportedFunctionResolver {
  /** Resolve only a default/named ESM import binding to a compiled function. */
  resolveImportedFunction(node: ts.Identifier): IrResolvedFunctionTarget | undefined;
  /** Resolve only a direct same-file top-level FunctionDeclaration value. */
  resolveTopLevelFunctionValue(node: ts.Identifier): IrResolvedFunctionTarget | undefined;
  /** True for every import binding, including deliberately unsupported forms. */
  isImportBinding(node: ts.Identifier): boolean;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === kind);
}

function canonicalTargetName(declaration: ts.FunctionDeclaration): string | undefined {
  if (declaration.name) return declaration.name.text;
  return hasModifier(declaration, ts.SyntaxKind.DefaultKeyword) ? "default" : undefined;
}

function importClauseOfSpecifier(specifier: ts.ImportSpecifier): ts.ImportClause | undefined {
  const named = specifier.parent;
  const clause = named.parent;
  return ts.isImportClause(clause) ? clause : undefined;
}

function isAnyImportDeclaration(node: ts.Declaration): boolean {
  return (
    ts.isImportSpecifier(node) ||
    ts.isImportClause(node) ||
    ts.isNamespaceImport(node) ||
    ts.isImportEqualsDeclaration(node)
  );
}

function isSupportedValueImportDeclaration(node: ts.Declaration): boolean {
  if (ts.isImportSpecifier(node)) {
    const clause = importClauseOfSpecifier(node);
    return node.isTypeOnly !== true && clause?.isTypeOnly !== true;
  }
  // The symbol for a default import is declared on its ImportClause.
  if (ts.isImportClause(node)) return !!node.name && node.isTypeOnly !== true;
  return false;
}

/**
 * Build one realm-wide resolver over the exact source set compileMulti will
 * emit.  Targets outside this set (package imports, declaration files, ambient
 * declarations) are external even when the TypeChecker can see their symbol.
 */
export function makeIrImportedFunctionResolver(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
): IrImportedFunctionResolver {
  const sourceSet = new Set(sourceFiles);

  // funcMap remains keyed by a flat canonical name.  More than one body with
  // the same key is therefore ambiguous for symbolic IR lowering, even when
  // TypeScript's module namespace would otherwise distinguish them.
  const canonicalNameCounts = new Map<string, number>();
  for (const sourceFile of sourceFiles) {
    for (const statement of sourceFile.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.body) continue;
      const name = canonicalTargetName(statement);
      if (name) canonicalNameCounts.set(name, (canonicalNameCounts.get(name) ?? 0) + 1);
    }
  }

  const deAlias = (symbol: ts.Symbol | undefined): ts.Symbol | undefined => {
    if (!symbol) return undefined;
    let current = symbol;
    const seen = new Set<ts.Symbol>();
    for (let depth = 0; depth < 32 && current.flags & ts.SymbolFlags.Alias; depth++) {
      if (seen.has(current)) return undefined;
      seen.add(current);
      try {
        const next = checker.getAliasedSymbol(current);
        if (!next || next === current) return undefined;
        current = next;
      } catch {
        return undefined;
      }
    }
    return current.flags & ts.SymbolFlags.Alias ? undefined : current;
  };

  // Live/reassigned function bindings cannot be represented by a cached ref to
  // the original funcIdx.  Record canonical symbols, not text, so shadowed
  // locals and same-named declarations in different modules do not poison one
  // another.
  const reassigned = new Set<ts.Symbol>();
  const noteSymbolWrite = (candidate: ts.Symbol | undefined): void => {
    const symbol = deAlias(candidate);
    if (symbol && (symbol.declarations ?? []).some(ts.isFunctionDeclaration)) reassigned.add(symbol);
  };
  const noteWrite = (identifier: ts.Identifier): void => {
    try {
      noteSymbolWrite(checker.getSymbolAtLocation(identifier));
    } catch {
      // An unresolved write has no exact symbol that can safely be recorded.
    }
  };
  const scanAssignmentTargetWrites = (target: ts.Expression): void => {
    while (
      ts.isParenthesizedExpression(target) ||
      ts.isAsExpression(target) ||
      ts.isTypeAssertionExpression(target) ||
      ts.isSatisfiesExpression(target) ||
      ts.isNonNullExpression(target)
    ) {
      target = target.expression;
    }

    if (ts.isIdentifier(target)) {
      noteWrite(target);
      return;
    }
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // Destructuring defaults write only their left-hand target.  The default
      // expression is a read/evaluation and must not poison same-named symbols.
      scanAssignmentTargetWrites(target.left);
      return;
    }
    if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) {
        if (ts.isOmittedExpression(element)) continue;
        scanAssignmentTargetWrites(ts.isSpreadElement(element) ? element.expression : element);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          // getSymbolAtLocation(property.name) is the synthetic object-property
          // symbol; the checker API below returns the actual assignment target.
          try {
            noteSymbolWrite(checker.getShorthandAssignmentValueSymbol(property));
          } catch {
            // See noteWrite: an unresolved shorthand cannot certify a target.
          }
        } else if (ts.isPropertyAssignment(property)) {
          scanAssignmentTargetWrites(property.initializer);
        } else if (ts.isSpreadAssignment(property)) {
          scanAssignmentTargetWrites(property.expression);
        }
      }
    }
    // Property/element accesses write a member, not an identifier binding.
  };
  const scanBindingNameWrites = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      noteWrite(name);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) scanBindingNameWrites(element.name);
    }
  };
  const scanWrites = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      scanAssignmentTargetWrites(node.left);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      scanAssignmentTargetWrites(node.operand);
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (ts.isVariableDeclarationList(node.initializer)) {
        // A declaration usually introduces a distinct loop binding, but a
        // same-scope `var` may merge with and overwrite a function declaration.
        // Symbol comparison in noteWrite distinguishes those cases.
        for (const declaration of node.initializer.declarations) scanBindingNameWrites(declaration.name);
      } else {
        scanAssignmentTargetWrites(node.initializer);
      }
    }
    ts.forEachChild(node, scanWrites);
  };
  for (const sourceFile of sourceFiles) scanWrites(sourceFile);

  const targetForSymbol = (symbol: ts.Symbol | undefined): IrResolvedFunctionTarget | undefined => {
    const target = deAlias(symbol);
    if (!target || reassigned.has(target)) return undefined;
    const declarations = target.declarations ?? [];
    const functions = declarations.filter(ts.isFunctionDeclaration);
    // Overload sets and declaration merging are outside this exact slice.  A
    // single implementation plus one or more overload signatures is still an
    // overload set, so require exactly one FunctionDeclaration total.
    if (functions.length !== 1) return undefined;
    const declaration = functions[0]!;
    if (
      !declaration.body ||
      declaration.getSourceFile().isDeclarationFile ||
      !sourceSet.has(declaration.getSourceFile()) ||
      hasModifier(declaration, ts.SyntaxKind.DeclareKeyword)
    ) {
      return undefined;
    }
    // A different valueDeclaration means the symbol is merged/ambiguous even
    // when only one FunctionDeclaration happened to appear in declarations.
    if (target.valueDeclaration && target.valueDeclaration !== declaration) return undefined;
    const targetName = canonicalTargetName(declaration);
    if (!targetName || canonicalNameCounts.get(targetName) !== 1) return undefined;
    return { targetName, declaration };
  };

  const symbolAt = (node: ts.Identifier): ts.Symbol | undefined => {
    try {
      return checker.getSymbolAtLocation(node);
    } catch {
      return undefined;
    }
  };

  const importDeclarations = (node: ts.Identifier): readonly ts.Declaration[] => symbolAt(node)?.declarations ?? [];

  return {
    resolveImportedFunction(node) {
      const symbol = symbolAt(node);
      if (!symbol) return undefined;
      const declarations = symbol.declarations ?? [];
      // Namespace imports, import-equals, type-only imports, and identifiers
      // that merely happen to share an imported name are never direct-call
      // evidence.
      if (!declarations.some(isSupportedValueImportDeclaration)) return undefined;
      if (declarations.some((d) => isAnyImportDeclaration(d) && !isSupportedValueImportDeclaration(d))) {
        return undefined;
      }
      return targetForSymbol(symbol);
    },

    resolveTopLevelFunctionValue(node) {
      const target = targetForSymbol(symbolAt(node));
      if (!target) return undefined;
      const sourceFile = node.getSourceFile();
      if (target.declaration.getSourceFile() !== sourceFile) return undefined;
      if (!sourceFile.statements.some((statement) => statement === target.declaration)) return undefined;
      return target;
    },

    isImportBinding(node) {
      return importDeclarations(node).some(isAnyImportDeclaration);
    },
  };
}
