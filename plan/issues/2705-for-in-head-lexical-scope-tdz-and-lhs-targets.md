---
id: 2705
title: "for-in: head let/const TDZ, lexical scope open/close, LHS non-simple targets, var-head visibility"
status: done
assignee: ttraenkler/Esch
completed: 2026-06-26
sprint: 67
goal: test262-conformance
feasibility: hard
depends_on: []
priority: high
es_edition: ES2015
language_feature: for-in
task_type: bug
created: 2026-06-26
updated: 2026-06-26
---
# #2705 — for-in head lexical scope, TDZ, LHS targets, var visibility

## Problem

The `for (... in ...)` statement has multiple scoping and LHS-target gaps vs ECMAScript §14.7.5:

**(a) Per-iteration lexical binding + TDZ.** `for (let x in obj)` and `for (const x in obj)` must create a fresh lexical binding each iteration with a TDZ entry at the top of each iteration body. Accessing `x` before the binding is initialized should throw a ReferenceError. Tests: `head-let-bound-names-fordecl-tdz`, `head-const-bound-names-fordecl-tdz`, `scope-head-lex-open`, `scope-head-lex-close`, `scope-body-lex-open`, `scope-body-lex-close`.

**(b) LHS that is NOT a simple declaration or plain identifier.** `head-lhs-cover` ("for-in requires a variable declaration or identifier" — the LHS is a CoverParenthesizedExpression/ObjectPattern not yet handled), `head-lhs-let` / `identifier-let-allowed-as-lefthandside-expression-not-strict` ("Cannot read properties of undefined (reading 'name')" — the parser/compiler tries to access `.name` on an undefined node when `let` appears as a plain LHS identifier in non-strict mode). `let-identifier-with-newline` (invalid Wasm binary — line-terminator between `for` and `(let` causing a bad parse path).

**(c) `var`-declared head variable not visible in body or after loop.** `S12.6.4_A3.js`, `S12.6.4_A4.js`, `S12.6.4_A4.1.js`, `S12.6.4_A3.1.js` ("__str is not defined" in both the loop body and after the loop) and `scope-head-var-none.js`, `scope-body-var-none.js` (null_deref) — the `var x` in `for (var x in obj)` is not being hoisted into the enclosing function scope properly, or the code-generated iteration variable has the wrong wasm local slot.

Spec: ECMAScript §14.7.5 (The `for-in` Statement), §14.7.5.6 ForIn/OfHeadEvaluation, §14.7.5.7 ForIn/OfBodyEvaluation.

## Failing tests (test262 baseline 2026-06-26)

### (a) let/const TDZ + lexical scope open/close (~6 tests)

```
test/language/statements/for-in/head-let-bound-names-fordecl-tdz.js
test/language/statements/for-in/head-const-bound-names-fordecl-tdz.js
test/language/statements/for-in/scope-head-lex-open.js
test/language/statements/for-in/scope-head-lex-close.js
test/language/statements/for-in/scope-body-lex-open.js
test/language/statements/for-in/scope-body-lex-close.js
```

### (b) LHS non-simple targets (~3 tests)

```
test/language/statements/for-in/head-lhs-cover.js
test/language/statements/for-in/head-lhs-let.js
test/language/statements/for-in/identifier-let-allowed-as-lefthandside-expression-not-strict.js
test/language/statements/for-in/let-identifier-with-newline.js
```

### (c) var-head visibility in body/after (~6 tests)

```
test/language/statements/for-in/S12.6.4_A3.js
test/language/statements/for-in/S12.6.4_A4.js
test/language/statements/for-in/S12.6.4_A4.1.js
test/language/statements/for-in/S12.6.4_A3.1.js
test/language/statements/for-in/scope-head-var-none.js
test/language/statements/for-in/scope-body-var-none.js
test/language/statements/for-in/head-var-bound-names-in-stmt.js
```

### Additional related tests in this cluster (~3 tests)

```
test/language/statements/for-in/nonstrict-initializer.js
test/annexB/language/statements/for-in/nonstrict-initializer.js
test/language/statements/for-in/resizable-buffer.js
```

