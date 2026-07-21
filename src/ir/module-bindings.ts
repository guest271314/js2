// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2856 Capability C — checker-backed module-binding identity shared by the
// selector and AST→IR builder. This module is deliberately leaf-shaped so the
// fallback gate can import it without pulling in codegen/index.ts.

import { isExternalDeclaredClass } from "../checker/type-mapper.js";
import { ts } from "../ts-api.js";

export type IrPrimitiveExpressionFamily = "number" | "boolean" | "string";
export type IrDeclaredPrimitiveExpressionFamily = IrPrimitiveExpressionFamily | "primitive-union";

/**
 * Build a checker-only ambient-binding predicate. Unlike the full module
 * binding resolver, this exposes no source storage capability, so backends
 * without module-global lowering can still distinguish the real lib `Math`
 * object from a source declaration or parameter with the same name.
 */
export function makeIrAmbientBindingPredicate(checker: ts.TypeChecker): (node: ts.Identifier) => boolean {
  return (node) => {
    try {
      const symbol = checker.getSymbolAtLocation(node);
      return (
        symbol !== undefined &&
        [symbol.valueDeclaration, ...(symbol.declarations ?? [])].some(
          (declaration) => declaration?.getSourceFile().isDeclarationFile === true,
        )
      );
    } catch {
      return false;
    }
  };
}

/**
 * Classify the receiver's declared checker surface for builtin-name routing.
 * This is intentionally distinct from the provenance-safe classifier below:
 * an invalid `const x: string = 1` must still be recognised as a primitive
 * builtin receiver and rejected before claim, while class/extern receivers
 * with the same method name keep ordinary dispatch. Mixed or nullable unions
 * containing a primitive get a sentinel family so they reject conservatively;
 * `any` and `unknown` remain unproven.
 */
export function makeIrDeclaredPrimitiveExpressionClassifier(
  checker: ts.TypeChecker,
): (expr: ts.Expression) => IrDeclaredPrimitiveExpressionFamily | undefined {
  const classifyType = (type: ts.Type): IrDeclaredPrimitiveExpressionFamily | undefined => {
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return undefined;
    if (type.isUnion()) {
      const families = new Set<IrPrimitiveExpressionFamily>();
      let sawNonPrimitive = false;
      let sawNullish = false;
      for (const member of type.types) {
        if ((member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) !== 0) {
          sawNullish = true;
          continue;
        }
        const family = classifyType(member);
        if (family === "primitive-union") {
          sawNonPrimitive = true;
        } else if (family !== undefined) {
          families.add(family);
        } else {
          sawNonPrimitive = true;
        }
      }
      if (families.size === 0) return undefined;
      if (families.size !== 1 || sawNonPrimitive || sawNullish) return "primitive-union";
      return families.values().next().value;
    }
    if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return "number";
    if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return "boolean";
    if ((type.flags & ts.TypeFlags.StringLike) !== 0) return "string";
    return undefined;
  };

  return (expr) => {
    try {
      return classifyType(checker.getTypeAtLocation(unwrapParens(expr)));
    } catch {
      return undefined;
    }
  };
}

/**
 * Build a provenance-safe primitive classifier for coercion-sensitive
 * builtin acceptance. This follows local initializers and ignores type
 * assertions, so diagnostics-off annotations cannot masquerade as runtime
 * evidence. Use makeIrDeclaredPrimitiveExpressionClassifier for routing.
 */
