---
id: 2182
title: "collectInstrs detached-array audit + liveBodies-empty assertion (funcIdx-shift hazard completeness)"
status: ready
sprint: 63
created: 2026-06-16
priority: low
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: error-model
related: [1257]
origin: "Sprint-62 follow-up: #1257 symptom verified closed + regression net landed; this is the deferred completeness/hardening half"
---

# #2182 — detached-array funcIdx-shift hazard: completeness audit + assertion

## Context

#1257 (done) closed the observable funcIdx-shift corruption in detached
instruction arrays (the `{x=f()} = null` destructure-null-throw recursion) and
landed `tests/issue-1257.test.ts` as the regression net. It also established
that the architectural mechanism the #1257 spec called for (a `ctx.detachedBodies`
stack walked by `shiftLateImportIndices`) **already exists in tree as
`ctx.liveBodies`** — a `Set<Instr[]>` walked at
`src/codegen/expressions/late-imports.ts:212`, with balanced
`liveBodies.add`/`.delete` discipline at the known hazard sites
(`closures.ts`, `destructuring-params.ts`, `statements/loops.ts`,
`expressions/calls.ts`).

What #1257 deliberately deferred (to avoid a broad risky refactor mid-sprint at
the box's load cap) is the **completeness/hardening** half.

## Scope

1. **Audit** every `collectInstrs` caller and every `pushBody`/`popBody` /
   raw body-swap site (`src/codegen/statements/shared.ts:collectInstrs` is the
   detaching primitive) for the "detached array held across a late import that
   isn't `liveBodies`-registered" hazard. The async-gen body swap at
   `closures.ts` (per #1257 §"Why this is architectural") is a specific
   candidate. Where a gap is found, wrap the detached array's lifetime in
   `ctx.liveBodies.add(...)` / `.delete(...)` (or register in
   `parentBodiesStack` where that's the idiom).

2. **Defensive assertion**: at the end of `compileFunctionBody` (or
   end-of-module compilation), assert `ctx.liveBodies` has no entries that
   should have been deleted — catches a missing `.delete()` that would silently
   over-shift on a later late import. Scope the assertion so it doesn't
   false-positive on legitimately-live nested bodies.

3. **Property/stress test**: compile a fixture that triggers MANY late imports
   during deeply nested detached-array compilation (nested destructuring with
   defaults that call host builtins, inside async generators) and assert every
   `call` funcIdx resolves to the expected function name — the stress test the
   #1257 "Risks" note specified.

## Acceptance criteria

- Audit documented (list of `collectInstrs` / body-swap sites, each marked
  covered or fixed).
- Assertion in place; full test + equivalence suite green (no false positives).
- Stress test added and green.
- No test262 regression.

## Notes

Pure hardening — no known live bug remains (verified in #1257). Low priority;
its value is preventing silent re-introduction of the funcIdx-shift class as
new detached-array codegen patterns are added.