Note: `cptn-expr-itr.js`, `cptn-decl-abrupt-empty.js`, `cptn-decl-itr.js`, `cptn-expr-abrupt-empty.js` use `eval()` — deferred (eval is skip-filtered).

## Root cause (suspected)

**(a)** The for-in codegen in `src/codegen/statements.ts` (ForInStatement handler) likely emits the loop binding as a single outer let rather than creating a fresh per-iteration scope. The TDZ guard (ref.is_null + throw) is absent. Fix: wrap each iteration body in a new inner scope where the binding is initialized (see `ForIn/OfBodyEvaluation` step 6.c.iii — CreatePerIterationEnvironment equivalent).

**(b)** The parser/codegen has a special case for `let` as a non-reserved word that appears as a plain identifier in LHS position (non-strict mode). The name resolution path calls `.name` on a node that is `undefined` — needs a guard. `head-lhs-cover` requires recognizing destructuring patterns in for-in heads.

**(c)** The `var` binding in `for (var x in obj)` head is not being added to the enclosing function's variable scope during hoisting, so `x` is local to the loop block and not visible outside. The fix is to ensure `var` in a for-in head is declared at function scope.

This is marked `feasibility: hard` because (a) requires per-iteration environment creation which is a structural change to how the for-in loop is lowered, and (b) requires understanding `let`-as-identifier ambiguity in the grammar.

## Acceptance criteria

At least 10 of the **11** closeable listed tests flip from fail to pass (Slice A: 5, Slice B: 6). Note: 8 of the originally-listed for-in tests (`S12.6.4_A3/A3.1/A4/A4.1`, `scope-head-var-none`, `scope-body-var-none`, and the `cptn-*` set) route through `__extern_eval` because `allNodesInlineSupported` bails on `ForInStatement` — they are **eval-blocked, not closeable by this issue** (they belong to the eval-inline Slice D, deferred). See the Implementation Plan note below. No regression in `statements/for-in/` currently-passing tests. Full CI green.

## Notes

- The architect should spec the per-iteration scope mechanism carefully — particularly how the wasm locals for the binding are cloned per iteration without an allocation.
- See also #2706 (for-in enumeration order — a separate issue on the enumeration algorithm, not scoping).
- `resizable-buffer.js` ("ctors is not defined") is TypedArray-related and out of scope for this issue.

## Implementation Plan

> **Scope correction (read first).** The four `S12.6.4_A3/A3.1/A4/A4.1.js` and
> `scope-head-var-none.js`/`scope-body-var-none.js` tests in section (c) are
> **eval-based** — they enumerate via `eval("for(var ind in …)…")` or run
> `eval('var x=2')` inside the head's computed default. They reach the dynamic
> `__extern_eval` host import (not the inline path) because
> `allNodesInlineSupported` in `src/codegen/expressions/eval-inline.ts:179`
> **bails on `ForInStatement`**, and the host eval cannot see the module's
> `__str`/`arr`/`x` locals → "__str is not defined". They are therefore NOT
> closeable by the for-in lowering changes below; they belong to the eval-inline
> work (Slice D, deferred). The PO's "excluding eval-based" carve-out in the
> acceptance criteria should be read to cover these six, not just the four
> `cptn-*` tests. **Realistic closeable set = 11 tests** (Slice A: 5, Slice B: 6).

### Root cause

All for-in lowering lives in **`src/codegen/statements/loops.ts` →
`compileForInStatement` (line 5389)**. The whole loop uses a **single
`externref` local `keyLocal`** for the head variable (allocated once, lines
5400–5447) and writes `keys[i]` into it each iteration (line 5631). There is no
per-iteration fresh binding, no TDZ environment, and no head/per-iteration env
split. The user body is compiled with `saveBlockScopedShadows` /
`restoreBlockScopedShadows` (lines 5596–5604) — a name-shadow save/restore, not
a fresh declarative environment.

