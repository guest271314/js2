---
id: 2691
title: "ESLint api.js: re-export 'ESLint' declared locally but not exported (compile error)"
status: ready
created: 2026-06-26
priority: medium
area: module-resolution
goal: npm-library-support
feasibility: medium
related: [1573]
---
# ESLint api.js — re-export resolution: 'ESLint' declared locally but not exported

Carved from the de-staled #1573 ESLint survey. Unlike the other residuals this
is a **compile error** (not a validation failure) — it fails earlier in the
pipeline, in module resolution.

## Reproducer
```ts
import { compileProject } from "./src/index.js";
const r = await compileProject("/workspace/node_modules/eslint/lib/api.js", { allowJs: true });
// r.success === false
// r.errors[0].message === "Module '\"./eslint/eslint\"' declares 'ESLint' locally, but it is not exported."
```

## Error (current main, eslint 10.0.3)
```
Module '"./eslint/eslint"' declares 'ESLint' locally, but it is not exported.
```

`api.js` is the public re-export bundle. It re-exports `ESLint` from
`./eslint/eslint`, but the compiler's module-resolution / re-export handling
does not see `ESLint` as exported from that module (likely a CJS
`module.exports` / `Object.defineProperty(exports, ...)` shape, or a re-export
form the resolver doesn't follow).

## Fix direction
Investigate how `eslint/lib/eslint/eslint.js` exports `ESLint` (CJS
`module.exports = { ESLint }` vs `Object.defineProperty`/getter) and why the
re-export in `api.js` doesn't resolve it. Module resolver + CJS interop in
`src/` (ModuleResolver / `resolveAllImports` / CJS export detection in
`src/codegen/declarations.ts`).

## Bug class
MODULE RESOLUTION / CJS interop — re-export of a CJS-exported binding.
