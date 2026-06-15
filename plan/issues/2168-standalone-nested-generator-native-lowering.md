---
id: 2168
title: "standalone: nested `function*` declarations take the JS-host path (funcindex CE) — native lowering only wired for top-level generators"
status: ready
sprint: 62
created: 2026-06-15
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: iterators-generators
goal: standalone-mode
parent: 2157
depends_on: [2079]
---

# #2168 — nested generator native lowering (SF-1 of #2157)

## Problem

A `function*` declared INSIDE a function body always takes the JS-host
generator path (`__create_generator` etc.), so standalone leaks env imports /
hits the late-import funcindex CE. The same generator hoisted to top-level
works (native lowering, #2079).

```ts
export function test(): number {
  function* g(){ yield 1; yield 2; yield 3; }   // nested
  let s=0; for (const v of g()) s+=v; return s;  // FAIL: funcindex CE; exp 6
}
```

## Root cause

`statements/nested-declarations.ts:207-209` hard-codes a nested generator's
return type to `externref` and never calls `registerNativeGenerator` /
`compileNativeGeneratorFunction`. The native path
(`collectDeclarations` → `registerNativeGenerator`) is only wired for
`sourceFile.statements` (top-level) + `registerBodylessFunctionDeclaration`.

## Fix direction

Route nested generator declarations through the native lowering in
standalone/wasi mode. The hard part vs top-level: a nested generator can
**capture enclosing locals**, so the native state struct must also spill the
captured cells (the existing nested-function capture analysis in
`nested-declarations.ts` already computes the capture set — feed it into the
generator state struct). Keep the JS-host path for non-standalone targets.

## Acceptance criteria

- `tests/issue-2157-*.test.ts` SF-1 `it.todo` passes, zero host imports.
- Captured-variable nested generators (`let x=10; function* g(){ yield x; }`)
  produce correct values.

## Source

Triage of #2157 (2026-06-15, sdev5), SF-1 — largest single lever in the gap.
