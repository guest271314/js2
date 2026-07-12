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

/**
 * (#3143 gate 9) Parameter mutation. from-ast binds every parameter as a
 * `local` SSA binding (from-ast.ts:536), never a mutable `slot` — the mutation
 * pre-pass (`collectMutatedLetNames`) drives slot promotion for `let`s but the
 * param binding loop does not consult it. So ANY write to a parameter —
 * assignment (`n = …`), compound assignment (`n += …`), or increment/decrement
 * (`n++`/`--n`) — throws a clean post-claim fallback ("assignment/… to non-slot
 * binding … — mutation pre-pass should have detected it"). The selector claims
 * such functions (the write shapes are all Phase-1), so under IR-first the
 * demote becomes a skipped-slot hard error. Keep any function that mutates one
 * of its own parameters on the compile-twice path until from-ast promotes
 * mutated params to slots (the natural follow-up: mirror the `let`-slot arm for
 * params). Local (`let`) mutation is unaffected — it already slot-promotes.
 *
 * Conservative: a false positive only keeps a function compile-twice. Nested
 * function/arrow bodies are skipped (their writes bind to their own scope).
 */
export function irFirstBodyMutatesParam(fn: ts.FunctionDeclaration): boolean {
  if (!fn.body) return false;
  const params = new Set<string>();
  for (const p of fn.parameters) {
    if (ts.isIdentifier(p.name)) params.add(p.name.text);
  }
  if (params.size === 0) return false;
  const isAssignToken = (k: ts.SyntaxKind): boolean =>
    k === ts.SyntaxKind.EqualsToken || (k >= ts.SyntaxKind.PlusEqualsToken && k <= ts.SyntaxKind.CaretEqualsToken);
  let found = false;
  const scan = (node: ts.Node): void => {
    if (found) return;
    // Don't descend into nested function scopes — a shadowed param there is a
    // different binding; an outer-param write from a closure is handled by the
    // closure gates, never reaching this gate as a clean claim.
    if (
      node !== fn.body &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node))
    ) {
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      isAssignToken(node.operatorToken.kind) &&
      ts.isIdentifier(node.left) &&
      params.has(node.left.text)
    ) {
      found = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand) &&
      params.has(node.operand.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, scan);
  };
  scan(fn.body);
  return found;
}

/** Array.prototype methods that from-ast's `lowerMethodCall` can lower on a vec
 *  receiver. Today ONLY `push` (single plain arg, f64/externref elem — see
 *  from-ast.ts:3642). Every other array method (`indexOf`, `includes`,
 *  `lastIndexOf`, `flat`, `flatMap`, `map`, `filter`, `reduce`, `slice`,
 *  `join`, `sort`, …) hits the "not in slice 4" throw. */
const IR_LOWERABLE_VEC_METHODS: ReadonlySet<string> = new Set(["push"]);

/**
 * (#3143 gate 10) Array (vec) method call not lowered by from-ast. The selector
 * accepts any `<recv>.<method>(...)` whose receiver is a Phase-1 expression
 * (select.ts:2773) WITHOUT checking that the method is lowerable — the overlay
 * assumption "the lowerer falls back to legacy if not a class method". from-ast
 * lowers only `.push` on a vec receiver; every other array method throws
 * "method call .<m>(...) on ref not in slice 4". Under IR-first that demote
 * becomes a skipped-slot hard error. Keep any function that calls a non-`push`
 * method on a (syntactically-detectable) array receiver on the compile-twice
 * path until the IR gains those array-method lowerings.
 *
 * Checker-free array detection (same conservative style as gates 5/8): a
 * receiver identifier is an array when it is a parameter/local annotated
 * `T[]` / `Array<T>` / `ReadonlyArray<T>`, or a local initialized with an array
 * literal `[…]` or `new Array(…)`. `.length` / element reads (not calls) are
 * unaffected; class-instance method calls (different receiver) are not gated.
 */
export function irFirstBodyCallsUnloweredArrayMethod(fn: ts.FunctionDeclaration): boolean {
  if (!fn.body) return false;
  const isArrayTypeNode = (t: ts.TypeNode | undefined): boolean => {
    if (t === undefined) return false;
    if (ts.isArrayTypeNode(t)) return true;
    return (
      ts.isTypeReferenceNode(t) &&
      ts.isIdentifier(t.typeName) &&
      (t.typeName.text === "Array" || t.typeName.text === "ReadonlyArray")
    );
  };
  const isArrayInit = (e: ts.Expression | undefined): boolean => {
    if (e === undefined) return false;
    if (ts.isArrayLiteralExpression(e)) return true;
    return ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "Array";
  };
  const arrayNames = new Set<string>();
  for (const p of fn.parameters) {
    if (ts.isIdentifier(p.name) && isArrayTypeNode(p.type)) arrayNames.add(p.name.text);
  }
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (isArrayTypeNode(node.type) || isArrayInit(node.initializer)) arrayNames.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(fn.body);
  if (arrayNames.size === 0) return false;
  const isArrayReceiver = (e: ts.Expression): boolean => {
    let cur = e;
    while (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur) || ts.isAsExpression(cur))
      cur = cur.expression;
    return ts.isIdentifier(cur) && arrayNames.has(cur.text);
  };
  let found = false;
  const scan = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.name) &&
      !IR_LOWERABLE_VEC_METHODS.has(node.expression.name.text) &&
      isArrayReceiver(node.expression.expression)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, scan);
  };
  scan(fn.body);
  return found;
}

