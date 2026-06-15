---
id: 2152
title: "Array HOF callbacks ignore thisArg; callback `this` is always undefined"
status: done
completed: 2026-06-15
sprint: 62
created: 2026-06-15
updated: 2026-06-15
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: this-binding
goal: core-semantics
related: [2085, 1459, 1636]
unblocks: [1459]
origin: "2026-06-15 #1459 net-6 regression root-cause (senior-dev): upstream this-binding"
---

# #2152 — Array HOF callbacks ignore `thisArg`; callback `this` is always undefined

## Problem

Array higher-order methods (`every`/`filter`/`some`/`map`/`forEach`/`find*`/…)
accept an optional `thisArg` that per spec becomes the callback's `this`
(`Call(callbackfn, thisArg, «kValue,k,O»)`, §23.1.3.*). The compiler did NOT
forward `thisArg`, and a callback's `this` compiled to a literal
`__get_undefined()`. So `arr.every(function(){return this.x}, {x:true})` wrongly
saw `this === undefined`.

This was exposed by #1459's (correct) §7.1.2 ToBoolean fix: on main the wrong
`undefined`/`NaN` callback results were rendered truthy by two compensating
truthiness bugs (`f64.ne 0` → NaN truthy; `ref.is_null` → non-null undefined
sentinel truthy), so the affected test262 cases passed *by accident*. Correct
ToBoolean made the broken `this` observable, regressing 18 array tests. The
truthiness fix is correct; the latent defect is this `this`-binding bug.

