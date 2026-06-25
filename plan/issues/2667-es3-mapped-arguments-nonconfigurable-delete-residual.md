---
id: 2667
title: "≤ES3: mapped arguments object — non-configurable/non-writable property + [[Delete]] semantics (residual of #1511)"
status: done
assignee: ttraenkler/dev-es3
created: 2026-06-25
updated: 2026-06-25
completed: 2026-06-25
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
es_edition: 0
language_feature: arguments-object
goal: spec-completeness
depends_on: []
related: [1511, 2676]
sprint: 66
---
# #2667 — ≤ES3 mapped-arguments non-configurable/non-writable + delete residual

## Edition / impact

- **Edition:** ≤ES3 (base language, sloppy-mode mapped arguments).
- **Fail count:** **12** failing `language/arguments-object/mapped/*` tests.
- Part of the ≤ES3 full-coverage goal (32 total ≤ES3 fails; this is the second
  largest ≤ES3 cluster after #2666).
- Residual after #1511 (arguments-object fidelity, done sprint 57) — the mapped
  argument <-> formal-parameter linkage and descriptor-redefinition path was
  improved but these `[[Delete]]` / non-configurable / non-writable cases still
  fail.

## Problem

In a sloppy-mode function, the `arguments` object is **mapped**: index
properties stay linked to the formal parameters. The spec requires:

- `Object.defineProperty(arguments, "0", {configurable: false})` must succeed,
  and a subsequent `delete arguments[0]` must return **false** (non-configurable
  → delete fails), leaving both `arguments[0]` and the formal `a` at their
  original value.
- Making a mapped property non-writable then deleting/redefining follows the
  mapped-arguments [[DefineOwnProperty]]/[[Delete]] algorithm (ES2015 9.4.4),
  including breaking the parameter map on redefinition.

Current behaviour throws `Cannot redefine property: 0` (runtime_error) or
returns the wrong `delete` result (assertion_fail).

## Failing-test cluster

```
language/arguments-object/mapped/mapped-arguments-nonconfigurable-delete-1.js .. -4.js
language/arguments-object/mapped/mapped-arguments-nonconfigurable-strict-delete-1.js .. -4.js
language/arguments-object/mapped/mapped-arguments-nonconfigurable-3.js
language/arguments-object/mapped/mapped-arguments-nonwritable-nonconfigurable-3.js / -4.js
language/arguments-object/mapped/mapped-arguments-nonconfigurable-nonwritable-5.js
```

Representative (`mapped-arguments-nonconfigurable-delete-1.js`, noStrict):
```js
function argumentsAndDelete(a) {
  Object.defineProperty(arguments, "0", {configurable: false});
  assert.sameValue(delete arguments[0], false);
  assert.sameValue(a, 1);
  assert.sameValue(arguments[0], 1);
}
argumentsAndDelete(1);
```

## Acceptance criteria

- All 12 listed `language/arguments-object/mapped/*` tests pass.
- `delete` on a non-configurable mapped index returns `false`; the value and the
  linked formal parameter are unchanged.
- No regression in the other (passing) arguments-object tests.

## Notes

- Builds on #1511. The fix is in the mapped-arguments exotic-object [[Delete]] /
  [[DefineOwnProperty]] implementation (configurability check before unmap).

## Resolution (2026-06-25)

The WasmGC-vec-backed mapped `arguments` object never modelled the
configurability/writability of its own index properties — `delete arguments[i]`
returned `true` even for a non-configurable index, and
`Object.defineProperty(arguments,"i",{value})` routed to the runtime
`Object.defineProperty` on the vec (which carries no matching sidecar
descriptor) and threw `Cannot redefine property: 0`.

Fixed by tracking per-index attribute state **at compile time** in
`fctx.mappedArgsInfo`, mirroring the existing `unmappedIndices` link-break set
(§10.4.4):

- `nonConfigurableIndices` — `delete arguments[i]` on such an index emits the
  spec `false` (OrdinaryDelete) without severing the param map
  (`src/codegen/typeof-delete.ts`).
- `nonWritableIndices` — `arguments[i] = x` on such an index is dropped
  (`src/codegen/expressions/assignment.ts`); also severs the param map.
- A pure-data `{value}` define on a still-configurable-or-writable mapped index
  is handled inline (`emitMappedArgValueDefine` in `src/codegen/object-ops.ts`):
  writes the vec slot and, when still mapped, the linked formal param. Truly
  frozen (non-configurable AND non-writable) slots fall through to the runtime
  for the spec TypeError.

These are populated by the statically-resolvable
`Object.defineProperty(arguments, "<literal>", {literal desc})` shape and read
live during body codegen (codegen order matters), exactly like `unmappedIndices`.

## Test Results (real test262 runner, `language/arguments-object/mapped`)

8 of the 12 listed cases now pass:
`mapped-arguments-nonconfigurable-delete-1..4`,
`mapped-arguments-nonconfigurable-3`,
`mapped-arguments-nonwritable-nonconfigurable-3` / `-4`,
`mapped-arguments-nonconfigurable-nonwritable-5`.
Category: 34 pass / 9 fail (was 26 pass). Covered by `tests/issue-2667.test.ts`.

**Carved out → #2676**: `mapped-arguments-nonconfigurable-strict-delete-1..4`
(4 tests). These do `var args = arguments; (function(){ "use strict"; delete
args[0]; })` — an *aliased* delete inside a *nested strict* function that must
throw a TypeError on a non-configurable index. That needs cross-function alias
tracking plus strict-mode delete-throws, a distinct and larger sub-problem than
the static per-index attribute path landed here.
