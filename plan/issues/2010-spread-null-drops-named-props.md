---
id: 2010
title: "{...null} / {...undefined} in an object literal silently drops ALL named properties (externref fallback skips PropertyAssignment)"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: objects
goal: core-semantics
related: [987, 2009]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2010 — error-typed spread routes to a fallback that ignores named props

## Problem

```ts
const o: any = { a: 1, ...null, b: 2 };
o.a + "," + o.b
// wasm: "undefined,undefined" (JSON.stringify → {})   node: "1,2"
```

Spec §13.2.5.5 CopyDataProperties: null/undefined spread is a no-op; named
props must survive.

## Root cause

`src/codegen/literals.ts:230-233` — TS gives the literal an error type
(null isn't spreadable), so it falls to
`compileObjectLiteralAsExternref`, whose loop explicitly states
"PropertyAssignment and ShorthandPropertyAssignment are not handled in
this fallback … let them be silently skipped."

## Fix direction

Handle PropertyAssignment/ShorthandPropertyAssignment in the externref
fallback (compile value, `__extern_set`), and treat null/undefined spread
sources as no-ops.

## Acceptance criteria

- Repro returns "1,2"; `{...undefined}` likewise
- Error-typed literals never silently drop members

## Dupe check

#987 (done) was the CE-shaped fallback issue. New.
