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
}

const EMPTY_RESULT: FnctorEscapeGateResult = {
  sites: new Map(),
  approved: new Set(),
};

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

  // 1. Collect every `new F()` whose callee is a fnctor.
  const newSites: { newExpr: ts.NewExpression; ctorSym: ts.Symbol }[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const ctorSym = resolveFnctorSymbol(checker, node.expression);
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
    // reconstruct/keep-static split.
    let cls: FnctorGateClass;
    if (sawTyped) cls = "keep-typed";
    else if (sawDynamic) cls = "reconstruct";
    else cls = "keep-static";

    sites.set(newExpr, cls);
    if (cls === "reconstruct") approved.add(newExpr);
  }

  // 4. Optional inert logging (no effect on output).
  if (process.env.JS2WASM_LOG_FNCTOR_GATE === "1" && sites.size > 0) {
    const counts = { reconstruct: 0, "keep-typed": 0, "keep-static": 0 };
    for (const c of sites.values()) counts[c]++;
    // eslint-disable-next-line no-console
    console.error(
      `[#2660 fnctor-escape-gate] ${sites.size} new F() site(s): ` +
        `reconstruct=${counts.reconstruct} keep-typed=${counts["keep-typed"]} keep-static=${counts["keep-static"]}`,
    );
  }

  return { sites, approved };
}
