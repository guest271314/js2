---
id: 2930
title: "codegen: import binding whose local name differs from the target declaration name resolves to null"
status: done
priority: high
sprint: 69
created: 2026-07-02
completed: 2026-07-02
assignee: ttraenkler/dev-2900
feasibility: medium
task_type: bug
area: codegen
goal: spec-completeness
related: [2900, 2931, 2932]
parent: 2900
---

# #2930 — import-alias name mismatch (local name ≠ declaration name) → null

Split from #2900 (RC2). Root-caused by dev-2900 — see #2900's Implementation Plan.

## Problem

Codegen keys `funcMap` / `closureMap` / `moduleGlobals` (and per-name call
metadata) by the imported symbol's **declaration name**, never by the **local
import binding**. So any import whose local name differs from the target's
declaration name left the local binding unresolved — every read/call of it fell
through to the graceful-null default (returned 0 / null / a wrong closure).

Proven on `.ts` fixtures (no `.js`/allowJs involved) on `origin/main`:

- `import fn from './h.ts'` where `./h.ts` is `export default function fn(){…}` (local == decl) → `fn()` = 7 ✓
- `import val from './h.ts'` (local `val` ≠ decl `fn`) → `val()` = **0** ✗
- `import { add as plus } from './h.ts'` (renamed named import) → `plus(1,2)` = **0** ✗
- `function g(){…} export { g as default }` + `import v from './h.ts'` → `v()` = **0** ✗
- anonymous `export default function(){…}` + `import val` → `val()` = **0** ✗

## Fix (implemented)

New pass `registerImportBindingAliases(ctx, sourceFiles)` in
`src/codegen/index.ts`, run **after** `collectDeclarations` (targets registered)
and **before** function bodies compile. For each default / named import binding
it follows the checker alias (`getSymbolAtLocation` → `getAliasedSymbol`) to the
target declaration's name (or `"default"` for anonymous default), then copies the
resolution entries (`funcMap`, `closureMap`, `moduleGlobals`, `funcOptionalParams`,
`nestedFuncCaptures`) onto the local name. Purely **additive** — writes only
local-name keys that are currently absent, so every already-resolving binding
stays byte-identical; only currently-null sites change.

## Acceptance

- Default / renamed-named / `export { x as default }` / anonymous-default imports
  resolve to the imported target for both **call** and **value read**.
- No regression in existing multi-file / module tests (CI full test262; the delta
  is expected to be net-positive — many `_FIXTURE`-independent renamed/default
  imports start resolving).

## Notes

- Unrelated pre-existing quirk (out of scope): `typeof <function-value>` does not
  report `'function'` — true for local functions too, so not introduced here.
- The cross-module `.js`-fixture case (#2900's real test) additionally needs
  #2932 (compile `.js` module deps) and #2931 (live function-decl bindings).