- **(a) let/const TDZ + per-iteration (6 tests).** `keyLocal` is a plain local,
  always initialized before the body runs (line 5631), and the receiver
  expression is compiled at line 5531 **with no head binding in scope**. So:
  - `head-let-bound-names-fordecl-tdz` (`for (let x in { x })`): per
    §14.7.5.6 ForIn/OfHeadEvaluation step 2, the head's `let x` must be a **TDZ
    binding in scope while the receiver `{ x }` is evaluated** → reading `x`
    (shorthand `{x:x}`) must throw ReferenceError. We currently evaluate `{ x }`
    against the *outer* `x` (no throw) → test fails.
  - `scope-head-lex-open/close`: a closure created **inside the receiver**
    (`{ i: probeExpr = function(){ typeof x } }`) must capture the **head TDZ
    binding** (never initialized) → `typeof x` throws ReferenceError when called
    later. We capture the outer/loop `x` instead → no throw.
  - `scope-body-lex-open/close`: closures created in the ForDeclaration defaults
    (`probeDecl`) and the body (`probeBody`) must capture a **fresh
    per-iteration binding** initialized to the key (`'i'`). We share one local
    → wrong capture identity.
- **(b) non-simple / `let`-identifier LHS (4 tests).** The dispatch at lines
  5399–5447 does not cover two parse shapes (verified via `ts.createSourceFile`
  probe):
  - `head-lhs-cover` (`for ((x) in …)`): the initializer parses as a
    **`ParenthesizedExpression`** wrapping the identifier — no branch matches →
    falls to the `else` "for-in requires a variable declaration or identifier"
    (line 5445).
  - `head-lhs-let` / `identifier-let-allowed-as-lefthandside-expression-not-strict`
    (`for (let in obj)`, non-strict): TS parses this as a
    **`VariableDeclarationList` with `declarations.length === 0`** (the `let`
    token is consumed as the list keyword; the identifier text is lost). Line
    5400 does `const decl = init.declarations[0]!` → `decl` is `undefined`, then
    line 5401 `decl.name` → **"Cannot read properties of undefined (reading
    'name')"**. Per the grammar's `[lookahead ∉ { let [ }]` restriction, a `let`
    not followed by `[` is the *identifier* `let`. The second half of
    `head-lhs-let` (`for ([let][1] in obj)`) parses as an
    `ElementAccessExpression` and already routes through the `memberTarget`
    branch (line 5412) — only the `for (let in obj)` half crashes.
  - `let-identifier-with-newline` (`for (var x in null) let \n x = 1;`): the
    **receiver is `null`** (`exprKind=NullKeyword`). There is no
    null/undefined-receiver guard — `compileExpression` pushes a null externref
    (line 5531) and `__for_in_keys(null)` / the native enumeration path is
    emitted over it → invalid Wasm / trap. Per §14.7.5.6 step 7, a `null`/`undefined`
    receiver yields **zero iterations**.
- **(c) var-head visibility — the ONE non-eval test, `head-var-bound-names-in-stmt`
  (`for (var x in {…}) { var x; … }`).** `var x` is already hoisted to a
  function-scope local by `hoistVarDeclarations`
  (`src/codegen/index.ts:13582–13594`). But the var-decl-list-with-identifier
  branch at **lines 5407–5411 unconditionally calls
  `allocLocal(fctx, varName, …)`**, allocating a *fresh* local that **shadows
  the hoisted slot**. Writes to `keyLocal` never reach the hoisted `x`, so the
  body's `var x` reference and the post-loop value read the wrong slot. (The
  bare-identifier branch at lines 5418–5427 already does the right thing — it
  checks `fctx.localMap.get(varName)` first. The var-decl branch must do the
  same.)

### Approach

Split along risk. **Slice A** is small, local, and closes 5 tests with no new
infrastructure. **Slice B** is the hard per-iteration-env + TDZ change and
should reuse the existing C-style-for-loop machinery rather than invent new.

#### Slice A — LHS dispatch + var reuse + null-receiver guard (5 tests)

All edits in `compileForInStatement` (loops.ts 5389–5447, 5531).

1. **Unwrap parentheses** at the top of the dispatch: before the
   `isVariableDeclarationList`/`isIdentifier`/member checks, set
   `let head: ts.Node = init; while (ts.isParenthesizedExpression(head)) head = head.expression;`
   and dispatch on `head`. A parenthesized identifier `(x)` then routes to the
   existing bare-identifier branch; a parenthesized member `(a.b)` to the
   member-target branch. (Closes `head-lhs-cover`.)
