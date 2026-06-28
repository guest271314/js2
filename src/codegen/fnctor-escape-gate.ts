// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2660 S1 — whole-program escape / dynamic-use classification for `new F()`
 * function-constructor ("fnctor") instances.
 *
 * This is the **inert analysis** slice (S1) of the #2660 value-rep
 * infrastructure. It computes, per `new F()` allocation site (where `F` is a
 * plain function constructor — a `FunctionDeclaration` / `FunctionExpression` /
 * `var F = function`, NOT a `class`), whether the constructed instance is a
 * candidate for the future #2660 S3 `$Object` reconstruction.
 *
 * The gate predicate (see #2660 `## Implementation Plan`) approves a site for
 * reconstruction iff BOTH hold:
 *   - **(A) dynamically consumed** — at least one use of the instance (or a
 *     binding it flows into) is a *dynamic* access: it is the receiver of a
 *     generic-method `.call` / `.apply`, a computed / `any`-typed member read,
 *     or it is passed to an `any`-typed parameter / returned as `any`. These are
 *     the uses that need the `$Object.$proto` walk the bespoke
 *     `$__fnctor_<Name>` struct cannot provide.
 *   - **(B) NO typed own-field consumer** — NO use resolves to a typed
 *     `instance.<ownField>` read/write that would lower to `struct.get` /
 *     `struct.set` on the fnctor struct. This is the hot-path-protection clause:
 *     reconstructing a site that has a typed field read would move that read onto
 *     `__extern_get` and regress it (the #1888-floor eject). A site with ANY
 *     typed-field consumer is therefore NEVER approved.
 *
 * **Conservative default = do NOT approve.** A site the analysis cannot prove
 * satisfies (A)∧(B) is classified `keep` (status-quo lowering). The failure mode
 * is bounded to "miss a reconstruction candidate" (0 rows), NEVER "approve a
 * typed `new F()`" (which would be the floor regression). This inversion is what
 * makes an imprecise/incomplete analysis safe.
 *
 * **S1 is INERT.** This module performs NO codegen and has NO side effects on the
 * module. The result is stored on `ctx` and (optionally) logged, but is NOT yet
 * consumed by any lowering decision — S3 wires `compileNewFunctionDeclaration` to
 * consult it. Removing this pass cannot change emitted Wasm.
 *
 * Relation to the IR `analyzeEscape` (`src/ir/analysis/escape.ts`, #747): that is
 * a DIFFERENT, per-function analysis classifying closure/allocation *escape* for
 * stack-allocation / scalar-replacement, over the IR. This pass is whole-program,
 * over the AST (the fnctor lowering lives on the direct AST→Wasm path, not the
 * IR), and classifies dynamic-vs-typed *use*. They are siblings; they may later
 * share an alias oracle, but the questions they answer are distinct.
 */
import { ts, forEachChild } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

/** Classification of a `new F()` fnctor allocation site. */
export type FnctorGateClass =
  /** (A)∧(B): dynamically consumed, no typed own-field consumer → S3 candidate. */
  | "reconstruct"
  /** Has a typed own-field consumer (clause B fails) → never reconstruct (hot path). */
  | "keep-typed"
  /** No dynamic consumer found (clause A fails) → no reconstruction needed. */
  | "keep-static";

/** Result of the #2660 S1 fnctor escape/dynamic-use analysis (frozen before codegen). */
export interface FnctorEscapeGateResult {
  /**
   * Per `new F()` site classification, keyed by the `NewExpression` AST node.
   * S3 consults this via the node identity at `compileNewFunctionDeclaration`.
   */
  readonly sites: ReadonlyMap<ts.NewExpression, FnctorGateClass>;
  /** Sites approved for reconstruction (`reconstruct`) — the (A)∧(B) set. */
  readonly approved: ReadonlySet<ts.NewExpression>;
  /**
   * Fnctor symbol NAMES that have ≥1 `reconstruct`-classified `new F()` site —
   * i.e. the constructors S3 will reconstruct as `$Object`. #2660 S2 gates its
   * per-fnctor prototype `$Object` materialization on this set so it ONLY touches
   * constructors whose instances need the `$proto` walk; a `keep-typed` /
   * `keep-static` / never-`new`'d function (e.g. `Test262Error`, a species
   * `Ctor` used only via `Object.getPrototypeOf`) keeps its existing prototype
   * behaviour untouched (avoids the identity/harness regressions an unscoped
   * interception caused).
   */
  readonly approvedNames: ReadonlySet<string>;
  /**
   * #2660 PART-1 — receiver-expression → `__fnctor_<Name>` struct-name flow map.
   *
   * Keyed by every USE-site expression (the identifier nodes) of a LOCAL binding
   * `const/let/var x = <call>` whose initializer call is a *single-return-
   * inferable* fnctor-returning method (e.g. `var node = this.startNode()` where
   * `startNode` is the aliased-prototype method `pp.startNode = function(){ return
   * new Node(...) }`). The mapped value is the `__fnctor_<Name>` struct name
   * (the `ctx.structMap` key from `new-super.ts`). It lets the PART-2 dispatch
   * pin the dynamic `x.<field>` read/write/compound to that one struct instead of
   * the open-scan `findAlternateStructsForField` — the local-receiver half of the
   * #2660 substrate (the `this`-receiver half is `FunctionContext.thisStructName`,
   * resolution case (1)).
   *
   * **Conservative-closed**: only bindings whose initializer resolves to a SINGLE
   * `return new X()` / `return <single-return call>` chain (depth-capped,
   * memoized) are recorded; anything ambiguous is omitted ⇒ `resolveReceiverStruct`
   * returns `undefined` ⇒ the consumer stays on the dynamic path. A miss NEVER
   * yields a wrong struct.
   *
   * **INERT in PART-1**: produced here but consulted only by the (as-yet-uncalled)
   * `resolveReceiverStruct`; no lowering reads it, so emitted Wasm is byte-identical.
   */
  readonly receiverStruct: ReadonlyMap<ts.Expression, string>;
}

const EMPTY_RESULT: FnctorEscapeGateResult = {
  sites: new Map(),
  approved: new Set(),
  approvedNames: new Set(),
  receiverStruct: new Map(),
};

/** Max callee-chain depth the single-return struct inference will follow. */
const RETURN_INFER_MAX_DEPTH = 6;

/** A generic Array/Function method that, used as `m.call(recv,…)`, makes `recv` array-like-dynamic. */
const GENERIC_METHOD_CALL = new Set(["call", "apply", "bind"]);

/**
 * Whether `expr` resolves to a plain function constructor (fnctor) rather than a
 * `class`. Mirrors the recognition `compileNewExpression` uses to route to
 * `compileNewFunctionDeclaration`: the callee symbol has a `FunctionDeclaration`
 * / `FunctionExpression` declaration (or a `var F = function …`), and is not a
 * class. Returns the resolved constructor symbol when it is a fnctor, else
 * `undefined`.
 */
export function resolveFnctorSymbol(checker: ts.TypeChecker, calleeExpr: ts.Expression): ts.Symbol | undefined {
  let e: ts.Expression = calleeExpr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
    e = (e as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression;
  }
  if (!ts.isIdentifier(e)) return undefined;
  const sym = checker.getSymbolAtLocation(e);
  const decls = sym?.getDeclarations();
  if (!sym || !decls) return undefined;
  for (const decl of decls) {
    // A class `new` is NOT a fnctor — it has its own lowering.
    if (ts.isClassDeclaration(decl) || ts.isClassExpression(decl)) return undefined;
    if (ts.isFunctionDeclaration(decl) && decl.body) return sym;
    if (ts.isFunctionExpression(decl) && decl.body) return sym;
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      let init: ts.Expression = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isFunctionExpression(init) && init.body) return sym;
      if (ts.isArrowFunction(init)) return undefined; // arrows are not constructors
    }
  }
  return undefined;
}

/**
 * #2681/#2686 — resolve the fnctor `F` that OWNS the enclosing method a node sits
 * in, for a `new this(…)` site or a lifted method body. `this` inside a method
 * `F.method = function(){…}` / `F.prototype.m = function(){…}` / aliased `var pp =
 * F.prototype; pp.m = function(){…}` binds to `F` (static) or an `F` instance
 * (prototype). Walks up to the nearest non-arrow function (arrows do not rebind
 * `this`) and resolves its defining assignment's holder to a fnctor symbol.
 *
 * Returns `{ name, sym, viaPrototype }` where `viaPrototype` is true for a
 * prototype/aliased method (`this` is an INSTANCE — the read-dispatch case) and
 * false for a direct static method (`this` is the CONSTRUCTOR — the `new this()`
 * reconstruct case). `undefined` when the enclosing function is not a fnctor
 * method, or the holder does not resolve to a user fnctor.
 */
export function resolveEnclosingFnctorOwner(
  checker: ts.TypeChecker,
  node: ts.Node,
): { name: string; sym: ts.Symbol; viaPrototype: boolean } | undefined {
  // Walk up to the nearest `this`-rebinding function (FunctionExpression /
  // FunctionDeclaration). Arrows are transparent to `this`, so a `new this()` in
  // an arrow refers to the enclosing function's `this` — keep walking through them.
  let fn: ts.Node | undefined = node;
  while (fn && !ts.isFunctionExpression(fn) && !ts.isFunctionDeclaration(fn)) {
    fn = fn.parent;
  }
  if (!fn) return undefined;
  const assign = fn.parent;
  if (
    !ts.isBinaryExpression(assign) ||
    assign.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    assign.right !== fn ||
    !ts.isPropertyAccessExpression(assign.left)
  ) {
    return undefined;
  }
  const left = assign.left;
  // prototype `F.prototype.m = fn` → holder F = left.expression.expression.
  if (
    ts.isPropertyAccessExpression(left.expression) &&
    ts.isIdentifier(left.expression.name) &&
    left.expression.name.text === "prototype"
  ) {
    const sym = resolveFnctorSymbol(checker, left.expression.expression);
    if (sym) return { name: sym.name, sym, viaPrototype: true };
    return undefined;
  }
  // static `F.method = fn` (holder = F directly) OR aliased `pp.m = fn` where
  // `var pp = F.prototype` (holder = pp → F, via the alias initializer).
  const holder = left.expression;
  const direct = resolveFnctorSymbol(checker, holder);
  if (direct) return { name: direct.name, sym: direct, viaPrototype: false };
  if (ts.isIdentifier(holder)) {
    const hsym = checker.getSymbolAtLocation(holder);
    for (const decl of hsym?.getDeclarations() ?? []) {
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        let init: ts.Expression = decl.initializer;
        while (ts.isParenthesizedExpression(init)) init = init.expression;
        if (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.name) && init.name.text === "prototype") {
          const fsym = resolveFnctorSymbol(checker, init.expression);
          if (fsym) return { name: fsym.name, sym: fsym, viaPrototype: true };
        }
      }
    }
  }
  return undefined;
}

