// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3278) Arrow / function-expression closure PHASE helpers, extracted from the
 * ~1.3k-LOC god-function `compileArrowAsClosure` in `../closures.ts` (WAVE B
 * code-bloat-elimination, subtask of #3182). Behaviour-preserving verbatim
 * lift — the emitted-Wasm byte-identity oracle (scripts/prove-emit-identity.mjs)
 * proves these produce IDENTICAL output.
 *
 *   - planClosureCaptures    — phase 1: capture analysis (free-var scan, boxing)
 *   - mintClosureStructTypes — phase 2: capture-struct + lifted-func type minting
 *
 * A short module-cycle with `../closures.ts` (it imports these back) is safe:
 * every cross-module binding is used only inside function bodies, which run long
 * after module initialization.
 */
import { ts, forEachChild } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { ValType } from "../../ir/types.js";
import { addFuncType, getOrRegisterRefCellType } from "../index.js";
import { addFunctionOwnLocals } from "../binding-info.js";
import { getOrCreateFuncRefWrapperTypes } from "./funcref-wrapper-types.js";
import {
  arrowOwnLocals,
  buildCaptureFieldDef,
  closureProvablyAfterLetDecl,
  collectOverBody,
  collectParamDefaultReferences,
  collectReferencedIdentifiers,
  collectWrittenIdentifiers,
  isOwnParamName,
} from "../closures.js";

export type ArrowClosureCapture = {
  name: string;
  type: ValType;
  localIdx: number;
  mutable: boolean;
  alreadyBoxed: boolean;
  /**
   * #1177: whether this capture's TDZ flag must be propagated through the
   * closure (forces value-boxing too — see planClosureCaptures).
   */
  hasTdzFlag: boolean;
};

/**
 * Phase 1 of compileArrowAsClosure: capture analysis. Scans the arrow /
 * function-expression body (and its parameter default initializers) for free
 * variables, decides which must be boxed (written inside the closure, written
 * in the enclosing scope, or TDZ-flagged), and resolves each to its outer-scope
 * local slot + type. Also detects the self-recursive const/let binding routed
 * through `__self`.
 *
 * Pure analysis: the only side effect on the caller's `fctx` is seeding
 * `fctx.tdzFlagLocals` for names whose TDZ slot was recovered by the #1177
 * block-scope-shadow rescan — preserved because `fctx` is passed by reference.
 */
export function planClosureCaptures(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  body: ts.ConciseBody,
): { captures: ArrowClosureCapture[]; selfBindingName: string | undefined } {
  // 2. Analyze captured variables. Use scope-aware collection so that nested
  //    `var` declarations and parameter bindings inside the closure body shadow
  //    outer references — otherwise a closure with its own `var i;` would be
  //    treated as capturing the outer `i` (#995/#996).
  const ownLocals = arrowOwnLocals(arrow);

  // (#2118) Self-recursive const/let arrow: `const f = (n) => ... f(n-1)`.
  // The closure references its own binding `f`. Without special handling the
  // binding is captured as an ordinary variable; but the outer slot for `f` is
  // typed `externref` (function types resolve to externref) and is still
  // uninitialized at the moment the closure is constructed, so the capture is
  // boxed into a `__ref_cell_externref` and the construction path emits an
  // invalid `ref.cast` between the ref-cell struct and the closure struct
  // (struct.get type-mismatch validation failure). Detect the self-binding and
  // route the self-reference through `__self` (lifted param 0) — exactly the
  // mechanism named function expressions already use — so the recursive call
  // dispatches through the closure's own struct and the name is NOT captured.
  let selfBindingName: string | undefined;
  if (ts.isArrowFunction(arrow) || (ts.isFunctionExpression(arrow) && !arrow.name)) {
    const declParent = arrow.parent;
    if (
      declParent &&
      ts.isVariableDeclaration(declParent) &&
      declParent.initializer === arrow &&
      ts.isIdentifier(declParent.name)
    ) {
      selfBindingName = declParent.name.text;
    }
  }

  const referencedNames = new Set<string>();
  collectOverBody(collectReferencedIdentifiers, body, referencedNames, ownLocals);
  // (#3096) Free variables referenced ONLY in a parameter default initializer
  // — or in a binding-pattern element default / computed key — must be
  // captured too. The body scan above misses them, so a default like
  // `([x] = iter) => {}` (where `iter` is an outer var referenced nowhere in
  // the body) never captured `iter`; the default then compiled to `ref.null`,
  // and array destructuring threw "Cannot destructure null/undefined". Scan
  // `param.name` (catches binding-pattern element defaults + computed keys) and
  // `param.initializer` (top-level param default) with the same own-locals
  // shadow set, so the param's own binding names stay excluded.
  collectParamDefaultReferences(arrow.parameters, referencedNames, ownLocals);

  // (#3040) Parameter DEFAULT initializers can reference enclosing-scope names
  // that appear NOWHERE in the body — e.g. `f = async function*([x] = iter)`
  // where `iter` is an outer local used ONLY in the default. The body-only scan
  // above misses them, so such a name is never captured and the lifted
  // default-init reads a null local, which then destructures to "Cannot
  // destructure null". This is the function-expression / arrow twin of the
  // FunctionDeclaration fix in statements/nested-declarations.ts (the async-gen /
  // gen / fn EXPRESSION variants of the `ary-init-iter-close` cluster lower here,
  // not through the declaration path). Scan each parameter subtree (its
  // `= <default>` initializer AND nested binding-pattern element defaults like
  // `[x = outer]`) with `ownLocals` as the shadow set so the destructured binding
  // names and earlier params stay local while free references in the defaults
  // become captures. Placed BEFORE the transitive-capture loop so a default that
  // calls a capturing nested function also pulls in that function's transitive
  // captures.
  for (const p of arrow.parameters) {
    collectReferencedIdentifiers(p, referencedNames, ownLocals);
  }

  // Transitively add captures needed by called nested functions.
  // E.g. if this closure calls g() and g has nestedFuncCaptures {first, second},
  // this closure must also capture first and second so it can pass ref cells to g.
  for (const name of [...referencedNames]) {
    if (ownLocals.has(name)) continue;
    const transitiveCaptures = ctx.nestedFuncCaptures.get(name);
    if (transitiveCaptures) {
      for (const cap of transitiveCaptures) {
        if (!ownLocals.has(cap.name)) referencedNames.add(cap.name);
      }
    }
  }

  // Detect which captured variables are written inside the closure body
  const writtenInClosure = new Set<string>();
  collectOverBody(collectWrittenIdentifiers, body, writtenInClosure, ownLocals);
  // (#3040) Symmetric with the referencedNames scan above: a param default that
  // ASSIGNS an outer var (rare, e.g. `[x] = (outer = 5, [outer])`) must keep that
  // capture boxed rather than snapshotted.
  for (const p of arrow.parameters) {
    collectWrittenIdentifiers(p, writtenInClosure, ownLocals);
  }

  // Also detect variables written in the enclosing scope (not just the closure).
  // If the outer function writes to a captured variable, the capture must use a
  // ref cell so the closure sees the updated value.
  // We use the TS checker to find all write references to the variable's symbol.
  // A variable needs boxing if it has any assignment outside the closure body.
  const writtenInOuter = new Set<string>();
  for (const name of referencedNames) {
    if (writtenInClosure.has(name)) continue; // Already mutable, no need to check
    try {
      // Find the symbol for this variable
      const sym = ctx.checker.getSymbolAtLocation(ts.isBlock(body) ? (body.statements[0] ?? body) : body);
      // Use the enclosing function body to find all writes to this name.
      // (#3128) Walk PAST function nodes the call-site inliner flattened into
      // this fctx (`fctx.inlinedIifeNodes`): an inlined IIFE is not a real
      // scope boundary in the emitted Wasm — its "locals" live in fctx's
      // frame, so writes to the captured name in the REAL enclosing body
      // (e.g. `p2 = (function(){ return () => p2; })()`) must count as outer
      // writes. Stopping at the erased boundary made the capture by-value:
      // a stale copy the outer assignment never reached.
      //
      // Shadow guard: only walk past an inlined IIFE that does NOT itself
      // declare `name` (params / own function-scoped decls). If it does, the
      // capture refers to the IIFE's OWN binding — an outer same-named write
      // targets a DIFFERENT variable and must not force-box the shadow
      // (`var x=1; (function(){ var x=5; return ()=>x; })(); x=2;` — the
      // closure must keep seeing 5).
      const iifeDeclaresName = (fn: ts.Node): boolean => {
        const own = new Set<string>();
        addFunctionOwnLocals(fn, own);
        return own.has(name);
      };
      let enclosing: ts.Node | undefined = arrow.parent;
      while (
        enclosing &&
        (!(
          ts.isFunctionDeclaration(enclosing) ||
          ts.isFunctionExpression(enclosing) ||
          ts.isArrowFunction(enclosing) ||
          ts.isMethodDeclaration(enclosing) ||
          ts.isConstructorDeclaration(enclosing) ||
          ts.isSourceFile(enclosing)
        ) ||
          ((fctx.inlinedIifeNodes?.has(enclosing) ?? false) && !iifeDeclaresName(enclosing)))
      ) {
        enclosing = enclosing.parent;
      }
      if (enclosing) {
        const outerBody = ts.isSourceFile(enclosing) ? enclosing : (enclosing as any).body;
        if (outerBody) {
          // Collect writes in the outer body, excluding the closure body itself
          const outerWrites = new Set<string>();
          const collectOuterWrites = (node: ts.Node): void => {
            // Skip the closure body itself
            if (node === arrow) return;
            // Check for assignments
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
              if (ts.isIdentifier(node.left) && node.left.text === name) {
                outerWrites.add(name);
              }
            }
            if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
              if (ts.isIdentifier(node.operand) && node.operand.text === name) {
                outerWrites.add(name);
              }
            }
            // Compound assignments (+=, -=, etc.)
            if (
              ts.isBinaryExpression(node) &&
              node.operatorToken.kind >= ts.SyntaxKind.PlusEqualsToken &&
              node.operatorToken.kind <= ts.SyntaxKind.CaretEqualsToken
            ) {
              if (ts.isIdentifier(node.left) && node.left.text === name) {
                outerWrites.add(name);
              }
            }
            forEachChild(node, collectOuterWrites);
          };
          if (ts.isBlock(outerBody)) {
            for (const stmt of outerBody.statements) {
              collectOuterWrites(stmt);
            }
          } else {
            collectOuterWrites(outerBody);
          }
          if (outerWrites.has(name)) {
            writtenInOuter.add(name);
          }
        }
      }
    } catch {
      // If analysis fails, be conservative — don't add to writtenInOuter
    }
  }

  const captures: {
    name: string;
    type: ValType;
    localIdx: number;
    mutable: boolean;
    alreadyBoxed: boolean;
    /**
     * #1177: Whether this capture's TDZ flag must be propagated through the
     * closure. Set when `fctx.tdzFlagLocals?.has(name)` at capture-analysis time.
     * Forces value-boxing too — the value at construction time may be the default
     * (uninit), so the closure must see post-init mutations through the ref cell.
     */
    hasTdzFlag: boolean;
  }[] = [];
  for (const name of referencedNames) {
    let localIdx = fctx.localMap.get(name);
    let tdzFlagIdxFromScan: number | undefined;
    if (localIdx === undefined) {
      // (#3121) A localMap miss can ALSO mean the name was PROMOTED to a
      // module global by `promoteAccessorCapturesToGlobals` (an earlier
      // object-literal method/accessor in this function captured it). The
      // promotion deliberately deleted the localMap entry so every later
      // reference — including this closure's body — resolves through the
      // promoted global (identifiers.ts/assignment.ts check
      // `ctx.capturedBoxGlobals`/`ctx.capturedGlobals` on a localMap miss).
      // The #1177 rescan below would resurrect the ORPHANED local slot and
      // box it into a fresh ref cell — a second store the method's
      // global-routed writes never reach (write via `__captured_c` global,
      // read via the stale cell → silent wrong results). Skip the capture:
      // the lifted body then shares the method's store via the global.
      if (fctx.promotedCaptureNames?.has(name)) continue;
      // #1177: The block-scope shadow manager (saveBlockScopedShadows) deletes
      // localMap entries for block-scoped let/const names that were pre-hoisted
      // by hoistLetConstWithTdz. Inside the block, before the let-decl runs,
      // the slot still exists in fctx.locals — find it by name. This restores
      // the ability of closures constructed inside the block to capture the
      // hoisted slot, which is essential for TDZ-through-closure to fire.
      for (let i = 0; i < fctx.locals.length; i++) {
        const slot = fctx.locals[i]!;
        if (slot.name === name) {
          localIdx = fctx.params.length + i;
          break;
        }
      }
    }
    if (localIdx === undefined) continue;
    // #2669: skip names bound to a *user* function (a function reference, not a
    // captured variable) — but NOT a wasm:js-string builtin import
    // (concat/length/equals/substring/charCodeAt), which lives in funcMap yet
    // must not block capture of a same-named outer local (e.g. the test262
    // `let length = "outer"` dstr template). Discriminate by index.
    if (ctx.funcMap.has(name) && ctx.funcMap.get(name) !== ctx.jsStringImports.get(name)) continue;
    // Skip if the name is the arrow's own parameter (including destructuring bindings)
    if (isOwnParamName(arrow, name)) continue;
    // Skip if the name is a named function expression's own name (self-reference)
    if (ts.isFunctionExpression(arrow) && arrow.name && arrow.name.text === name) continue;
    // (#2118) Skip the self-recursive const/let arrow binding — routed via __self.
    if (selfBindingName !== undefined && name === selfBindingName) continue;
    // #1177: Also fall back to scanning for a `__tdz_<name>` slot when
    // tdzFlagLocals was cleared by block-scope shadow management.
    if (!fctx.tdzFlagLocals?.has(name)) {
      const tdzSlotName = `__tdz_${name}`;
      for (let i = 0; i < fctx.locals.length; i++) {
        if (fctx.locals[i]!.name === tdzSlotName) {
          tdzFlagIdxFromScan = fctx.params.length + i;
          break;
        }
      }
    }
    const type =
      localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : (fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" });
    // A capture is mutable if the closure writes to it OR the outer scope writes to it.
    // Both cases require a ref cell so mutations are visible across scope boundaries.
    // #1177: Also force-box when the variable has a TDZ flag — the captured value
    // at construction time may be the uninitialized default (e.g. `let x` declared
    // after the closure is built), so post-init mutations must flow through the
    // ref cell for the closure to observe them.
    //
    // BUT: only force-box if the closure is in a position where TDZ is actually
    // possible. For for-let-iter where the closure is inside the loop body (and
    // the let-decl is the for-init), the variable is initialized BEFORE every
    // iteration's closure construction. Force-boxing breaks per-iteration
    // semantics: each iteration would share the same box (single Wasm slot),
    // so all closures see the final value of the loop variable.
    const tdzFlagPresent = !!fctx.tdzFlagLocals?.has(name) || tdzFlagIdxFromScan !== undefined;
    const hasTdzFlag = tdzFlagPresent && !closureProvablyAfterLetDecl(ctx, arrow, name);
    const isMutable = writtenInClosure.has(name) || writtenInOuter.has(name) || hasTdzFlag;
    // Check if the variable is already boxed from a previous closure capture.
    // If so, the local already holds a ref cell — don't wrap it again.
    const alreadyBoxed = !!fctx.boxedCaptures?.has(name);
    // #1177: If we found the TDZ flag via fctx.locals scan (block-scope shadow
    // cleared tdzFlagLocals), seed fctx.tdzFlagLocals so downstream emit code
    // (including the construction-time emit below and the call-site TDZ check)
    // routes through the boxed flag mechanism.
    if (tdzFlagIdxFromScan !== undefined) {
      if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
      if (!fctx.tdzFlagLocals.has(name)) fctx.tdzFlagLocals.set(name, tdzFlagIdxFromScan);
    }
    captures.push({ name, type, localIdx, mutable: isMutable, alreadyBoxed, hasTdzFlag });
  }

  return { captures, selfBindingName };
}

