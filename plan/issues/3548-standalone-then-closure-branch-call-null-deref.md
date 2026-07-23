---
id: 3548
title: "Standalone: then-callback closure with branch-guarded module-fn calls traps null-deref — the ~193-row 'async continuation threw' Promise cluster"
status: ready
sprint: current
priority: high
horizon: m
feasibility: hard
task_type: bug
area: codegen, standalone, async, closures
language_feature: promises, closures
goal: standalone-mode
parents: [3178]
related: [3417, 3442, 3443, 3542, 3545, 2865]
created: 2026-07-23
origin: "2026-07-23 fable-3417 umbrella triage: third head of the F2-unmasked standalone async FAIL surface, after #3538 (280) and #3542 (130)."
---

# #3548 — then-closure branch-call null-deref (the 193-row cluster)

## Problem (measured)

The remaining big standalone async FAIL bucket on the 2026-07-21 baseline:
**193 rows** `async continuation threw before completion: dereferencing a
null pointer / illegal cast [in __closure_N() ← __then_{fulfill,reject}_M ←
__drain_microtasks]`. Dirs: `built-ins/Promise/{prototype,any,race,
allSettled,all,resolve}` (~151) + `language/statements/for-await-of` (16) +
tail. Signature split: ~150 null-deref in a `__closure_N` invoked from a
then-reaction wrapper; ~33 `illegal cast [in __then_fulfill_*]` (possibly a
separate sub-cause — verify, #3443-adjacent).

**NOT the #3542 null-reason echo** — re-probed post-#3542: a stride-6 sample
(33 files) still traps identically.

## COLLAPSED root cause (WAT-confirmed, same day) — it is an ARITY-FILL bug; promises/closures are irrelevant

The WAT of the trapping closure ends:

```wat
;; $DONE("m") branch: builds the native string, call — fine.  Then:
ref.null 6        ;; the ZERO-ARG $DONE() call's missing-argument fill
ref.as_non_null   ;; ← TRAPS unconditionally
call $DONE
```

When a module-level function is called BOTH with a string literal AND with
zero args, the param is inferred as a NON-NULLABLE native-string ref; the
zero-arg site fills the missing argument with `ref.null` and then coerces
through `ref.as_non_null` — an unconditional null-deref trap **on the
zero-arg (usually the PASS) path**. Per spec a missing argument is
`undefined`. Two-line module-scope repro (standalone, traps in
`__module_init`):

```js
function d(x) { console.log('called'); }
d('m');
d();     // RuntimeError: dereferencing a null pointer
```

The Promise/then/closure/comparison ingredients in the original fence were
all incidental — they only determined WHERE the trap surfaced
(`__closure_N ← __then_fulfill_*`). The corpus hits it constantly because
the canonical test262 template calls `$DONE('msg')` on failure paths and
bare `$DONE()` on the pass path. Scope note: this likely affects MORE than
the async cluster — any standalone function under-applied at one site and
string-applied at another; measure corpus-wide when fixing. Fix direction:
the param typing must degrade to a nullable/undefined-capable carrier when
any call site under-applies (or the fill must pass the canonical undefined),
never a trapping non-null cast.

## Original bisection fence (kept for the record; superseded by the above)

```js
function $DONE(x) { console.log("OK"); }
var value = {};
var p1 = new Promise(function(_, reject) { reject(); });
var p2 = p1.then(function() {}, function() { return value; });
p2.then(function(x) {
  if (x !== value) { $DONE("m"); return; }
  $DONE();
}, function() { console.log("rejected BAD"); });
```

→ `RuntimeError: dereferencing a null pointer` in
`__closure_17 ← __then_fulfill_6 ← __drain_microtasks` (standalone,
zero-import instantiate + drain).

The bisection fence (all probed):
- same body with `console.log` instead of the `$DONE(...)` calls → WORKS;
- `$DONE()` / `$DONE(1)` calls WITHOUT the `if (x !== value)` comparison →
  WORK (zero-arg call, missing-param ternary, string concat all fine);
- comparison present + $DONE declared but NOT called in the branches → WORKS;
- comparison + branch-guarded `$DONE("m")` / `$DONE()` calls → **TRAPS**.

So the trigger is the COMBINATION: an any-`!==` comparison plus
branch-guarded calls to a module-level function (with an early `return`)
inside a then-callback closure. NO harness files needed (earlier
harness-scale hypothesis was disproven by this fence). The `__closure_N`
frame suggests the closure body itself dereferences a null — plausibly a
capture/local slot the branching layout leaves null on one path, or an
any-comparison spill consumed after the branch. Ground in how
`compileFunctionExpression`/closure lowering emits the if/early-return shape
for an externref param, and what `__then_fulfill_*` passes as the closure
env.

## Why it matters

These are exactly the test262 Promise-verification templates
(`if (x !== value) { $DONE(msg); return; } $DONE();` is THE canonical
then-assert shape) — fixing this single lowering plausibly flips most of the
~150 null-deref sub-family across all Promise built-ins dirs. Gate any claim
on measured runtime PASS (stride sample), per the #3417 discipline.

## Note

An uncaught trap here also SILENTLY ENDS the drain (#3545) — fixing #3545
first would at least make this cluster's residuals scoreable.
