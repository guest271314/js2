// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Conservative checker-backed evidence for recursive top-level call-graph
// components. The general TypeMap intentionally uses optimistic arithmetic
// propagation; this certification layer prevents the linear IR selector from
// treating that optimism alone as an ABI proof for a recursive cycle.

import { forEachChild, ts } from "../ts-api.js";
import type { LatticeType, TypeMap, TypeMapEntry } from "./propagate.js";

export type RecursiveTypeEvidenceReason =
  | "ambiguous"
  | "polymorphic"
  | "escaping"
  | "higher-order"
  | "conflicting"
  | "any-based"
  | "unsupported";

export interface RecursiveTypeEvidenceDecision {
  readonly accepted: boolean;
  readonly component: readonly string[];
  readonly reason?: RecursiveTypeEvidenceReason;
  readonly detail?: string;
}

export interface RecursiveTypeEvidence {
  /** TypeMap entries for certified recursive functions only. */
  readonly typeMap: TypeMap;
  /** One decision for every member of every recursive SCC. */
  readonly decisions: ReadonlyMap<string, RecursiveTypeEvidenceDecision>;
  /**
   * Checker Type objects for expressions whose ordinary JS checker type is
   * `any`, but whose scalar kind was independently certified by the SCC fixed
   * point. Consumers overlay these narrowly; the source AST is untouched.
   */
  readonly checkerTypeOverrides: ReadonlyMap<ts.Node, ts.Type>;
}

type EvidenceKind = "f64" | "bool" | "string";

interface FunctionInfo {
  readonly name: string;
  readonly decl: ts.FunctionDeclaration;
  readonly symbol: ts.Symbol | undefined;
}

interface DirectCallSite {
  readonly target: string;
  readonly owner: string | null;
  readonly nested: boolean;
  readonly call: ts.CallExpression;
}

interface ExpressionEvidence {
  readonly kind: EvidenceKind | null;
  readonly anchored: boolean;
}

interface CandidateSignature {
  readonly params: readonly EvidenceKind[];
  readonly returnType: EvidenceKind;
}

/**
 * Certify recursive SCC signatures before the linear selector consumes the
 * propagated TypeMap. A component is accepted only when:
 *
 * - every signature position is a supported scalar TypeMap fact;
 * - no member is explicit-any, higher-order, exported, or used as a value;
 * - each parameter has a non-circular checker/annotation/caller anchor;
 * - every call argument agrees with the candidate signature; and
 * - a monotone return fixed point reaches every return expression without a
 *   conflict or an unanchored recursive-only equation.
 *
 * Rejection is component-wide. This is load-bearing: selecting only part of
 * an SCC would let the IR and direct linear paths disagree about call ABIs.
 */
