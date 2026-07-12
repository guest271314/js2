// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3143 — the IR-first ALLOWLIST skip predicate + caller graph.
//
// Pure, checker-free AST helpers used by `computeIrFirstSkipSet` in
// `src/codegen/index.ts` (and unit-tested directly — this lives in its own
// module so tests can import it without pulling the whole codegen entry
// module and its init-order-sensitive cycles).
//
// History: this module previously held per-shape DENYLIST gate predicates
// (`irFirstBodyReadsHostNode` / `…ReadsStringElement` / `…HasNullish` /
// `…StoresTypedArrayView` / `…MutatesParam` / `…CallsUnloweredArrayMethod`).
// #3143 replaced the denylist with the ALLOWLIST below (the denylist could not
// safely close the ~22 from-ast throw classes the equivalence corpus revealed),
// so those predicates were deleted — git history preserves them if the
// allowlist-widening track (#2855/#2856) ever wants to reference them.
import ts from "typescript";

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
