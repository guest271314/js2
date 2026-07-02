---
id: 2963
title: "Reify builtins as first-class values: retire the `__get_builtin` dynamic-shape CE cluster (~400 compile errors)"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: builtins
goal: standalone-mode
related: [1472, 2036, 2860, 2964]
origin: "2026-07-02 July Fable audit §3 cluster 5 (biggest standalone CE family; #1472 Phase-C refusal successor)"
---

# #2963 — reading a builtin as a value is a compile error standalone

## Problem

The standalone compile-error population (915) is dominated by builtins
used as **values** rather than called directly: `__get_builtin`
dynamic-shape refusals account for **295 CEs**, plus ~100 more for
builtin-method extraction (`Promise.resolve` passed as a function,
`Array.of` stored in a variable, `Symbol.matchAll` as a key,
`Atomics.waitAsync` feature-detection reads). Direct calls are lowered
natively; the _reference_ form has no standalone representation — the
sites refuse ("#1472 Phase C") or lean on the `__get_builtin` host import.

## Approach

1. **Inventory first**: harvest the exact builtin×usage-form matrix from
   the per-test CE data (the runner's error strings name the builtin) —
   the top ~15 builtins likely cover >80% of the cluster.
2. **Reify on demand**: for each referenced builtin, synthesize (once per
   module, lazily) a `$Object`-backed callable — a closure wrapping the
   existing native lowering, registered with correct `name`/`length` own
   properties — and return that as the value. Method extraction
   (`const r = Promise.resolve; r(1)`) then works through the normal
   closure call path.
3. **Identity**: the same builtin reference must yield the same object
   (`Promise.resolve === Promise.resolve`) — module-level singleton slot
   per reified builtin (instance-carried identity, June audit D4 rule).
4. Feature-detection reads (`typeof Atomics.waitAsync`) must not CE — an
   absent builtin reads as `undefined`.

## Acceptance criteria

- `const r = Promise.resolve; r(5).then(...)` and `[1,2].map(Number)`
  compile and run host-free.
- `__get_builtin` CE count (295) driven to ~0 on the standalone lane;
  before/after recorded.
- Reified identity stable within a module; no new host imports.
