---
id: 1665
title: "host-indep: Wasm-native generators (retire __gen_* / __create_generator host scheduler)"
status: ready
created: 2026-05-25
priority: medium
feasibility: hard
task_type: feature
area: codegen, standalone
language_feature: generators, iterators
goal: standalone-mode
sprint: Backlog
related: [1662, 1376, 1103]
---
# #1665 — Wasm-native generators for standalone mode

## Problem

`function*` generators (and `for-of` over them) emit a large family of
JS-host scheduler imports under `--target wasi`:

```
env.__gen_create_buffer, env.__gen_push_f64, env.__gen_push_i32,
env.__create_generator, env.__create_async_generator, env.__gen_throw,
env.__get_caught_exception,
env.__iterator, env.__iterator_next, env.__iterator_done,
env.__iterator_value, env.__iterator_return
```

Probe (`.tmp/probes/generator.ts`):
```ts
function* gen() { yield 1; yield 2; }
export function test(): number { let s = 0; for (const x of gen()) s += x; return s; }
```
→ all twelve imports above; the module also fails WASM validation (#1666).

The allowlist entries for `__gen_` / `__create_generator` /
`__create_async_generator` (lines 273–291) cite **#1376**, but #1376 is the
*IR fallback telemetry gate* (done) — it tracks generators as an IR
*fallback*, not a native-implementation issue. There is no issue that owns a
**Wasm-native generator engine**. This issue fills that ownership gap.

## Standalone alternative

Generators are coroutines. Two viable lowerings without a JS host:

1. **State-machine transform (preferred, no proposal dependency)** — lower a
   generator body to a switch over a `state: i32` field stored in a WasmGC
   `$GeneratorState` struct: each `yield` is a state checkpoint that saves
   live locals into struct fields and returns; `next()` re-enters the switch
   at the saved state. This is the classic Babel/regenerator approach,
   expressed in WasmGC. No host scheduler, no stack-switching proposal.
2. **Wasm stack-switching proposal** (`cont`/`resume`) — cleaner but the
   proposal is not yet broadly shipping; defer.

The iterator-protocol helpers (`__iterator*`) are shared with #1664 and
#1103 (for-of over Map/Set) — a native `$Iterator` interface (a WasmGC
struct with a `next` funcref returning a `{value, done}` struct) lets
for-of, generators, and collection iteration all share one native path.
`__get_caught_exception` is owned by #1473 (landed) but reappears here via
the generator `throw()` path.

## Acceptance criteria

- [ ] The generator probe emits **zero** `__gen_*` / `__create_generator*`
      / `__iterator*` imports under `--target wasi` / `--target standalone`,
      and the module validates (coordinate with #1666).
- [ ] `for (const x of gen()) s += x` yields `s === 3` standalone.
- [ ] `gen().next()` returns `{value:1, done:false}` then `{value:2,…}` then
      `{value:undefined, done:true}`.
- [ ] `yield*` delegation works standalone (separate phase acceptable).
- [ ] async generators may remain deferred (document; out of standalone
      scope short-term per the IR fallback "deferred" bucket).
- [ ] Remove `__gen_*` / `__create_generator*` allowlist entries on landing.

## Files

- `src/codegen/closures.ts` / generator lowering (search `__create_generator`).
- New `src/codegen/wasm-helpers/generator-state.ts` — `$GeneratorState`
  struct + native iterator interface.
- `src/codegen/host-import-allowlist.ts`.