2. **`let`-as-identifier (declCount === 0).** In the `isVariableDeclarationList`
   branch, **before** dereferencing `declarations[0]`, add:
   `if (init.declarations.length === 0) { /* "for (let in …)" — the only empty
   VarDeclList shape; head is the identifier "let" */ varName = "let";
   keyLocal = fctx.localMap.get("let") ?? allocLocal(fctx, "let", {kind:"externref"}); }`
   then skip the rest. (`var`/`const` can't produce an empty list — both are
   reserved as identifiers — so `"let"` is unambiguous.) (Closes `head-lhs-let`,
   `identifier-let-allowed-…`.)
3. **`var`-head reuses the hoisted local.** In the var-decl-list-identifier
   branch (lines 5407–5411), gate on `let`/`const` vs `var`:
   `const isLexical = !!(init.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));`
   For a **`var`** head, mirror the bare-identifier path — reuse
   `fctx.localMap.get(varName)` if present (the hoisted slot), else `allocLocal`.
   For **let/const**, keep allocating a fresh block-scoped local (Slice B
   refines this). (Closes `head-var-bound-names-in-stmt`.)
4. **Null/undefined receiver guard.** The receiver type is known at compile time
   for the literal case (`exprKind === NullKeyword`, or
   `ctx.checker.getTypeAtLocation(stmt.expression)` is `null`/`undefined`/`void`).
   When statically nullish, **emit nothing for the loop** (skip body codegen
   entirely — zero iterations) after still running var-hoisting (already done in
   the pre-pass, so safe to skip here). For the dynamic case where the receiver
   *may* be null at runtime, wrap the enumeration in a `ref.is_null`
   guard: `local.tee $obj; ref.is_null; if (then: br to $break)` before
   `__for_in_keys`. The static skip alone closes `let-identifier-with-newline`
   (receiver is the `null` literal); add the runtime guard for robustness.
   **Caveat:** the body of `let-identifier-with-newline` is a lexical
   declaration (`let x = 1`, dead code) — confirm the static-skip path does not
   compile the body (so no invalid-Wasm lexical-decl-as-sole-statement is
   emitted).

#### Slice B — head TDZ env + per-iteration fresh binding for let/const (6 tests)

This implements §14.7.5.6 (head TDZ environment) and §14.7.5.7
ForIn/OfBodyEvaluation step 6.e (CreatePerIterationEnvironment +
BindingInstantiation) for the **let/const head** only. Reuse the existing
ref-cell + TDZ-flag machinery that the **C-style `for (let x = …; …)` loop**
already uses (same file): `findHeadBindingsCapturedByClosures` (loops.ts:571),
`getOrRegisterRefCellType` (`registry/types.ts`), `fctx.boxedCaptures`,
`fctx.tdzFlagLocals`, the per-iteration cell-clone block (loops.ts ~1152–1260),
and `collectPatternBindingNames` / `emitLocalTdzInit` / `emitTdzInitForBindingPattern`
(`statements/tdz.ts`).

Sequence inside `compileForInStatement`, gated on
`isVariableDeclarationList(init) && (init.flags & (Let|Const))`:

1. **Head TDZ environment (before line 5531, the receiver compile).**
   - Collect the head bound names with `collectPatternBindingNames(decl.name)`.
   - For each name, allocate a **ref cell** (`getOrRegisterRefCellType(ctx,
     {kind:"externref"})`), store its `boxedLocal`, register
     `fctx.boxedCaptures.set(name, {refCellTypeIdx, valType})`, and allocate a
     **TDZ flag local set to 0 (uninitialized)** via `fctx.tdzFlagLocals`.
     (Save the prior `boxedCaptures`/`tdzFlagLocals`/`localMap` entries to
     restore on loop exit — see the `savedForBoxedCaptures` pattern at
     loops.ts:687, 896–907.)
   - **Now compile the receiver** (existing line 5531). Any identifier read of
     the head name inside the receiver routes through the ref cell + TDZ flag,
     so an uninitialized read emits the TDZ guard (`ref.is_null`/flag check →
     `throw ReferenceError`) — closing `head-let-bound-names-fordecl-tdz` and the
     receiver-closure capture in `scope-head-lex-open/close`. A closure built in
     the receiver captures **this** (never-initialized) cell → `typeof x`
     throws when later called.
