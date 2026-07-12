// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2138 (Trap 4) — gate-4 host-node scan for the IR-first skip set.
//
// Pure, checker-free AST helpers used by `computeIrFirstSkipSet` in
// `src/codegen/index.ts` (and unit-tested directly — this lives in its own
// module so tests can import it without pulling the whole codegen entry
// module and its init-order-sensitive cycles).
import ts from "typescript";

// (#2972) Single-source string-element-read predicates — shared with the
// from-ast lowering arm so the gate and the builder cannot drift.
// capability.ts is a dependency-free leaf (ts-api only), so this import
// preserves this module's no-codegen-entry-cycle property.
import { collectStringLiteralLens, stringElementReadLowerable } from "../ir/capability.js";

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

/**
 * Gate 5 of `computeIrFirstSkipSet` (#2972) — does this function's body read
 * an element of a STRING receiver (`s[i]`)?
 *
 * The IR front-end has no string-element-read lowering at all: `from-ast.ts`'s
 * `lowerElementAccess` dispatches only object-field (string-literal key) and
 * vec (`array.get`) receivers; a `string`-typed receiver — with a constant
 * OR a computed index — falls through to a hard `throw` ("element access on
 * string … not in slice 12"). The selector's element-access arm, however,
 * accepts the shape structurally (`isPhase1Expr(recv) && isPhase1Expr(index)`)
 * because it is checker-free (`scope: ReadonlySet<string>` carries no types)
 * and therefore cannot distinguish a string receiver from a vec receiver.
 *
 * Flag-OFF that from-ast throw silently demotes the function to legacy (which
 * indexes strings correctly, incl. OOB→undefined). Flag-ON (IR-first), a
 * CLAIMED function that throws during lowering is promoted to a HARD compile
 * error (the `unreachable` placeholder must never ship) — the designed #2138
 * surfacing. That turned 14 test262 helper functions (the `decimalToHexString`
 * / `decimalToPercentHexString` harness, `hex[(n>>4)&0xf]`) into
 * `pass → compile_error` regressions flag-on.
 *
 * Since the selector cannot type-resolve the receiver, the guard lives here:
 * keep any function with an UNPROVEN string-element read on the compile-twice
 * path (legacy + silently-demoting overlay) — exactly the compile-twice
 * deferral gate 4 uses for host nodes.
 *
 * (#2972 lowering refinement) The IR builder NOW lowers PROVEN-in-bounds
 * string element reads (`lowerElementAccess` delegates to the charAt
 * machinery when the receiver has a literal-known length and
 * `stringIndexProvenBelow` holds — e.g. the harness `hex[(n>>4)&0xf]` on a
 * 16-char literal). Those reads are genuinely IR-first-safe, so this gate
 * consults the SAME single-source predicates (`collectStringLiteralLens` +
 * `stringElementReadLowerable` from `src/ir/capability.ts`) and only flags
 * reads the builder would still throw on. One predicate, two consumers —
 * gate and builder cannot drift. The remaining lift is the unproven
 * residual (OOB→undefined widening or broader proofs).
 *
 * Checker-free string detection (conservative — a false positive only keeps a
 * non-string element access on compile-twice, never a correctness risk; a
 * false negative leaves a rarer string-receiver shape to hard-error as before,
 * i.e. no NEW regression): a receiver is treated as a string when it is a
 * string literal / template, or an identifier bound inside the function to a
 * string-literal (or template) initializer, or a parameter annotated
 * `: string`.
 */