export function makeIrPrimitiveExpressionClassifier(
  checker: ts.TypeChecker,
): (expr: ts.Expression) => IrPrimitiveExpressionFamily | undefined {
  const classifyType = (type: ts.Type): IrPrimitiveExpressionFamily | undefined => {
    if (type.isUnion()) {
      const families = type.types.map(classifyType);
      const first = families[0];
      return first !== undefined && families.every((family) => family === first) ? first : undefined;
    }
    if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return "number";
    if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return "boolean";
    if ((type.flags & ts.TypeFlags.StringLike) !== 0) return "string";
    return undefined;
  };

  const classifyExpression = (
    expr: ts.Expression,
    seen: Set<ts.VariableDeclaration>,
  ): IrPrimitiveExpressionFamily | undefined => {
    try {
      const candidate = unwrapParens(expr);
      // A type assertion is not runtime evidence. Follow the represented
      // value so diagnostics-off inputs such as `"x" as number` cannot make
      // a coercion-sensitive builtin claim the function.
      if (
        ts.isAsExpression(candidate) ||
        ts.isTypeAssertionExpression(candidate) ||
        ts.isSatisfiesExpression(candidate) ||
        ts.isNonNullExpression(candidate)
      ) {
        return classifyExpression(candidate.expression, seen);
      }
      const family = classifyType(checker.getTypeAtLocation(candidate));
      if (family === undefined || !ts.isIdentifier(candidate)) return family;

      const symbol = checker.getSymbolAtLocation(candidate);
      const declaration = [symbol?.valueDeclaration, ...(symbol?.declarations ?? [])].find(
        (node): node is ts.VariableDeclaration =>
          node !== undefined && ts.isVariableDeclaration(node) && node.getSourceFile() === candidate.getSourceFile(),
      );
      if (!declaration) return family; // parameters and checker-owned nonlocals
      if (!declaration.initializer || seen.has(declaration)) return undefined;
      const nextSeen = new Set(seen);
      nextSeen.add(declaration);
      return classifyExpression(declaration.initializer, nextSeen) === family ? family : undefined;
    } catch {
      return undefined;
    }
  };

  return (expr) => classifyExpression(expr, new Set());
}

export type IrModuleBindingValueKind =
  | { readonly kind: "f64" }
  | { readonly kind: "i32"; readonly semantic: "boolean" }
  | { readonly kind: "extern"; readonly className: string };

export interface IrModuleBindingIdentity {
  /** The checker-resolved top-level declaration. Node identity is the key. */
  readonly declaration: ts.VariableDeclaration;
  readonly mutable: boolean;
  readonly valueKind: IrModuleBindingValueKind;
}

export interface IrModuleBindingResolver {
  (node: ts.Identifier, writeValue?: ts.Expression): IrModuleBindingIdentity | undefined;
  /** True for any checker-owned top-level lexical, including unsupported reps. */
  readonly isDirectModuleBinding: (node: ts.Identifier) => boolean;
  /** True when the identifier resolves to an ambient declaration-file symbol. */
  readonly isAmbientBinding: (node: ts.Identifier) => boolean;
  /** Resolve a local variable use to its exact declaration for alias tracking. */
  readonly localVariableDeclaration: (node: ts.Identifier) => ts.VariableDeclaration | undefined;
  /** Module extern arguments must keep their exact branded parameter ABI. */
  readonly externCallArgumentsMatch: (call: ts.CallExpression | ts.NewExpression) => boolean;
  /** True when a value can cross an extern member boundary without GC-ref boxing. */
  readonly externValueIsPassable: (value: ts.Expression) => boolean;
  /** Checker-backed scalar result family for provenance-preserving consumers. */
  readonly scalarExpressionFamily: (expr: ts.Expression) => "f64" | "boolean" | undefined;
  /** True when f64 `.toString()` lowers through the host string import. */
  readonly supportsHostNumberToString: boolean;
  /** Prove an initializer/RHS matches the binding's actual IR representation. */
  readonly bindingValueMatches: (node: ts.Identifier, value: ts.Expression) => boolean;
}

export interface IrModuleBindingResolverOptions {
  /** Actual legacy storage choice for an ordinary TS `number`. */
  readonly numberStorage: "f64" | "i32";
  /** Extern-class globals exist only on the JS-host lane. */
  readonly allowHostExterns: boolean;
  /**
   * Builtin Map uses an externref slot only in host-string mode. Native-string
   * lanes store it as `(ref null $Map)`, outside this capability's surface.
   */
  readonly allowBuiltinMapExtern: boolean;
}

