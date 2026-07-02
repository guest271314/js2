---
id: 2997
title: "Migrate legacy Wasm EH (try/catch 0x06/0x07) to try_table so binaries run under modern wasmtime/wasmer"
status: ready
sprint: Backlog
created: 2026-07-02
priority: medium
horizon: xl
feasibility: hard
task_type: refactor
area: codegen
language_feature: exceptions
goal: standalone-mode
related: [2968, 2962, 1473]
origin: "follow-up filed from #2968 wrap-up (wasmtime rejects legacy EH opcodes)"
---

# Migrate legacy Wasm exception-handling opcodes to `try_table`

## Problem

The compiler emits the **legacy** Wasm exception-handling encoding — `try`
(`0x06`), `catch` (`0x07`), `catch_all`, `delegate`, `rethrow` — from the first
(withdrawn) exception-handling proposal. V8/Node and the #2962 exception-render
harness accept these opcodes, but **modern wasmtime (46+) rejects them**:

```
Error: WebAssembly translation error
Caused by: Invalid input WebAssembly code ... legacy_exceptions feature
required for try instruction
```

wasmtime (and wasmer) implement only the **standardized** exception-handling
proposal, which replaces the legacy stack-structured `try/catch` with
`try_table` (`0x1F`) + `throw_ref`. As a result, **any** js2wasm binary that
uses `try/catch` — whether a user-written `try { … } catch { … }`, or the
`_start` uncaught-exception wrapper added in #2968 — fails to even validate
under a current standalone WASI runtime.

This is a **compiler-wide gap**, not specific to any single feature. It was
surfaced while wrapping up #2968 (WASI `_start` exception printer): that fix is
correct and validated under `node:wasi`, but its acceptance criterion mentioned
wasmtime specifically, and wasmtime can't load the binary because of this
pre-existing legacy-EH encoding — identical to how an ordinary user `try/catch`
already fails under wasmtime on clean `origin/main`.

## Scope

Migrating from legacy EH to `try_table` is not a localized change — it touches
every place the instruction tree is produced, encoded, or walked:

- **Emitter / encoder** — the opcode encoding for `try`/`catch`/`catch_all`/
  `delegate`/`rethrow` must be replaced with `try_table` (which takes an inline
  block type + a vector of catch clauses, each `(tag, label)` / `catch_all`),
  and `throw` handling reworked to the `throw` / `throw_ref` model. The
  structured `try`/`end` block nesting changes to a single `try_table` block
  whose body branches to handler labels.
- **Instruction-tree walkers** — every pass that traverses or rewrites the
  instruction tree and currently special-cases the legacy `try`/`catch`
  structure: dead-code elimination / index remapping, the funcidx-shift fixups
  (`addUnionImports` / late-import shifting), stack-balance validation, and the
  WAT pretty-printer / disassembler.
- **Control-flow / label model** — legacy `catch` is a stack-structured landing
  pad; `try_table` catch clauses branch to ordinary block labels, so the label
  map and branch-depth accounting must account for the catch-target labels.

Because of that breadth this is a **hard, XL** refactor and needs a proper
architect spec before implementation — do **not** attempt it as an inline fix.

## Acceptance criteria

- The compiler emits `try_table` (+ `throw`/`throw_ref`) instead of legacy
  `try`/`catch`/`catch_all`/`delegate`/`rethrow`.
- A `--target wasi` binary using `try/catch` (and the #2968 `_start` wrapper)
  **validates and runs under wasmtime 46+**, printing the expected stderr and
  exiting nonzero on an uncaught throw.
- V8/Node execution and the #2962 exception-render harness remain correct
  (no regression in host or standalone lanes); test262 conformance is unchanged
  or improved.

## Notes

- Needs an architect spec (functions, exact opcode encodings, the catch-clause
  label lowering, and the pass-by-pass walker changes) before dev work.
- Reference: the WebAssembly exception-handling proposal (`try_table` /
  `throw_ref`) and wasmtime's `legacy_exceptions` gate.