/**
 * #2681/#2686 A3 — the `__fnctor_<F>` struct name a lifted PROTOTYPE method's
 * `this` receiver resolves to, when `F` is approved for reconstruction. Sets
 * `FunctionContext.thisStructName` (closures.ts) so the dynamic `this.<field>`
 * read dispatch (property-access.ts) routes through the finalize-filled
 * `__get_member_<name>` dispatcher.
 *
 * Deliberately NOT gated on `ctx.structMap.has(__fnctor_<F>)`: the reader method
 * frequently compiles BEFORE the `new this()` site that registers the struct
 * (acorn defines `pp.parseExprAtom` long before the static `Parser.parse`). The
 * dispatcher is reserved at the read site and FILLED at finalize over the
 * COMPLETE type table, so a struct registered later is still enumerated — pinning
 * on `approvedNames` (frozen pre-codegen at index.ts) is order-independent and
 * correct, while a `structMap.has` gate would race the compile order and miss.
 * Excludes static methods (`viaPrototype === false`) — their `this` is the
 * constructor function-value, not an instance.
 */
export function resolveLiftedMethodThisStruct(
  ctx: CodegenContext,
  fn: ts.FunctionExpression | ts.ArrowFunction,
): string | undefined {
  const owner = resolveEnclosingFnctorOwner(ctx.checker, fn);
  if (!owner || !owner.viaPrototype) return undefined;
  if (!ctx.fnctorEscapeGate?.approvedNames.has(owner.name)) return undefined;
  return `__fnctor_${owner.name}`;
}

