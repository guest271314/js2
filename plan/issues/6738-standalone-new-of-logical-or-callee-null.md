---
id: 6738
title: "standalone: `new (a || B)()` with a non-identifier callee expression evaluates to null"
status: ready
sprint: Backlog
created: 2026-09-28
updated: 2026-09-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6720, 3981]
---

# #6738 — host-free `new (a || B)()` answers null

## Problem

In `--target standalone` a `new` whose callee is a parenthesized expression
other than an identifier, member access or call — `new (a || B)()`,
`new (cond ? A : B)()` — evaluates to **null** with no trap. The static arms
decline (no identifier), the host-free dynamic-`new` chains in
`compileNewExpression` admit only identifier / member / call callees, and the
legacy `__new_<name>` terminal has no import in standalone.

```js
function ListCache() { this.size = 0; }
ListCache.prototype.set = function (k, v) { this.size++; return this; };
var U;
export function run() {
  var b = new (U || ListCache)();
  return b == null ? 3 : typeof b.set == "function" ? 1 : 2;   // Node 1, standalone 3
}
```

Measured on main `e16ace7ca0` + #6720, single file, `runtimeEvalProvider:
false`. Same answer with or without a runtime-eval site in the module.

## Why it matters

lodash-es uses exactly this shape: `new (Map || ListCache)` in
`_mapCacheClear.js` and `_stackSet.js`. Since
[#6720](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6720-standalone-lodash-es-module-init-null-property-regression)
`Map` is the real realm carrier, so both operands are constructible, but the
`new` never reaches either. The `words` / `kebabCase` lane does not hit it;
any lodash-es operation that builds a `MapCache` or `Stack` at run time does
(`memoize`, `isEqual`, `cloneDeep`, `uniqBy`, …).

## Suggested fix

Admit any expression callee to the host-free native construct path
(`tryCompileNativeConstructFromValue` → `__native_construct_<N>`), which
already evaluates the callee once to an externref and dispatches by runtime
value (closure, class, Proxy, collection carrier). Check the #3981 note that
widening that gate is a larger blast radius, and run the scoped standalone
test262 `language/expressions/new` slice before and after.
