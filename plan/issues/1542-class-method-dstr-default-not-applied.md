---
id: 1542
title: "Class method destructured-pattern param default not applied; throws \\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"Cannot destructure null\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\" instead"
status: ready
created: 2026-05-20
updated: 2026-05-29
priority: high
feasibility: hard
goal: test262-conformance
sprint: 57
parent: 820
test262_fail: 134
---

## 2026-05-28 — Second attempt parked: prior fix landed and reverted with -1219 regression

The architect spec proposed Fix #1 (externref→vec coercion in `coerceType`),
but `src/codegen/type-coercion.ts:1347` ALREADY handles externref→ref/ref_null
where `to` is a vec/tuple struct (via `buildVecFromExternref` /
`buildTupleFromExternref`). The vec path is not the bug.

PR #440 (commit `cc732f511`) correctly identified the actual root cause:
`compileClassesFromStatements` in `src/codegen/declarations.ts` does NOT
propagate `insideFunction` through recursive descents into `block`/`if`/
`try`/loop/switch/labeled. Classes nested in any control-flow construct
inside a function are therefore treated as module-level: their bodies are
**eagerly compiled at module-pass time**, BEFORE `hoistFunctionDeclarations`
registers sibling function declarations (the nested `function* g()` referenced
by the method's param default) into `funcMap`. The lookup misses, the call
falls back to `ref.null.extern`, and the destructure guard throws.

**PR #440 was merged then reverted (commit `46b026aaa`) due to a confirmed
-1219 test262 regression** (28817 → 27598). Breakdown from the revert PR
#516:

- **wasm_compile: 691** (cascade — classes nested in blocks no longer
  eagerly compiled, shape registration missing at use site)
- runtime_error: 279
- assertion_fail: 275
- type_error: 42

The broad propagation `compileClassesFromStatements(stmts, insideFunction)`
through every recursive descent fixed the -134 dstr-default cases but broke
~1085 OTHER cases where module-level code (or anonymous class expressions
reached via `compileAnonymousClassBodiesInNode`'s `forEachChild` recursion)
depended on the eager class-body compilation that the broad defer disabled.
Collection (`collectClassesFromStatements`) DOES register shapes recursively,
so the shape itself wasn't missing — what broke was downstream code that
needed method bodies to be compiled at module-init time, not deferred to
function-body-compile time.

### What a correct fix must do

Eager compile vs deferred compile is not a binary choice driven by syntactic
nesting alone. The deferred path (`compileNestedClassDeclaration` reached via
`compileStatement` while compiling the enclosing function body) only fires
for classes reached through the function body's statement traversal. Module-
level code that constructs the nested class directly (or references its
methods through closure capture) needs the body emitted at module-init.

A correct fix needs an architect spec to disambiguate:

1. Which class nesting positions are reachable only from inside the
   enclosing function's body (safe to defer).
2. Which positions can be referenced from outside the function (require
   eager compile, but then the missing-funcMap-entry case for default
   initializers has to be handled differently — e.g. by hoisting nested
   function decls into a pre-pass before eager class-body compile, OR by
   making the call-expression compiler emit an order-independent
   `call_indirect` against a wrapper struct that gets filled in later).
3. Whether the `compileAnonymousClassBodiesInNode` `forEachChild` recursion
   needs to be conditioned on `insideFunction` too, and what the cascade
   effects are on its callers.

Files of interest for the architect:
- `src/codegen/declarations.ts:3171-3253` — `compileClassesFromStatements`
- `src/codegen/declarations.ts:2168-2289` — `collectClassesFromStatements`
  (recursive shape collection — already handles nested classes)
- `src/codegen/statements/nested-declarations.ts:75-148` —
  `compileNestedClassDeclaration` (deferred-compile path)
- `src/codegen/statements/nested-declarations.ts:717+` —
  `hoistFunctionDeclarations` (registers `funcMap` entries during function
  body compile — runs AFTER module-pass class-body compile, hence the bug)

### Why senior-dev declined to retry the same fix

Re-applying PR #440's broad `insideFunction` propagation will reproduce the
-1219 regression. A narrower variant (e.g. only deferring when the class
has method param defaults referencing unresolved identifiers) is feasible
but the heuristic is fragile and risks half-fixing — the +134 here is not
worth the risk of another -N regression when N other code paths share the
same eager-class-body assumption.

The proper sequence is:
1. **Architect** writes a respec that defines the eager/deferred contract
   for nested classes precisely (not just "if in a function, defer").
2. **Senior-dev** implements per the spec.
3. Pre-merge CI is the gate — but the architect work has to come first so
   the implementation isn't another guess-and-revert.

Marked `status: needs-architect-spec` and reprioritized off sprint 52.

## Implementation Plan (respec 2026-05-29)

> This supersedes the "Fix #1 (coerceType externref→vec)" plan at the bottom
> of this file — that hypothesis was already proven wrong (the vec path is not
> the bug; see the 2026-05-28 note above). This respec targets the **confirmed**
> root cause: funcMap-population order at the *eager* class-body compile site,
> and it is deliberately designed to NOT reproduce the −1219 cascade that
> reverted PR #440.

### Confirmed root cause (verified against current `src/codegen/declarations.ts`)

Module-level compilation runs in this order inside `compileDeclarations`
(`src/codegen/declarations.ts`):

1. **L3346** — `compileClassesFromStatements(sourceFile.statements)` walks the
   tree and **eagerly** calls `compileClassBodies` for every class it reaches
   whose `insideFunction` flag is `false` (L3223-3235). Crucially, the recursive
   descents into `if`/`block`/`for`/`while`/`switch`/`try`/labeled (L3257-3293)
   **do NOT pass `insideFunction`**, so a class nested in any control-flow
   construct *inside a function* is treated as module-level and compiled here,
   eagerly, at module-pass time.
2. **L3452** — the top-level function-declaration body loop runs. Only here,
   when an enclosing function body is compiled via `compileFunctionBody`
   (`src/codegen/function-body.ts:880`/`951`), does
   `hoistFunctionDeclarations` register *control-flow-nested* sibling
   `function`/`function*` declarations into `ctx.funcMap`. (The module-level
   `collectDeclarations` loop at L2327-2328 only registers **top-level**
   function declarations — nested ones are lazy-hoisted.)

So when step 1 eagerly compiles the body of a control-flow-nested class whose
method has a param default referencing a sibling generator
(`method([,] = g())` where `function* g(){}` is a sibling in the same block),
`g` is **not yet in `funcMap`** (it only lands there in step 2). The
call-expression compiler emits its graceful `ref.null.extern` fallback, the
guarded `local.set` stores null, and `destructureParamArray` hits its
`ref.is_null` guard → "Cannot destructure 'null' or 'undefined'".

**Shape registration is NOT the problem.** `collectClassesFromStatements`
(L2203-2272) recurses unconditionally into every control-flow construct and
registers the struct + method stubs in `ctx.structMap` / `ctx.funcMap`
regardless of nesting. The struct type and the method *stub* (function index)
always exist. Only the **param-default lookup of the sibling generator** is
order-dependent.

### Why PR #440 cascaded to −1219 (the landmine the respec must dodge)

PR #440 fixed the symptom by propagating `insideFunction` through every
recursive descent in `compileClassesFromStatements`, which flipped those
control-flow-nested classes from **eager** (step 1) to **deferred** (added to
`ctx.deferredClassBodies`, L3227/3240). A deferred class body is only compiled
later, when `compileNestedClassDeclaration` (`statements/nested-declarations.ts:75`)
is reached during the enclosing function's body traversal via
`compileStatement` (`statements.ts:225`).

The fatal gap: **`ctx.deferredClassBodies` is never flushed.** It is keyed by
class *name*, added when `insideFunction`, and removed (L143) only when
`compileNestedClassDeclaration` actually fires. The set of classes
`compileClassesFromStatements` *marks deferred* (its broad structural descent)
is **larger** than the set `compileStatement` *reaches during body compile*
(the actual runtime statement traversal — which skips dead branches, differs
for arrow/function-expression bodies handled by `compileClassesFromFunctionBody`,
and never runs for functions whose bodies aren't compiled). Every class in the
difference is **orphaned**: shape + method stubs exist, but the method/ctor
**bodies are never emitted**. Downstream `call`/`call_ref` sites and static
member references then point at empty function bodies → the **691 wasm_compile**
failures. (The other revert buckets — runtime_error 279, assertion_fail 275,
type_error 42 — are the same orphaned-body defect surfacing as wrong runtime
behaviour rather than a hard validation error.)

So the binary "eager vs deferred by syntactic nesting" is the wrong lever: it
silently drops bodies whenever the marking traversal and the compiling
traversal diverge.

### Chosen approach: keep bodies EAGER, fix only the funcMap order

**Do NOT defer.** Keep every class body compiled eagerly at step 1 exactly as
today — this preserves the load-bearing eager path byte-for-byte and is what
makes this respec cascade-proof: **no body changes from eager→deferred, so the
orphaned-body failure mode is structurally impossible.** The only change is to
make the sibling function declarations *visible in `funcMap`* before the eager
class body is compiled.

Concretely: when `compileClassesFromStatements` is about to eagerly compile a
class body that lives in a statement list, **first hoist the sibling
function/function* declarations from that same statement list into `funcMap`**,
using the existing module-level function-registration path (NOT
`hoistFunctionDeclarations`, which needs an `fctx` we don't have at module
pass — see "Why not hoistFunctionDeclarations" below).

This is approach #2 from the 2026-05-28 note ("hoist sibling function decls
into funcMap BEFORE compiling nested-class method bodies, while keeping shape
registration eager") — selected because it touches the **smallest** surface and
leaves the eager/deferred contract untouched.

### Changes

**File: `src/codegen/declarations.ts`**

1. **`compileClassesFromStatements` (L3214-3297)** — add a sibling-function
   pre-hoist. At the **top of the `for (const stmt of stmts)` loop body**
   (before the class-declaration branch at L3223), when the *current statement
   list* contains a class declaration / class-expression var that will be
   compiled eagerly in this call (i.e. `!insideFunction`), first ensure every
   sibling `ts.isFunctionDeclaration(s) && s.body && !hasDeclareModifier(s)` in
   `stmts` is registered in `ctx.funcMap`.

   Implementation shape — factor a helper `ensureSiblingFunctionsRegistered(stmts)`
   that, for each function-declaration statement in `stmts` whose name is not
   already in `ctx.funcMap`, runs the **same registration** that the top-level
   loop at L2327-2328 → L2563 (`ctx.funcMap.set(name, funcIdx)`) performs:
   allocate the `WasmFunction` entry (signature, generator/async flags via the
   existing `collectDeclarations` helpers) and `ctx.funcMap.set(name, funcIdx)`.
   The cleanest path is to extract the per-statement function-registration body
   of the L2327 loop into a reusable `registerFunctionDeclaration(ctx, stmt,
   sourceFile)` and call it from both sites. Then the body is filled in later by
   the step-2 loop (L3452) / `hoistFunctionDeclarations` as today — we only need
   the **index + signature** in `funcMap` for the param-default call-expression
   compiler to resolve `g()` to a `call`/`call_ref`, not the body.

   Call `ensureSiblingFunctionsRegistered(stmts)` **once per `stmts` list**
   (guard with a `WeakSet<readonly ts.Statement[]>` of already-processed lists,
   or simply call it at the top of each `compileClassesFromStatements` invocation
   before the loop) so its cost is O(statements) not O(statements²).

   IMPORTANT: do this for the statement list **only when it actually contains a
   class that will be eagerly compiled** — i.e. when `!insideFunction`. When
   `insideFunction` is true the eager branch is not taken (those would be
   deferred), so the pre-hoist is unnecessary and must be skipped to avoid
   double-registering nested functions that the step-2 hoist owns.

2. **DO NOT change the recursive-descent calls (L3257-3293) to pass
   `insideFunction`.** That is the exact PR #440 change that cascaded. Leave the
   descents calling `compileClassesFromStatements(...)` with the default
   `insideFunction = false`. The control-flow-nested class stays **eager**; the
   pre-hoist (change 1) on each descended statement list makes its sibling `g()`
   resolvable.

   (Because the descents recurse into the inner statement lists with
   `insideFunction = false`, change 1's `ensureSiblingFunctionsRegistered` runs
   on each inner block's statement list too — which is exactly where the sibling
   `function* g` lives relative to the nested class. That is the mechanism that
   fixes the repro.)

#### Why not just call `hoistFunctionDeclarations`?

`hoistFunctionDeclarations` (`statements/nested-declarations.ts:717`) requires a
live `FunctionContext` (`fctx`) and emits the function body immediately via
`compileNestedFunctionDeclaration`. At module-pass time (step 1) there is no
enclosing `fctx` for these siblings, and forcing body compilation here would
duplicate work the step-2 loop already does and risk index-shift fights with
`addUnionImports`/string-constant globals. We only need the **funcMap index +
signature**, which the lightweight `collectDeclarations`-style registration
provides without compiling a body. The body is compiled later by the existing
machinery.

#### Generator/async-generator sibling specifics

The repro's sibling is a `function* g(){}`. Registration must set the same
metadata the top-level loop sets: `ctx.generatorFunctions.add(name)`,
`ctx.generatorYieldType.set(...)`, and (for async) `ctx.asyncFunctions`. Reuse
the exact branch at L2359-2371 — do not hand-roll a subset, or the call-site
lowering of `g()` will pick the wrong return-shape and re-introduce a coercion
mismatch.

### Phase ordering — before vs after

```
BEFORE (current main):
  compileDeclarations:
    L3346  compileClassesFromStatements(top-level)
             └─ eagerly compileClassBodies(control-flow-nested class C)
                  └─ param default g() lookup → funcMap MISS  ❌  (g not yet hoisted)
                  └─ ref.null.extern fallback → destructure throws
    L3452  top-level function bodies
             └─ hoistFunctionDeclarations registers sibling g  (too late)

AFTER (this respec):
  compileDeclarations:
    L3346  compileClassesFromStatements(top-level)
             ├─ ensureSiblingFunctionsRegistered(stmts)         ✅ NEW
             │     └─ ctx.funcMap.set("g", idx) (+gen/async metadata), body deferred
             ├─ (recurse into block/if/try/loop with insideFunction=false, each
             │    descent runs ensureSiblingFunctionsRegistered on its own stmts)
             └─ eagerly compileClassBodies(control-flow-nested class C)
                  └─ param default g() lookup → funcMap HIT     ✅
                  └─ proper call/call_ref → destructure runs against materialised value
    L3452  top-level function bodies
             └─ hoistFunctionDeclarations: g already in funcMap → no-op for g,
                bodies of g and C's methods compiled as before
```

Nothing moves from eager→deferred; the only delta is that `funcMap` learns the
sibling function indices one phase earlier.

### Wasm IR

No new IR shapes. The fix simply makes the existing param-default lowering emit
the *correct* path it already emits when `g` is in `funcMap`:

```wasm
;; param default `= g()` once g is resolvable:
call $g                 ;; was: ref.null.extern  (the bug)
;; → externref Generator object; existing materialisation/destructure runs
```

### Edge cases the dev MUST cover

- **Sibling fn declared AFTER the class textually** — JS hoists function
  declarations, so `class C { m([,]=g()){} }` then `function* g(){}` in the
  same block must also resolve. `ensureSiblingFunctionsRegistered` iterates the
  whole `stmts` list up front, so textual order is irrelevant. Add a test for
  the after-declaration case.
- **Name collision with a top-level function** — if `g` is already in
  `funcMap` (top-level), the `!ctx.funcMap.has(name)` guard skips re-registration.
  Do not overwrite.
- **Async generator sibling** (`async function* g(){}`) — set both
  `asyncFunctions` exclusion and `generatorFunctions` per the L2359-2371 logic.
  Covered by `async-gen-meth-*` / `async-private-gen-meth-*` test262 families.
- **Private methods** (`#m([,]=g())`) lower to `C___priv_method` stubs through
  the *same* `compileClassBodies` path — no extra site; verify the
  `C___priv_method` bucket (38 fails) clears.
- **Anonymous class expressions** reached via `compileAnonymousClassBodiesInNode`
  (`forEachChild`, L3329-3344) — these are ALSO eager and ALSO bypass the
  per-stmt-list pre-hoist (forEachChild doesn't go through
  `compileClassesFromStatements`). The `__anonClass_0___priv_method` bucket (24
  fails) lives here. The pre-hoist must therefore ALSO run for the statement
  list that *contains* the anon-class-bearing statement. Since
  `compileAnonymousClassBodiesInNode(stmt)` is called per-`stmt` inside the
  `compileClassesFromStatements` loop (L3295), the per-stmt-list pre-hoist at
  the top of that loop already covers the sibling functions for anon classes in
  the same list. Verify with a `new (class { #m([,]=g()){} })()` + sibling
  `function* g` repro.
- **`local`/`const`-captured sibling** — if the "function" is actually a
  `const g = function*(){}` (function *expression* in a var), it is NOT a
  `ts.FunctionDeclaration` and is hoisted differently (closure capture). Out of
  scope for this fix (separate path); document as a known non-goal in the test
  file. The 134-fail bucket is all `function*` *declarations*.

### Test plan

**A. The original repro MUST pass** (`tests/issue-1542.test.ts` — re-add the
4 cases PR #440 added, which the revert deleted):
1. `function* g(){yield;} class C { method([,]=g()){return 'ok';} } new C().method()` → `'ok'`
2. `class C { method({x=1}={}){return x;} } new C().method()` → `1`
3. Private: `class C { #m([,]=g()){return 'ok';} run(){return this.#m();} }` with sibling `function* g`
4. Static: `class C { static m({x=5}={x:10}){return x;} }` → `5`
5. **NEW (forward-reference)** — class textually BEFORE its sibling generator,
   both in a `{ ... }` block inside a function, then the function is called.
6. **NEW (anon class)** — `new (class { method([,]=g()){return 'ok';} })()`
   with sibling `function* g`.

**B. Regression guard for the 691-wasm_compile cascade** — spot-check that
control-flow-nested classes whose **shapes/methods are used downstream** still
compile their bodies. The dev must compile-and-run (not just compile) each of:
- class nested in an `if`-block, instantiated and a method called from
  module-level AND from inside the same function;
- class nested in a `try`-block, used in a `catch`;
- class nested in a `for`-loop body, instantiated each iteration;
- class nested in a `switch`-case;
- a class whose method is referenced via `C.prototype.m` and via `instance.m`
  (the `classExprNameMap` dual-registration path, see L2276-2302) — assert
  `c.m === C.prototype.m`.

Add these as a dedicated `tests/issue-1542-nested-shape-guard.test.ts`. Because
this respec keeps bodies eager, all of these should be **unchanged from
current main** — the guard exists to *prove* no body went missing.

**C. Targeted test262 categories** (run via the runner with a path filter, do
NOT rely on the full suite for the signal):
- `language/statements/class/dstr/meth-dflt-*`, `gen-meth-*`, `async-gen-meth-*`
- `language/statements/class/dstr/private-meth-*`, `private-gen-meth-*`
- `language/expressions/class/dstr/*` (anon/private families)

### Risk section — this issue has a −1219 landmine

- **Highest risk: silent body loss.** The whole point of keeping bodies eager
  is to make body-loss impossible. The dev MUST NOT, under any circumstance,
  add `insideFunction` to the recursive-descent calls (the PR #440 change). If a
  reviewer sees `compileClassesFromStatements(stmt.X.statements, insideFunction)`
  in the diff, reject it — that is the reverted approach.
- **Index-shift risk.** Registering function indices in `funcMap` at module-pass
  time interacts with `addUnionImports` / string-constant import globals which
  shift function indices later. The dev must register using the SAME mechanism
  the existing L2327 top-level loop uses (which is already correct under those
  shifts), not a bespoke index calculation. If the existing loop's registration
  cannot be cleanly extracted, prefer moving the **nested sibling function
  registration into the existing `collectDeclarations` pass** (recurse into
  control-flow bodies there, registering indices but not bodies) over
  hand-rolling registration in `compileClassesFromStatements`.
- **Double-registration.** Guard every registration with
  `!ctx.funcMap.has(name)`; the step-2 `hoistFunctionDeclarations` already
  guards the same way (`nested-declarations.ts:724`), so the two passes coexist.
- **Mandatory full-CI net read before merge.** This issue carries a confirmed
  −1219 history. The dev **MUST NOT self-merge on a local hunch or on the
  targeted-category signal alone.** Required gate before merge:
  - Full sharded CI `net_per_test > 0`, total regressions ≤ 10, no single bucket
    > 50 (per `/dev-self-merge`), AND
  - **specifically inspect the `wasm_compile` bucket delta** — it must be ≥ 0
    (ideally +0; any positive `wasm_compile` regression is the cascade
    re-appearing and is an automatic ESCALATE-to-tech-lead, not a self-merge).
  - Cross-check the `runtime_error` / `assertion_fail` buckets (the 279/275
    revert buckets) for any cluster matching the orphaned-body signature.
  - If `wasm_compile` regresses at all, revert and escalate; do not iterate
    blindly.

### Estimated impact

~134 official test262 fails in the `Cannot destructure 'null' or 'undefined'
[in C_method/C___priv_method/__anonClass_*___priv_method]` families flip to
pass, with **zero** expected movement in any other bucket (bodies stay eager).
A positive net that is *not* ≈+134-and-nothing-else is a signal to investigate
before merge.

## Suspended Work
## Suspended Work

**Suspended**: 2026-05-20 by dev-equiv-tests after smoke-testing.

**Worktree**: `/workspace/.claude/worktrees/issue-1542-class-method-dstr-default` (branch
`issue-1542-class-method-dstr-default`). Clean — no commits.

**Status**: Minimal repros all PASS on current main:
- `method({ x = 1 } = {})` → 1 ✓
- `method([,] = g())` with `function* g() { yield; }` → "ok" ✓
- Side-effect tracking with `let first/second` → matches JS ✓
- Private method `#m([,] = g())` ✓
- Static method `static m({ x = 5 } = { x: 10 })` ✓

But the baseline still shows 102+ failures (`Cannot destructure 'null' or 'undefined'`
across `C_method`, `C___priv_method`, `__anonClass_0___priv_method`). The failures
must require specific test262-harness shape that the simple repros don't trigger.

**Hand-off notes for senior-developer**:
- Architect spec at line 105+ proposes a `coerceType` branch for externref → vec
  via `__array_from_iter`. The fall-through at line 1019-1048 of
  `src/codegen/type-coercion.ts` is where opaque externrefs lose their iterable
  nature (today emits `ref.null` in the else of `ref.test`).
- Need to compile actual failing test262 file shape (with harness wrap) and
  trace the param-default code path to find the bug.
- One incidental observation while probing: array-elision `[,]` over a generator
  appears to advance the iterator one extra time (second=1 vs expected 0). This
  may or may not be a related bug.

Reprioritized to `feasibility: hard` because reproduction requires harness
shape; the architect's proposed `coerceType` change is the right hypothesis but
needs validation against the actual failing tests.

# #1542 — Class method destructured-pattern param default not applied

## Problem

Class methods (regular, generator, async-generator, private) whose parameter is a
**binding pattern with a parenthesised default** (e.g. `method([,] = g())`,
`method({ x = 1 } = {})`) throw

```
Cannot destructure 'null' or 'undefined' [in C_method() ← test]
```

when called with no argument (or `undefined`), instead of substituting the
default value and then destructuring.

Per ES spec §13.15.5.6 (KeyedBindingInitialization) and §13.3.3.6
(IteratorBindingInitialization), the param-level default must be evaluated
**before** the destructuring step runs against the value.

### Minimal repro

```js
function* g() { yield; }
class C {
  method([,] = g()) {           // default = g()
    return 'ok';
  }
}
new C().method();                // expected: 'ok'; actual: TypeError "Cannot destructure null"
```

```js
class C {
  method({ x = 1 } = {}) { return x; }
}
new C().method();                // expected: 1; actual: TypeError
```

### Test262 coverage (~134 official fails)

Sample paths (all match `L8:5 Cannot destructure 'null' or 'undefined' [in C_method()…]`):

- `test/language/statements/class/dstr/meth-dflt-ary-ptrn-elem-ary-elision-init.js`
- `test/language/statements/class/dstr/meth-dflt-ary-ptrn-elision.js`
- `test/language/statements/class/dstr/async-gen-meth-ary-ptrn-elem-ary-elision-init.js`
- `test/language/statements/class/dstr/gen-meth-ary-ptrn-elem-ary-elision-init.js`
- `test/language/expressions/class/dstr/async-private-gen-meth-static-dflt-obj-ptrn-prop-obj-init.js`
- `test/language/expressions/class/dstr/private-gen-meth-dflt-ary-ptrn-elision.js`
- `test/language/expressions/class/dstr/async-private-gen-meth-static-dflt-obj-ptrn-id-init-skipped.js`
- Family `private-meth-static-dflt-*`, `private-gen-meth-*`, `async-gen-meth-static-dflt-*`

The four broad message buckets (from latest baseline):
- `[in C_method() ← test]`: 57
- `[in C___priv_method() ← test]`: 38
- `[in __anonClass_0___priv_method() ← test]`: 24
- `[in C_method() ← test]` (15 additional class-decl variants): 15

## Root cause

`src/codegen/class-bodies.ts:1222-1300` — default-value emission for method
parameters with initializers.

The flow is:
1. Allocate paramLocalIdx with the resolved `paramType` (e.g. `ref_null $vec_*`,
   `ref_null $iter_*`, or `externref` when TS couldn't resolve).
2. If `param.initializer` is present, compile it to `paramType` and emit a
   guarded `local.set` (line 1249) that fires when the param is null/undefined.
3. Then call `destructureParamArray` / `destructureParamObject`
   (`src/codegen/class-bodies.ts:1303-1311`).

The guard at step 2 uses `ref.is_null` (line 1275) for `ref` / `ref_null`
paramTypes and `__extern_is_undefined` (line 1264) for externref. The guard
**reads the local AFTER it was already initialised by the calling convention**,
which is the right place. However:

- For methods whose `paramType` was resolved to a concrete struct `ref_null`
  (vec or tuple), the call site receives `undefined` from JS and the param
  arrives as `ref.null $vec_*`. The guard fires correctly.
- The default initializer (`g()` or `{}`) is compiled to `paramType` — but
  `coerceType` from `externref` (the runtime type of `g()`) to a vec ref
  `ref_null $vec_*` falls through to the **guarded-cast branch**
  (`type-coercion.ts:1010-1048`) where `ref.test` against the vec type fails
  for an opaque generator externref and we emit `ref.null $vec_*` in the else.
- `local.set` then stores `null` into paramLocalIdx.
- `destructureParamArray` runs against the now-null local and hits its own
  `ref.is_null` guard → `buildDestructureNullThrow`.

So the default *appears* to be applied but is silently coerced to null because
neither `coerceType` nor `emitSafeStructConversion` know how to materialise an
externref iterable into a vec struct **in the default-application path** (the
fast path for actual params at the call site does use `__array_from_iter`).

## Implementation Plan

### Fix #1 (preferred) — Materialise externref → vec via `__array_from_iter`

**File: `src/codegen/type-coercion.ts`** — `coerceType` (line 951)

When `from.kind === "externref"` and `to` is `ref_null $vec_*` (or `ref $vec_*`),
materialise the externref through `__array_from_iter` + the vec
constructor pattern already used elsewhere (see `type-coercion.ts:206`,
`destructuring-params.ts:823`). Today this case falls through silently.

Add a branch near the top of `coerceType`:

```ts
if (from.kind === "externref" && (to.kind === "ref" || to.kind === "ref_null")) {
  const toIdx = (to as { typeIdx: number }).typeIdx;
  if (isVecTypeIdx(ctx, toIdx)) {
    emitExternrefToVec(ctx, fctx, toIdx);   // existing helper at line ~196
    return;
  }
}
```

`isVecTypeIdx` already exists in `type-coercion.ts`; `emitExternrefToVec`
factors out the conversion path from line 196 onward (already implements
`ref.is_null` early-return, length probe via `__extern_length`, element loop
via `__extern_get_idx`).

### Fix #2 (defensive) — Re-guard the destructure path

**File: `src/codegen/class-bodies.ts`** — line 1303-1311

After the param-default block sets the local, the value should never be
null/undefined (default applied). But because step 2 silently stores null on a
failed coercion, the destructure inherits the bug. Independent of Fix #1, the
destructure entry should **re-check the local** and (when the param had an
initializer with `dstrNullDefault === false`) re-emit the default into a temp
buffer that fires on null-after-default. This is a belt-and-braces safety net
the dev should add IF Fix #1 alone doesn't restore correctness:

```ts
for (let pi = 0; pi < member.parameters.length; pi++) {
  const param = member.parameters[pi]!;
  if (ts.isObjectBindingPattern(param.name) || ts.isArrayBindingPattern(param.name)) {
    // ... existing destructure call
  }
}
```

becomes guarded: emit destructure only after asserting the local is non-null.
For the externref destructure path this already runs (`emitExternrefDestructureGuard`
at `destructuring-params.ts:391`) — preserve current behaviour there.

### Wasm IR pattern

For Fix #1 (`coerceType` externref → vec):

```wasm
;; on stack: externref (the default's return value, e.g. g())
local.set $extTmp
local.get $extTmp
ref.is_null extern
if (result (ref null $vec_externref))
  ref.null $vec_externref      ;; default of default is null — destructure guard catches
else
  local.get $extTmp
  call $__array_from_iter      ;; externref → externref (materialised array)
  ;; then build vec struct via existing length/get-idx loop
end
```

The simpler shape: just `call $__array_from_iter` unconditionally; it already
handles null gracefully (returns `[]`).

### Edge cases

- Param default is the **literal** `null`/`undefined`: handled separately by
  the `dstrNullDefault` check at `class-bodies.ts:1240` (emits throw eagerly).
  Do not regress this.
- Param default returns a primitive (e.g. `method({} = 5)` — destructure
  primitive): per spec, ToObject is invoked. `__array_from_iter` returns an
  empty array for non-iterables, so this is **wrong** for object patterns; the
  object-binding-pattern destructure path uses `__extern_get` which already
  works on primitives via JS's `ToObject` boxing.
- Generator default (`= g()`): the destructure consumes via the iterator
  protocol. Make sure `__array_from_iter` is invoked exactly once (don't
  re-iterate when the destructure pattern is empty — `isPatternEmptyOnly`).
- Static methods (`isStatic === true`): param indexing uses `pi`, not `pi + 1`.
  Verify the existing logic at line 1226 is preserved.
- Private methods: lowered to `__priv_method` calls; the param-default emission
  should be the same path. Check `class-bodies.ts:1167-1300` is the right loop
  for private methods too (otherwise the bug repeats in a separate site).

### Test files to verify

Smoke tests after fix:
1. `test/language/statements/class/dstr/meth-dflt-ary-ptrn-elision.js` — array elision default
2. `test/language/statements/class/dstr/meth-dflt-ary-ptrn-elem-ary-elision-init.js`
3. `test/language/expressions/class/dstr/private-gen-meth-dflt-ary-ptrn-elision.js`
4. `test/language/statements/class/dstr/async-gen-meth-ary-ptrn-elem-ary-elision-init.js`

Run all `class/dstr/meth-dflt-*`, `gen-meth-*`, `async-gen-meth-*`,
`private-meth-*`, `private-gen-meth-*` via the test262 runner with a category
filter.

### Estimated impact

~134 official test262 fails should flip to pass (the `Cannot destructure` family
above). Possibly +10-15 secondary tests in the same dirs that hit the same
destructure path with non-default arguments and incidentally trip over null
materialisation.

## Acceptance criteria

- `new C().method()` for `method([,] = g())` returns normally
- `new C().method()` for `method({ x = 1 } = {})` returns `1`
- No regressions in `*/class/dstr/meth-*` baseline buckets
- `Cannot destructure 'null' or 'undefined' [in C_method() ← test]` error count
  in the latest test262 baseline drops by ≥100

## Related

- Parent: #820 (null/TypeError/illegal-cast umbrella)
- Sibling: #1543 (async-gen-meth dstr default → illegal cast)
- Sibling: #1544 (for-of/for-await-of dstr → illegal cast)
- Touches: `src/codegen/class-bodies.ts`, `src/codegen/type-coercion.ts`,
  `src/codegen/destructuring-params.ts`
