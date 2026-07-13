---
id: 3034
title: "IR-equivalence vitest harness stubs env imports non-callable (__unbox_number)"
status: done
completed: 2026-07-04
assignee: ttraenkler/opus-2161b1
sprint: 71
created: 2026-07-04
priority: medium
feasibility: easy
task_type: test-infra
area: testing
language_feature: none
goal: ir-migration
---

# IR-equivalence vitest harness stubs env imports non-callable

## Problem

The four IR-path equivalence suites —
`tests/ir-numeric-bool-equivalence.test.ts`,
`tests/ir-if-else-equivalence.test.ts`,
`tests/ir-let-const-equivalence.test.ts`,
`tests/ir-ternary-equivalence.test.ts` (~73 tests total) — **fail on current
main** with:

```
WebAssembly.instantiate(): Import #0 "env" "__unbox_number":
function import requires a callable
```

Each suite compiles the same source twice (legacy vs `experimentalIR: true`)
and instantiates both binaries against a **hand-rolled** import object:

```js
const ENV = { env: { console_log_number: () => {}, console_log_string: () => {}, console_log_bool: () => {} } };
```

That stub only provides the three `console_log_*` functions. The compiled
binaries (host mode, `nativeStrings: true`) also import the union helpers
`env::__unbox_number` / `env::__box_number`, which `ENV` does not supply — so
`env.__unbox_number` is `undefined` (not callable) and instantiation throws
before any assertion runs.

This is **purely a local-test-infra gap**, NOT a codegen bug: the CI
equivalence shards use the real runtime import builder
(`buildImports` from `src/runtime.ts`) and PASS. The stale local stub has been
masking real IR-equivalence signal and adding red noise to every local
`vitest` run.

## Fix

Replace the hand-rolled `ENV` in all four suites with the canonical
`buildImports(result.imports, undefined, result.stringPool)` — the same builder
`tests/test262-runner.ts` and `src/index.ts` use. It resolves each import by its
`intent` metadata (`__unbox_number` → the `unbox`/`number` ToNumber funnel,
`__box_number` → the `box`/`number` identity), and still provides the
`console_log_*` stubs, so both the legacy and IR binaries instantiate with a
correct, per-binary import object.

No assertion changed — the suites already compared legacy-vs-IR return values;
they simply could not instantiate. All ~73 tests flip FAIL → PASS.

## Acceptance criteria

- `tests/ir-{numeric-bool,if-else,let-const,ternary}-equivalence.test.ts` all
  pass locally with zero assertion changes.
- No codegen / `src/` change (test-infra only).