/**
 * The set of own property names a fnctor constructor assigns to `this` in its
 * body (`this.x = …`). A typed `instance.x` read of one of these lowers to a
 * `struct.get` on the `$__fnctor_<Name>` struct — clause (B)'s hot path.
 */
function collectFnctorOwnFields(ctorSym: ts.Symbol): Set<string> {
  const fields = new Set<string>();
  const decls = ctorSym.getDeclarations() ?? [];
  for (const decl of decls) {
    let body: ts.Block | undefined;
    if ((ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl)) && decl.body) body = decl.body;
    else if (ts.isVariableDeclaration(decl) && decl.initializer) {
      let init: ts.Expression = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isFunctionExpression(init) && init.body) body = init.body;
    }
    if (!body) continue;
    const walk = (node: ts.Node): void => {
      // `this.x = …`
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        fields.add(node.left.name.text);
      }
      forEachChild(node, walk);
    };
    walk(body);
  }
  return fields;
}

/**
 * Classify how a single use-site of a fnctor instance reads it. Returns:
 *   - `"typed"`   — a typed own-field access (clause B trip → keep-typed).
 *   - `"dynamic"` — a dynamic access (clause A satisfied).
 *   - `"neutral"` — neither (e.g. identity compare, `typeof`); does not decide.
 *
 * Conservative: an unrecognised use that COULD be a typed field read is treated
 * as `"typed"` (keep), never as `"dynamic"`.
 */