2. **Per-iteration environment (top of each iteration body, where line 5631
   currently does the plain `local.set keyLocal`).** Mirror the C-style
   per-iteration cell-clone at loops.ts ~1152–1170:
   - Allocate a **fresh ref cell** each iteration (`struct.new $refcell` with a
     null/placeholder init) and **re-aim `boxedCaptures[name]`** to it, so
     closures created in the ForDeclaration defaults and the body capture a
     **distinct per-iteration cell**.
   - Run **BindingInstantiation**: bind the key into the per-iteration cell. For
     a plain identifier head, write the key into the cell and flip the TDZ flag
     to 1 (`emitLocalTdzInit`). For a **binding-pattern head**
     (`let [x, _ = …]`), reuse the existing externref-destructuring helpers
     (`compileExternrefArrayDestructuringDecl` /
     `compileExternrefObjectDestructuringDecl`, already invoked at lines
     5582–5592) so default initializers run **in the per-iteration env** and
     `emitTdzInitForBindingPattern` flips the flags. This closes
     `scope-body-lex-open/close` (probeDecl/probeBody capture the per-iteration
     cell → return `'i'`).
   - **Important:** establish the per-iteration env (fresh cell + re-aim) BEFORE
     running the pattern defaults, so a default that builds a closure
     (`_ = probeDecl = function(){ return x }`) captures the new cell.
3. **Restore** the saved `boxedCaptures`/`tdzFlagLocals`/`localMap` entries on
   loop exit (the `savedForBoxedCaptures` restore at loops.ts:1254–1260 is the
   template).

> **Reuse-vs-rebuild call.** The cleanest implementation factors the C-style
> loop's per-iteration cell logic (loops.ts ~858–909 setup, ~1152–1260
> clone+restore) into a small shared helper
> (`emitPerIterationLexicalEnv(fctx, headNames, …)`) and calls it from both the
> C-style loop and for-in. If that refactor looks too broad for one PR,
> **duplicate the ~40-line cell-clone block** into the for-in path and leave a
> `// TODO(#2705) de-dup with compileForStatement per-iter env` marker — the
> functional outcome is identical and lower-risk than a cross-cutting refactor.

#### Slice C — dynamic null-receiver runtime guard (robustness, 0 new tests)

If Slice A only does the *static* nullish skip, add the runtime `ref.is_null →
br $break` guard for non-literal receivers that may be null at runtime. Optional;
no listed test requires it but it prevents the same trap class for
`for (k in maybeNull)`. Can fold into Slice A.

#### Slice D — eval-based var-head (deferred, 6 tests)

`S12.6.4_A3/A3.1/A4/A4.1`, `scope-head-var-none`, `scope-body-var-none`. Closing
these requires lifting the `ForInStatement` bail in `allNodesInlineSupported`
(`eval-inline.ts:179`) so `eval("for(var ind in …)…")` inlines and outer locals
(`__str`, `arr`) resolve. **High risk:** the inlined source is parsed via
`ts.createSourceFile` with **no checker bindings**, and `compileForInStatement`
leans on `ctx.checker.getTypeAtLocation(stmt.expression)` (resolveArrayInfo /
resolveWasmType) which returns error/`any` types for foreign nodes — the
enumeration-primitive selection would mis-route. Treat as a **separate
follow-up**, not part of #2705's acceptance.

### Edge cases

- `for (let in obj)` — `"let"` is a *real binding name* in non-strict mode; it
  must be writable and visible after the loop per `head-lhs-let`'s
  `assert.sameValue(let, 'key')`. Use the same reuse-or-alloc logic as any other
  identifier (Slice A step 2), not a throwaway temp.
- `for ([let][1] in obj)` (member target) — already handled by the
  `memberTarget` branch + `emitForInMemberTargetWrite`; verify the
  `Array.prototype[1]` **setter** is invoked (PutValue semantics) so
  `head-lhs-let`'s second assertion passes. No change expected; add a test probe.
- Head binding-pattern with defaults (`let [x, _ = f()]`) — defaults must run
  per iteration in the per-iteration env (Slice B step 2), not once.