export function buildRecursiveTypeEvidence(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  propagated: TypeMap,
): RecursiveTypeEvidence {
  const infos = collectTopLevelFunctions(sourceFile, checker);
  if (infos.size === 0) return { typeMap: new Map(), decisions: new Map(), checkerTypeOverrides: new Map() };

  const symbolNames = new Map<ts.Symbol, string>();
  for (const info of infos.values()) {
    if (info.symbol) symbolNames.set(info.symbol, info.name);
  }

  const calls: DirectCallSite[] = [];
  const escapes = new Set<string>();
  const graph = new Map<string, Set<string>>();
  for (const name of infos.keys()) graph.set(name, new Set());

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      const target = symbol ? symbolNames.get(symbol) : undefined;
      if (target) {
        const context = enclosingTopLevelFunction(node, sourceFile, infos);
        calls.push({ target, owner: context.owner, nested: context.nested, call: node });
        if (context.owner) graph.get(context.owner)?.add(target);
      }
    }

    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const target = symbol ? symbolNames.get(symbol) : undefined;
      if (target && !isDeclarationName(node, infos.get(target)!.decl) && !isDirectCallCallee(node)) {
        escapes.add(target);
      }
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);

  const components = recursiveComponents(graph, infos);
  const certified = new Map<string, TypeMapEntry>();
  const decisions = new Map<string, RecursiveTypeEvidenceDecision>();
  const checkerTypeOverrides = new Map<ts.Node, ts.Type>();
  let canonicalTypes: ReadonlyMap<EvidenceKind, ts.Type> | undefined;

  for (const component of components) {
    // Fully declared SCCs already have an authoritative ABI and retain the
    // selector's established behavior. This pass certifies only cycles that
    // need propagated evidence for at least one signature position.
    if (component.every((name) => hasCompleteSupportedDeclaration(infos.get(name)!.decl))) continue;
    // A declared non-scalar position (array/object/void/union/etc.) belongs to
    // the selector's existing type/shape gates, not this scalar evidence pass.
    // Keep its established fallback bucket. `any` and callable positions are
    // retained below because they require explicit conservative diagnostics.
    if (component.some((name) => hasUnsupportedDeclaredPosition(infos.get(name)!.decl))) continue;

    const componentSet = new Set(component);
    const reject = (reason: RecursiveTypeEvidenceReason): void => {
      const decision: RecursiveTypeEvidenceDecision = {
        accepted: false,
        component,
        reason,
        detail: `recursive-type-evidence:${reason}`,
      };
      for (const name of component) decisions.set(name, decision);
    };

    let structuralReason: RecursiveTypeEvidenceReason | null = null;
    for (const name of component) {
      const info = infos.get(name)!;
      if (hasExplicitAny(info.decl)) {
        structuralReason = "any-based";
        break;
      }
      if (hasHigherOrderSignatureOrCall(info.decl, checker)) {
        structuralReason = "higher-order";
        break;
      }
      if (escapes.has(name) || info.decl.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        structuralReason = "escaping";
        break;
      }
      if (calls.some((site) => site.target === name && site.nested)) {
        structuralReason = "higher-order";
        break;
      }
      if (calls.some((site) => site.target === name && site.owner === null)) {
        structuralReason = "escaping";
        break;
      }
    }
    if (structuralReason) {
      reject(structuralReason);
      continue;
    }

    const signatures = new Map<string, CandidateSignature>();
    let signatureReason: RecursiveTypeEvidenceReason | null = null;
    for (const name of component) {
      const entry = propagated.get(name);
      if (!entry || entry.params.length !== infos.get(name)!.decl.parameters.length) {
        signatureReason = "ambiguous";
        break;
      }
      const params: EvidenceKind[] = [];
      for (const param of entry.params) {
        const kind = latticeKind(param);
        if (!kind) {
          // Multiple concrete observations for one parameter are call-site
          // polymorphism. Do not let an arbitrary member of that union
          // become the recursive ABI.
          signatureReason = param.kind === "union" ? "polymorphic" : latticeRejectReason(param);
          break;
        }
        params.push(kind);
      }
      if (signatureReason) break;
      const returnType = latticeKind(entry.returnType);
      if (!returnType) {
        // A concrete return union is an internally conflicting contract,
        // rather than caller-driven parameter polymorphism.
        signatureReason = entry.returnType.kind === "union" ? "conflicting" : latticeRejectReason(entry.returnType);
        break;
      }
      signatures.set(name, { params, returnType });
    }
    if (signatureReason) {
      reject(signatureReason);
      continue;
    }

    const componentCalls = calls.filter((site) => componentSet.has(site.target));
    let callShapeInvalid = false;
    for (const site of componentCalls) {
      const signature = signatures.get(site.target)!;
      if (
        site.call.arguments.length !== signature.params.length ||
        site.call.arguments.some((argument) => ts.isSpreadElement(argument))
      ) {
        callShapeInvalid = true;
        break;
      }
    }
    if (callShapeInvalid) {
      reject("conflicting");
      continue;
    }

    // A concrete disagreement across call sites is polymorphism, regardless
    // of which candidate the optimistic TypeMap happened to retain.
    let polymorphic = false;
    for (const name of component) {
      const signature = signatures.get(name)!;
      const inbound = componentCalls.filter((site) => site.target === name);
      for (let index = 0; index < signature.params.length; index++) {
        const observed = new Set<EvidenceKind>();
        for (const site of inbound) {
          const kind = checkerKindAt(site.call.arguments[index]!, checker);
          if (kind) observed.add(kind);
        }
        if (observed.size > 1) {
          polymorphic = true;
          break;
        }
      }
      if (polymorphic) break;
    }
    if (polymorphic) {
      reject("polymorphic");
      continue;
    }

    const paramSymbols = collectComponentParamSymbols(component, infos, checker);
    const locals = collectStableLocalInitializers(component, infos, checker);
    const paramAnchors = new Map<string, boolean[]>();
    const returnAnchors = new Map<string, boolean>();
    for (const name of component) {
      const info = infos.get(name)!;
      const signature = signatures.get(name)!;
      paramAnchors.set(
        name,
        info.decl.parameters.map((param, index) => declarationKind(param, checker) === signature.params[index]),
      );
      returnAnchors.set(name, declarationReturnKind(info.decl, checker) === signature.returnType);
    }

    const infer = (expression: ts.Expression): ExpressionEvidence =>
      inferExpressionEvidence(
        expression,
        checker,
        componentSet,
        symbolNames,
        paramSymbols,
        locals,
        signatures,
        paramAnchors,
        returnAnchors,
      );

    // Parameter anchors flow from explicit/checker declarations and from
    // call arguments whose own dependencies are already anchored. Since bits
    // only flip false→true, the bound is the total number of parameter slots.
    const paramSlotCount = [...signatures.values()].reduce((sum, signature) => sum + signature.params.length, 0);
    for (let round = 0; round <= paramSlotCount; round++) {
      let changed = false;
      for (const site of componentCalls) {
        const signature = signatures.get(site.target)!;
        const anchors = paramAnchors.get(site.target)!;
        for (let index = 0; index < signature.params.length; index++) {
          if (anchors[index]) continue;
          const evidence = infer(site.call.arguments[index]!);
          if (evidence.kind === signature.params[index] && evidence.anchored) {
            anchors[index] = true;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }

    if ([...paramAnchors.values()].some((anchors) => anchors.some((anchored) => !anchored))) {
      reject("ambiguous");
      continue;
    }

    let callReason: RecursiveTypeEvidenceReason | null = null;
    for (const site of componentCalls) {
      const signature = signatures.get(site.target)!;
      for (let index = 0; index < signature.params.length; index++) {
        const evidence = infer(site.call.arguments[index]!);
        if (evidence.kind === null || !evidence.anchored) {
          callReason = "ambiguous";
          break;
        }
        if (evidence.kind !== signature.params[index]) {
          callReason = "conflicting";
          break;
        }
      }
      if (callReason) break;
    }
    if (callReason) {
      reject(callReason);
      continue;
    }

    const returns = new Map<string, readonly ts.ReturnStatement[]>();
    for (const name of component) returns.set(name, collectReturns(infos.get(name)!.decl));

    // Return evidence is another monotone fixed point. A base return (fib's
    // `return n`) anchors the SCC; recursive returns become anchored only in a
    // later round. A pure equation `f -> f` never gains evidence.
    for (let round = 0; round <= component.length; round++) {
      let changed = false;
      for (const name of component) {
        if (returnAnchors.get(name)) continue;
        const expected = signatures.get(name)!.returnType;
        let hasAnchor = false;
        for (const statement of returns.get(name)!) {
          if (!statement.expression) continue;
          const evidence = infer(statement.expression);
          if (evidence.kind === expected && evidence.anchored) {
            hasAnchor = true;
            break;
          }
        }
        if (hasAnchor) {
          returnAnchors.set(name, true);
          changed = true;
        }
      }
      if (!changed) break;
    }

    let returnReason: RecursiveTypeEvidenceReason | null = null;
    for (const name of component) {
      const expected = signatures.get(name)!.returnType;
      const statements = returns.get(name)!;
      if (statements.length === 0 || !returnAnchors.get(name)) {
        returnReason = "ambiguous";
        break;
      }
      for (const statement of statements) {
        if (!statement.expression) {
          returnReason = "conflicting";
          break;
        }
        const evidence = infer(statement.expression);
        if (evidence.kind === null || !evidence.anchored) {
          returnReason = "ambiguous";
          break;
        }
        if (evidence.kind !== expected) {
          returnReason = "conflicting";
          break;
        }
      }
      if (returnReason) break;
    }
    if (returnReason) {
      reject(returnReason);
      continue;
    }

    const decision: RecursiveTypeEvidenceDecision = { accepted: true, component };
    const acceptedCanonicalTypes = (canonicalTypes ??= collectCanonicalCheckerTypes(sourceFile, checker));
    for (const name of component) {
      certified.set(name, propagated.get(name)!);
      decisions.set(name, decision);
      collectExpressionTypeOverrides(
        infos.get(name)!.decl,
        checker,
        infer,
        acceptedCanonicalTypes,
        checkerTypeOverrides,
      );
    }
    for (const site of componentCalls) {
      const kind = signatures.get(site.target)!.returnType;
      const type = acceptedCanonicalTypes.get(kind);
      if (type && checkerKindAt(site.call, checker) === null) checkerTypeOverrides.set(site.call, type);
    }
  }

  return { typeMap: certified, decisions, checkerTypeOverrides };
}

function collectCanonicalCheckerTypes(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ReadonlyMap<EvidenceKind, ts.Type> {
  const types = new Map<EvidenceKind, ts.Type>();
  const visit = (node: ts.Node): void => {
    try {
      const type = checker.getTypeAtLocation(node);
      const kind = checkerKind(type);
      const current = kind ? types.get(kind) : undefined;
      if (
        kind &&
        (!current || ((current.flags & ts.TypeFlags.Literal) !== 0 && (type.flags & ts.TypeFlags.Literal) === 0))
      ) {
        types.set(kind, type);
      }
    } catch {
      // Absence of a checker type simply leaves that evidence kind unable
      // to override an `any` expression later.
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return types;
}

function collectExpressionTypeOverrides(
  declaration: ts.FunctionDeclaration,
  checker: ts.TypeChecker,
  infer: (expression: ts.Expression) => ExpressionEvidence,
  canonicalTypes: ReadonlyMap<EvidenceKind, ts.Type>,
  overrides: Map<ts.Node, ts.Type>,
): void {
  const visit = (node: ts.Node): void => {
    if (node !== declaration.body && isFunctionBoundary(node)) return;
    if (ts.isExpression(node)) {
      const evidence = infer(node);
      const type = evidence.kind ? canonicalTypes.get(evidence.kind) : undefined;
      if (evidence.anchored && type && checkerKindAt(node, checker) === null) overrides.set(node, type);
    }
    forEachChild(node, visit);
  };
  visit(declaration.body!);
}

function collectTopLevelFunctions(sourceFile: ts.SourceFile, checker: ts.TypeChecker): Map<string, FunctionInfo> {
  const infos = new Map<string, FunctionInfo>();
  const duplicates = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
    const name = statement.name.text;
    if (duplicates.has(name)) continue;
    if (infos.has(name)) {
      infos.delete(name); // overload/duplicate declarations are not certifiable
      duplicates.add(name);
      continue;
    }
    infos.set(name, { name, decl: statement, symbol: checker.getSymbolAtLocation(statement.name) });
  }
  return infos;
}

function enclosingTopLevelFunction(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  infos: ReadonlyMap<string, FunctionInfo>,
): { owner: string | null; nested: boolean } {
  for (let current = node.parent; current && current !== sourceFile; current = current.parent) {
    if (!isFunctionBoundary(current)) continue;
    if (ts.isFunctionDeclaration(current) && current.parent === sourceFile && current.name) {
      const info = infos.get(current.name.text);
      if (info?.decl === current) return { owner: info.name, nested: false };
    }
    return { owner: null, nested: true };
  }
  return { owner: null, nested: false };
}

function isFunctionBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function isDeclarationName(node: ts.Identifier, declaration: ts.FunctionDeclaration): boolean {
  return declaration.name === node;
}

function isDirectCallCallee(node: ts.Identifier): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

function recursiveComponents(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  infos: ReadonlyMap<string, FunctionInfo>,
): readonly (readonly string[])[] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const strongConnect = (name: string): void => {
    indices.set(name, nextIndex);
    low.set(name, nextIndex);
    nextIndex++;
    stack.push(name);
    onStack.add(name);

    for (const callee of graph.get(name) ?? []) {
      if (!indices.has(callee)) {
        strongConnect(callee);
        low.set(name, Math.min(low.get(name)!, low.get(callee)!));
      } else if (onStack.has(callee)) {
        low.set(name, Math.min(low.get(name)!, indices.get(callee)!));
      }
    }

    if (low.get(name) !== indices.get(name)) return;
    const component: string[] = [];
    for (;;) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === name) break;
    }
    component.sort((a, b) => infos.get(a)!.decl.pos - infos.get(b)!.decl.pos);
    if (component.length > 1 || graph.get(component[0]!)?.has(component[0]!)) components.push(component);
  };

  for (const name of infos.keys()) {
    if (!indices.has(name)) strongConnect(name);
  }
  components.sort((a, b) => infos.get(a[0]!)!.decl.pos - infos.get(b[0]!)!.decl.pos);
  return components;
}

function latticeKind(type: LatticeType): EvidenceKind | null {
  if (type.kind === "f64" || type.kind === "bool" || type.kind === "string") return type.kind;
  return null;
}

function latticeRejectReason(type: LatticeType): RecursiveTypeEvidenceReason {
  if (type.kind === "union") return "polymorphic";
  if (type.kind === "unknown" || type.kind === "dynamic") return "ambiguous";
  return "unsupported";
}

function effectiveParamTypeNode(param: ts.ParameterDeclaration): ts.TypeNode | undefined {
  return param.type ?? ts.getJSDocType(param);
}

function effectiveReturnTypeNode(declaration: ts.FunctionDeclaration): ts.TypeNode | undefined {
  return declaration.type ?? ts.getJSDocReturnType(declaration);
}

function nodeKind(node: ts.TypeNode | undefined): EvidenceKind | null {
  if (!node) return null;
  if (node.kind === ts.SyntaxKind.NumberKeyword) return "f64";
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return "bool";
  if (node.kind === ts.SyntaxKind.StringKeyword) return "string";
  return null;
}

function hasCompleteSupportedDeclaration(declaration: ts.FunctionDeclaration): boolean {
  return (
    declaration.parameters.every((param) => nodeKind(effectiveParamTypeNode(param)) !== null) &&
    nodeKind(effectiveReturnTypeNode(declaration)) !== null
  );
}

function hasUnsupportedDeclaredPosition(declaration: ts.FunctionDeclaration): boolean {
  const unsupported = (node: ts.TypeNode | undefined): boolean =>
    node !== undefined &&
    nodeKind(node) === null &&
    node.kind !== ts.SyntaxKind.AnyKeyword &&
    !ts.isFunctionTypeNode(node);
  return (
    declaration.parameters.some((param) => unsupported(effectiveParamTypeNode(param))) ||
    unsupported(effectiveReturnTypeNode(declaration))
  );
}

function hasExplicitAny(declaration: ts.FunctionDeclaration): boolean {
  if (effectiveReturnTypeNode(declaration)?.kind === ts.SyntaxKind.AnyKeyword) return true;
  return declaration.parameters.some((param) => effectiveParamTypeNode(param)?.kind === ts.SyntaxKind.AnyKeyword);
}

function hasHigherOrderSignatureOrCall(declaration: ts.FunctionDeclaration, checker: ts.TypeChecker): boolean {
  const paramSymbols = new Set<ts.Symbol>();
  for (const param of declaration.parameters) {
    const effective = effectiveParamTypeNode(param);
    if (effective && ts.isFunctionTypeNode(effective)) return true;
    const symbol = ts.isIdentifier(param.name) ? checker.getSymbolAtLocation(param.name) : undefined;
    if (symbol) paramSymbols.add(symbol);
    try {
      if (checker.getTypeAtLocation(param).getCallSignatures().length > 0) return true;
    } catch {
      return true;
    }
  }

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== declaration.body && isFunctionBoundary(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      if (symbol && paramSymbols.has(symbol)) {
        found = true;
        return;
      }
    }
    forEachChild(node, visit);
  };
  if (declaration.body) visit(declaration.body);
  return found;
}

