---
id: 2818
title: "Bug C (class-method half): block-scoped let captured by a class method reads null (captured-globals promotion ordering)"
parent: 2669
related: [2820, 2811, 1672]
status: blocked
created: 2026-06-29
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 2015
language_feature: closures
goal: spec-completeness
sprint: current
horizon: m
architect_spec: needed
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
  { let s = "outer"; class C { m(): string { return s; } } return new C().m(); }
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
