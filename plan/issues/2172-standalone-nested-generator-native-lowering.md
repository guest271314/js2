---
id: 2172
title: "standalone: nested `function*` declarations take the JS-host path (funcindex CE) — native lowering only wired for top-level generators"
status: done
completed: 2026-06-15
sprint: 62
created: 2026-06-15
updated: 2026-06-15
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

# #2172 — nested generator native lowering (SF-1 of #2157)

> Renumbered from #2168 (which was already assigned to the multi-dev
> issue-assignment-lock issue).

## Problem

A `function*` declared INSIDE a function body always took the JS-host
generator path (`__create_generator` etc.), so standalone leaks env imports /
hits the late-import funcindex CE. The same generator hoisted to top-level
works (native lowering, #2079).

```ts
export function test(): number {
  function* g(){ yield 1; yield 2; yield 3; }   // nested
  let s=0; for (const v of g()) s+=v; return s;  // was: funcindex CE; exp 6
}
```

## Root cause

`statements/nested-declarations.ts:207-209` hard-coded a nested generator's
return type to `externref` and never called `registerNativeGenerator` /
`compileNativeGeneratorFunction`. The native path
(`collectDeclarations` → `registerNativeGenerator`) was only wired for
top-level `sourceFile.statements` + `registerBodylessFunctionDeclaration`.

## Resolution (2026-06-15, sdev5) — no-capture native lowering landed

`compileNestedFunctionDeclaration` now, for a **no-capture** native-generator
candidate (`isGenerator && captures.length === 0 && isNativeGeneratorCandidate`),
registers it via `registerNativeGenerator` (so the factory returns the
state-struct ref) and emits the factory body via `compileNativeGeneratorFunction`
— exactly the top-level path. A no-capture nested generator is semantically a
module-level function, so it slots straight into the existing native machinery.
The funcindex hazard is already handled: the no-capture branch reserves the
function's module slot with a placeholder before its body emits (#2068/#2079).

Verified standalone, zero host imports: sequential / while / for(param) yields,
manual `next()`, and multiple distinct nested generators in one function.
Top-level generators unchanged; default (JS-host) mode unchanged (the native
path is gated on `noJsHostTarget` inside `isNativeGeneratorCandidate`).
Test: `tests/issue-2172-nested-native-generator.test.ts`.

## Deliberately deferred — capturing nested generators

A nested generator that **captures** an enclosing local still falls through to
the host path (which fails standalone) — the resume function runs detached from
the enclosing frame, so captured cells would have to spill into the state
struct. That's a separate, larger change (`reasoning_effort: max`). Tracked as
the SF-1 capture follow-up under #2157. The capture case bails cleanly (no
crash, no wrong answer) exactly as before.

## Acceptance criteria

- No-capture nested generators compile + run standalone with zero host imports.
- Capturing nested generators bail cleanly (unchanged).
- Top-level + JS-host generator paths unchanged.

## Source

Triage of #2157 (2026-06-15, sdev5), SF-1 — largest single lever in the gap.
