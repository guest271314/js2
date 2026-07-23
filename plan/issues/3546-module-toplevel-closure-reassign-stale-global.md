---
id: 3546
title: "codegen: module TOP-LEVEL closure reassignment writes only the __module_init local shadow — cross-function calls read the stale first closure from the global"
status: ready
sprint: Backlog
created: 2026-07-23
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: closures
goal: correctness
related: [3534, 3533]
---

# #3546 — `let f = () => 1; f = () => 2;` at module top level: `f()` from another function returns 1

## Repro (verified 2026-07-23 on post-#3505 main; gc lane)

```ts
let f = (): number => 1;
f = (): number => 2;
export function test(): number { return f(); }
// test() === 1   (want 2)   — binary sha256-16: d57a1b35964e0b09
```

`var` behaves identically (`module_var_reassign` → WRONG got=1). This is
PRE-EXISTING relative to #3534/#3505 (same WRONG result + same binary hash on
the pre-#3505 baseline) — it is the ASSIGNMENT-path sibling of the #3534
declaration-path family, not a regression.

## Scoping matrix (probe `.tmp/probe-3546.mts`, kept in the #3534 owner's notes)

| shape | result |
|---|---|
| module top-level reassign, call from exported fn | **WRONG got=1** |
| reassign inside a function (`set2()` writes `f`), then call | PASS |
| purely local `let f = …; f = …; f()` | PASS |
| module top-level `var` reassign | **WRONG got=1** |

## Mechanism (verified by the scoping split; exact write-arm to confirm)

The declaration's arrow path in `variables.ts` dual-stores the closure: it
`local.tee`s a **local shadow of `f` inside `__module_init`** and boxes the
value into the `$__mod_f` externref global. A LATER top-level reassignment
statement compiles inside the same `__module_init` fctx, where
`fctx.localMap.has("f")` is true — the assignment takes the LOCAL write arm and
updates only the shadow local. The module global — which every OTHER function's
read/call of `f` resolves through — still holds the first closure. The
function-scope variant passes precisely because `set2`'s fctx has no local
shadow, so the assignment writes the global.

## Suggested direction

In the assignment path, when the write target has BOTH a local shadow in the
current fctx AND a module global (`ctx.moduleGlobals.has(name)`), mirror the
declaration's dual-store: write the local AND box-on-store
(`extern.convert_any` for a precise closure ref — the #3534 invariant: the
global stays externref, never narrowed) into the global. Alternatively drop the
`__module_init` local shadow entirely and route top-level reads through the
global; the dual-store is the smaller change.

## Acceptance criteria

- The repro returns 2 on both lanes; `module_var_reassign` likewise.
- The #3534 corpus (sha256s in that issue file) stays byte-identical except
  the reassignment shapes.
- No new invalid-Wasm signatures; equivalence suite delta zero.