// Builtins which are deliberately excluded by isExternalDeclaredClass but are
// registered in the legacy extern-class table on the JS-host lane. This keeps
// the already-landed #2856 C3 const-Map read path intact.
const MODULE_EXTERN_BUILTINS = new Set(["Map"]);
const NON_F64_NATIVE_NUMBER_ALIASES = new Set(["i8", "i16", "i32", "u8", "u16", "u32", "f32"]);

function directTopLevelDeclaration(node: ts.Identifier, checker: ts.TypeChecker): ts.VariableDeclaration | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  const sourceFile = node.getSourceFile();
  const candidates = [symbol.valueDeclaration, ...(symbol.declarations ?? [])];
  for (const candidate of candidates) {
    if (!candidate || !ts.isVariableDeclaration(candidate)) continue;
    if (candidate.getSourceFile() !== sourceFile) continue;
    if (!ts.isIdentifier(candidate.name)) continue;
    const list = candidate.parent;
    if (!ts.isVariableDeclarationList(list)) continue;
    const statement = list.parent;
    if (!ts.isVariableStatement(statement) || statement.parent !== sourceFile) continue;
    // Capability C is intentionally lexical-binding-only. Module `var`
    // hoisting has wider aliasing rules and stays on the legacy path.
    if (!(list.flags & ts.NodeFlags.Let) && !(list.flags & ts.NodeFlags.Const)) continue;
    return candidate;
  }
  return undefined;
}

function localVariableDeclaration(node: ts.Identifier, checker: ts.TypeChecker): ts.VariableDeclaration | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  const sourceFile = node.getSourceFile();
  const candidates = [symbol.valueDeclaration, ...(symbol.declarations ?? [])];
  return candidates.find(
    (candidate): candidate is ts.VariableDeclaration =>
      candidate !== undefined && ts.isVariableDeclaration(candidate) && candidate.getSourceFile() === sourceFile,
  );
}

function scalarKind(type: ts.Type, options: IrModuleBindingResolverOptions): IrModuleBindingValueKind | undefined {
  const alias = type.aliasSymbol?.name;
  if (alias === "f64" && (type.flags & ts.TypeFlags.NumberLike) !== 0) {
    return { kind: "f64" };
  }
  if (alias && NON_F64_NATIVE_NUMBER_ALIASES.has(alias) && (type.flags & ts.TypeFlags.NumberLike) !== 0) {
    return undefined;
  }
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) {
    return { kind: "i32", semantic: "boolean" };
  }
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) {
    // IR's semantic `number` remains f64. Fast mode stores ordinary numbers
    // as i32 in the legacy ABI, so claiming here would create f64/i32 body,
    // return, and module-init mismatches. Explicit f64 aliases were handled
    // above; numeric i32 aliases are not inferred because the checker erases
    // their storage-significant alias at this lookup site.
    return options.numberStorage === "f64" ? { kind: "f64" } : undefined;
  }
  return undefined;
}

