---
id: 6736
title: "standalone: `.length` of a function's `prototype` object reads a number, so lodash's `isArrayLike(LazyWrapper.prototype)` is true and module init throws"
status: ready
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
related: [6713, 6711]
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