// ===========================================================================
// (#3143) ALLOWLIST skip predicate — the safe-by-construction IR-first skip.
//
// The IR-first flip's divergence surface is BROAD: the selector claims a wide
// range of shapes the from-ast builder cannot lower (a `result.errors` scan of
// the equivalence inline corpus found ~22 distinct from-ast throw classes over
// core operations — string methods, class-member resolution, call/ctor arity,
// type-mismatched arith, property assignment, coercion, `new Date`, …). A
// per-shape DENYLIST cannot close that set (unbounded; a single miss ships a
// skipped-slot HARD error / equivalence regression).
//
// So the skip decision is inverted to an ALLOWLIST: skip the legacy body ONLY
// for a function whose ENTIRE body is a small, PROVEN-lowerable subset. This is
// safe by construction — a construct the allowlist does not recognise keeps the
// function COMPILE-TWICE (correct, just no compile-once), whereas a denylist
// miss is a hard error. The subset starts intentionally narrow (matched-type
// numeric/boolean arithmetic, control flow, correctly-typed local variable
// mutation, exact-arity calls to other claimed functions, returns) and widens
// as the IR gains real lowering for more kinds (#2855/#2856) — each widening
// unlocks more of the gated-G1 legacy deletion.
//
// This predicate covers only the BODY shape; the caller
// (`computeIrFirstSkipSet`) additionally verifies the function's params/return
// are numeric/boolean and that it has no default/optional/rest/destructuring
// params (those from-ast throw arms are not observable from the body walk).
// ===========================================================================

/**
 * (#3143) Return true iff `fn`'s body is entirely within the proven-lowerable
 * subset, given `claimedArity` (name → parameter count for every currently
 * claimed function — used to enforce from-ast's exact call-arity requirement;
 * a call to a non-claimed / wrong-arity callee is NOT allowlisted).
 *
 * **Strict number-only, with a separate boolean CONTEXT.** The caller restricts
 * params + return to `f64` (JS `number`) — so every identifier/local is a
 * number. from-ast's Phase-1 arithmetic requires MATCHED operand types and its
 * logical/`!` ops require BOOLEAN operands; a checker-free walk cannot inspect
 * types, so it enforces the split structurally:
 *   - a NUMBER context (`numOk`) allows number literals, number locals,
 *     arithmetic/bit ops between numbers, local number mutation, ternaries whose
 *     branches are numbers, and exact-arity calls to claimed functions;
 *   - a BOOLEAN context (`boolOk`) — the condition of if/while/do/for and the
 *     `?:` test, plus operands of `&&`/`||`/`!` — allows ONLY relational/equality
 *     comparisons of two NUMBERS, and `&&`/`||`/`!` over nested booleans.
 * No boolean literals, no boolean-valued locals, no string/array/object/closure/
 * class/extern/dynamic/member/element/`new`/coercion constructs — all
 * compile-twice until the IR lowers them. Local (`let`) mutation is allowed
 * (from-ast slot-promotes mutated lets); PARAMETER mutation is NOT.
 */
