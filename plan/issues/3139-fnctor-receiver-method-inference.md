---
id: 3139
title: "host lane: Array generics over fnctor-instance array-likes — first-match extern mis-bind (Uint8ClampedArray_*) + extern index/length handlers not prototype-inclusive"
status: done
assignee: ttraenkler/fable-harvest2
sprint: 71
created: 2026-07-11
updated: 2026-07-13
completed: 2026-07-11
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime
language_feature: array-methods, prototype-chain
es_edition: 5
goal: correctness
test262_category: built-ins/Array/prototype
related: [3138, 3022, 3014, 1712, 2580, 3116]
depends_on: [3138]
origin: "2026-07-11 — follow-on to #3138, banked there as the 'Array-iteration fnctor subclassing' residual (~150 officially-failing files matched the shape)"
# +22 LOC in runtime.ts: the three prototype-inclusive fall-throughs must live
# inside the __extern_length/__extern_get_idx/__extern_has_idx handlers they
# amend — there is no subsystem module for host-import handler bodies.
loc-budget-allow:
  - src/runtime.ts
---

# #3139 — Array generics over fnctor-instance array-likes

## Problem

The test262 applied-to-object family (`built-ins/Array/prototype/{every,filter,
map,some,forEach,reduce,reduceRight,indexOf,lastIndexOf}/15.4.4.x-*`):

```js
foo.prototype = new Array(11, 22, 33);
function foo() {}
var f = new foo();
var r = f.every(cb); // direct form
var r2 = Array.prototype.every.call(f, cb); // .call form
```

Both forms silently iterate **zero** elements on main (post-#3138: the
instance→ctor link exists and `f[1]` / `f.length` reads already resolve, but
the iteration methods still see an empty receiver).

## Root causes (two stacked, WAT-verified)

1. **Direct form — first-match extern mis-bind.** `f` is `any`-typed, so
   `tryExternClassMethodOnAny` (calls-closures.ts) scans `ctx.externClasses`
   and first-match binds `f.every(cb)` to **`Uint8ClampedArray_every`** — the
   %TypedArray% host bridge, which iterates zero elements on a receiver with
   no [[TypedArrayName]] slot. This is EXACTLY the #3014 `forEach`/`some`
   hazard; the refusal list simply didn't cover the other iteration/search
   generics.
2. **.call form — extern index/length reads are not prototype-inclusive.**
   `Array.prototype.every.call(f, cb)` compiles to the generic array loop over
   `__extern_length` / `__extern_get_idx` / `__extern_has_idx`. For a WasmGC
   struct receiver those handlers stopped at own-level reads (sidecar +
   `__sget_*`) and returned `0`/`undefined` — never walking the fnctor
   instance→ctor prototype chain (§7.3.2 Get / §7.3.12 HasProperty are
   prototype-inclusive), where the Array-valued prototype's LIVE length and
   elements are served by the `_readOwnDescriptor` vec arm (#3116).

## Fix

- **calls-closures.ts** — extend the #3014 refusal list with `every`,
  `filter`, `map`, `reduce`, `reduceRight`, `indexOf`, `lastIndexOf` (the
  `indexOf` pair is String∩Array-ambiguous exactly like the #1062 `.slice`
  refusal). Refusal falls through to the runtime-shape-dispatching generic
  paths, which are correct for TypedArrays, arrays, strings AND fnctor
  array-likes.
- **runtime.ts** — `__extern_length` / `__extern_get_idx` /
  `__extern_has_idx`: after every own-level probe misses, resolve through
  `_fnctorProtoLookup` (before the #2580 `Object.prototype` extended-index
  table — the receiver's own [[Prototype]] chain shadows %Object.prototype%).
  Own reads always shadow; receivers without a registered ctor link are
  untouched (lookup returns undefined). Depends on the #3138 call-site
  registration having linked the instance.

## Verified probes (branch, vs main which yields 0/2/0)

- direct `f.every(cb)` iterates 3 elements with correct values (3066 encode);
- `Array.prototype.every.call(f, cb)` iterates 3;
- exact `15.4.4.16-8-10` shape passes;
- any-receiver controls unchanged: string `indexOf`, array
  `map`/`reduce`/`every`/`filter`/`lastIndexOf` on `any` all correct.

## Acceptance criteria

- Measured flips (per-file process isolation, fail-on-base/pass-on-branch)
  in the `built-ins/Array/prototype` applied-to-object family, zero
  regressions.
- Controls: any-receiver String/Array method calls unchanged; genuinely
  TypedArray-typed receivers keep the native path (never reach the `any`
  fallback).

## Measured result (fable-harvest2, 2026-07-11, branch vs post-#3138 main state)

**+41 genuine flips, 0 regressions** over the 158-file officially-failing
shape corpus, per-file process isolation both sides (contamination-safe —
see #3138's methodology caution): every 8, filter 8, map 1, reduce 12,
reduceRight 12; zero pass→fail / fail→other flips. The corpus now passes
49/158 (was 8 post-#3138).

Validation: emit-hash corpus **byte-identical** (typed receivers keep native
paths); 12 adjacent suites green (issue-3014, all issue-2580 array-like
suites incl. protoextend/any-length/map-arraylike, issue-1712 acorn
tokenizer sentinels, array equivalence incl. externref-indexOf); any-receiver
String/Array controls correct (string indexOf, array map/reduce/every/filter/
lastIndexOf on `any`); tsc clean; new unit suite 5/5 (incl. the no-ctor-link
plain-struct control: generic loops still see length 0).

Residual in the corpus (~109 fails) is NOT this mechanism: mostly
`Object.defineProperty(child, …)` attribute setups on the array-like
(descriptor semantics on fnctor receivers), delete-on-prototype semantics,
and strict-callback `this` checks — separate causes, none regressed here.