- `continue`/`break` depth bookkeeping (the `+= 3` / `-= 3` adjustments at lines
  5566–5614) must remain correct if Slice B adds nesting; if the per-iteration
  cell-clone adds a block, update the depth deltas accordingly.
- TDZ flag for a head whose name **also** exists as an outer let/const (the
  `let x = 1; for (let x in {x})` shadow in `head-let-bound-names-fordecl-tdz`) —
  the head TDZ binding must **shadow** the outer one for the receiver eval; save
  and restore the outer `localMap`/`boxedCaptures`/`tdzFlagLocals` entry.
- A `var` head that collides with a body `var` re-declaration
  (`head-var-bound-names-in-stmt`) — both must resolve to the single hoisted slot
  (Slice A step 3).

### Wasm / IR patterns

- **Ref cell** for the per-iteration + head bindings:
  `struct (field $value (mut externref))` via `getOrRegisterRefCellType`. Closure
  capture reads/writes go through `struct.get`/`struct.set` so every closure that
  captured the same cell sees the same mutation (existing `boxedCaptures` path).
- **TDZ guard** (uninitialized read): the existing module/local TDZ pattern —
  flag local (i32, 0=uninitialized) checked before the value read; on 0 emit
  `throw ReferenceError`. For the boxed (closure-captured) case the flag itself
  is boxed (`fctx.boxedTdzFlags`) so the throw fires from inside the closure.
  `typeof` of a TDZ binding must **also** throw (not yield `"undefined"`) — the
  `typeof x` in `scope-head-lex-open` relies on this; confirm the `typeof`
  lowering honors the TDZ flag for boxed head bindings.
- **Per-iteration fresh cell:** `struct.new $refcell` each iteration then re-aim
  `boxedCaptures` — copy the C-style template at loops.ts ~1163–1170.
- **Null-receiver skip:** static case emits no loop; dynamic case
  `local.tee $obj / ref.is_null / br_if $break`.

### Suggested slicing (dev-sized PRs)

| Slice | Closes | Risk |
|-------|--------|------|
| **A** — LHS dispatch (paren unwrap + `let`-identifier declCount===0) + `var`-head local reuse + static null-receiver skip | `head-lhs-cover`, `head-lhs-let`, `identifier-let-allowed-…`, `let-identifier-with-newline`, `head-var-bound-names-in-stmt` (**5**) | Low — local edits in lines 5399–5447, 5531 |
| **B** — head TDZ env + per-iteration fresh lexical binding for let/const heads | `head-let-bound-names-fordecl-tdz`, `head-const-bound-names-fordecl-tdz`, `scope-head-lex-open`, `scope-head-lex-close`, `scope-body-lex-open`, `scope-body-lex-close` (**6**) | High — reuses C-style per-iter machinery; new head/per-iter env split |
| **C** — dynamic runtime null-receiver guard | (robustness, 0) | Low — fold into A |
| **D** — eval-inline `ForInStatement` support | `S12.6.4_A3/A3.1/A4/A4.1`, `scope-head-var-none`, `scope-body-var-none` (**6**) | High, **deferred** — foreign-node type resolution; separate follow-up |

Ship **A first** (independent, 5 tests, fast). **B** can start in parallel but
should land after A to avoid dispatch-block conflicts in lines 5399–5447.
Re-target the acceptance criteria to **"≥10 of the 11 Slice A+B tests"** (the
"18 of 20" figure counted the 6 eval/var-none tests that are not closeable here).

### Risk note

- **#2552 (AnnexB TDZ hotpath).** AnnexB §B.3.5 allows a `var`-redeclaration to
  cross a `catch` parameter and has special TDZ handling that touches the same
  `tdzFlagLocals`/`boxedTdzFlags` maps (`src/codegen/statements/nested-declarations.ts`,
  `expressions/identifiers.ts`). Slice B adds head bindings to those maps — verify
  the save/restore is symmetric so a for-in inside a `catch` body (or vice-versa)
  doesn't leak a TDZ flag. Add a regression probe combining a `catch` and a
  `for (let x in …)`.
