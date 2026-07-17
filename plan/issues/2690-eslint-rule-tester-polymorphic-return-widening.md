---
id: 2690
title: "ESLint rule-tester.js: cloneDeeplyExcludesParent polymorphic return widens i32 into anyref slot"
status: ready
updated: 2026-07-17
model: fable
fable_role: spec
sprint: fable-final
created: 2026-06-26
priority: low
area: codegen
goal: npm-library-support
feasibility: medium
related: [1573]
---
# ESLint rule-tester.js — cloneDeeplyExcludesParent polymorphic return widening

Carved from the de-staled #1573 ESLint survey. This is rule-tester.js's NEW
first-error after #1573 bug A (`inferLastType` branch-arm fix) unblocked the
prior `LazyLoadingRuleMap_new` blocker.

## Reproducer
```ts
import { compileProject } from "./src/index.js";
const r = await compileProject(
  "/workspace/node_modules/eslint/lib/rule-tester/rule-tester.js",
  { allowJs: true },
);
expect(r.success).toBe(true);                      // passes
expect(WebAssembly.validate(r.binary)).toBe(true); // FAILS
```

## Error (current main, eslint 10.0.3, post-#1573-bug-A)
```
function #236 "cloneDeeplyExcludesParent":
  local.tee[0] expected type (ref null 2), found local.get of type i32
```

## Source
```js
function cloneDeeplyExcludesParent(x) {
  if (typeof x === "object" && x !== null) {
    if (Array.isArray(x)) return x.map(cloneDeeplyExcludesParent);
    const retv = {};
    for (const key in x) {
      if (key !== "parent" && hasOwnProperty(x, key))
        retv[key] = cloneDeeplyExcludesParent(x[key]);
    }
    return retv;
  }
  return x;
}
```

## Root cause (hypothesis)
Polymorphic / self-recursive return: the function returns `x` (any), or
`x.map(...)` (array), or `retv` (object), or the primitive fall-through. The
unified return slot was inferred as a struct ref `(ref null 2)` (from the
`retv = {}` branch), but the `return x` fall-through routes an `i32`-typed
value through the same slot. Return-type widening across `Array.isArray` /
`typeof` narrowing + self-recursion is the gap.

## Fix direction
Return-coercion path in `src/codegen/statements.ts` (ReturnStatement) plus the
unified-return-type inference in `src/codegen/index.ts`. rule-tester.js is the
least end-user-critical ESLint binary, so this is lower priority than #2688 /
#2689.

## Bug class
CODEGEN — polymorphic return-type widening / coercion. Pure ES5.
