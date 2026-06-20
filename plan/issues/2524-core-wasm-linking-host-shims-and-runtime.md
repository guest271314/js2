---
id: 2524
title: "Core-wasm module linking (shared store + canonical rec-group) for host-API shims and the shared runtime — CHOSEN approach"
status: ready
sprint: Backlog
created: 2026-06-20
updated: 2026-06-20
priority: medium
feasibility: hard
reasoning_effort: high
task_type: architecture
area: codegen
language_feature: module-linking
goal: architecture
related: [2512, 2514, 2525, 2523]
---

## Decision

For modularizing both the **host-API shims** (#2512: process/fs/… as separately
compiled, link-on-demand modules) and the **shared runtime helpers** (#2514:
`number_toString`, string/vec/GC helpers), use **core-wasm module linking in a
shared store** — NOT the Component Model (tracked separately as the deferred
alternative in #2525). **Implement this version first.**

## Why core linking (the key fact)

WasmGC is **structural with canonicalization**: the engine canonicalizes
structurally-identical rec groups from separately-compiled modules into a single
runtime type (e.g. V8 maps every module's types into one global canonical index).
So two core modules that declare the **same** `String`/`Vec`/boxed rec group and
exchange those objects across a shared import/export get the **same** type —
**direct, zero-copy GC sharing**. The cross-module type identity we need is
**already provided by shipped runtimes**; this is an ABI engineering project, not
a standards gap.

The Component Model's Canonical ABI, by contrast, **copies** values across a
component boundary and does not hand core GC objects across — so it cannot give a
zero-copy shared GC runtime (it's fine for the byte-typed host-API boundary, but
that's the lesser win). Hence: core linking here.

## Shape

- A shared **`runtime.wasm`** (and per-host shim modules, e.g. `node-shim.wasm`
  over WASI, `deno-shim.wasm`) instantiated into the **same store** as the user
  module, sharing memory/tables/types.
- The user module declares its dependency the standard way: **core wasm imports**
  (`(import "js2wasm:runtime" "number_toString" (func …))`,
  `(import "node:io" "process_read" (func …))`). The import module-name + field
  *is* the in-wasm dependency declaration; a linker resolves it to the shim.
- A **frozen, versioned canonical rec group** (#2514) shared by `runtime.wasm`
  and every user module, so the GC types canonicalize to identity. Helpers pass
  GC objects directly; host-API shims pass bytes/scalars (no identity concern).

## Risks / work (the crux)

1. **Binaryen must preserve the canonical rec group verbatim** — `wasm-opt`
   merges/reorders types, which breaks canonical equality. Pin or post-process.
2. ABI versioning + distribution of `runtime.wasm` / shim modules.
3. Linking mechanism: plain multi-module instantiation in one store vs
   **shared-everything dynamic linking**
   (<https://github.com/WebAssembly/component-model/blob/main/design/mvp/examples/SharedEverythingDynamicLinking.md>)
   for the `.so`-style memory/table sharing. (Note: that design is linear-memory
   oriented; the GC-type sharing rides on engine canonicalization, separate from
   it.)

## Scope / phasing

- Phase 0: prove the canonical rec group canonicalizes across two
  separately-compiled js2wasm modules on the target engines (V8 + wasmtime), and
  that Binaryen can be made to preserve it.
- Phase 1: host-API shims (#2512) — byte/scalar boundary, simplest.
- Phase 2: shared runtime helpers (#2514) — GC boundary, on the canonical rec
  group.

## Notes

Split from the #389-driven modularization discussion. The Component Model + WIT
alternative is #2525 (deferred). Corrects an earlier framing that called GC
cross-module sharing "blocked" — it is not; runtimes canonicalize identical
structs.
