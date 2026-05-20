---
id: 1560
sprint: 53
title: "CJS module.exports = { Linter } — named class re-exports link to compiled class, not extern fallback"
status: ready
created: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, cjs-resolver
language_feature: commonjs, classes, re-exports
goal: npm-library-support
related: [1400, 1277, 1279, 1284, 1559]
blocks: [eslint-tier-1e]
depends_on: [1559]
---

# #1560 — CJS class re-exports link to compiled class

## Problem

ESLint exposes its `Linter` class through a chain of CommonJS
re-exports:

```js
// eslint/lib/api.js
const { Linter } = require("./linter");
module.exports = { Linter, SourceCode, RuleTester, /* ... */ };
```

```js
// eslint/lib/linter/index.js
const { Linter } = require("./linter");
module.exports = { Linter };
```

```js
// eslint/lib/linter/linter.js
class Linter { /* real implementation */ }
module.exports = { Linter };
```

The CJS lowering established by #1277 (module.exports → Wasm exports)
and #1279 (require() graph) handles function exports correctly. But
**class values** at the `module.exports = { ClassName }` site
currently degrade to an extern constructor in the package-entry path:
the named import `{ Linter }` at the consumer module ends up wired to
`env.__new_Linter` rather than to the compiled class struct/type from
the leaf module.

## Reproducer

After #1559 (resolver picks `./lib/api.js` for the bare-package import):

```ts
import { Linter } from "eslint";
new Linter();
```

`compileProject` succeeds, but `r.imports` includes `__new_Linter`
because the re-export chain
`api.js` → `linter/index.js` → `linter/linter.js` loses the link to
the compiled `Linter` type at one of the `module.exports = { Linter }`
hops.

A reduced repro that mirrors the chain (independent of ESLint):

```js
// pkg/leaf.js
class Foo {
  hello() { return 42; }
}
module.exports = { Foo };
```

```js
// pkg/middle.js
const { Foo } = require("./leaf");
module.exports = { Foo };
```

```ts
// entry.ts
import { Foo } from "./pkg/middle";
new Foo();
```

Expected: `new Foo()` produces a compiled-class struct; no
`__new_Foo` extern in `r.imports`. Current: extern fallback.

## Hypothesis

`src/codegen/index.ts` (or the multi-module pipeline in
`compileMultiSource`) handles named CJS exports at the leaf level —
the class is registered as a compile target. But the re-export hop
(`const { Foo } = require("./leaf")` followed by
`module.exports = { Foo }`) does not propagate the class binding
through the binding-import chain. The consumer module then looks up
`Foo` and finds either no binding (falls back to extern from `.d.ts`)
or finds a "JS value" binding that doesn't carry the class-type info.

`#1284` (class-typed values in index-signature dicts) and `#1308`
(Wasm closure struct returned to JS host) handled adjacent
class-as-value cases. This issue is the **CJS re-export** variant:
the class survives the dict round-trip in-module but not the
`module.exports` round-trip across modules.

## Suggested investigation

1. Add a probe `tests/issue-1560.test.ts` with the minimal
   `leaf` → `middle` → `entry` repro above. Confirm `r.imports`
   contains the extern.
2. Inspect the CJS lowering in `src/codegen/index.ts` (search for
   `module.exports` and the named-binding propagation). The leaf
   module's `class Foo` should register a compile target keyed by
   the export name `Foo`; the middle module's re-export should
   forward that same compile target under its `Foo` name.
3. Compare with the function re-export path which already works
   (the #1276 HOF pattern). What's different about the class case?

## Acceptance criteria

1. The reduced repro (`leaf` → `middle` → `entry` class re-export)
   compiles such that `r.imports` contains no `__new_Foo` extern,
   and `new Foo()` produces a compiled-class struct.
2. After #1559 lands, `compileProject` on the ESLint entry
   produces no `__new_Linter` extern in `r.imports` and `Linter`
   is the compiled class.
3. ESLint Tier 1e unskips and either passes or moves to the
   next-layer blocker.
4. Existing tests pass: lodash Tier 1+2 (function re-exports),
   Hono Tier 5 (class App with method re-exports), the #1284
   class-in-dict regression.
5. A regression test under `tests/issue-1560.test.ts` pins the
   minimal class re-export chain.

## Notes

- This is #1400 item 2 (deferred from S52 partial PR), promoted to
  its own issue.
- Depends on #1559: bare-package resolution must pick the impl
  graph before re-export linkage is testable end-to-end. Until
  #1559 lands, this issue's reduced repro is the actionable
  workload (the ESLint case can be confirmed once #1559 closes).
- Feasibility kept at `medium` (not `hard`) because the underlying
  CJS plumbing already supports function values — extending it to
  class values should be a localized change in the export
  resolution.

## Finding (2026-05-20) — reduced repro PASSES on current main

While building the regression test (`tests/issue-1560.test.ts`), we
discovered that the **local-file** CJS class re-export pattern
(`./pkg/leaf` -> `./pkg/middle` -> `entry.ts`) ALREADY WORKS:

- `compileProject` succeeds.
- `r.imports` contains no `__new_Foo` extern.
- The binary instantiates and `new Foo().hello()` returns 42 end-to-end.

This narrows #1560's scope significantly. The CJS re-export plumbing
established by #1277 and #1279 IS functional for local-file graphs;
class values DO survive the `module.exports = { ClassName }` hop.

The remaining bug surface is **bare-package + package.json resolution
specific**: the failure observed in #1400 (`__new_Linter` extern
appearing in `r.imports`) is most likely caused by #1559 (resolver
returns the `.d.ts` instead of the impl), not by a CJS re-export
linkage gap.

### Revised dispatch plan

1. Land #1559 first (resolver picks impl entry for bare-package codegen).
2. Re-test ESLint Tier 1a with the #1559 fix in place — verify
   `r.imports` no longer contains `__new_Linter`.
3. If `__new_Linter` is gone after #1559, **close #1560 as "covered
   by #1559"**.
4. If `__new_Linter` is still present after #1559, the residual bug
   IS in the bare-package CJS class re-export hop, and #1560 stays
   open with a refined test that exercises a synthetic
   `node_modules/foo/` fixture (not relative paths).

### Status transition recommendation

Flip frontmatter to:
```yaml
status: blocked   # blocked by #1559
depends_on: [1559]
```

Until #1559 lands, this issue cannot be confirmed live. The current
regression test in `tests/issue-1560.test.ts` remains as a positive
guard for local-file CJS class re-exports — that pattern must
continue to work.
