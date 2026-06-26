---
id: 2688
title: "ESLint apply-disable-directives.js: conditional-spread produces two struct shapes for array.set element type"
status: ready
created: 2026-06-26
priority: medium
area: codegen
goal: npm-library-support
feasibility: hard
related: [1573]
---
# ESLint apply-disable-directives.js — conditional-spread struct-shape mismatch

Carved from the de-staled #1573 ESLint survey (bug B). One of the residual
validation blockers after #1573 bug A (`inferLastType` branch-arm fix) landed.

## Reproducer
```ts
import { compileProject } from "./src/index.js";
const r = await compileProject(
  "/workspace/node_modules/eslint/lib/linter/apply-disable-directives.js",
  { allowJs: true },
);
expect(r.success).toBe(true);                      // passes
expect(WebAssembly.validate(r.binary)).toBe(true); // FAILS
```

## Error (current main, eslint 10.0.3)
```
function #128 "applyDirectives":
  array.set[2] expected type (ref null 107), found call_ref of type (ref null 118)
```

## Root cause (hypothesis)
`applyDirectives` maps over `processed` with a callback returning an object
literal that contains a **conditional spread**:
```js
return {
  ruleId: null, message, line, column, severity,
  ...(options.disableFixes ? {} : { fix }),
};
```
The conditional spread yields **two distinct struct shapes** (one with `fix`,
one without). The result array's element type was inferred as one shape
(struct 107) but the `.map` callback's `call_ref` returns the other (struct
118). Conditional-spread struct-shape unification is missing.

## Fix direction
Either (1) treat the conditional-spread literal as a single struct shape with
`fix` as a nullable/optional field, or (2) widen the result array's element
type to a common-supertype struct covering both branches. Shape inference in
`src/shape-inference.ts` + the `Array#map` element-type computation in
`src/codegen/array-methods.ts` / object-literal lowering in
`src/codegen/literals.ts`.

## Bug class
CODEGEN — struct-shape unification at object-literal level (conditional
spread). Pure JS object-literal feature, not async/generators/Proxy.
