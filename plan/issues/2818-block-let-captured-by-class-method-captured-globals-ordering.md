---
id: 2818
title: "Bug C (class-method half): block-scoped let captured by a class method reads null (captured-globals promotion ordering)"
parent: 2669
related: [2820, 2811, 1672]
status: done
assignee: ttraenkler/sendev-2818
created: 2026-06-29
completed: 2026-07-03
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 2015
language_feature: closures
goal: spec-completeness
sprint: 69
horizon: m
architect_spec: done
---

# #2818 — Bug C (class-method half): block-scoped `let` captured by a class method reads null

Carved from #2820 (the function-declaration half of Bug C, fixed there) and
#2811 / parent #2669. This is the **class-method context** of the
`ary-ptrn-rest-obj-prop-id` cluster — the `meth-…` / `gen-meth-…` /
`private-meth-…` (and their `-dflt` / `-static`) members, which dominate the
remaining cluster fails. It is a **distinct** bug from #2820's duplicate-local
desync.

## Reproduction (host/gc lane, single file)

```ts
export function test(): string {
  {
    let s = "outer";
    class C {
      m(): string {
        return s;
      }
    }
    return new C().m();
  }
}
// => null   (should be "outer")
```

Also fails for an **arrow inside the method** (`m(){ const g = () => s; return g(); }`)
— so the method's capture channel never fires at all, the inner closure can't
reach `s` either.

Controls that PASS:

- `let s` at **function scope** (not in a block) → "outer" (promotion fires;
  `$C_m` reads `global.get __captured_s`).
