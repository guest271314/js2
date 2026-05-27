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

## Senior-dev analysis (2026-05-25) — STOP: spec/design gap, not an impl pass

A senior-dev pass mapped the existing model end-to-end before coding. The
conclusion is that the *smallest coherent slice* cannot land as an isolated
implementation pass without either colliding with in-flight #1664 or baking
wrong semantics into standalone mode. Escalated to tech-lead for a shared
`$Iterator` design decision. Findings:

### How generators are lowered today (the model is already EAGER)

- `closures.ts:2067` — a `function*` body is **run to completion at
  creation time**, inside a try/catch. It is NOT a coroutine/state machine.
- Each `yield v` (`expressions/misc.ts:162`) pushes `v` into a host JS array
  via `__gen_push_f64` / `__gen_push_i32` / `__gen_push_ref` (`runtime.ts:5652`).
  `__gen_create_buffer` returns `[]`. A 1M-yield `__EAGER_GEN_LIMIT` guard
  caps it.
- `__create_generator(buf, pendingThrow)` (`runtime.ts:5685`) wraps
  `{buf, index, pendingThrow}` into an object on `%GeneratorPrototype%`.
- `for-of` (`statements/loops.ts:3314-3465`) and `.next()` walk it via the
  polymorphic host helpers `__iterator` / `__iterator_next` /
  `__iterator_done` / `__iterator_value` / `__iterator_return`
  (`runtime.ts:5762-5906`).

### Why a native slice IS structurally buildable (the good news)

The precedent exists: `addUnionImportsAsNativeFuncs` (`index.ts:6404`, gated
on `ctx.wasi || ctx.standalone`) already emits **native** `__box_number` /
`__unbox_number` as a `$box_number` WasmGC struct + `extern.convert_any`, no
host. So a native eager buffer is feasible: a `$Generator` struct
`{ items: (array (mut anyref)), len: i32, index: i32 }`, native
`__gen_push_*` that box-and-append, native `__create_generator` as identity,
and native `__iterator*` that read the struct when the operand is a
`$Generator`.

### Why it must NOT land as #1665-only (the stop reasons)

1. **`__iterator*` is a shared polymorphic dispatcher, co-owned by #1664 /
   #1103.** A native `__iterator_next` cannot assume `$Generator` — in
   standalone it must also serve arrays, Map/Set, native-string iterators,
   and user `[Symbol.iterator]` structs. The issue text itself (lines 56-62)
   calls for a **shared native `$Iterator` interface** for exactly this.
   #1664 line 56-59 *depends on #1665* for that native iterator
   ("a WasmGC loop calling the iterator protocol helpers (which themselves
   must be native — see #1665)"). #1664 is **in-flight** (`origin/issue-1664`,
   task #91). Building a generator-only `__iterator*` here would either be
   non-reusable (forcing a #1664 rewrite) or require designing the full
   polymorphic discriminator now — the "more design than one pass" line.

2. **The eager model is semantically wrong and would be enshrined.** Running
   the body at creation time mis-handles any generator with an unbounded loop
   or observable interleaved side effects (it runs to completion / hits the
   1M guard up front). The issue's own preferred lowering is the
   state-machine transform precisely to fix this. Shipping a *native eager*
   buffer would make standalone generators silently wrong — worse than the
   current honest host-import leak.

3. **#1666 (invalid-wasm) is an unfixed hard prerequisite.** The audit (#1662)
   shows the generator probe emits **invalid Wasm today**, before the import
   question. Both #1664 and #1665 list "resolve #1666 first." Native lowering
   must land on a module that validates.

### Recommended decomposition (needs architect + tech-lead decision)

- **#1665a (shared, architect-owned):** design + build a single native
  `$Iterator` interface (struct with a `next` funcref returning a
  `{value:anyref, done:i32}` struct) reused by generators, for-of, Map/Set
  (#1103), and `__array_from_iter` (#1664). This is the missing shared
  artifact none of #1664/#1665/#1103 currently owns.
- **#1665b:** native eager `$Generator` buffer on top of #1665a (acceptable
  *only* if the eager-semantics limitation is explicitly documented and
  scoped to the basic slice), OR
- **#1665c (preferred long-term):** state-machine / CPS lowering so
  generators are true coroutines — large, depends on the IR async/CPS work
  (#1373b / #1042).
- All of the above gated on **#1666** landing first.
