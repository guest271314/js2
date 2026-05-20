---
id: 1559
sprint: 53
title: "ModuleResolver: bare-package import resolves to implementation (default/main) for codegen, not .d.ts"
status: needs-spec
created: 2026-05-20
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: resolver, codegen
language_feature: package-exports, npm-resolution, module-resolution
goal: npm-library-support
related: [1400, 1060, 1061, 1287]
blocks: [eslint-tier-1e, 1560]
---

# #1559 — Bare-package import resolves to implementation for codegen

## Problem

`import { Linter } from "eslint"` currently resolves through ESLint's
`package.json` `exports` map:

```json
{
  ".": {
    "types": "./lib/types/index.d.ts",
    "default": "./lib/api.js"
  }
}
```

The TypeScript checker correctly picks `./lib/types/index.d.ts` for
type information, **but the compiler then uses that same `.d.ts` as
the source of truth for codegen**. The result: codegen treats
`Linter` as an extern class and emits `env.__new_Linter`. The compiled
implementation in `./lib/api.js` (and its transitively required
`./lib/linter/linter.js`) is never traced.

Symptom captured in #1400:

```text
No dependency provided for extern class "Linter"
```

This is the inverse of the #1060 fix (which removed `@types/*`
preference for the implementation graph). #1060 handled the
`@types/foo` case (declaration package distinct from impl package).
This issue handles the **package-local** case where one `package.json`
declares both `types` and `default` for the same bare import.

## Scope distinction

- #1060 — `@types/foo` vs `foo`: separate packages. **DONE**.
- #1559 — single package, `types` + `default` in same `exports`
  conditions block. **OPEN**.

## Reproducer

```ts
import { compileProject } from "./src/index.js";

const r = compileProject("/workspace/entry.ts", { allowJs: true });
// entry.ts contains: import { Linter } from "eslint"; new Linter();
```

Inspect `r.imports`: currently includes `__new_Linter` (extern fallback).
After fix: should not, because `Linter` is found in
`./lib/api.js` → `./lib/linter/linter.js` (a real compiled class).

A direct compile of `./lib/api.js` already works (#1400 Tier 1c-equivalent),
so the implementation graph is reachable — the resolver just needs to
pick it for the bare-package import.

## Required behaviour

When resolving a bare-package specifier (`import X from "pkg-name"`):

1. The TypeScript checker continues to read `.d.ts` for *type* checking
   (so the developer sees `Linter` typed correctly).
2. The codegen module graph follows the `default` / `main` /
   implementation condition for the **module resolution** step,
   producing an implementation source path that is fed to
   `compileMultiSource`.
3. If the implementation entry is `.js`, `allowJs: true` paths must
   honor this (already true for #1287's `.d.ts`-as-extern fix).
4. The fallback chain: implementation entry → if missing/invalid →
   declaration-only extern class (current behaviour).

## Architect spec needed

This issue is **`needs-spec` before dispatch**. The resolver currently
has two competing requirements:

- For `@types/*`: prefer the impl package (`foo`) over the types
  package (`@types/foo`). #1060 addressed this.
- For self-typed packages: prefer the impl entry (`default`/`main`)
  over the types entry (`types`) when codegen needs a body.

The architect spec must define:

1. Where in `src/checker/module-resolver.ts` (or wherever) the
   conditional `exports` resolution decides between `types` and
   `default`. The decision should be **callsite-driven**: codegen
   asks for impl, checker asks for types.
2. The fallback semantics when only one condition is present.
3. Interaction with `compileProject`'s tree-shaker — at what point
   the impl entry's module graph gets pulled in.
4. A regression matrix covering: bare-package + dts-only,
   bare-package + impl-only, bare-package + both (the ESLint case),
   bare-package + scoped (`@scope/pkg`), conditional-exports with
   `node`/`browser`/`default` flavors.

## Acceptance criteria

1. `compileProject` on an entry that does
   `import { Linter } from "eslint"; new Linter()` produces a binary
   whose `imports` manifest does **not** contain `__new_Linter`.
2. The `Linter` class in the produced module is the compiled class
   from `eslint/lib/linter/linter.js`, not an extern.
3. ESLint Tier 1b stays green (validate the bare-package shim binary).
4. ESLint Tier 1e unskips and either passes or moves to the next-layer
   blocker (likely runtime: rule loading, `for...in`, etc.).
5. Existing tests pass: lodash Tier 1+2, Hono Tier 1-6, prettier
   bundled-config compilation (the #1060 regression test), TypeScript
   `@types/*` resolution stays in `@types/*`-prefer-impl mode.
6. A new regression test under `tests/` covers the single-package
   `types` + `default` decision (a minimal `node_modules/foo` fixture
   with both a `.d.ts` and a `.js` body declared in `exports`).

## Notes

- This is #1400 item 1 (deferred from S52 partial PR), promoted to
  its own issue for tracking.
- Blocks #1560 (CJS class re-export linkage) — once this resolves to
  the impl, the re-export issue becomes the next blocker.
- Architect spec needed because the change touches the resolver's
  central decision path and a regression here breaks every npm
  import path.
