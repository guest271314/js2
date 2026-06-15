---
id: 2157
title: "Standalone iterator/generator conformance residual (~1,200 tests beyond #2079)"
status: ready
sprint: 62
created: 2026-06-15
updated: 2026-06-15
priority: critical
feasibility: hard
reasoning_effort: high
task_type: conformance
area: standalone
language_feature: iterators-generators
goal: standalone-mode
parent: 1665
depends_on: [2079, 1899]
---

# Standalone iterator/generator conformance residual

## Problem

The pure-Wasm iterator protocol and native generators landed across #680,
#1665, #681, #1718 (all `done`, sprints 58–61). But a host-vs-standalone
test262 baseline diff (`loopdive/js2wasm-baselines`, sha `31fa7e099`,
generated 2026-06-15) shows the **single largest catch-up bucket**: **2,172
tests pass in JS-host mode but fail standalone**, attributed to iterator /
generator machinery.

`#2079` (standalone generators funcindex CE) accounts for ~960 of these via
the late-import index-shift compile error. **This issue tracks the remaining
~1,200** — runtime/iterator-protocol divergences not explained by the
funcindex CE.

## Evidence

- Audit leak classes in the gap: `iterator_protocol` 2,057, plus generator
  host imports (`__gen_next`, `__gen_create_buffer`, `__create_generator`,
  `__create_async_generator`, `__gen_yield_star`, `__array_from_iter_n`).
- Mechanism split: heavy on `compile_error` (funcindex, captured by #2079)
  plus runtime `fail` (spread/for-of/destructuring over user iterators
  returning wrong values).

## Acceptance criteria

- Standalone pass count for `built-ins/Iterator`, `built-ins/GeneratorPrototype`,
  and generator/spread/for-of language tests rises toward host parity.
- No `iterator_protocol` host-import leak remains in standalone mode for the
  covered cases.
- Repros from the gap diff added as standalone equivalence tests.

## Notes

Parent (done): #1665. Sequenced after #2079 + #1899 (funcidx authority).
Part of sprint-62 standalone catch-up (rank 1 by gap impact).