function unwrapParens(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function externClassNameForType(
  type: ts.Type,
  checker: ts.TypeChecker,
  options: IrModuleBindingResolverOptions,
): string | undefined {
  const nonNull = checker.getNonNullableType(type);
  const className = nonNull.getSymbol()?.name ?? nonNull.aliasSymbol?.name;
  if (!className) return undefined;
  const builtinExtern =
    MODULE_EXTERN_BUILTINS.has(className) &&
    options.allowBuiltinMapExtern &&
    (nonNull.getSymbol()?.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile);
  if (MODULE_EXTERN_BUILTINS.has(className)) return builtinExtern ? className : undefined;
  return isExternalDeclaredClass(nonNull, checker) ? className : undefined;
}

function externValueSourceIsProven(
  checker: ts.TypeChecker,
  expr: ts.Expression,
  options: IrModuleBindingResolverOptions,
  seen: Set<ts.Node> = new Set(),
): boolean {
  const value = unwrapParens(expr);
  if (value.kind === ts.SyntaxKind.NullKeyword) return true;
  if (seen.has(value) || moduleExternValueNeedsLegacy(value)) return false;
  seen.add(value);
  if (!externClassNameForType(checker.getTypeAtLocation(value), checker, options)) return false;
  if (ts.isObjectLiteralExpression(value)) return false;
  if (ts.isAsExpression(value) || ts.isTypeAssertionExpression(value) || ts.isNonNullExpression(value)) {
    return externValueSourceIsProven(checker, value.expression, options, seen);
  }
  if (ts.isIdentifier(value)) {
    if (directTopLevelDeclaration(value, checker)) return true;
    const symbol = checker.getSymbolAtLocation(value);
    const declarations = [symbol?.valueDeclaration, ...(symbol?.declarations ?? [])].filter(
      (declaration): declaration is ts.Declaration => declaration !== undefined,
    );
    if (declarations.some((declaration) => declaration.getSourceFile().isDeclarationFile)) return true;
    const parameter = declarations.find(ts.isParameter);
    if (parameter) return true;
    const variable = declarations.find(ts.isVariableDeclaration);
    return variable?.initializer ? externValueSourceIsProven(checker, variable.initializer, options, seen) : false;
  }
  if (ts.isPropertyAccessExpression(value)) {
    const symbol = checker.getSymbolAtLocation(value.name);
    return (symbol?.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile);
  }
  if (ts.isCallExpression(value) || ts.isNewExpression(value)) {
    return checker.getResolvedSignature(value)?.getDeclaration()?.getSourceFile().isDeclarationFile === true;
  }
  return false;
}

function externValueIsPassable(
  checker: ts.TypeChecker,
  expr: ts.Expression,
  options: IrModuleBindingResolverOptions,
): boolean {
  const value = unwrapParens(expr);
  // Without the resolved legacy ValType, null is ambiguous: externref accepts
  // it, while nullable scalar declarations still use f64/i32 and reject it.
  if (value.kind === ts.SyntaxKind.NullKeyword) return false;
  const type = checker.getTypeAtLocation(value);
  if ((type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.StringLike)) !== 0) {
    return true;
  }
  if (!externClassNameForType(type, checker, options)) return false;
  return externValueSourceIsProven(checker, value, options);
}

function callReceiverIsModuleExtern(
  call: ts.CallExpression,
  resolve: (node: ts.Identifier) => IrModuleBindingIdentity | undefined,
): boolean {
  const visit = (expr: ts.Expression): boolean => {
    const candidate = unwrapParens(expr);
    if (ts.isIdentifier(candidate)) return resolve(candidate)?.valueKind.kind === "extern";
    if (ts.isPropertyAccessExpression(candidate)) return visit(candidate.expression);
    if (ts.isCallExpression(candidate)) return visit(candidate.expression);
    return false;
  };
  return ts.isPropertyAccessExpression(call.expression) && visit(call.expression.expression);
}

/**
 * Extern-valued conditionals and short-circuit expressions need control-flow
 * lowering that can preserve the branded externref on every arm. Capability C
 * deliberately leaves those shapes on the legacy path instead of accepting
 * them through checker assignability and failing after the IR claim.
 */