- **#1888 standalone open-any floor.** The standalone/WASI enumeration path
  (lines 5480–5523, `__object_keys`/`__extern_*`) is governed by the open-any
  floor; Slice B's per-iteration ref-cell + TDZ machinery is backend-agnostic
  (operates on `boxedCaptures` before the enumeration primitives are chosen), so
  it should not move the floor — but run the standalone floor check, since a new
  `throw ReferenceError` import or ref-cell type can shift func/type indices.
- **Index-shift / late-import hazards.** A new `throw ReferenceError` path or
  ref-cell struct type registered late can shift func/type indices — register
  shared types up-front (per `reference_subview_type_idx_stability`) and prefer
  name-based repoint over positional.
- **`continue` depth math.** If Slice B nests the per-iteration cell-clone in a
  new block, the `breakStack`/`continueStack` `+= 3`/`-= 3` deltas (lines
  5566–5614) must be updated in lockstep or `continue` lands on the wrong label.

## Implementation Notes (esch, 2026-06-26)

**Result: 10 / 11 closeable tests pass** (Slice A: 4, Slice B: 6). The single
miss is `head-lhs-let.js`, whose second assertion (`for ([let][1] in obj)`)
requires invoking an `Array.prototype['1']` numeric-index **setter** installed
via `Object.defineProperty` when assigning past the end of a freshly-built
array literal `[let]`. js2wasm lowers `[let]` to a WasmGC vec, not a host JS
array with a live prototype-accessor chain, so a PutValue through the inherited
numeric setter is a host-array exotic that is out of scope for for-in scoping.
The IdentifierReference half (`for (let in obj)`) **does** pass; only the
MemberExpression half is unreachable. This is the 1 allowed miss.

### What changed and WHY (not just what)

The architect's "Slice B = per-iteration ref-cell rebuild" turned out to be
**more than these tests need** — the existing externref-destructuring path
(`compileExternrefArrayDestructuringDecl`) already gives per-iteration-correct
captures for a 1-iteration receiver (confirmed: `scope-body-lex-close`'s
`probeDecl()`/`probeBody()` already returned `'i'` before any Slice B work).
The two genuinely-missing mechanisms were the **head TDZ environment** and the
**post-loop restore**. Implemented as a tightly-scoped change gated on
`isLexicalHead` (a `let`/`const` head with ≥1 declaration) so `var` and bare
identifier for-in — the overwhelming common case — are byte-identical.

1. **`src/codegen/statements/loops.ts` — LHS dispatch (Slice A).**
   - Paren-unwrap (`head = init; while isParenthesizedExpression …`) routes
     `for ((x) in …)` to the bare-identifier branch (`head-lhs-cover`).
   - Empty-`declarations` VariableDeclarationList ⇒ the non-strict `let`
     *identifier* (`for (let in …)`); TS drops the identifier text, so before
     this the code deref'd `declarations[0].name` on `undefined`
     (`head-lhs-let`, `identifier-let-allowed`).
   - `var`-head reuses the hoisted function-scope slot instead of `allocLocal`
     (a fresh slot shadowed the hoisted one, so writes never reached the body's
     view of `x`) (`head-var-bound-names-in-stmt`).
   - Static-nullish receiver (`isStaticNullishReceiver`) ⇒ emit no loop (zero
     iterations, §14.7.5.6 step 7) — fixes `let-identifier-with-newline` whose
     `null` receiver previously produced invalid Wasm.

2. **`src/codegen/statements/variables.ts` — `var x;` redeclaration is a
   runtime no-op (root cause of `head-var-bound-names-in-stmt`).** A no-init
   `var x;` whose slot was already hoisted re-emitted `__get_undefined → x`,
   **clobbering** the value the slot held (the enumerated key). Per §14.3.2.1 a
   bare `var x;` is a no-op; the hoister already initialized the slot to
   `undefined` at function entry. Now skipped when the var reused a hoisted
   local (`isVar && existingIdx >= params.length`). This is a general
   correctness fix, not for-in-specific.

