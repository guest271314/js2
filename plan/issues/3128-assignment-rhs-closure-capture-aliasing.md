---
id: 3128
title: "Assignment lost when the RHS contains a closure capturing the assigned var (`p2 = p1.then(() => p2)`)"
status: done
completed: 2026-07-10
assignee: ttraenkler/fable-3128 (rescued by ttraenkler/fable-18th)
sprint: 71
created: 2026-07-10
updated: 2026-07-13
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen
language_feature: closures
goal: standalone-mode
related: [3121, 3125, 2980, 3130, 3136]
loc-budget-allow:
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/literals.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
origin: "#3125 per-file drill — the resolve-settled-{fulfilled,rejected}-self.js widen regressions attributed to thenable assimilation in plan/log/2980-carrier-widen-tradeoff.md are actually THIS bug: p2 is null before .then() semantics ever matter"
---

# #3128 — assignment lost when the RHS closure captures the assigned var

## Problem (minimal repro, `--target standalone`, main@b6691942bd8)

```ts
export function test(): number {
  var p2: any;
  p2 = <RHS containing a closure that captures p2>;
  if (p2 === null || p2 === undefined) return 9; // ← returns 9
  return 1;
}
```

Measured (`.tmp`-style probes, 2026-07-10, standalone + `JS2WASM_ASYNC_CARRIER_WIDEN=1`
for the then-shapes — but the object shape reproduces WITHOUT any widen):

| RHS                                                                                            | result  |
| ---------------------------------------------------------------------------------------------- | ------- |
| `p1.then(function() { return 42; })` (no capture)                                              | 1 ✔     |
| `p1.then(function() { return p2; })` (captures p2)                                             | **9 ✗** |
| `(function(){ return { a: (function(){ return p2; }) }; })()` (captures p2, no Promise at all) | **9 ✗** |
| sibling closure capturing p2 NOT in the assignment RHS                                         | 1 ✔     |

So this is a general assignment/closure-capture aliasing bug, not a Promise
bug: when compiling `p2 = RHS` and the RHS **contains a closure capturing
`p2`**, the capture-boxing (ref-cell promotion) happens mid-expression and the
assignment's write lands in the stale slot (or vice versa) — the subsequent
read of `p2` sees null. Same family as the #3121 closure-capture aliasing
fixes (objlit method vs arrow), different site (assignment whose RHS triggers
the promotion of its own LHS).

## Impact

- `test262/test/built-ins/Promise/prototype/then/resolve-settled-fulfilled-self.js`
  and `resolve-settled-rejected-self.js` on the widened-standalone lane
  ("Cannot read properties of null (reading 'then')" — `p2.then(...)` on the
  null-read after `p2 = p1.then(function() { return p2; })`). These two were
  mis-attributed to thenable assimilation in the #2980 tradeoff doc; #3125
  landed the §27.2.1.3.2 self-resolution reject (verified via the executor
  shape) but these files stay blocked on THIS bug.
- Any `var x; x = expr-with-closure-over-x` pattern (deferred/lazy self
  references), host and standalone alike (verify host lane too — the probe
  above ran standalone).

## Repro harness

`.tmp/compile-self4.mts` in the #3125 worktree (recreate: compile the table
rows above with `target: "standalone"`, instantiate with env-stub, expect 1).

## Acceptance

- All four table rows return 1.
- `resolve-settled-fulfilled-self.js` / `resolve-settled-rejected-self.js`
  flip to pass on the widen arm (`JS2WASM_ASYNC_CARRIER_WIDEN=1`,
  `runTest262File(..., "standalone")`) — the #3125 self-resolution reject then
  fires and the tests' TypeError assertions hold.
- No regressions in tests/issue-3121\* and the closure capture suites.

## Implementation notes (fable-3128, 2026-07-10)

Verify-first drill found the recorded symptom was THREE stacked defects. Two
were in scope and are fixed here; the third is spun off as #3130.

### A. assignment.ts — LHS storage resolved BEFORE the RHS (the core bug)

`compileAssignment`'s identifier path captured `localIdx = localMap.get(name)`
and the `boxedCaptures` check BEFORE `compileExpression(expr.right)`. A closure
inside the RHS that captures `name` runs the construction-site boxing
(closures.ts ~L3000): it wraps the local's CURRENT value in a fresh ref cell,
tees it into `__boxed_<name>`, and re-points `fctx.localMap` — so the
pre-resolved raw-index `local.tee` wrote a slot nothing reads anymore. WAT
proof: `(local.set $1 (if … (struct.new $39 (ref.func $__closure_1) … (local.tee
$8 (struct.new $22 (local.get $1))))))` — the cell `$8` holds the closure's
view; the write went to raw `$1`.

