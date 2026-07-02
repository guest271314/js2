// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2138 (Trap 4) — gate-4 host-node scan for the IR-first skip set.
//
// Pure, checker-free AST helpers used by `computeIrFirstSkipSet` in
// `src/codegen/index.ts` (and unit-tested directly — this lives in its own
// module so tests can import it without pulling the whole codegen entry
// module and its init-order-sensitive cycles).
import ts from "typescript";

/** Collect every top-level module binding name of a source file: function /
 *  class / enum declarations, `var`/`let`/`const` statements (including
 *  destructuring patterns), and import clause names. Used by the gate-4
 *  host-node scan: a receiver rooted at one of these is user code. */
export function collectModuleTopLevelNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const bind = (n: ts.BindingName): void => {
    if (ts.isIdentifier(n)) {
      names.add(n.text);
    } else {
      for (const el of n.elements) {
        if (ts.isBindingElement(el)) bind(el.name);
      }
    }
  };
  for (const stmt of sourceFile.statements) {
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) && stmt.name) {
      names.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) bind(d.name);
    } else if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const ic = stmt.importClause;
      if (ic.name) names.add(ic.name.text);
      if (ic.namedBindings) {
        if (ts.isNamespaceImport(ic.namedBindings)) names.add(ic.namedBindings.name.text);
        else for (const spec of ic.namedBindings.elements) names.add(spec.name.text);
      }
    }
  }
  return names;
}

/**
 * Gate 4 of `computeIrFirstSkipSet` (#2138 Trap 4 — coordination with the
 * extern-in-IR plan, `plan/issues/2856-ir-body-shape-rejected-to-zero.md`,
 * docs PR #2461): does this function's body read a HOST node — a property /
 * element access (or bare call) whose root receiver/callee identifier is
 * neither bound inside the function nor a module top-level binding?
 *
 * Why this exists BEFORE the #2856 selector arm lands: today the selector
 * rejects host-global receivers wholesale (`scope.has("document") === false`,
 * the #2454 recorder's host-global arm), so no claimed function contains one
 * and this gate is a no-op. The moment #2856's `HostMemberGet`/`HostMethodCall`
 * selector arm starts ACCEPTING them, any select↔from-ast drift on a skipped
 * function would hard-fail the compile (the skipped-slot promotion in
 * `generateModule`) — polluting the flag-on measurement (Slice 3) with a
 * known-unimplemented feature instead of real divergences. Per the #2856
 * spec's sequencing note ("#2138's skippable-closure computation must exclude
 * any function whose claim depends on a host node until this slice proves the
 * lowering" — the #2138 owner mirrors it here), host-node-reading functions
 * stay on the compile-twice path until the extern-in-IR lowering is proven,
 * at which point this gate is lifted deliberately (with a measurement re-run).
 *
 * Calibration — the scan must NOT be stricter than today's selector accepts,
 * or it would falsely exclude proven lowerings and depress the #2949 skip
 * rate. The selector's ONLY ambient-identifier accepts today are:
 *   - `Math.<IR_MATH_UNARY_WHITELIST>(x)` — root receiver `Math` (#1371);
 *     `Math` is therefore allowlisted here (non-whitelisted `Math.*` shapes
 *     are unclaimable anyway, so a claimed body's `Math` use is proven).
 *   - `new <KnownExternClass>(…)` (slice 10) — a NewExpression is treated as
 *     an opaque, sanctioned root (its callee is selector-gated), so chains
 *     like `new Uint8Array(4).length` are not flagged.
 * Everything else out-of-scope in receiver/callee root position is a host
 * node. Over-approximating LOCAL bindings (all names bound anywhere in the
 * function, any depth) is safe: a use-before-declaration the selector would
 * reject never reaches this gate (the function isn't claimed), and the
 * selector rejects host-global shadowing (`vardecl-shadow`) outright.
 */
export function irFirstBodyReadsHostNode(fn: ts.FunctionDeclaration, moduleNames: ReadonlySet<string>): boolean {
  if (!fn.body) return false;
  // --- collect every name bound anywhere inside the function ---
  const local = new Set<string>();
  if (fn.name) local.add(fn.name.text);
  const bind = (n: ts.BindingName): void => {
    if (ts.isIdentifier(n)) {
      local.add(n.text);
    } else {
      for (const el of n.elements) {
        if (ts.isBindingElement(el)) bind(el.name);
      }
    }
  };
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) bind(node.name);
    else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node)) &&
      node.name
    ) {
      local.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  for (const p of fn.parameters) bind(p.name);
  collect(fn.body);
  // --- walk the root of a receiver chain; NewExpression is an opaque,
  //     sanctioned root (its callee is selector-gated: local or extern class) ---
  const rootOf = (e: ts.Expression): ts.Expression => {
    let cur = e;
    for (;;) {
      if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) cur = cur.expression;
      else if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur) || ts.isAsExpression(cur))
        cur = cur.expression;
      else if (ts.isCallExpression(cur)) cur = cur.expression;
      else return cur; // Identifier, NewExpression, this, literal, …
    }
  };
  const isUserBound = (name: string): boolean => local.has(name) || moduleNames.has(name) || name === "Math";
  let host = false;
  const scan = (node: ts.Node): void => {
    if (host) return;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const root = rootOf(node.expression);
      if (ts.isIdentifier(root) && !isUserBound(root.text)) {
        host = true;
        return;
      }
    } else if (ts.isCallExpression(node)) {
      // Bare out-of-scope callee (`parseInt(…)`-class future arms).
      let callee: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
      if (ts.isIdentifier(callee) && !isUserBound(callee.text)) {
        host = true;
        return;
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(fn.body);
  return host;
}