function checkerKind(type: ts.Type): EvidenceKind | null {
  if (type.isUnion()) {
    const kinds = type.types.map(checkerKind);
    if (kinds.some((kind) => kind === null)) return null;
    const members = new Set(kinds as EvidenceKind[]);
    return members.size === 1 ? [...members][0]! : null;
  }
  const flags = type.flags;
  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return null;
  if (flags & ts.TypeFlags.NumberLike) return "f64";
  if (flags & ts.TypeFlags.BooleanLike) return "bool";
  if (flags & ts.TypeFlags.StringLike) return "string";
  return null;
}

function checkerKindAt(node: ts.Node, checker: ts.TypeChecker): EvidenceKind | null {
  try {
    return checkerKind(checker.getTypeAtLocation(node));
  } catch {
    return null;
  }
}

function declarationKind(param: ts.ParameterDeclaration, checker: ts.TypeChecker): EvidenceKind | null {
  return nodeKind(effectiveParamTypeNode(param)) ?? checkerKindAt(param, checker);
}

function declarationReturnKind(declaration: ts.FunctionDeclaration, checker: ts.TypeChecker): EvidenceKind | null {
  const explicit = nodeKind(effectiveReturnTypeNode(declaration));
  if (explicit) return explicit;
  try {
    const signature = checker.getSignatureFromDeclaration(declaration);
    return signature ? checkerKind(signature.getReturnType()) : null;
  } catch {
    return null;
  }
}