function classifyUse(
  checker: ts.TypeChecker,
  idNode: ts.Identifier,
  ownFields: ReadonlySet<string>,
): "typed" | "dynamic" | "neutral" {
  const parent = idNode.parent;

  // `inst.<name>` — property access.
  if (ts.isPropertyAccessExpression(parent) && parent.expression === idNode) {
    const name = parent.name.text;
    // `inst.method.call(...)` / `inst.method.apply(...)` reflective dispatch is
    // dynamic ONLY when `inst` is the receiver ARG, not the method holder; a bare
    // `inst.method` access of a fnctor-prototype method is the dynamic-dispatch
    // case the substrate needs. A static OWN field read is typed.
    if (ownFields.has(name)) return "typed";
    // A non-own-field named access on a fnctor instance is an inherited /
    // prototype-chain read — the dynamic case (resolved at runtime via the
    // $proto walk). This is exactly what reconstruction enables.
    return "dynamic";
  }

  // `inst[expr]` — element access. Computed/indexed reads are dynamic.
  if (ts.isElementAccessExpression(parent) && parent.expression === idNode) {
    return "dynamic";
  }

  // `someMethod.call(inst, …)` / `.apply(inst, …)` — `inst` is the receiver arg
  // of a reflective generic-method call → array-like dynamic use.
  if (ts.isCallExpression(parent) && parent.arguments.length > 0 && parent.arguments[0] === idNode) {
    const callee = parent.expression;
    if (ts.isPropertyAccessExpression(callee) && GENERIC_METHOD_CALL.has(callee.name.text)) {
      return "dynamic";
    }
  }

  // Passed as a call argument to a parameter typed `any`/`unknown` → dynamic
  // (the callee may read it dynamically). Conservative: only the explicit
  // any/unknown parameter counts as dynamic; a typed parameter is neutral here
  // (the callee's own uses would be classified at that param's site in a fuller
  // interprocedural pass — out of scope for S1's conservative single-level view).
  if (ts.isCallExpression(parent)) {
    const argIdx = parent.arguments.indexOf(idNode);
    if (argIdx >= 0) {
      const sig = checker.getResolvedSignature(parent);
      const paramSym = sig?.parameters[argIdx];
      if (paramSym) {
        const pType = checker.getTypeOfSymbolAtLocation(paramSym, idNode);
        if (isAnyOrUnknown(pType)) return "dynamic";
      }
      return "neutral";
    }
  }

  // `return inst;` from a function whose return type is `any` → dynamic escape.
  if (ts.isReturnStatement(parent)) {
    return "neutral"; // S1 conservative: a returned instance's downstream use is
    // not tracked single-level; treat as neutral (does not approve, does not trip B).
  }

  // Everything else (identity compare, `typeof inst`, assignment source, etc.)
  // is neutral — it neither requires the $proto walk nor forces a typed field.
  return "neutral";
}