3. **`src/codegen/statements/loops.ts` — head TDZ env + post-loop restore
   (Slice B).** For a `let`/`const` head: before compiling the receiver, install
   a TDZ environment for the head's bound names (§14.7.5.6 step 2) — boxed
   ref-cell + boxed TDZ flag for names captured by a closure (so the closure
   captures the never-initialized binding by reference), plain local + i32 TDZ
   flag otherwise; both uninitialized. Compile the receiver (reads of head names
   now throw / `typeof` throws). Tear the env down (step 4); the per-iteration
   body binds the names afresh (binding-pattern via the existing destructuring,
   plain identifier via `keyLocal`). After the loop, restore the saved outer
   `localMap`/`tdzFlagLocals`/`boxedCaptures`/`boxedTdzFlags`/`constBindings`
   entries so head names do not leak (`scope-body-lex-close`'s
   `x === 'outside'`). Scoped to the host enumeration path; array/closed-shape
   receivers are unchanged. Ref-cell types are fetched via the shared
   `getOrRegisterRefCellType` (externref + i32 cells already exist, so no late
   type-index shift).

4. **`src/codegen/typeof-delete.ts` — `typeof x` of a boxed-TDZ binding must
   throw, not static-fold.** `compileTypeofExpression` folded `typeof x` to a
   type string via `staticTypeofForType` BEFORE compiling the operand, bypassing
   the TDZ check. Now, when the operand is an identifier with a boxed TDZ flag
   (`fctx.boxedTdzFlags`), force the runtime path so `compileExpression` emits
   the boxed TDZ check (throws when the flag is 0). Narrow gate — only
   closure-captured TDZ bindings — so ordinary `typeof letVar` is unchanged
   (verified: `language/expressions/typeof` 11/16 on branch == baseline).

5. **`src/codegen/closures.ts` — receiver closures are a TDZ risk
   (`closureProvablyAfterLetDecl`).** A closure built inside a `for (let x in
   RECEIVER)` head's receiver was wrongly deemed "provably after the decl /
   per-iteration, no TDZ" because the for-in wraps both. Per §14.7.5.6 the
   receiver is evaluated in the head TDZ env (distinct from the per-iteration
   env), so such a closure captures a binding that stays in its TDZ forever and
   its read/`typeof` must throw. Added: when the wrapping loop is for-in/for-of,
   the closure is in `cur.expression` (receiver) and the decl is the head
   (`cur.initializer`), return `false` (TDZ risk). Without this the closure
   never carried the TDZ flag, so `typeof x` could not throw
   (`scope-head-lex-open/close`, `scope-body-lex-open`).

### Regression validation (scoped, host mode, fresh process per test)

Re-run on resume (full for-in suite, both branch HEAD and merge-base `14fa625`
via a fresh tsx process per test — the test262 worker uses fork isolation, so
each compile must be isolated to avoid in-process TS-program pollution):

- **`language/statements/for-in` + `annexB/.../for-in` (122 tests): baseline 94
  PASS → branch 104 PASS = +10, ZERO regressions.** The 10 improvements are
  exactly the closeable set (Slice A: `head-lhs-cover`, `head-var-bound-names-in-stmt`,
  `identifier-let-allowed`, `let-identifier-with-newline`; Slice B: the 6
  TDZ/scope tests). `head-lhs-let` remains FAIL on both branches (the 1 allowed
  miss — Array.prototype numeric-index setter, out of scope; not a regression).
- **Broad var/typeof/scope sample (70 tests across
  `language/statements/{variable,for,let,const}` + `language/expressions/typeof`):
  baseline 56 PASS == branch 56 PASS, ZERO deltas.** Confirms the broad-reach
  `variables.ts` var-redecl-no-op and `typeof-delete.ts` boxed-TDZ changes do not
  regress non-for-in code.
- Curated equivalence batch (`issue-1896-typeof-closure`, `issue-1128-dstr-tdz`,
  `issue-2572-standalone-forin`, `issue-2200-annexb-block-fn-hoist`,
  `for-of-array-destructuring`, `issue-2705`) all green; the 3 failing files in
  the batch (`ir-let-const-equivalence`, `issue-1690b`, `illegal-cast-closures-585`)
  fail **identically on the merge-base** — pre-existing stale-import-map harness
  drift in those test files, not a codegen regression.
- The eval-routed `S12.6.4_A3/A3.1/A4/A4.1`, `scope-head/body-var-none`, `cptn-*`
  remain deferred (Slice D / eval-inline) as specced.
- CI runs full test262 for the authoritative regression check.