function collectComponentParamSymbols(
  component: readonly string[],
  infos: ReadonlyMap<string, FunctionInfo>,
  checker: ts.TypeChecker,
): Map<ts.Symbol, { readonly owner: string; readonly index: number }> {
  const symbols = new Map<ts.Symbol, { owner: string; index: number }>();
  for (const name of component) {
    const declaration = infos.get(name)!.decl;
    for (let index = 0; index < declaration.parameters.length; index++) {
      const param = declaration.parameters[index]!;
      if (!ts.isIdentifier(param.name)) continue;
      const symbol = checker.getSymbolAtLocation(param.name);
      if (symbol) symbols.set(symbol, { owner: name, index });
    }
  }
  return symbols;
}

function collectStableLocalInitializers(
  component: readonly string[],
  infos: ReadonlyMap<string, FunctionInfo>,
  checker: ts.TypeChecker,
): ReadonlyMap<ts.Symbol, ts.Expression> {
  const initializers = new Map<ts.Symbol, ts.Expression>();
  const mutated = new Set<ts.Symbol>();
  for (const name of component) {
    const declaration = infos.get(name)!.decl;
    const visit = (node: ts.Node): void => {
      if (node !== declaration.body && isFunctionBoundary(node)) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) initializers.set(symbol, node.initializer);
      }
      if (
        ts.isBinaryExpression(node) &&
        ts.isIdentifier(node.left) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const symbol = checker.getSymbolAtLocation(node.left);
        if (symbol) mutated.add(symbol);
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand)) {
        if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
          const symbol = checker.getSymbolAtLocation(node.operand);
          if (symbol) mutated.add(symbol);
        }
      }
      forEachChild(node, visit);
    };
    visit(declaration.body!);
  }
  for (const symbol of mutated) initializers.delete(symbol);
  return initializers;
}