function isAnyOrUnknown(t: ts.Type): boolean {
  return (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

/**
 * Find the binding symbol a `new F()` instance flows into, if it is the
 * initializer of a `const`/`let`/`var` declaration. S1 tracks this single,
 * dominant binding form (`const c = new F()`); an instance used inline
 * (`new F().foo`) is classified directly at the NewExpression's parent. Deeper
 * alias flow (reassignment, field-store-then-load) is a fuller-pass concern;
 * S1's conservative default keeps such sites.
 */
function bindingOf(newExpr: ts.NewExpression): ts.Identifier | undefined {
  const parent = newExpr.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === newExpr && ts.isIdentifier(parent.name)) {
    return parent.name;
  }
  return undefined;
}

// ── #2660 PART-1 — receiver-struct flow map (single-return inference) ─────────

/** Unwrap `( … )` / `as` / `!` wrappers around an expression. */
function unwrapExpr(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = (cur as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression;
  }
  return cur;
}

/** True for any function-like node that can carry a `return`-bearing body. */
function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/**
 * A program-wide index `methodName → FunctionLike[]` of expando method
 * assignments `<obj>.<name> = function(){…}` (the acorn aliased-prototype form
 * `pp.m = function(){…}`, and `Class.prototype.m = function(){…}`). Used as the
 * callee-resolution FALLBACK when the type-checker cannot resolve a
 * `this.<name>()` / `recv.<name>()` callee — which is the COMMON case here: the
 * checker types acorn's lifted-method `this` / the call result as `any` (the
 * whole reason #2660 exists), so symbol resolution of `this.startNode` fails. A
 * name with exactly ONE indexed body resolves unambiguously; a colliding name
 * (≥2 bodies) is left unresolved (conservative — never a wrong callee).
 */
type ProtoMethodIndex = ReadonlyMap<string, ts.FunctionLikeDeclaration[]>;

function buildProtoMethodIndex(sourceFile: ts.SourceFile): ProtoMethodIndex {
  const idx = new Map<string, ts.FunctionLikeDeclaration[]>();
  const walk = (n: ts.Node): void => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left)
    ) {
      const rhs = unwrapExpr(n.right);
      if (isFunctionLike(rhs)) {
        const name = n.left.name.text;
        const arr = idx.get(name);
        if (arr) arr.push(rhs);
        else idx.set(name, [rhs]);
      }
    }
    forEachChild(n, walk);
  };
  walk(sourceFile);
  return idx;
}

/**
 * Resolve a method/function call's callee to the function-like declaration that
 * supplies its body. Tries the type-checker symbol first (precise when it
 * resolves), then falls back to the syntactic {@link ProtoMethodIndex} for the
 * acorn-dominant `this.<name>()` / `recv.<name>()` form the checker leaves `any`.
 * Handles plain `function f(){…}`, `var f = function(){…}`, object/class methods,
 * `{ m() {} }` / `{ m: function(){} }`, and the aliased-prototype
 * `var pp = Class.prototype; pp.m = function(){…}` assignment. Returns `undefined`
 * when ambiguous (a name with ≥2 indexed bodies) — conservative, never a wrong
 * callee.
 */
function resolveCalleeFunction(
  checker: ts.TypeChecker,
  callExpr: ts.CallExpression,
  protoIndex: ProtoMethodIndex,
): ts.FunctionLikeDeclaration | undefined {
  const callee = unwrapExpr(callExpr.expression);
  let sym: ts.Symbol | undefined;
  if (ts.isPropertyAccessExpression(callee)) {
    sym = checker.getSymbolAtLocation(callee.name) ?? checker.getSymbolAtLocation(callee);
  } else if (ts.isIdentifier(callee)) {
    sym = checker.getSymbolAtLocation(callee);
  }
  if (sym) {
    for (const decl of sym.getDeclarations() ?? []) {
      const fn = functionFromDeclaration(decl);
      if (fn?.body) return fn;
    }
  }
  // Checker miss → syntactic prototype-method fallback (unique name only).
  if (ts.isPropertyAccessExpression(callee)) {
    const cands = protoIndex.get(callee.name.text);
    if (cands && cands.length === 1 && cands[0]!.body) return cands[0];
  }
  return undefined;
}

/** Extract the FunctionLike body-bearer a declaration node defines, if any. */
function functionFromDeclaration(decl: ts.Declaration): ts.FunctionLikeDeclaration | undefined {
  if (isFunctionLike(decl)) return decl;
  // `var f = function(){…}` / `var f = () => …`
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = unwrapExpr(decl.initializer);
    if (isFunctionLike(init)) return init;
    return undefined;
  }
  // `{ m: function(){…} }` / `{ m() {} }`
  if (ts.isPropertyAssignment(decl)) {
    const init = unwrapExpr(decl.initializer);
    if (isFunctionLike(init)) return init;
    return undefined;
  }
  if (ts.isMethodDeclaration(decl)) return decl;
  // `pp.m = function(){…}` — the symbol's declaration is the LHS PropertyAccess;
  // its BinaryExpression parent's RHS is the function.
  if (ts.isPropertyAccessExpression(decl) || ts.isElementAccessExpression(decl)) {
    const parent = decl.parent;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === decl
    ) {
      const rhs = unwrapExpr(parent.right);
      if (isFunctionLike(rhs)) return rhs;
    }
  }
  return undefined;
}

