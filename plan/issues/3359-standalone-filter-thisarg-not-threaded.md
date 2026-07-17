---
id: 3359
title: "standalone: Array.prototype.filter (and callback methods) ignore the thisArg argument — closure runs with wrong `this`"
status: ready
sprint: current
created: 2026-07-17
priority: low
horizon: s
feasibility: medium
task_type: bug
area: codegen
language_feature: array-methods, this-binding
goal: standalone-parity
related: [2036, 3326]
origin: "found while fixing #3326 (stale refuse-loudly expectations in tests/issue-2036.test.ts) — the `filter threads thisArg standalone` case genuinely fails (returns 0, expected 1); confirmed the same bug on a REAL array receiver, so it is a general filter-thisArg threading gap, not an $Object-only issue."
---

# #3359 — standalone `filter` ignores its `thisArg`

## Problem (measured, current main)

Under `--target standalone`, `Array.prototype.filter`'s optional second
argument (`thisArg`) is not threaded into the callback's `this`, so a
callback that reads `this.<prop>` sees `undefined` and the predicate is
mis-evaluated:

```ts
export function test(): number {
  const a = [5, 15];
  const r: any = a.filter(function (this: any, x: number) { return x > this.t; }, { t: 10 });
  return r.length; // standalone → 0 (WRONG); spec → 1
}
```

Confirmed on **both** a real array receiver and a borrowed array-like
`$Object` receiver (`Array.prototype.filter.call(o, cb, {t:10})`), so the gap
is in the native `filter` callback-invocation path, not the `$Object`
array-like arm. A closure that *captures* the value lexically (`(x) => x > t`)
works — only the `this`-binding path is broken.

## Scope

- Likely the same gap applies to the other callback methods that accept a
  `thisArg` (`map`/`some`/`every`/`find`/`findIndex`/`forEach`/`reduce`
  excepted — reduce has no thisArg). Audit each; fix the native standalone
  callback-invocation to bind `thisArg` as the callback receiver.

## Acceptance

1. `filter` (and the other thisArg-taking callback methods) thread `thisArg`
   into the callback's `this` under standalone.
2. Re-enable the `filter threads thisArg standalone` case in
   `tests/issue-2036.test.ts` (currently `it.skip`'d with a pointer here).
3. Host-lane byte-identity; no test262 regression.