export function irFirstBodyIsProvenLowerable(
  fn: ts.FunctionDeclaration,
  claimedArity: ReadonlyMap<string, number>,
): boolean {
  if (!fn.body) return false;
  const params = new Set<string>();
  for (const p of fn.parameters) {
    if (!ts.isIdentifier(p.name)) return false; // destructuring param — reject
    params.add(p.name.text);
  }
  // Every name bound anywhere in the function body. A bare identifier in number
  // context must resolve to one of these (all numbers, per the caller's f64
  // signature restriction); a module/host global is a from-ast throw.
  const locals = new Set<string>(params);
  const collectDecls = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) locals.add(node.name.text);
    ts.forEachChild(node, collectDecls);
  };
  collectDecls(fn.body);

  const isAssignToken = (k: ts.SyntaxKind): boolean =>
    k === ts.SyntaxKind.EqualsToken || (k >= ts.SyntaxKind.PlusEqualsToken && k <= ts.SyntaxKind.CaretEqualsToken);
  // Numeric binary ops (arith / bit / shift) — NOT comparisons, NOT logical.
  const isNumericBinaryToken = (k: ts.SyntaxKind): boolean =>
    k === ts.SyntaxKind.PlusToken ||
    k === ts.SyntaxKind.MinusToken ||
    k === ts.SyntaxKind.AsteriskToken ||
    k === ts.SyntaxKind.SlashToken ||
    k === ts.SyntaxKind.PercentToken ||
    k === ts.SyntaxKind.AsteriskAsteriskToken ||
    k === ts.SyntaxKind.AmpersandToken ||
    k === ts.SyntaxKind.BarToken ||
    k === ts.SyntaxKind.CaretToken ||
    k === ts.SyntaxKind.LessThanLessThanToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
  // Relational / equality — produce a boolean from two numbers.
  const isCompareToken = (k: ts.SyntaxKind): boolean =>
    k === ts.SyntaxKind.LessThanToken ||
    k === ts.SyntaxKind.GreaterThanToken ||
    k === ts.SyntaxKind.LessThanEqualsToken ||
    k === ts.SyntaxKind.GreaterThanEqualsToken ||
    k === ts.SyntaxKind.EqualsEqualsToken ||
    k === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    k === ts.SyntaxKind.ExclamationEqualsToken ||
    k === ts.SyntaxKind.ExclamationEqualsEqualsToken;

  // An assignable target: a local that is NOT a parameter (param mutation is a
  // from-ast non-slot throw; a mutated `let` slot-promotes).
  const isAssignableLocal = (e: ts.Expression): boolean =>
    ts.isIdentifier(e) && locals.has(e.text) && !params.has(e.text);

  const unwrapParen = (e: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(e) ? unwrapParen(e.expression) : e;

  // Expression in NUMBER context — must evaluate to a number.
  const numOk = (e: ts.Expression): boolean => {
    switch (e.kind) {
      case ts.SyntaxKind.NumericLiteral:
        return true;
      case ts.SyntaxKind.Identifier:
        return locals.has((e as ts.Identifier).text);
      case ts.SyntaxKind.ParenthesizedExpression:
        return numOk((e as ts.ParenthesizedExpression).expression);
      case ts.SyntaxKind.PrefixUnaryExpression: {
        const u = e as ts.PrefixUnaryExpression;
        if (u.operator === ts.SyntaxKind.PlusPlusToken || u.operator === ts.SyntaxKind.MinusMinusToken) {
          return isAssignableLocal(u.operand);
        }
        // `+x` / `-x` / `~x` are numeric; `!x` is boolean (rejected here).
        return (
          (u.operator === ts.SyntaxKind.PlusToken ||
            u.operator === ts.SyntaxKind.MinusToken ||
            u.operator === ts.SyntaxKind.TildeToken) &&
          numOk(u.operand)
        );
      }
      case ts.SyntaxKind.PostfixUnaryExpression:
        return isAssignableLocal((e as ts.PostfixUnaryExpression).operand); // ++ / -- only
      case ts.SyntaxKind.BinaryExpression: {
        const b = e as ts.BinaryExpression;
        const op = b.operatorToken.kind;
        if (isAssignToken(op)) return isAssignableLocal(b.left) && numOk(b.right);
        return isNumericBinaryToken(op) && numOk(b.left) && numOk(b.right);
      }
      case ts.SyntaxKind.ConditionalExpression: {
        const c = e as ts.ConditionalExpression;
        return boolOk(c.condition) && numOk(c.whenTrue) && numOk(c.whenFalse);
      }
      case ts.SyntaxKind.CallExpression: {
        const c = e as ts.CallExpression;
        if (!ts.isIdentifier(c.expression)) return false; // no method calls
        const arity = claimedArity.get(c.expression.text);
        if (arity === undefined || arity !== c.arguments.length) return false; // exact arity to a claimed fn
        for (const a of c.arguments) {
          if (ts.isSpreadElement(a) || !numOk(a)) return false;
        }
        return true;
      }
      default:
        return false; // strings/booleans/member/element/new/array/object/arrow/this/… → reject
    }
  };

  // Expression in BOOLEAN context — must evaluate to a boolean (comparisons of
  // numbers, or logical combinations thereof). No boolean literals / vars: a
  // number-vs-boolean mix is exactly the from-ast "matching operand types"
  // throw this split exists to avoid.
  function boolOk(e: ts.Expression): boolean {
    const x = unwrapParen(e);
    if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken) return boolOk(x.operand);
    if (ts.isBinaryExpression(x)) {
      const op = x.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        return boolOk(x.left) && boolOk(x.right);
      }
      if (isCompareToken(op)) return numOk(x.left) && numOk(x.right);
    }
    return false;
  }

  const stmtOk = (s: ts.Statement): boolean => {
    switch (s.kind) {
      case ts.SyntaxKind.Block:
        return (s as ts.Block).statements.every(stmtOk);
      case ts.SyntaxKind.EmptyStatement:
      case ts.SyntaxKind.BreakStatement:
      case ts.SyntaxKind.ContinueStatement:
        return true;
      case ts.SyntaxKind.ReturnStatement: {
        const r = s as ts.ReturnStatement;
        return r.expression === undefined || numOk(r.expression);
      }
      case ts.SyntaxKind.ExpressionStatement:
        return numOk((s as ts.ExpressionStatement).expression);
      case ts.SyntaxKind.IfStatement: {
        const i = s as ts.IfStatement;
        return (
          boolOk(i.expression) && stmtOk(i.thenStatement) && (i.elseStatement === undefined || stmtOk(i.elseStatement))
        );
      }
      case ts.SyntaxKind.WhileStatement: {
        const w = s as ts.WhileStatement;
        return boolOk(w.expression) && stmtOk(w.statement);
      }
      case ts.SyntaxKind.DoStatement: {
        const d = s as ts.DoStatement;
        return boolOk(d.expression) && stmtOk(d.statement);
      }
      case ts.SyntaxKind.ForStatement: {
        const f = s as ts.ForStatement;
        if (f.initializer) {
          if (ts.isVariableDeclarationList(f.initializer)) {
            if (!f.initializer.declarations.every(varDeclOk)) return false;
          } else if (!numOk(f.initializer)) return false;
        }
        if (f.condition && !boolOk(f.condition)) return false;
        if (f.incrementor && !numOk(f.incrementor)) return false;
        return stmtOk(f.statement);
      }
      case ts.SyntaxKind.VariableStatement:
        return (s as ts.VariableStatement).declarationList.declarations.every(varDeclOk);
      default:
        return false; // throw/try/switch/for-of/for-in/labeled/nested-fn/class/… → reject
    }
  };

  function varDeclOk(d: ts.VariableDeclaration): boolean {
    if (!ts.isIdentifier(d.name)) return false; // destructuring
    if (d.initializer === undefined) return false; // uninitialized — reject (conservative)
    return numOk(d.initializer);
  }

  return fn.body.statements.every(stmtOk);
}