/** The single `return <expr>` of a function body, or `undefined` if not exactly one. */
function singleReturnExpr(fn: ts.FunctionLikeDeclaration): ts.Expression | undefined {
  const body = fn.body;
  if (!body) return undefined;
  // Arrow with an expression body: `() => new Node()`.
  if (!ts.isBlock(body)) return body;
  const returns: ts.Expression[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isReturnStatement(n)) {
      if (n.expression) returns.push(n.expression);
      return;
    }
    // Do NOT descend into nested functions — their returns are not ours.
    if (isFunctionLike(n)) return;
    forEachChild(n, walk);
  };
  walk(body);
  return returns.length === 1 ? returns[0] : undefined;
}

/**
 * Infer the `__fnctor_<Name>` struct a function's SINGLE return yields, if any.
 * Follows `return new X()` directly and `return <single-return call>` chains
 * (depth-capped + memoized against recursion). Returns `undefined` when the
 * single return is anything else, when there is not exactly one return, or when
 * the chain exceeds the depth cap — conservative-closed, never a wrong struct.
 */
function inferReturnStruct(
  checker: ts.TypeChecker,
  fn: ts.FunctionLikeDeclaration,
  depth: number,
  memo: Map<ts.FunctionLikeDeclaration, string | undefined>,
  protoIndex: ProtoMethodIndex,
): string | undefined {
  if (memo.has(fn)) return memo.get(fn);
  if (depth <= 0) return undefined;
  // Tentative `undefined` guards against self-recursive chains resolving to junk.
  memo.set(fn, undefined);
  const ret = singleReturnExpr(fn);
  let result: string | undefined;
  if (ret) {
    const r = unwrapExpr(ret);
    if (ts.isNewExpression(r)) {
      let ctorSym = resolveFnctorSymbol(checker, r.expression);
      // #2681/#2686 — `return new this()` in a fnctor static method resolves to
      // the enclosing owner fnctor's struct.
      if (!ctorSym && r.expression.kind === ts.SyntaxKind.ThisKeyword) {
        ctorSym = resolveEnclosingFnctorOwner(checker, r)?.sym;
      }
      if (ctorSym) result = `__fnctor_${ctorSym.name}`;
    } else if (ts.isCallExpression(r)) {
      const callee = resolveCalleeFunction(checker, r, protoIndex);
      if (callee) result = inferReturnStruct(checker, callee, depth - 1, memo, protoIndex);
    }
    // `return this.field` / `return this.arr[i]` element-struct inference needs a
    // reliable element type (the checker types acorn's parser fields `any`), so it
    // is intentionally NOT attempted here — omission keeps the consumer on the
    // dynamic path (safe). A later slice can add a syntactic push-site scan.
  }
  memo.set(fn, result);
  return result;
}

/**
 * Build the #2660 PART-1 receiver-struct flow map: for every local binding
 * `const/let/var x = <call>` whose initializer call's single-return chain
 * resolves to a `__fnctor_<Name>` struct, map every USE identifier of `x` to
 * that struct name. Reuses the caller's symbol→uses index so it is a single
 * extra pass over the already-collected bindings.
 */
function buildReceiverStructMap(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  usesBySymbol: ReadonlyMap<ts.Symbol, ts.Identifier[]>,
): Map<ts.Expression, string> {
  const map = new Map<ts.Expression, string>();
  const memo = new Map<ts.FunctionLikeDeclaration, string | undefined>();
  const protoIndex = buildProtoMethodIndex(sourceFile);
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const init = unwrapExpr(node.initializer);
      let struct: string | undefined;
      if (ts.isCallExpression(init)) {
        const callee = resolveCalleeFunction(checker, init, protoIndex);
        struct = callee ? inferReturnStruct(checker, callee, RETURN_INFER_MAX_DEPTH, memo, protoIndex) : undefined;
      } else if (ts.isNewExpression(init)) {
        // #2681/#2686 — `var p:any = new this()` in a fnctor static method: pin
        // `p`'s uses to the owner fnctor struct (read-dispatch case (2)).
        let ctorSym = resolveFnctorSymbol(checker, init.expression);
        if (!ctorSym && init.expression.kind === ts.SyntaxKind.ThisKeyword) {
          ctorSym = resolveEnclosingFnctorOwner(checker, init)?.sym;
        }
        struct = ctorSym ? `__fnctor_${ctorSym.name}` : undefined;
      }
      if (struct) {
        const bindSym = checker.getSymbolAtLocation(node.name);
        const uses = bindSym ? (usesBySymbol.get(bindSym) ?? []) : [];
        for (const use of uses) {
          if (use === node.name) continue; // the declaration name itself
          map.set(use, struct);
        }
      }
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return map;
}