/**
 * Phase 2 of compileArrowAsClosure: capture-struct type minting. Builds the
 * closure struct type (field 0 = funcref, fields 1..N = capture values, then
 * TDZ-flag ref-cell fields) and the lifted function type. No-capture /
 * non-named closures reuse the shared funcref-wrapper struct; captured closures
 * become a subtype of it so call-site `ref.cast` succeeds. Returns the struct /
 * func type indices and the lifted parameter list.
 */
export function mintClosureStructTypes(
  ctx: CodegenContext,
  opts: {
    captures: ArrowClosureCapture[];
    arrowParams: ValType[];
    closureResults: ValType[];
    closureName: string;
    isNamedFuncExpr: boolean;
  },
): { structTypeIdx: number; liftedFuncTypeIdx: number; liftedParams: ValType[] } {
  const { captures, arrowParams, closureResults, closureName, isNamedFuncExpr } = opts;
  let structTypeIdx: number;
  let liftedFuncTypeIdx: number;
  let liftedParams: ValType[];
  if (captures.length === 0 && !isNamedFuncExpr) {
    const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, arrowParams, closureResults);
    if (wrapperTypes) {
      structTypeIdx = wrapperTypes.structTypeIdx;
      liftedFuncTypeIdx = wrapperTypes.liftedFuncTypeIdx;
      liftedParams = [{ kind: "ref", typeIdx: structTypeIdx }, ...arrowParams];
    } else {
      // Fallback: create a unique struct type
      const structFields = [{ name: "func", type: { kind: "funcref" as const }, mutable: false }];
      structTypeIdx = ctx.mod.types.length;
      ctx.mod.types.push({
        kind: "struct",
        name: `${closureName}_struct`,
        fields: structFields,
      });
      liftedParams = [{ kind: "ref", typeIdx: structTypeIdx }, ...arrowParams];
      liftedFuncTypeIdx = addFuncType(ctx, liftedParams, closureResults, `${closureName}_type`);
    }
  } else {
    const structFields = [
      { name: "func", type: { kind: "funcref" as const }, mutable: false },
      ...captures.map((c) => buildCaptureFieldDef(ctx, c)),
    ];

    // #1177: Append a TDZ-flag ref-cell field for every capture that carries
    // a TDZ flag in the outer fctx. The flag is shared by reference so the
    // outer scope and the closure observe the same initialization status.
    // Field layout: [funcref, ...value_fields, ...tdz_flag_fields].
    const tdzFlaggedCaptures = captures.filter((c) => c.hasTdzFlag);
    if (tdzFlaggedCaptures.length > 0) {
      const i32RefCellTypeIdx = getOrRegisterRefCellType(ctx, { kind: "i32" });
      for (const c of tdzFlaggedCaptures) {
        structFields.push({
          name: `__tdz_${c.name}`,
          type: { kind: "ref_null" as const, typeIdx: i32RefCellTypeIdx },
          mutable: false,
        });
      }
    }

    // For closures with captures (but not named func exprs), make the struct
    // a subtype of the shared wrapper struct so ref.cast at call sites succeeds.
    // Named func exprs need ref_null __self (for var hoisting), so they can't
    // share the wrapper's lifted func type which uses non-null ref.
    const wrapperTypes = !isNamedFuncExpr ? getOrCreateFuncRefWrapperTypes(ctx, arrowParams, closureResults) : null;

    structTypeIdx = ctx.mod.types.length;
    if (wrapperTypes) {
      // Subtype of the wrapper struct — inherits field 0 (funcref), adds captures
      ctx.mod.types.push({
        kind: "struct",
        name: `${closureName}_struct`,
        fields: structFields,
        superTypeIdx: wrapperTypes.structTypeIdx,
      });
      // Share the wrapper's lifted func type so call_ref dispatches correctly.
      // The __self param is (ref $wrapperStruct), and the lifted body will
      // ref.cast to the specific subtype to access captures.
      liftedFuncTypeIdx = wrapperTypes.liftedFuncTypeIdx;
      liftedParams = [{ kind: "ref_null", typeIdx: structTypeIdx }, ...arrowParams];
    } else {
      ctx.mod.types.push({
        kind: "struct",
        name: `${closureName}_struct`,
        fields: structFields,
      });
      // 4. Create the lifted function type: (ref_null $closure_struct, ...arrowParams) → results
      // Use ref_null for __self so that var-hoisted variables shadowing the function name
      // (e.g. `var g` inside `function g()`) can be default-initialized to null.
      liftedParams = [{ kind: "ref_null", typeIdx: structTypeIdx }, ...arrowParams];
      liftedFuncTypeIdx = addFuncType(ctx, liftedParams, closureResults, `${closureName}_type`);
    }
  }
  return { structTypeIdx, liftedFuncTypeIdx, liftedParams };
}