/**
 * (#3143) Build a syntactic caller→callees edge map over the WHOLE source file
 * (top-level function declarations + a `MODULE_INIT_CALLER` pseudo-node for
 * module-level statements). Used by `computeIrFirstSkipSet` to enforce a
 * signature-parity invariant: a function whose LEGACY body is skipped is
 * installed with its IR-resolved signature, so any LEGACY caller (a non-skipped
 * function, whose call-site arg coercion was resolved against the callee's
 * legacy signature) would mismatch it (the boxed-`any`→typed-param
 * `f64.convert_i32_s` validation break, #3143). Therefore a function may be
 * skipped only when EVERY caller is itself skipped — the caller graph lets
 * `computeIrFirstSkipSet` compute that fixpoint. Name-based + over-approximating
 * (any bare `f(...)` identifier call attributes an edge from the enclosing
 * top-level function, or the module-init node): a false edge only keeps a
 * function compile-twice, never unsafe.
 */
export const MODULE_INIT_CALLER = "<module-init>";

export function collectLocalCallEdges(sourceFile: ts.SourceFile): ReadonlyMap<string, ReadonlySet<string>> {
  const edges = new Map<string, Set<string>>();
  const addEdge = (caller: string, callee: string): void => {
    let s = edges.get(caller);
    if (!s) {
      s = new Set<string>();
      edges.set(caller, s);
    }
    s.add(callee);
  };
  // Walk a function/module body, attributing every identifier-callee `f(...)`
  // to `caller`. Does NOT descend into nested function declarations — their
  // calls are attributed to their OWN name (a nested `function g(){}` is walked
  // separately below with caller = the top-level owner is fine as an
  // over-approximation; to stay simple + safe we attribute nested calls to the
  // enclosing top-level `caller` too, so we do descend but keep the same
  // caller). Simplicity beats precision here (over-approx = safe).
  const walkCalls = (node: ts.Node, caller: string): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      addEdge(caller, node.expression.text);
    }
    ts.forEachChild(node, (c) => walkCalls(c, caller));
  };
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      walkCalls(stmt.body, stmt.name.text);
    } else {
      // module-level statement (incl. `export function` is handled above;
      // top-level expression statements, var initializers, class static blocks…)
      walkCalls(stmt, MODULE_INIT_CALLER);
    }
  }
  return edges;
}