export function irFirstBodyReadsStringElement(fn: ts.FunctionDeclaration): boolean {
  if (!fn.body) return false;
  // (#2972) literal-length facts — same source the from-ast lowering uses.
  const literalLens = collectStringLiteralLens(fn);
  // --- names known to hold a string value inside the function ---
  const stringNames = new Set<string>();
  const isStringInitializer = (e: ts.Expression | undefined): boolean =>
    e !== undefined &&
    (ts.isStringLiteral(e) || e.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral || ts.isTemplateExpression(e));
  for (const p of fn.parameters) {
    if (p.type?.kind === ts.SyntaxKind.StringKeyword && ts.isIdentifier(p.name)) stringNames.add(p.name.text);
  }
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.type?.kind === ts.SyntaxKind.StringKeyword || isStringInitializer(node.initializer)) {
        stringNames.add(node.name.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(fn.body);
  // --- flag an element access whose receiver is (syntactically) a string ---
  const isStringReceiver = (e: ts.Expression): boolean => {
    let cur = e;
    while (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur) || ts.isAsExpression(cur))
      cur = cur.expression;
    if (
      ts.isStringLiteral(cur) ||
      cur.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      ts.isTemplateExpression(cur)
    )
      return true;
    return ts.isIdentifier(cur) && stringNames.has(cur.text);
  };
  let found = false;
  const scan = (node: ts.Node): void => {
    if (found) return;
    if (ts.isElementAccessExpression(node) && !node.questionDotToken && isStringReceiver(node.expression)) {
      // (#2972) A PROVEN-in-bounds read on a literal-known-length receiver is
      // lowered by the IR builder's charAt arm — do NOT exclude its function
      // from the compile-once skip set for it. Same predicate the builder
      // consults (capability.ts), so gate and builder cannot disagree.
      if (!stringElementReadLowerable(node, literalLens)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(fn.body);
  return found;
}

/**
 * (#3143 gate 7) Nullish-coalescing residual: `lowerNullish` (from-ast.ts)
 * only lowers `??` when both operands are the SAME reference-shaped type;
 * numeric/string/mismatched operand pairs throw a clean post-claim fallback
 * to legacy. Under the overlay that demote is metered and harmless — but a
 * skipped IR-first slot would promote it to a hard compile error (the
 * `unreachable` placeholder must never ship). Keep any function containing
 * `??` / `??=` on the compile-twice path until `lowerNullish` covers every
 * operand shape. The IR body still ships via the overlay whenever it builds,
 * so this gate costs only the redundant legacy compile — never correctness.
 * Syntactic and conservative on purpose (same philosophy as gates 4/5): the
 * gate must never disagree with the builder in the dangerous direction.
 */
export function irFirstBodyHasNullish(fn: ts.FunctionDeclaration): boolean {
  if (!fn.body) return false;
  let found = false;
  const scan = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, scan);
  };
  scan(fn.body);
  return found;
}

/** The TypedArray view constructor / type names whose element STORE the IR
 *  front-end does not yet lower (`from-ast.ts` `lowerElementStore` throws
 *  "element store on a TypedArray view not in IR scope" — the per-view value
 *  conversions ToUint8/clamp/pack are legacy-only). Kept in lockstep with the
 *  resolver's `isTypedArrayViewExpr` semantics: any indexed write to one of
 *  these is legacy-only today. */
const TYPED_ARRAY_VIEW_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

/**
 * (#3143 gate 8) Unlowered TypedArray-view op — element STORE or CONSTRUCTION.
 * Two from-ast throws share this "TypedArray views are legacy-only in the IR"
 * boundary, and the selector accepts both shapes structurally (checker-free):
 *
 *   (a) element store `view[i] = v` → `lowerElementStore` throws "element store
 *       on a TypedArray view not in IR scope" (per-view ToUint8/clamp/pack
 *       conversions + typed backing store are legacy-only). Real population:
 *       the native-messaging `putAscii` / `putUint` writers.
 *   (b) construction `new <TypedArrayCtor>(n)` → `lowerNewExpression` throws
 *       "unknown class" (the extern-class registry has no TypedArray view arm
 *       in the IR path; only element READS on a claimed view lower today).
 *
 * Under the overlay both demote silently to legacy; as a skipped IR-first slot
 * either would promote to a HARD compile error (the `unreachable` placeholder
 * must never ship). Keep any function that stores to OR constructs a TypedArray
 * view on the compile-twice path until the IR gains those lowerings — exactly
 * the compile-twice deferral gates 4/5/7 use. (A view PARAMETER that is only
 * READ lowers fine and is NOT gated — element reads on a claimed view work.)
 *
 * Checker-free view detection (conservative — a false positive only keeps a
 * function compile-twice, never a correctness risk; a false negative leaves a
 * rarer view-typed receiver to hard-error as before, i.e. no NEW regression):
 * a receiver identifier is treated as a TypedArray view when it is a parameter
 * or local annotated with a TypedArray type, or a local initialized with
 * `new <TypedArrayCtor>(…)`.
 */
export function irFirstBodyStoresTypedArrayView(fn: ts.FunctionDeclaration): boolean {
  if (!fn.body) return false;
  const isViewTypeNode = (t: ts.TypeNode | undefined): boolean =>
    t !== undefined &&
    ts.isTypeReferenceNode(t) &&
    ts.isIdentifier(t.typeName) &&
    TYPED_ARRAY_VIEW_TYPE_NAMES.has(t.typeName.text);
  const isViewNewExpr = (e: ts.Expression | undefined): boolean => {
    if (e === undefined || !ts.isNewExpression(e)) return false;
    return ts.isIdentifier(e.expression) && TYPED_ARRAY_VIEW_TYPE_NAMES.has(e.expression.text);
  };
  // --- (b) ANY TypedArray-view construction `new <TypedArrayCtor>(…)` in the
  //     body keeps the function compile-twice (from-ast "unknown class"). ---
  {
    let constructsView = false;
    const scanNew = (node: ts.Node): void => {
      if (constructsView) return;
      if (ts.isNewExpression(node) && isViewNewExpr(node)) {
        constructsView = true;
        return;
      }
      ts.forEachChild(node, scanNew);
    };
    scanNew(fn.body);
    if (constructsView) return true;
  }
  // --- names known to hold a TypedArray view inside the function ---
  const viewNames = new Set<string>();
  for (const p of fn.parameters) {
    if (ts.isIdentifier(p.name) && isViewTypeNode(p.type)) viewNames.add(p.name.text);
  }
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (isViewTypeNode(node.type) || isViewNewExpr(node.initializer)) viewNames.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(fn.body);
  if (viewNames.size === 0) return false;
  // --- receiver root of an element access chain (unwrap parens/nonnull/as) ---
  const isViewReceiver = (e: ts.Expression): boolean => {
    let cur = e;
    while (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur) || ts.isAsExpression(cur))
      cur = cur.expression;
    return ts.isIdentifier(cur) && viewNames.has(cur.text);
  };
  // --- flag any assignment (=, compound) whose LHS is `view[idx]` ---
  const isAssignToken = (k: ts.SyntaxKind): boolean =>
    k === ts.SyntaxKind.EqualsToken ||
    k === ts.SyntaxKind.PlusEqualsToken ||
    k === ts.SyntaxKind.MinusEqualsToken ||
    k === ts.SyntaxKind.AsteriskEqualsToken ||
    k === ts.SyntaxKind.SlashEqualsToken ||
    k === ts.SyntaxKind.PercentEqualsToken ||
    k === ts.SyntaxKind.AmpersandEqualsToken ||
    k === ts.SyntaxKind.BarEqualsToken ||
    k === ts.SyntaxKind.CaretEqualsToken ||
    k === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken;
  let found = false;
  const scan = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      isAssignToken(node.operatorToken.kind) &&
      ts.isElementAccessExpression(node.left) &&
      !node.left.questionDotToken &&
      isViewReceiver(node.left.expression)
    ) {
      found = true;
      return;
    }
    // prefix/postfix `view[i]++` / `--view[i]` also route through the store.
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      ts.isElementAccessExpression(node.operand) &&
      !node.operand.questionDotToken &&
      isViewReceiver(node.operand.expression)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, scan);
  };
  scan(fn.body);
  return found;
}