function inferExpressionEvidence(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  component: ReadonlySet<string>,
  symbolNames: ReadonlyMap<ts.Symbol, string>,
  paramSymbols: ReadonlyMap<ts.Symbol, { readonly owner: string; readonly index: number }>,
  localInitializers: ReadonlyMap<ts.Symbol, ts.Expression>,
  signatures: ReadonlyMap<string, CandidateSignature>,
  paramAnchors: ReadonlyMap<string, readonly boolean[]>,
  returnAnchors: ReadonlyMap<string, boolean>,
  visitingLocals: ReadonlySet<ts.Symbol> = new Set(),
): ExpressionEvidence {
  let kind = checkerKindAt(expression, checker);
  let anchored = true;

  const visit = (node: ts.Node): void => {
    if (!anchored) return;
    if (node !== expression && isFunctionBoundary(node)) {
      anchored = false;
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      const target = symbol ? symbolNames.get(symbol) : undefined;
      if (target && component.has(target) && !returnAnchors.get(target)) anchored = false;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) {
        const param = paramSymbols.get(symbol);
        if (param && !paramAnchors.get(param.owner)?.[param.index]) anchored = false;
        const initializer = localInitializers.get(symbol);
        if (initializer && !visitingLocals.has(symbol)) {
          const next = new Set(visitingLocals);
          next.add(symbol);
          const local = inferExpressionEvidence(
            initializer,
            checker,
            component,
            symbolNames,
            paramSymbols,
            localInitializers,
            signatures,
            paramAnchors,
            returnAnchors,
            next,
          );
          if (!local.anchored) anchored = false;
          if (kind === null) kind = local.kind;
        }
      }
    }
    forEachChild(node, visit);
  };
  visit(expression);

  if (kind === null) {
    const nestedKind = (nested: ts.Expression): EvidenceKind | null =>
      inferExpressionEvidence(
        nested,
        checker,
        component,
        symbolNames,
        paramSymbols,
        localInitializers,
        signatures,
        paramAnchors,
        returnAnchors,
        visitingLocals,
      ).kind;

    if (ts.isNumericLiteral(expression)) {
      kind = "f64";
    } else if (ts.isStringLiteralLike(expression)) {
      kind = "string";
    } else if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) {
      kind = "bool";
    } else if (ts.isParenthesizedExpression(expression)) {
      kind = nestedKind(expression.expression);
    } else if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression);
      const param = symbol ? paramSymbols.get(symbol) : undefined;
      if (param) {
        kind = signatures.get(param.owner)?.params[param.index] ?? null;
      } else {
        const initializer = symbol ? localInitializers.get(symbol) : undefined;
        if (initializer && !visitingLocals.has(symbol!)) kind = nestedKind(initializer);
      }
    } else if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
      const symbol = checker.getSymbolAtLocation(expression.expression);
      const target = symbol ? symbolNames.get(symbol) : undefined;
      if (target && component.has(target)) kind = signatures.get(target)?.returnType ?? null;
    } else if (ts.isPrefixUnaryExpression(expression)) {
      const operand = nestedKind(expression.operand);
      if (expression.operator === ts.SyntaxKind.ExclamationToken) kind = "bool";
      else if (
        operand === "f64" &&
        (expression.operator === ts.SyntaxKind.PlusToken ||
          expression.operator === ts.SyntaxKind.MinusToken ||
          expression.operator === ts.SyntaxKind.TildeToken)
      ) {
        kind = "f64";
      }
    } else if (ts.isConditionalExpression(expression)) {
      const whenTrue = nestedKind(expression.whenTrue);
      const whenFalse = nestedKind(expression.whenFalse);
      if (whenTrue === whenFalse) kind = whenTrue;
    } else if (ts.isBinaryExpression(expression)) {
      const left = nestedKind(expression.left);
      const right = nestedKind(expression.right);
      const operator = expression.operatorToken.kind;
      if (operator === ts.SyntaxKind.PlusToken) {
        if (left === right && (left === "f64" || left === "string")) kind = left;
      } else if (isNumericBinaryOperator(operator) && left === "f64" && right === "f64") {
        kind = "f64";
      } else if (isComparisonOperator(operator) && left !== null && right !== null) {
        kind = "bool";
      } else if (
        (operator === ts.SyntaxKind.AmpersandAmpersandToken ||
          operator === ts.SyntaxKind.BarBarToken ||
          operator === ts.SyntaxKind.QuestionQuestionToken) &&
        left === right
      ) {
        kind = left;
      } else if (operator === ts.SyntaxKind.CommaToken) {
        kind = right;
      }
    }
  }

  return { kind, anchored };
}

function isNumericBinaryOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.MinusToken ||
    kind === ts.SyntaxKind.AsteriskToken ||
    kind === ts.SyntaxKind.SlashToken ||
    kind === ts.SyntaxKind.PercentToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskToken
  );
}

function isComparisonOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    kind === ts.SyntaxKind.LessThanToken ||
    kind === ts.SyntaxKind.LessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanToken ||
    kind === ts.SyntaxKind.GreaterThanEqualsToken
  );
}

function collectReturns(declaration: ts.FunctionDeclaration): readonly ts.ReturnStatement[] {
  const returns: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== declaration.body && isFunctionBoundary(node)) return;
    if (ts.isReturnStatement(node)) {
      returns.push(node);
      return;
    }
    forEachChild(node, visit);
  };
  visit(declaration.body!);
  return returns;
}