/**
 * #2660 PART-1 — resolve the WasmGC struct a member-access RECEIVER expression
 * concretely is, for the dynamic read/write/compound dispatch to PIN to.
 *
 * Resolution order (the consumer pins to the first hit; a miss ⇒ dynamic path):
 *   1. `this` receiver → `fctx.thisStructName` (the #2681 syntactic prototype
 *      resolver's result, populated by the PART-2 dispatch slice);
 *   2. a local receiver in the {@link FnctorEscapeGateResult.receiverStruct} flow
 *      map (bound from a single-return-inferable fnctor call);
 *   3. otherwise `undefined` → the consumer keeps its existing dynamic
 *      (`__extern_get` / open-scan) lowering.
 *
 * **Conservative-closed**: a returned name is additionally gated on
 * `ctx.structMap.has(name)`, so a struct not (yet) registered at the call site
 * yields `undefined` rather than a dangling pin — a miss NEVER produces a wrong
 * struct. **INERT in PART-1**: exported for the PART-2 dispatch to consume; no
 * lowering calls it yet, so emitted Wasm is byte-identical.
 */
export function resolveReceiverStruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvExpr: ts.Expression,
): string | undefined {
  const recv = unwrapExpr(recvExpr);
  let name: string | undefined;
  if (recv.kind === ts.SyntaxKind.ThisKeyword) {
    name = fctx.thisStructName;
  } else {
    name = ctx.fnctorEscapeGate?.receiverStruct.get(recv);
  }
  if (name !== undefined && ctx.structMap.has(name)) return name;
  return undefined;
}

/**
 * #2660 S1 — classify every `new F()` fnctor site in the program.
 *
 * @param checker     the program type checker
 * @param sourceFile  the (already import-preprocessed) module source
 * @returns a frozen {@link FnctorEscapeGateResult}; empty when no fnctor `new`
 *          sites exist (so the pass is a no-op for class-only / fnctor-free code).
 */
