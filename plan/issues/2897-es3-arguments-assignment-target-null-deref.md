---
id: 2897
title: "≤ES3: `arguments` as assignment target crashes (null-deref)"
status: done
priority: high
sprint: 69
created: 2026-06-30
completed: 2026-06-30
assignee: ttraenkler/es3-2897
feasibility: medium
task_type: bug
area: codegen
es_edition: 3
language_feature: arguments
goal: spec-completeness
related: [2676, 2667]
---

# #2897 — `arguments` identifier-reference assignment target null-derefs

One of the **8 tests blocking 100% ≤ES3 conformance** (ES3 edition currently 266/274 ≈ 97%).

## Failing test
`test/language/expressions/assignmenttargettype/simple-basic-identifierreference-arguments.js`

→ **`L41:3 dereferencing a null pointer [in test()]`** — a compiler/runtime **crash**, not a wrong value.

## What it checks
`arguments` is a valid `SimpleAssignmentTarget` (AssignmentTargetType = "simple") in non-strict code, so an assignment whose target is the `arguments` identifier reference must compile and run. The test drives the assignment-target-type machinery using `arguments` as the LHS.

## Root-cause direction
The codegen path for an assignment whose LHS resolves to the `arguments` binding dereferences a null pointer — the `arguments` object/local is likely not materialized on the **assignment-target (lvalue)** path the way it is on the read path. Look at identifier-reference assignment lowering (`src/codegen/expressions/assignment.ts`) and how `arguments` is bound as an lvalue (the eager-arguments-materialization site).

## Acceptance
- The test compiles + runs without the null-deref and passes.
- No regression in other `arguments`/assignment tests.

## Root cause (confirmed)
`arguments` is eagerly materialized as a **concrete non-null vec ref** local
(`(ref null $__vec_externref)`) for fast `.length` / `[i]` access
(`src/codegen/function-body.ts` → `allocLocal(fctx, "arguments", vecRef)`). On
the assignment path (`compileAssignment`, `src/codegen/expressions/assignment.ts`)
a whole-identifier write `arguments = X` resolved that local and compiled the RHS
with the vec-ref type as the expected type. Coercing an arbitrary RHS (e.g. the
f64 `1`) into a non-null vec ref produced:

```wat
f64.const 1
drop
ref.null $__vec_externref
ref.as_non_null     ;; <-- traps: "dereferencing a null pointer"
local.set $arguments
```

i.e. the placeholder `ref.null` is forced non-null and traps at runtime.

## Fix
In the identifier-assignment branch of `compileAssignment`, detect when the LHS
is the materialized `arguments` vec local (`name === "arguments"` + ref-typed +
not a closure ref). In non-strict code `arguments` is a valid
`SimpleAssignmentTarget` (§13.15.1), so `arguments = X` **rebinds** the
identifier: compile the RHS as `externref` (the universal value carrier), store
it into a fresh `externref` local (which `allocLocal` re-points `arguments` to in
`localMap`), and clear `fctx.mappedArgsInfo` (the arguments object is replaced).
The assignment expression evaluates to the RHS value. Subsequent reads of
`arguments` resolve to the rebound externref; `.length` / `[i]` on a non-vec
value degrade to `undefined` via the externref `__vec_len`/`__vec_get` helpers,
matching JS.

## Test Results
- New unit tests: `tests/issue-2897.test.ts` — 6/6 pass.
  - `arguments = 1` runs (no crash), evaluates to RHS, rebinds (`return arguments`),
    string RHS, formal param intact after reassign, mapped `arguments[i]` write
    still reflects into the param (regression control).
- Repro (exact test262 wrapper + `inferModuleStrictArguments:false`,
  `skipSemanticDiagnostics:true`): `arguments = 1` → `test()` returns 1 (was a
  null-deref trap).
- `tsc --noEmit` clean; `biome lint` clean; prettier clean.
- The one pre-existing failure in `tests/issue-1053-arguments-global-staleness.test.ts`
  reproduces on unmodified `origin/main` (unrelated to this change).