export function moduleExternValueNeedsLegacy(expr: ts.Expression): boolean {
  let needsLegacy = false;
  const visit = (node: ts.Node): void => {
    if (needsLegacy) return;
    if (
      ts.isConditionalExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isArrayLiteralExpression(node) ||
      (ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken))
    ) {
      needsLegacy = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(unwrapParens(expr));
  return needsLegacy;
}

function writeValueMatches(
  checker: ts.TypeChecker,
  targetType: ts.Type,
  targetKind: IrModuleBindingValueKind,
  value: ts.Expression,
  options: IrModuleBindingResolverOptions,
): boolean {
  const valueExpr = unwrapParens(value);
  if (targetKind.kind === "extern") {
    if (moduleExternValueNeedsLegacy(valueExpr)) return false;
    if (valueExpr.kind === ts.SyntaxKind.NullKeyword) return true;
    try {
      return (
        externValueSourceIsProven(checker, valueExpr, options) &&
        checker.isTypeAssignableTo(checker.getTypeAtLocation(valueExpr), targetType)
      );
    } catch {
      return false;
    }
  }
  let scalarShapeIsLowerable = true;
  const checkScalarShape = (node: ts.Node): void => {
    if (!scalarShapeIsLowerable) return;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      const operandType = checker.getTypeAtLocation(unwrapParens(node.operand));
      if ((operandType.flags & ts.TypeFlags.BooleanLike) === 0) {
        scalarShapeIsLowerable = false;
        return;
      }
    }
    if (ts.isConditionalExpression(node)) {
      const conditionType = checker.getTypeAtLocation(unwrapParens(node.condition));
      if ((conditionType.flags & ts.TypeFlags.BooleanLike) === 0) {
        scalarShapeIsLowerable = false;
        return;
      }
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
        const leftType = checker.getTypeAtLocation(unwrapParens(node.left));
        const rightType = checker.getTypeAtLocation(unwrapParens(node.right));
        if ((leftType.flags & ts.TypeFlags.BooleanLike) === 0 || (rightType.flags & ts.TypeFlags.BooleanLike) === 0) {
          scalarShapeIsLowerable = false;
          return;
        }
      }
      if (operator === ts.SyntaxKind.QuestionQuestionToken) {
        const leftType = checker.getTypeAtLocation(unwrapParens(node.left));
        if ((leftType.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) !== 0) {
          scalarShapeIsLowerable = false;
          return;
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiverType = checker.getTypeAtLocation(unwrapParens(node.expression.expression));
      const receiverIsNumber = (receiverType.flags & ts.TypeFlags.NumberLike) !== 0;
      const receiverIsBoolean = (receiverType.flags & ts.TypeFlags.BooleanLike) !== 0;
      const supportedNumberString =
        receiverIsNumber &&
        !receiverIsBoolean &&
        node.expression.name.text === "toString" &&
        node.arguments.length === 0 &&
        node.questionDotToken === undefined &&
        node.expression.questionDotToken === undefined;
      if ((receiverIsNumber || receiverIsBoolean) && !supportedNumberString) {
        scalarShapeIsLowerable = false;
        return;
      }
    }
    node.forEachChild(checkScalarShape);
  };
  checkScalarShape(valueExpr);
  if (!scalarShapeIsLowerable) return false;
  const valueKind = scalarKind(checker.getTypeAtLocation(valueExpr), options);
  if (!valueKind || valueKind.kind !== targetKind.kind) return false;
  return targetKind.kind !== "i32" || (valueKind.kind === "i32" && valueKind.semantic === targetKind.semantic);
}

export function makeIrModuleBindingResolver(
  checker: ts.TypeChecker,
  options: IrModuleBindingResolverOptions,
): IrModuleBindingResolver {
  const isAmbientBinding = makeIrAmbientBindingPredicate(checker);
  const resolve = (node: ts.Identifier, writeValue?: ts.Expression): IrModuleBindingIdentity | undefined => {
    try {
      const declaration = directTopLevelDeclaration(node, checker);
      if (!declaration) return undefined;
      const list = declaration.parent as ts.VariableDeclarationList;
      const statement = list.parent;
      // Ambient declarations establish a real checker identity but allocate no
      // legacy `__mod_*` slot. Keep them visible to isDirectModuleBinding below
      // so leaked flat scope names cannot impersonate them, while declining
      // them as supported storage here.
      if (
        declaration.getSourceFile().isDeclarationFile ||
        (ts.isVariableStatement(statement) &&
          statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword))
      ) {
        return undefined;
      }
      const mutable = (list.flags & ts.NodeFlags.Let) !== 0;
      if (writeValue !== undefined && !mutable) return undefined;

      const declaredType = checker.getTypeAtLocation(declaration.name);
      let valueKind = scalarKind(declaredType, options);
      if (!valueKind && options.allowHostExterns) {
        const className = externClassNameForType(declaredType, checker, options);
        if (className) {
          valueKind = { kind: "extern", className };
        }
      }
      if (!valueKind) return undefined;
      if (writeValue !== undefined && !writeValueMatches(checker, declaredType, valueKind, writeValue, options)) {
        return undefined;
      }
      return { declaration, mutable, valueKind };
    } catch {
      return undefined;
    }
  };
  return Object.assign(resolve, {
    isDirectModuleBinding(node: ts.Identifier): boolean {
      try {
        return directTopLevelDeclaration(node, checker) !== undefined;
      } catch {
        return false;
      }
    },
    isAmbientBinding(node: ts.Identifier): boolean {
      return isAmbientBinding(node);
    },
    localVariableDeclaration(node: ts.Identifier): ts.VariableDeclaration | undefined {
      try {
        return localVariableDeclaration(node, checker);
      } catch {
        return undefined;
      }
    },
    externCallArgumentsMatch(call: ts.CallExpression | ts.NewExpression): boolean {
      try {
        const containsModuleExtern = (node: ts.Node): boolean => {
          let found = false;
          const visit = (candidate: ts.Node): void => {
            if (found) return;
            if (ts.isIdentifier(candidate) && resolve(candidate)?.valueKind.kind === "extern") {
              found = true;
              return;
            }
            candidate.forEachChild(visit);
          };
          visit(node);
          return found;
        };
        const callArguments = call.arguments ?? [];
        const signature = checker.getResolvedSignature(call);
        const moduleExternReceiver = ts.isCallExpression(call) && callReceiverIsModuleExtern(call, resolve);
        if (!signature) return !moduleExternReceiver && !callArguments.some(containsModuleExtern);
        const parameters = signature.getParameters();
        const argumentMatches = (rawArgument: ts.Expression, parameterIndex: number): boolean => {
          const argument = unwrapParens(rawArgument);
          if (moduleExternReceiver && !externValueIsPassable(checker, argument, options)) return false;
          if (!ts.isIdentifier(argument)) return !containsModuleExtern(argument);
          const binding = resolve(argument);
          if (binding?.valueKind.kind !== "extern") return true;
          const parameter = parameters[parameterIndex];
          const parameterDeclaration = parameter?.valueDeclaration ?? parameter?.declarations?.[0];
          if (
            !parameter ||
            !parameterDeclaration ||
            (ts.isParameter(parameterDeclaration) && parameterDeclaration.dotDotDotToken)
          ) {
            return false;
          }
          const parameterType = checker.getNonNullableType(
            checker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration),
          );
          const parameterClassName = parameterType.getSymbol()?.name ?? parameterType.aliasSymbol?.name;
          return parameterClassName === binding.valueKind.className;
        };
        let parameterIndex = 0;
        for (const rawArgument of callArguments) {
          if (ts.isSpreadElement(rawArgument)) {
            const spreadSource = unwrapParens(rawArgument.expression);
            if (!ts.isArrayLiteralExpression(spreadSource)) return false;
            for (const element of spreadSource.elements) {
              if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) return false;
              if (!argumentMatches(element, parameterIndex)) return false;
              parameterIndex++;
            }
            continue;
          }
          if (!argumentMatches(rawArgument, parameterIndex)) return false;
          parameterIndex++;
        }
        return true;
      } catch {
        return false;
      }
    },
    externValueIsPassable(value: ts.Expression): boolean {
      try {
        return externValueIsPassable(checker, value, options);
      } catch {
        return false;
      }
    },
    scalarExpressionFamily(expr: ts.Expression): "f64" | "boolean" | undefined {
      try {
        const type = checker.getTypeAtLocation(unwrapParens(expr));
        if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return "boolean";
        if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return "f64";
        return undefined;
      } catch {
        return undefined;
      }
    },
    supportsHostNumberToString: options.allowHostExterns,
    bindingValueMatches(node: ts.Identifier, value: ts.Expression): boolean {
      try {
        const identity = resolve(node);
        if (!identity) return false;
        const declaredType = checker.getTypeAtLocation(identity.declaration.name);
        return writeValueMatches(checker, declaredType, identity.valueKind, value, options);
      } catch {
        return false;
      }
    },
  });
}