- the same with a hoisted **function declaration** instead of a class → "outer"
  (fixed by #2820).

## Root cause (verified)

Class methods do NOT take lifted leading capture params (a method has a fixed
`[instance, ...userParams]` signature). Instead, an outer local referenced by a
method body is **promoted to a global** `__captured_<name>` by
`promoteAccessorCapturesToGlobals` (`src/codegen/closures.ts:345`), invoked from
`compileNestedClassDeclaration` (`src/codegen/statements/nested-declarations.ts:125`).
The enclosing function emits `local.get <slot>; global.set <captured>` to sync
the value, and the method body reads `global.get <captured>`.

For a **block-nested** class, that promotion never runs:
`compileNestedClassDeclaration` early-returns when the class is already collected
(`structMap.has(className) && !isDeferred`, `nested-declarations.ts:99-106`) —
**before** reaching the promotion loop and `compileClassBodies`. The class body
gets collected/compiled at a point where the block-let is not yet a promotable
local (it is shadow-removed on block entry, and `let s` has not run), so:

1. the method body resolves `s` to the `ref.null.extern` graceful fallback in
   `identifiers.ts` → `$C_m` compiles to `ref.null extern; return` (returns
   null), and
2. no `local.get; global.set __captured_s` sync is emitted in `$test`.

WAT confirms: in the failing case `$C_m` has no `global.get`, and `$test` has no
`global.set` for `s`; in the passing (fn-scope) case both appear plus a
`(global $__captured_s …)`.

This is a **class-collection-ordering + captured-globals** interaction, in the
delicate promotion subsystem (#1672 stale-global-sync hazards), NOT the
duplicate-local desync. #2820's producer-side slot reuse correctly collapses the
duplicate local but does not help here because the method never attempts the
capture.

## Direction (for the architect)

Make the captured-globals promotion fire for block-nested class methods that
reference an outer block-scoped local, with the value-sync emitted **after** the
block-let initialises (mirroring the fn-scope case). Candidate approaches to
spec/evaluate:

- Defer the block-nested class body compile (and its `promoteAccessorCaptures…`)
  to the class's textual position inside the block (after the block-let runs),
  instead of the early collected-compile — i.e. treat block-nested classes like
  `deferredClassBodies` so the promotion + sync land in-scope. Guard against the
  `#1672` stale-sync: the `local.get; global.set` must run after the block-let's
  store, and re-sync on later mutation if the method observes writes.
- Ensure `promoteAccessorCapturesToGlobals` runs even on the
  `structMap.has(className)` early-return path when the class is block-nested and
  has unpromoted outer-local references.

Edge cases to cover: `-dflt` (param-default initializers referencing the outer
local — already scanned via `extraNodes`), `-static` methods, generator /
async-generator methods, private methods, and the TDZ flag promotion
(`__tdz_<name>` global) for a `let`/`const` read before init.

## Implementation Plan

_(architect spec, senior-conflicts 2026-07-02 — written after closing the broad
attempt PR #2335. Read the `## Merge-group regression` section below FIRST: the
whole-hog `insideFunction` propagation is proven **−471** and must NOT be retried.)_

### Root cause (exact site)

`compileClassesFromStatements` (`src/codegen/declarations.ts:4431`, nested closure
in `compileDeclarations`) recurses into the control-flow carriers — `if`
(~4477), bare `block` (~4484), the `for*`/`while`/`do` loop bodies (~4487),
`switch` clauses, `try`/`catch`/`finally`, and labeled blocks (~4477–4507) —
**without forwarding its `insideFunction` parameter**, so those recursions run
with the default `insideFunction = false`. A class textually nested in a block
_inside a function body_ is therefore collected + compiled **eagerly** via the
`else` arm (line 4448 `compileClassBodies` for a declaration; line 4461 for a
`const C = class{}` expression) at module-collection time — **before** the
enclosing block's `let`s have been allocated/initialised. Its method body then
resolves the captured `let` to the `ref.null.extern` graceful fallback
(`identifiers.ts`), and no `local.get <slot>; global.set __captured_s` value-sync
is emitted in the enclosing function → the method reads **null**. The fn-scope
control (a `let` NOT in a block) passes because that class is collected at a
point where `promoteAccessorCapturesToGlobals`
(`src/codegen/statements/nested-declarations.ts:128–136`) can promote the local.

### Why the broad fix regressed (PR #2335, net −471) — DO NOT retry

PR #2335 forwarded `insideFunction` through **every** control-flow recursion
(`compileClassesFromStatements(…, insideFunction)` everywhere). That routes
**every** block-nested class — including non-capturing ones **and class
expressions** (`const C = class{}`, line 4458) — into `ctx.deferredClassBodies`
(lines 4447 / 4460). But the deferred-compile path
(`compileNestedClassDeclaration`, `nested-declarations.ts:82`) is only reached
from `compileStatement` for class **declaration statements**; a class
**expression** in a variable initializer, and some deeply-nested declaration
shapes, are **never revisited**, so their method/element bodies are silently
dropped. Merge_group proof: net −471 (545 regressions / 74 improvements, ratio
736%), two buckets over the 50-gate — `class/dstr` (335) + `class/elements`
(165); on `class/dstr/async-gen-meth-obj-ptrn-list-err.js` the WAT shrinks
54869→51844 bytes (≈3 KB of class codegen dropped) and a `runTest262File` probe
flips it pass→fail. **The invariant this violated: never add a class to
`deferredClassBodies` unless the deferred path is guaranteed to re-compile that
exact shape.**

### Work Item A: narrow the deferral to genuine block-`let` capturers only

**Risk**: Medium — touches class-collection ordering, but strictly shrinks the
set of deferred classes vs PR #2335. **Priority**: 1st.

**File: `src/codegen/declarations.ts`**, `compileClassesFromStatements`
(line ~4431) and its control-flow recursions (~4477–4507):

- Forward `insideFunction` into the control-flow recursions **only for class
  _declarations_ that actually capture** an enclosing block-scoped `let`/`const`
  — never for class expressions, never for non-capturing classes. Concretely,
  gate the `ctx.deferredClassBodies.add(...)` at line 4447 behind a capture
  pre-scan: `classMethodCapturesEnclosingBlockLet(stmt, enclosingBlockLets)` —
  a member-body identifier walk (mirror the existing accessor-capture scan used
  by `promoteAccessorCapturesToGlobals`) that returns true iff a method/getter/
  setter/param-default of the class references a name declared `let`/`const` in
  an enclosing block of the **same function** (not module scope, not a param).
- All other block-nested classes (non-capturing declarations **and every class
  expression**, line 4458) stay on the **eager** `else` arm — byte-identical to
  today, so the −471 `class/dstr` + `class/elements` clusters do not move.
- Do NOT change the module-level (`insideFunction` already false at top) path.

The #2818 repro (`class C { m(){ return s; } }` capturing block-`let s`) is a
capturing block-nested **declaration** → it is the _only_ shape this newly
defers, and it IS reachable by `compileNestedClassDeclaration` via
`compileStatement` when the block is compiled.

### Work Item B: make the deferred capturer promote in-scope (ordering fix)

**Risk**: Medium — the #1672 stale-global-sync subsystem. **Priority**: 2nd
(coupled to A; land together).

**File: `src/codegen/statements/nested-declarations.ts`**,
`compileNestedClassDeclaration` (line ~82):

- With the class now in `deferredClassBodies`, `isDeferred` (line 97) is true so
  the `structMap.has && !isDeferred` early-return (line 99) is correctly skipped
  and the body is compiled at the class's **textual position in the block** —
  i.e. after `let s = "outer"` has executed and been allocated. Verify
  `promoteAccessorCapturesToGlobals` (lines 128–136) now sees `s` as a live
  promotable local and emits `(global $__captured_s …)` + the enclosing-function
  `local.get <s-slot>; global.set __captured_s` sync, and the method body reads
  `global.get __captured_s`.
- **#1672 guard**: the `global.set` sync MUST run **after** the block-`let`'s
  store (not at the pre-hoist slot), and re-sync on any later mutation the method
  observes. Confirm against the fn-scope accessor-capture regression controls.

### Edge cases (must all be covered by `tests/issue-2818.test.ts`)

- `meth-` / `gen-meth-` / `private-meth-` (+ `-dflt` / `-static`) cluster members
  return 1. `-dflt`: param-default initializers referencing the outer local are
  scanned via `extraNodes` — include them in the capture pre-scan.
- Arrow inside the method (`m(){ const g = () => s; return g(); }`) — the
  method's capture channel must fire so the inner closure reaches `s`.
- TDZ: a block-`let`/`const` read before init through the method still throws
  (promote the `__tdz_<name>` flag global in lockstep).
- **Non-capturing** block-nested class + **`const C = class{}`** expression stay
  on the eager path (regression control — these are the −471 shapes).
- generator / async-generator / static / private methods as capturers.

### Test / validation (REQUIRED)

`tests/issue-2818.test.ts` with the repros + the cluster slice + the fn-scope
capture regression control + the non-capturing/class-expression eager-path
controls. **This class of flip only manifests on the merged baseline** — the PR
checks stub test262. **Validate on a full `merge_group` / local-CI test262 run
BEFORE re-enqueue** (`JS2WASM_LOCAL_CI=1 ./scripts/local-ci.sh`), and confirm
**zero** movement in `class/dstr` + `class/elements` (the −471 buckets). A scoped
sweep cannot see this 545-test cluster.

### Residual design risk to resolve during implementation

The completeness invariant (Work Item A) assumes every _capturing declaration_
shape the pre-scan defers is reachable by `compileNestedClassDeclaration`.
Confirm this for capturing classes nested inside `for`/`switch`/`try` bodies
(not just a bare block) — if any such shape is NOT revisited by
`compileStatement`, either (i) extend the eager arm to compile it in-scope
instead of deferring, or (ii) add the missing deferred-compile entry point. Do
not defer a shape you have not proven is re-compiled.

## Acceptance criteria

- `{ let s="outer"; class C { m(){ return s; } } new C().m(); }` returns "outer"
  (string + numeric), and the arrow-inside-method variant too.
- The `meth-…` / `gen-meth-…` / `private-meth-…` cluster members return 1 (pass).
- No regression in fn-scope class-method capture (#1672 / accessor-captures),
  the #2820 function-declaration fix, or TDZ throws.
- `tests/issue-2818.test.ts` with the repros + a class-method cluster slice +
  fn-scope-capture regression controls.

## Merge-group regression (do not re-enqueue as-is)

The first implementation attempt (PR #2335, branch `issue-2818-blocklet-classmethod-capture`,
commit `498f7b9f7` "defer block-nested class bodies inside functions") was
**auto-parked** (`hold` + `auto-park-bot:merge-group-failure`) on a LARGE, REAL,
net-negative test262 regression caught only in `merge_group`. It is NOT
baseline drift.

**Why PR-level missed it:** at PR level the test262 shards are skipped — the
`check for test262 regressions` check ran in ~3s on a stub with no shard data.
Full conformance is only validated in `merge_group`. So "PR-green" never
validated test262 here.

**Delta (merge_group, baseline f8c1aa5):**

- **545 regressions / 74 improvements → net −471**, ratio 736%, signature `9c6151da5837060f`.
- Two buckets EACH over the 50-test gate limit:
  `language/expressions/class/dstr` (335) + `language/expressions/class/elements` (165),
  plus class `method-static` / `gen-method-static` / `arguments-object cls-expr-meth-static`.
- Confirmed PR-caused (not drift/flake): on `class/dstr/async-gen-meth-obj-ptrn-list-err.js`
  the WAT shrinks 54869→51844 bytes (≈3 KB of class codegen DROPPED), and a
  runtime probe via the exact CI path (`runTest262File`) flips it from
  **pass on main** to **fail on branch**.
- Cross-checked against #2333/#2826: DIFFERENT signature, ZERO shared regressed
  tests → not a shared drift cluster.

**Root cause of the regression:** the fix propagates `insideFunction=true`
through the block/if/loop/switch/try/labeled recursion in
`compileClassesFromStatements` (`src/codegen/declarations.ts`), which adds those
classes to `ctx.deferredClassBodies`. The deferred-compilation path
(`compileNestedClassDeclaration` in `src/codegen/statements/nested-declarations.ts`,
reached from `compileStatement`) does NOT fully cover all the now-deferred
shapes — in particular class **expressions** assigned in variable statements
(`const C = class {…}`) and block-nested classes — so their method/element
bodies are never compiled and the codegen is silently dropped. The pre-#2818
eager path compiled them correctly (at the cost of the one narrow capture bug
this issue targets).

**Narrowing direction for the rework — two viable options:**

1. **Defer only when there is an actual capture:** restrict the
   `insideFunction` deferral to classes that genuinely capture a block-scoped
   `let` declared in the enclosing block (the exact #2818 case), and keep all
   other block-nested / class-expression classes on the eager path.
2. **Fix the deferred path to be complete:** make the deferred-class compilation
   cover class **expressions** in variable statements and block-nested class
   declarations, so deferral never drops codegen.

Option 1 is the lower-risk, more surgical fix. Either way, **validate against a
full `merge_group` / local-CI test262 run BEFORE re-enqueue** — a scoped check
cannot see this 545-test cluster. PR #2335 branch + this diagnosis must survive;
re-open this issue for the narrowed attempt.

## Resolution (2026-07-03, sendev-2818 — Option 1, narrowed)

Implemented the architect's Option 1 (defer only genuine capturers), branch
`issue-2818-classmethod-capture-v2`. Single source file touched:
`src/codegen/declarations.ts` (`compileClassesFromStatements` + two new local
helpers). No changes to `closures.ts` / `nested-declarations.ts` — the
promotion channel (`promoteAccessorCapturesToGlobals`) was already correct; the
only bug was that block-nested class bodies were compiled *eagerly* (out of
scope) so promotion never got a chance to fire.

### What the fix does

1. `compileClassesFromStatements` now threads an `enclosingLocals: Set<string>`
   through the control-flow recursions (block / if / loop / switch / try /
   labeled) — **not** `insideFunction` (that was PR #2335's fatal move). The set
   is `null` at module scope (nothing new deferred there) and seeded fresh
   (`new Set()`) at each function/arrow/function-expression body, accumulating
   this-level `let`/`const` names as it descends (fresh copy per level → no
   sibling-block pollution).
2. A control-flow-nested class **declaration** is added to
   `deferredClassBodies` **iff** `classDeclCapturesNames` is true — i.e. a
   method/ctor/accessor body or param-default references an enclosing
   block-scoped `let`/`const` that `promoteAccessorCapturesToGlobals` would
   actually promote. The scan **mirrors that function's skip conditions**
   (already a module/captured global, `this`, a user-function name) so we never
   defer on a name that is already global.
3. Deferred capturers are re-compiled in-scope by `compileNestedClassDeclaration`
   (reached from `compileStatement` for a class declaration in **any** statement
   position — block, if, loop, switch, try, labeled), where the `let` is a live
   local, promotion emits `(global $__captured_<name> …)` + the enclosing
   `local.get; global.set` sync, and the method reads `global.get`.

### Why this does NOT reproduce the −471 (PR #2335)

- **Class *expressions* (`const C = class{}`) are never deferred** — they stay
  on the eager `else` arm, byte-identical to before. That was the shape #2335
  deferred-but-never-recompiled (dropped codegen).
- **Non-capturing classes are never deferred** — only genuine `let`/`const`
  capturers.
- **`var` is excluded** from the capture scan: a function-scoped `var`
  referenced by a class method is already hoisted to a module global by
  `wrapTest`, so deferring on it is pointless and — as measured — perturbs the
  order-sensitive async-generator lowering (it caused 8 `async-*gen-meth-*`
  pass→fail regressions in an earlier over-broad draft; excluding `var` +
  applying the module-global skip removed all 8).

### Validation (measure-first, exhaustive over the affected set)

Byte-inertness proven by compiling every test262 file the change *could* touch,
on this branch vs `origin/main` HEAD, and sha256-diffing the wasm:

- **All `class/dstr` + `class/elements` dirs (8426 files, wrapped via
  `wrapTest`)**: 48 files change bytes, **0** compile-drops (the −471
  mechanism), 0 `THROW`. Runner sweep of all 48: **+24 fail→pass, 0
  regressions**.
- **Every file outside the class dirs containing a class + `let`/`const`
  (477 candidates across `language/` + `built-ins/`)**: 74 change bytes; runner
  sweep: **+9 fail→pass, 0 regressions**.
- **Combined: +33 test262 pass, 0 regressions, 0 compile-drops.**
- `class/dstr` + `class/elements` (the −471 buckets) net movement: **0
  regressions**.
- New `tests/issue-2818.test.ts`: 18 unit repros (block/if/for/switch/try/nested,
  ctor, param-default, post-capture mutation, arrow-in-method, static) + the
  fn-scope / non-capturing / class-expression / shadowing regression controls +
  the `meth-`/`gen-meth-`/`private-meth-` test262 cluster slice. All green.

### Out of scope / follow-up

The `expressions/class/dstr/*meth-*` cluster half (`var C = class{…}` capturing
`let length`) is **not** fixed here — deferring a class *expression* is exactly
the #2335 hazard (the deferred path does not re-compile class expressions in
variable initializers). Fixing it needs Option 2 (complete the deferred path for
class expressions) and should be a separate, independently-validated issue.

## Standalone follow-up (2026-07-03, sendev-2818) — derived-class capturers stay eager

PR #2567 (this branch) was park-held on a **6-test standalone regression**
(distinct from the separate ~55-test base-drift being fixed elsewhere):

- `language/expressions/super/call-spread-obj-getter-init.js`
- `built-ins/Iterator/prototype/{map,take,drop,filter}/return-is-forwarded*.js`
- `built-ins/Iterator/prototype/flatMap/return-is-forwarded-to-underlying-iterator.js`

### Root cause (measured, both lanes, branch vs `origin/main`)

The test262 harness (`wrapTest`) wraps every test body in
`export function test(){ try { <body> } catch(e){…} }`. So a top-level
`let returnCount = 0; class TestIterator extends Iterator { return(){ ++returnCount; } }`
becomes a class **nested in the `try` block** — a control-flow carrier. The
#2818 capture-defer branch therefore fired for it and moved the class into
`deferredClassBodies`.

The deferred, in-block-recompiled path promotes the captured `let` to a
`__captured_<name>` global and emits the `global.set`/`global.get` sync **in
both lanes** (verified: the WAT sync structure is identical GC vs standalone).
But for a class with a **base class** (`extends …`), the derived-constructor
`super(...)` invocation + any spread/getter in its arguments **desyncs the
promoted-global read in the standalone lane only** — the captured value reads
stale/empty through the super/spread machinery. The WasmGC/host lane lowers it
correctly (it actually *fixed* `super/call-spread-obj-getter-init` fail→pass in
host/gc). The **eager** path — exactly how `origin/main` compiled these — is
correct in standalone. So on `origin/main` all 6 passed standalone (eager);
deferring them broke standalone while (coincidentally) improving host/gc.

Full lane matrix (branch pre-fix vs main), e.g. `take/return-is-forwarded`:
main(gc FAIL, sa PASS) → pre-fix branch(gc FAIL, sa **FAIL**). `super`:
main(gc FAIL, sa PASS) → pre-fix(gc PASS, sa **FAIL**).

### Fix

`classDeclCapturesNames` (`src/codegen/declarations.ts`) now returns `false` for
any class with an `extends` heritage clause, so **derived classes are never
deferred** — they compile eagerly, byte-identically to `origin/main`. Base-less
capturers (the genuine #2818 target: `class C { m(){ return s; } }` reading a
block-`let`) still defer and are fixed in **both** lanes (they have no
super-constructor path and lower identically GC vs standalone). The edit is
strictly **subtractive** vs the pre-fix branch: it can only *reduce* the set of
deferred classes, so it cannot introduce a new regression beyond `origin/main`.

### Validation

- The 6 regressions: **fail→pass in standalone**, and host/gc now == `origin/main`
  (no regression; the one incidental host/gc gain on `super` is foregone).
- Exhaustive standalone sweep of **all 700 `extends`+`let`/`const` candidates**
  (`class/dstr` + `class/elements` + external), FIXED vs `origin/main`:
  **0 regressions, +2 improvements**.
- `tests/issue-2818.test.ts`: the 22 existing repros + 3 new standalone
  regression guards (derived-class method / super-ctor capturer stays correct;
  base-less capturer still works) — all green.
- Typecheck clean.

