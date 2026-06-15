---
id: 2152
title: "Array HOF callbacks ignore thisArg (and top-level `this`): callback `this` is always undefined"
status: ready
sprint: Backlog
created: 2026-06-15
updated: 2026-06-15
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: this-binding
goal: core-semantics
related: [2085]
origin: "2026-06-15 senior-dev root-cause of PR #1459 (#2085) net -6: 18 regressions all trace to callback `this` modeled as undefined"
---

# #2152 — Array HOF callbacks ignore thisArg; callback `this` is always undefined

## Problem

`Array.prototype.{every,filter,some,map,forEach,find,findIndex,reduce,...}`
accept an optional `thisArg` (2nd/last arg) that **must** become the `this`
binding inside the callback (ECMA-262 §23.1.3.x: "Let funcResult be ?
Call(callbackfn, thisArg, « kValue, k, O »)"). The compiler **does not forward
thisArg** to the callback. Worse, a callback compiled via the closure path
(`call_ref`) has **no `this` parameter at all** — `this` inside the callback
body compiles to a literal `__get_undefined()`.

Proof (current main + PR #1459):
```ts
[1].map(function () { return this; })[0]        // => undefined  (Node: global/undefined per mode)
var o = { res: true };
[1, 2, 3].filter(function () { return this.res; }, o).length   // wasm => 0   (Node => 3)
```

Top-level `this` is also mis-modeled as `undefined` (should be the sloppy-mode
global object), so `var g = this; arr.some(() => g)` sees `g === undefined`.

## Why it matters now

PR #1459 (#2085) correctly fixed array-HOF predicate ToBoolean (NaN / boxed
`0`/`""`/`false` are now falsy). That fix **exposed** this latent bug: ~18
test262 tests (`every/filter/some/reduceRight` `-5-2..6`, `-7-c-iii-26/27`,
`-9-c-iii-28`) were passing on main only because two compensating truthiness
bugs (`f64.ne 0` made NaN truthy; `ref.is_null` made the non-null `undefined`
sentinel truthy) rendered the wrong `undefined` callback result as truthy,
coincidentally matching the spec answer. With correct ToBoolean those become
correctly falsy → element dropped → assertion fails.

So #1459 is net −6 (12 real wins, 18 masked-bug exposures) and is blocked on
this issue. See the "CI regression analysis" section in
`plan/issues/2085-buildtruthycheck-nan-boxed-falsy-truthy.md` for the full
runtime-proven breakdown. **No `buildTruthyCheck` change can make #1459
net-positive** — the wins and the regressions share the same (correct) ToBoolean
arms; the fix must be here, upstream.

## Scope of the 18 #1459 regressions

- **15** (`-5-2..6` × every/filter/some): callback returns `this.PROP` with a
  **thisArg passed** whose PROP is truthy → needs thisArg forwarding.
- **3** (`-7-c-iii-26/27`, `-9-c-iii-28`): callback returns top-level `this`
  (= global) → needs top-level-`this` = sloppy-global modeling.

## Acceptance criteria

- `arr.filter(cb, thisArg)` / `every` / `some` / `map` / `forEach` / `find*` /
  `reduce*` bind `thisArg` as the callback's `this`; `cb` reading `this.x`
  observes thisArg.x.
- Callback `this` with no thisArg matches the host (`undefined` in the contexts
  the runner uses); top-level `this` returns the global object (sloppy).
- The 18 #1459 regressions pass for the RIGHT reason (thisArg/`this` correct),
  and the 12 #1459 ToBoolean wins are retained → #1459 (or #1459+#2152) lands
  net-positive.
- No new regressions across the array-method suite (map/forEach/reduce thisArg
  variants).

## Implementation notes (from #1459 root-cause)

The hard part is the **closure (`call_ref`) path** in `src/codegen/array-methods.ts`
(`buildClosureCallInstrs`, `setupArrayCallback`, and the per-method
`compileArray{Filter,Every,Some,...}` plus the `.call`-arraylike variants in
`compileArrayPrototype{Every,Some,ForEach}`). A named-function callback compiles
once with funcref signature `(captures, elem, idx, arr)` and no `this` slot, so
thisArg cannot simply be appended.

Two candidate strategies (architect to decide):
1. **`.call`-aware host bridge** — when `arguments[thisArgIdx]` is present, route
   the callback through a new bridge `__call_N_*_this(fn, thisArg, …) =>
   fn.call(thisArg, …)` (mirrors existing `fn.call(self, …)` uses in
   `src/runtime.ts`). Loses the closure fast-path but is contained; must handle
   object-return → f64/externref ToBoolean for results like `return global`.
2. **Thread a `__this` param through the closure ABI** — extend the array-method
   `call_ref` signature with a leading `__this` externref (the `needsThis` /
   `__this` machinery already exists for getter/setter callbacks in
   `src/codegen/closures.ts` around line 2554), and make plain-function callbacks
   resolve `this` from that param instead of `__get_undefined()`. Cleaner long
   term but touches the universal function calling convention.

Standalone-mode parity required (per CLAUDE.md dual-mode): a host `.call` bridge
needs a Wasm-native equivalent or the closure-`__this` approach (which is
host-independent) is preferred.

Top-level-`this` = sloppy-global is a separate, smaller change (resolve `this`
at module scope to the global object instead of `__get_undefined()`); may be
split into its own issue if it complicates the thisArg work.
