// (#802) Dynamic prototype support — pre-scan.
//
// `Object.setPrototypeOf(o, p)`, `Reflect.setPrototypeOf(o, p)` and
// `o.__proto__ = p` mutate an object's [[Prototype]] at runtime. The open
// `$Object` hash-map runtime (src/codegen/object-runtime.ts) already carries a
// mutable `$proto` at field 0 and the native `__object_setPrototypeOf` /
// `__getPrototypeOf` helpers give it full, correct, standalone dynamic-prototype
// semantics. A plain object literal, however, is normally lowered to a
// closed-shape WasmGC struct which has no `$proto` field — so in `--target
// standalone` `__object_setPrototypeOf`'s `ref.test $Object` fails on it and the
// link is silently dropped (inherited reads then return `undefined`/0).
//
// SLICE A (this file's only consumer today): detect object-literal RECEIVERS of
// these proto-mutation operations and promote just those literals to the open
// `$Object` representation at lowering time (see `compileObjectLiteral` in
// literals.ts). `$Object` inherits the entire existing setPrototypeOf / read /
// getPrototypeOf machine for free, so this needs ZERO struct-layout change.
//
// The scan is a cheap structural AST walk (no type queries), gated so a module
// that never mutates a prototype is byte-for-byte unchanged (`usesDynamicProto`
// stays false, `dynamicProtoLiteralNodes` stays empty). Detection is a
// deliberately CONSERVATIVE over-approximation: promoting an extra literal to
// `$Object` is always semantically correct (a `$Object` is a fully-correct
// object representation), so a false-positive costs only a little perf, never
// correctness — whereas UNDER-marking a real receiver would silently drop its
// proto. See the issue spec §5 ("never silently wrong").
//
// NOTE: `dynamicProtoClasses` (class-instance receivers) is intentionally NOT
// populated here yet — that is Slice B, which appends a conditional
// `$__proto__` struct field. This prescan is written so Slice B extends the same
// walk to populate that set without re-touching Slice A.

import { ts, forEachChild } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/**
 * Walk up the lexical scope chain from `id` looking for a `const`/`let`/`var`
 * binding of the same name whose initializer is an object literal, returning
 * that literal node. Scope-owning nodes are source files, blocks and module
 * blocks (a function body IS a block, so a binding at function-top is found when
 * the walk reaches that body block). Nearest scope wins. Returns `undefined`
 * when the identifier does not resolve to an in-scope object-literal binding
 * (e.g. a parameter, an imported/reassigned name, or a class instance — the
 * latter is Slice B's concern).
 */
function findObjectLiteralBinding(id: ts.Identifier): ts.ObjectLiteralExpression | undefined {
  const name = id.text;
  let node: ts.Node | undefined = id.parent;
  while (node) {
    let statements: readonly ts.Statement[] | undefined;
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
      statements = node.statements;
    }
    if (statements) {
      for (const st of statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const decl of st.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.name.text === name &&
            decl.initializer !== undefined &&
            ts.isObjectLiteralExpression(decl.initializer)
          ) {
            return decl.initializer;
          }
        }
      }
    }
    node = node.parent;
  }
  return undefined;
}

/**
 * Pre-scan the source for object-literal receivers of prototype-mutation
 * operations. Populates `ctx.usesDynamicProto` and `ctx.dynamicProtoLiteralNodes`
 * (Slice A). Cheap structural walk; runs once before body compilation, mirroring
 * `scanForNewTarget` / `scanForArrayHoles`.
 */
export function scanForDynamicProto(ctx: CodegenContext, root: ts.Node): void {
  const markReceiver = (recv: ts.Expression | undefined): void => {
    // Unwrap the transparent expression wrappers so `(o as any)`, `(o)!`,
    // `(o)`, `<any>o` all resolve to their inner receiver — the same wrappers
    // the read-side `resolveStructName` overrides strip (property-access.ts).
    let node: ts.Expression | undefined = recv;
    while (
      node &&
      (ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isTypeAssertionExpression(node))
    ) {
      node = (node as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression;
    }
    if (!node) return;
    if (ts.isObjectLiteralExpression(node)) {
      ctx.usesDynamicProto = true;
      ctx.dynamicProtoLiteralNodes.add(node);
      return;
    }
    if (ts.isIdentifier(node)) {
      const lit = findObjectLiteralBinding(node);
      if (lit) {
        ctx.usesDynamicProto = true;
        ctx.dynamicProtoLiteralNodes.add(lit);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    // Object.setPrototypeOf(X, _) / Reflect.setPrototypeOf(X, _)
    //   — X is the RECEIVER. Object.create(_) is NOT a receiver (it MAKES an
    //   object, which is already a `$Object`), so it is deliberately excluded.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === "Object" || node.expression.expression.text === "Reflect") &&
      node.expression.name.text === "setPrototypeOf" &&
      node.arguments.length >= 1
    ) {
      markReceiver(node.arguments[0]);
    }

    // X.__proto__ = _  (legacy [[Prototype]] setter; §B.3.1). X is the receiver.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "__proto__"
    ) {
      markReceiver(node.left.expression);
    }

    forEachChild(node, visit);
  };

  visit(root);
}