export function analyzeFnctorEscapeGate(checker: ts.TypeChecker, sourceFile: ts.SourceFile): FnctorEscapeGateResult {
  const sites = new Map<ts.NewExpression, FnctorGateClass>();
  const approved = new Set<ts.NewExpression>();
  const approvedNames = new Set<string>();

  // 1. Collect every `new F()` whose callee is a fnctor.
  const newSites: { newExpr: ts.NewExpression; ctorSym: ts.Symbol }[] = [];
  // #2681/#2686 — `new this(…)` sites inside a fnctor static/prototype method
  // (acorn instantiates Parser ONLY this way). The callee is `this`, not an
  // identifier, so `resolveFnctorSymbol` misses; resolve the enclosing owner
  // fnctor instead. These are ALWAYS classified `reconstruct` (the instance is
  // consumed dynamically via `this.<field>` across the fnctor's lifted methods;
  // the read/write dispatch (#2664/#2674 + A3) routes those onto the native
  // struct, so clause B's `__extern_get`-regression concern does not apply).
  const newThisSites = new Set<ts.NewExpression>();
  const collect = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      let ctorSym = resolveFnctorSymbol(checker, node.expression);
      if (!ctorSym && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const owner = resolveEnclosingFnctorOwner(checker, node);
        if (owner) {
          ctorSym = owner.sym;
          newThisSites.add(node);
        }
      }
      if (ctorSym) newSites.push({ newExpr: node, ctorSym });
    }
    forEachChild(node, collect);
  };
  collect(sourceFile);
  if (newSites.length === 0) return EMPTY_RESULT;

  // 2. Build a per-binding-symbol index of identifier uses across the program,
  //    so a `const c = new F()` instance's uses can be found by symbol identity.
  const usesBySymbol = new Map<ts.Symbol, ts.Identifier[]>();
  const indexUses = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const sym = checker.getSymbolAtLocation(node);
      if (sym) {
        const arr = usesBySymbol.get(sym);
        if (arr) arr.push(node);
        else usesBySymbol.set(sym, [node]);
      }
    }
    forEachChild(node, indexUses);
  };
  indexUses(sourceFile);

  // 3. Classify each site.
  for (const { newExpr, ctorSym } of newSites) {
    const ownFields = collectFnctorOwnFields(ctorSym);
    let sawDynamic = false;
    let sawTyped = false;

    const bind = bindingOf(newExpr);
    if (bind) {
      // Classify every use of the binding symbol.
      const bindSym = checker.getSymbolAtLocation(bind);
      const uses = bindSym ? (usesBySymbol.get(bindSym) ?? []) : [];
      for (const use of uses) {
        if (use === bind) continue; // the declaration name itself
        const c = classifyUse(checker, use, ownFields);
        if (c === "typed") sawTyped = true;
        else if (c === "dynamic") sawDynamic = true;
      }
    } else {
      // Inline `new F().X` — classify the single immediate consuming use,
      // unwrapping any `( … )` / `as` / `!` wrappers between the NewExpression
      // and its consumer (`(new Con()).x` has a ParenthesizedExpression parent).
      let inner: ts.Expression = newExpr;
      let parent = inner.parent;
      while (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent)) {
        inner = parent;
        parent = parent.parent;
      }
      if (ts.isPropertyAccessExpression(parent) && parent.expression === inner) {
        if (ownFields.has(parent.name.text)) sawTyped = true;
        else sawDynamic = true;
      } else if (ts.isElementAccessExpression(parent) && parent.expression === inner) {
        sawDynamic = true;
      } else if (
        ts.isCallExpression(parent) &&
        parent.arguments.length > 0 &&
        parent.arguments[0] === inner &&
        ts.isPropertyAccessExpression(parent.expression) &&
        GENERIC_METHOD_CALL.has(parent.expression.name.text)
      ) {
        // `some.call(new F(), …)` inline receiver.
        sawDynamic = true;
      }
      // any other inline use → neither; stays keep-static.
    }

    // Clause (B) is absolute: ANY typed own-field consumer ⇒ keep-typed (never
    // reconstruct — hot-path protection). Only then does clause (A) gate the
    // reconstruct/keep-static split. EXCEPTION (#2681/#2686): a `new this()`
    // site is always `reconstruct` — the parser instance is consumed
    // dynamically via `this.<field>` across the fnctor's lifted methods, and A1
    // (native struct) + A3 (struct read-dispatch) keep its typed-field reads on
    // `struct.get`, so clause B's `__extern_get`-regression does not apply.
    let cls: FnctorGateClass;
    if (newThisSites.has(newExpr)) cls = "reconstruct";
    else if (sawTyped) cls = "keep-typed";
    else if (sawDynamic) cls = "reconstruct";
    else cls = "keep-static";

    sites.set(newExpr, cls);
    if (cls === "reconstruct") {
      approved.add(newExpr);
      approvedNames.add(ctorSym.name);
    }
  }

  // 4. (#2660 PART-1) Build the receiver-struct flow map for local bindings whose
  //    initializer is a single-return-inferable fnctor-returning call. Reuses the
  //    symbol→uses index from step 2. INERT — stored for the PART-2 dispatch.
  const receiverStruct = buildReceiverStructMap(checker, sourceFile, usesBySymbol);

  // 5. Optional inert logging (no effect on output).
  if (process.env.JS2WASM_LOG_FNCTOR_GATE === "1" && (sites.size > 0 || receiverStruct.size > 0)) {
    const counts = { reconstruct: 0, "keep-typed": 0, "keep-static": 0 };
    for (const c of sites.values()) counts[c]++;
    // eslint-disable-next-line no-console
    console.error(
      `[#2660 fnctor-escape-gate] ${sites.size} new F() site(s): ` +
        `reconstruct=${counts.reconstruct} keep-typed=${counts["keep-typed"]} keep-static=${counts["keep-static"]}; ` +
        `receiverStruct flow-map entries=${receiverStruct.size}`,
    );
  }

  return { sites, approved, approvedNames, receiverStruct };
}
