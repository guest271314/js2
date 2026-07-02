---
id: 2970
title: "codegen: import.meta is not a distinct per-module object (identity shared/absent across modules)"
status: ready
priority: medium
sprint: Backlog
created: 2026-07-02
feasibility: medium
task_type: bug
area: codegen
language_feature: module-code
goal: spec-completeness
related: [2932]
---

# #2970 — `import.meta` per-module object identity

Split from #2932's honest-regression bucket. Exposed when `.js` fixture
modules started compiling for real (#2932): the baseline "pass" was the
null-import artifact.

## Failing test

`test/language/expressions/import.meta/distinct-for-each-module.js`

The test imports `{ meta as fixture_meta, getMeta }` from a fixture module and
asserts:

1. `import.meta !== fixture_meta` (each module gets its own object),
2. `import.meta !== getMeta()` (a function returns the `import.meta` of the
   module it is declared in),
3. `fixture_meta === getMeta()` (stable identity within one module).

## Spec

sec-meta-properties-runtime-semantics-evaluation — `module.[[ImportMeta]]` is
created once per module record and cached; distinct module records have
distinct objects.

## Direction

Multi-file compiles need a per-source-file `import.meta` object (lazily
created singleton per module, e.g. one immutable extern/struct global per
compiled module unit), not a shared or absent value.

## Acceptance

- `distinct-for-each-module.js` passes via the test262 runner.
- Identity is stable within a module and distinct across modules.
