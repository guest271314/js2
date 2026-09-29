---
id: 6736
title: "standalone: `.length` of a function's `prototype` object reads a number, so lodash's `isArrayLike(LazyWrapper.prototype)` is true and module init throws"
status: done
completed: 2026-09-29
sprint: current
created: 2026-09-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6713, 6711, 2580, 6751]
---

# #6736 — `F.prototype.length` answers a number in standalone

## Problem

lodash 4.18.1 npm-compat **standalone-dynamic** lane, after
[#6713](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6713-standalone-dynamic-regexp-carrier-call-construct)
(`RegExp` / Error carriers callable through a variable):

```
runtime-error (phase: module-init): TypeError: called value is not a function
```

Located with in-source step markers (a lodash copy with
`globalThis.__probeStep = N` markers, compiled standalone, no provider): module
init now runs to `lodash.js:17127`,
`baseForOwn(LazyWrapper.prototype, function(func, methodName) { … })`, and
throws inside `keys(LazyWrapper.prototype)` before the first iteratee call —
`isArrayLike(LazyWrapper.prototype)` answers **true**, so `keys` takes
`arrayLikeKeys` (never `baseKeys`), which calls a non-callable.

`isArrayLike` is `value != null && isLength(value.length) && !isFunction(value)`,
so the root is `.length` on a function's `prototype` object.

## Reduction (standalone, `runtimeEvalProvider: false`, 0 imports)

```js
var out = 0;
function ric(context) {
  var Object = context.Object;
  var objectCreate = Object.create;
  function isObject(v) { var t = typeof v; return v != null && (t == 'object' || t == 'function'); }
  var baseCreate = (function () {
    function object() {}
    return function (proto) {
      if (!isObject(proto)) return {};
      if (objectCreate) return objectCreate(proto);
      object.prototype = proto; var r = new object; object.prototype = undefined; return r;
    };
  }());
  function baseLodash() {}
  function lodash(value) { return value; }
  lodash.prototype = baseLodash.prototype;
  lodash.prototype.constructor = lodash;
  function LazyWrapper(value) { this.__wrapped__ = value; }
  LazyWrapper.prototype = baseCreate(baseLodash.prototype);
  LazyWrapper.prototype.constructor = LazyWrapper;
  var len = LazyWrapper.prototype.length;
  if (len === undefined) out += 1;
  if (typeof len === 'number') out += 2;
  if (typeof baseLodash.prototype.length === 'undefined') out += 4;
}
ric(globalThis);
export function run() { return out; }
```

Node answers **5**; standalone answers **2** (measured 2026-09-28 on
`2e23e49fb1` + #6713). A top-level variant is also internally inconsistent:
`function two(a, b) {}; var q = two.prototype;` reads `q.length === undefined`
as true (static fold) while `typeof q.length` is `"number"` (0).

## Direction

Find where a fnctor's `prototype` object answers `length` — likely the
prototype read resolving to (or inheriting from) the function carrier, whose
`length` is its arity. `F.prototype` is an ordinary object (§10.2.5
MakeConstructor), so `length` must be absent unless written. Re-run the lodash
standalone-dynamic lane for the next link.

## Implementation Plan

Executed as written.

1. **Measure where the number comes from.** Probes (`.tmp/p6736/*.js`) showed
   the bug is not specific to function prototypes. In standalone, every
   `recv.length` read on an `any` receiver goes through
   `emitStandaloneAnyLength` in `property-access-dispatch.ts`, which
   always returns `f64`. Its non-string, non-closure fallback is
   `__extern_length`, the array-like ToLength reader, so an absent `length`
   comes back as `0`. Four cases all read `0`: `id({}).length`,
   `Object.create(p).length`, `F.prototype.length`, and lodash's
   `LazyWrapper.prototype.length`. The dynamic-key spelling (`o[k]` with
   `k = "length"`) was already correct. JS-host fixed the same bug in #2580 M2
   through `emitDynGet`.
2. **Lowering.** Replace the function with `emitStandaloneAnyLengthGet` in a
   new classified module, `src/codegen/standalone-any-length.ts`. It
   returns `externref` and tries these arms in order:
   1. `$AnyString` → box(len).
   2. `__builtinfn_get_meta` hit → the metadata value.
   3. Closure → own `length` from the closure bag, else 0.
   4. `null`/`undefined` → box(`__extern_length`), same as before.
   5. `$__vec_base` → box(field 0).
   6. Anything else → `__extern_get(recv, "length")`, a real Get that walks
      the prototype chain and returns `undefined` when `length` is absent.

   Arms 1–5 return the same values as before. Every boxed-number template is
   cloned per use: the late-import shift rewrites `call` operands in place,
   so a shared `Instr` would get shifted twice.
3. **Scope.** Only the two standalone/WASI callers change (the `any`-receiver
   `.length` arm and the tuple-length externref fallback). The JS-host path is
   untouched.
4. **Acceptance.** The regression test `tests/issue-6736-any-length-absent.test.ts`
   has three cases: the issue's reduction, lodash `isArrayLike`, and a
   present/absent length matrix. It must fail on the parent and pass with the
   fix. Scoped standalone test262 (`built-ins/Function/prototype`,
   `language/statements/function` plus array-like `.length` consumers) must
   show no losses, and the lodash standalone-dynamic lane is compared before
   and after.

## Resolution

**Root cause.** The bug was broader than function prototypes. In standalone,
every `.length` read on an `any` receiver was lowered as a number, so
`{}.length`, `Object.create(p).length`, `F.prototype.length` and `(5).length`
all read as `0` instead of `undefined`. The fix is
`src/codegen/standalone-any-length.ts`, which follows the plan above.

**Regression test.** `tests/issue-6736-any-length-absent.test.ts`: 3/3 pass
with the fix. On the parent all three fail, reading `2`, `108` and `127`
(expected `5`, `127` and `511`).

**Updated test.** `tests/issue-2576.test.ts` used to pin the old lowering's
`0` for `(5).length`. It now expects `NaN`, which is `undefined` returned
through a `number` export.

**Unit tests near the change.** 15 files. The 9 failures in
`issue-1472`, `issue-2861` and `string-derived-length-fast-path` fail
identically on the parent.

**Scoped standalone test262.** 1401 rows, run in-process against the same base
(`0aeb5733bb`), parent vs fix:

| Rows | Parent | Fix |
|---|---|---|
| All 1401 | 1216 pass · 137 fail · 48 CE | 1216 pass · 137 fail · 48 CE |
| `built-ins/Function/prototype` + `language/statements/function` (760) | 711 pass | 711 pass |

The other rows cover `built-ins/Array/from`, `Array/prototype/{slice,indexOf}`,
`Object/keys` and `language/arguments-object`. Zero rows flipped in either
direction.

**JS-host.** Byte-identical binaries on the probe set; both call sites are
gated on standalone/WASI.

**lodash standalone-dynamic lane.** The lane status is `optimization-error`
both before and after:
`wasm-opt -O4 failed: unexpected expr type … Flatten.cpp:231`. That is the
#4586/#6732 retry class, and it does not change here.

The unoptimized binary (`--inspect-binary`) moves forward:

- **Before:** module init throws `TypeError: called value is not a function`
  (measured on the #6713 PR head).
- **After:** module init completes. The checksum call throws
  `TypeError: called value is not a function`, which is filed as #6751.

**Residual.** Numeric var-slot inference can still type a local that is
initialized from `v.length` as f64 when that parameter's call sites mix arrays
and plain objects. Example: `function chk(v, want){ var got = v.length; … }`,
called first with an array and then with `{}`. The value is then read as `NaN`
instead of `undefined`. Such a local was already numeric before this change.