**Fix**: after the RHS compiles, re-resolve the storage; if the name was boxed
mid-RHS (fresh `boxedCaptures` entry + re-pointed index) write through the
cell (null-guarded `struct.set`, same shape as the pre-boxed branch), refresh
the orphaned raw slot for pre-boxing-compiled reads, and return the value. Two
extra arms cover mid-RHS PROMOTION (`promoteAccessorCapturesToGlobals` — an
objlit method in the RHS capturing the LHS): captured box global via
`emitCapturedBoxGlobalWrite`, plain captured global via `global.set`. Mirrors
the post-initializer re-resolution variables.ts already does (#1177/#2692/#1672)
— the assignment path simply lacked it.

### B. closures.ts — mutability walk stopped at an INLINED IIFE boundary

`writtenInOuter` walked from `arrow.parent` to the nearest AST function-like
node and scanned only ITS body for writes. For
`p2 = (function(){ return () => p2; })()` the IIFE is flattened into the
current fctx by the call-site inliner (calls.ts ~L15030) — the AST boundary
has no Wasm scope, `p2` lives in the OUTER frame, and the outer write was
invisible → the capture went **by value** (WAT proof: `struct.new $4 (ref.func
$__closure_0) (local.get $0)` — a stale copy; no cell at all).

**Fix**: the inliner records the callee node in `fctx.inlinedIifeNodes`
(new FunctionContext field, types.ts); the walk continues past recorded nodes
— EXCEPT when the IIFE itself declares `name` (own params/vars via
`addFunctionOwnLocals`): a shadow keeps its own binding, otherwise the outer
same-named write would force-box the shadow and conflate the two variables
(probe `var x=1; (function(){ var x=5; return ()=>x; })(); x=2` regressed
without the guard, caught during validation).

### C. calls.ts — zero-arg dynamic call skipped over-arity VOID closures

With A+B fixed, the acceptance files still hung: their `p1` comes from
`new Promise(function(resolve){ resolve(); })` and the ZERO-ARG `resolve()`
never ran — `tryEmitInlineDynamicCall`'s #1837 gate excluded over-arity
void-result candidates, and the native settle closure is exactly
`(externref) -> ()`. The dispatch found no arm and silently produced
`undefined`; p1 stayed pending forever (`resolve(5)` worked — exact arity).
The #1837 gate was a band-aid for a June-21 emitter bug ("not enough arguments
on the stack for call_ref", 52 merge_group regressions) that the since-landed
rework (#3031/#2611/#2923) fixed structurally.

**Fix**: re-admit over-arity void candidates whose padded formals are all
externref (undefined-pad is exact per §7.3.14). Validated directly against the
original #1837 regression clusters (Promise/{all,race,any,allSettled} +
TypedArrayConstructors/internals/{Delete,Set}, 63 sampled files, standalone
widen lane): pass=20 fail=43 IDENTICAL before/after, zero flips.

### Validation

- All issue-table rows return 1, BOTH lanes (tests/issue-3128.test.ts, 14/14).
- Promise self-shape end-to-end (probe): executor + `return p2` → reject arm
  with TypeError (`flags=2111`), `return 42` → fulfil arm (`1111`),
  `Promise.resolve` shape unchanged (`2100`). `reason instanceof TypeError`
  holds.
- Emit-identity: SHA-256 over every playground example, gc + standalone lanes
  — byte-identical to main.
- Suites: issue-3121 (10/10), issue-2623, issue-1712-dynamic-dispatch,
  issue-2923, issue-3125-widen, issue-2980-carrier-fallback, promise
  executor/capability suites — green (3 pre-existing wasi-import failures in
  issue-2867-gap2 and 1 in issue-1712-capture-closure-dispatch fail
  identically on pristine main; 2 pre-existing failures in
  equivalence/optional-direct-closure-call likewise).

### Residuals

- **Acceptance criterion 2 is NOT met by this PR alone**: after A+B+C the
  `resolve-settled-*-self` files fail ONLY on
  `reason.constructor !== TypeError` — native Error objects lack
  `.constructor`/`.name` on standalone (pre-existing, `instanceof` works).
  Spun off with full probes as **#3130**; these two files flip when it lands.
- Compound assignments (`x op= RHS-with-self-capture`) share defect A's
  pre-resolution pattern (assignment.ts ~L6198) — not covered here; rare
  shape, noted for a follow-up if it surfaces.
- `compileArrowAsCallback` (host-callback path) has NO outer-write analysis
  at all (`isMutable = writtenInCallback || forceMutableCaptures`) — same
  family, host-lane `.then` shapes; untouched here.
- Pre-existing standalone `===`-identity gap on any-routed $Promise values
  (`seen === p1` false with no self-capture involved — tag-5 host-only
  strict-eq arm) noted in #3130's notes; do not conflate with this bug.

## Rescue addendum (fable-18th, 2026-07-10 — PR #2843 completed)

The original PR validated its "standalone" cases with a `{ standalone: true }`
compile option — which the pipeline IGNORES (`buildCodegenOptions` derives the
codegen flag ONLY from `options.target === "standalone"`), so both lanes of
the test matrix actually ran gc-host. On the REAL standalone lane
(`target: "standalone"`) two residuals surfaced:

1. **Inlined-IIFE ret-local type mismatch (fixed here).** An objlit returned
   from the IIFE in any-context diverts to the open-`$Object` externref path
   (#1901/#2542), but the ret local was typed from the TS struct type; the
   return coercion's `ref.test` arm silently nulled the value — so row 3 of
   the issue table still returned 9 standalone (the #3128-A cell write was
   correct; it wrote the nulled ret value). Fix: extracted the divert
   decision as `objectLiteralTakesStandaloneAnyObjectPath` (literals.ts) and
   the inliner (calls.ts) now widens the ret local to externref when any of
   the IIFE's own returns is a diverted objlit — the same lockstep-predicate
   discipline as #2804/#1930.
2. **Cell-read object identity loss (pre-existing, spun off as #3136).**
   `closureRead() === p2` answers false standalone for the same object even
   with no IIFE and no self-capture RHS. The test file pins identity on the
   host lane and value-flow on standalone (`standaloneSrc` variants) until
   #3136 lands.

Tests: `tests/issue-3128.test.ts` 14/14 with the standalone lane now real.