Proof (current main + PR #1459):
```ts
[1].map(function () { return this; })[0]        // => undefined
var o = { res: true };
[1, 2, 3].filter(function () { return this.res; }, o).length   // wasm => 0   (Node => 3)
```

## Scope

In scope: forward `thisArg` to the callback's `this` for the thisArg-bearing
HOF methods (filter / map / forEach / find / findIndex / findLast /
findLastIndex / some / every). NOT reduce / reduceRight (their 2nd arg is
`initialValue`, not `thisArg`). Arrow callbacks are lexically `this`-bound, so
`thisArg` MUST be ignored for them.

### The 18 #1459 regressions break down as

- **15** (`-5-2..6` × every/filter/some): callback returns `this.PROP` with a
  **thisArg passed** whose PROP is truthy → needs thisArg forwarding. **FIXED**
  for the object-receiver shapes; the Array-as-receiver-property-bag shapes
  (`-5-3`: `var a = new Array(); a.res = true; return this.res`) remain a
  separate limitation (thisArg IS forwarded, but reading `.res` off a WasmGC vec
  receiver does not resolve).
- **3** (`-7-c-iii-26/27`, `-9-c-iii-28`): callback returns top-level `this`
  (= sloppy global) → needs top-level-`this` = sloppy-global modeling. **Out of
  scope** here (separate semantics change; the compiler models top-level/
  free-function `this` as `undefined`).

## Acceptance criteria

- `arr.filter(cb, thisArg)` / `every`/`some`/`map`/`forEach`/`find*` bind
  `thisArg` as the callback's `this`; `cb` reading `this.x` observes
  `thisArg.x`. ✅
- Callback `this` with NO thisArg matches the host (`undefined`). ✅
- Arrow callbacks ignore `thisArg` (lexical `this`). ✅
- Works in BOTH JS-host AND standalone (pure-Wasm) mode. ✅
- The 12 #2085 ToBoolean wins still hold; no NEW array-method regressions. ✅

## Resolution (2026-06-15, senior-dev)

### Strategy chosen — `__current_this` install/restore (mode-agnostic)

Reused the existing `__current_this` **module global** (#1636-S1) rather than a
new closure-ABI `__this` param (candidate strategy #2) or a `.call`-aware host
bridge (candidate strategy #1). `__current_this` is a pure Wasm global (not a
host import), so the same path forwards `this` in standalone mode — no
JS-host-only branch. The host-bridge approach was rejected because it can't
satisfy the standalone-parity constraint without a separate Wasm
implementation; the closure-ABI `__this`-param approach was rejected as a far
larger and riskier ABI change touching every array method's `call_ref`
signature, its `__call_fn_method_N` exports, and the object-return → f64
coercion surface — `__current_this` achieves the same effect with a save + two
`global.set`s per dispatch.

The two halves:

1. **Install side** (`src/codegen/array-methods.ts`): `setupArrayCallback` now
   takes a `thisArgIndex` (1 for the 9 thisArg-bearing methods; absent for
   reduce/reduceRight). `compileThisArg` compiles `arguments[thisArgIndex]` to
   an externref local AFTER the callback (spec arg order), but only when the
   callback is NOT an arrow (arrows ignore thisArg). `buildClosureCallInstrs`
   then brackets the `call_ref` with save-prev → `global.set __current_this` →
   call_ref → restore-prev. The restore `global.set` leaves the call result on
   the stack untouched. Nesting-safe (each dispatch saves/restores), so nested
   HOFs don't leak a stale receiver.

2. **Read side** (`src/codegen/function-body.ts`,
   `src/codegen/statements/nested-declarations.ts`): a function declaration
   (top-level OR nested) whose body references its own `this` now gets
   `readsCurrentThis: true`, so `ThisKeyword` reads `__current_this` with the
   #1702 null-guard. For DIRECT calls the global is null → null-guard falls back
   to `__get_undefined()` (identical to the prior hard-coded `undefined`), so
   this is behaviour-preserving for ordinary calls and only changes the value
   when a receiver was actually installed by an enclosing dispatch. Function
   EXPRESSIONS already set `readsCurrentThis` (compiled via
   `compileArrowAsClosure`), so they needed only the install side. New shared
   helper `src/codegen/helpers/body-references-own-this.ts` (memoised iterative
   DFS, skips nested non-arrow/method/class scopes, traverses arrows — mirrors
   `bodyUsesArguments`).

The test262 runner wraps each test body in `export function test()`, so the
named `callbackfn` is a **nested** function declaration — which is why the
read-side change had to cover `compileNestedFunctionDeclaration`, not just the
top-level `compileFunctionBody`.

### Why not patch `buildTruthyCheck` (rejected)

The 12 #2085 wins and the 18 #1459 regressions flow through the SAME (correct)
ToBoolean arms — a legitimately-falsy `""` and a broken-`this` `undefined` are
indistinguishable at the ToBoolean layer. Masking the `this` bug there would
re-break the `""`/boxed-falsy wins. The only correct fix is upstream `this`
forwarding (this issue). `buildTruthyCheck` left unchanged.

### Verification

- `tests/issue-2152.test.ts` — 11/11 pass (filter/every/some/map/forEach/
  find/findIndex object-thisArg; no-thisArg `this===undefined`; arrow ignores
  thisArg; reduce 2nd-arg-is-initialValue; nested-HOF this restore). Both the
  default and `standalone: true` mode verified via scoped probes
  (filter/funcexpr/no-thisArg all correct in standalone).
- `tests/issue-2085.test.ts` — 7/7 still green. Direct-call probes confirm a
  `this`-using function called directly still sees `undefined` (null-guard), and
  a direct call AFTER a HOF dispatch sees `undefined` (restore worked).
- **Array-method test262 delta (local harness, my-branch vs the merged
  pre-#2152 branch — same harness, deltas only):** +17 / **−0**. Zero
  newly-broken tests; 17 thisArg cases recovered/fixed
  (`filter -5-2/4/5/6/9/11..19/22/23/24`, plus every/some recoveries that were
  already pass↔pass vs the CI baseline). The local absolute pass/fail count
  diverges from the CI baseline by a large constant noise floor (~770 array
  tests differ on BOTH branches, none touching `this`) — only the
  branch-vs-branch delta is trustworthy locally; CI validates absolutes.
- Residual still-failing in the array suite are the two out-of-scope groups
  above (Array-as-prop-bag `-5-3`; top-level-this-as-global `-7/9-c-iii-26..28`)
  — pre-existing limitations, not thisArg.

Recommendation: land with #2085/#1459 (PR #1459). Together they are
net-positive: #1459's ToBoolean wins + this issue's thisArg recoveries, with no
new array-method regressions.

## Follow-up (out of scope, new issues if pursued)

- **top-level `this` = sloppy global**: resolve module-scope `this` to the
  global object instead of `__get_undefined()` (fixes the 3 `*-c-iii-26..28`).
- **Array-as-property-bag receiver**: reading an own data property (`.res`) off
  an Array used as a thisArg/receiver (fixes the `*-5-3` group).
