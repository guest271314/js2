---
id: 2514
title: "Runtime helpers (number_toString, string/array/GC helpers) as a shared linkable module — blocked on WasmGC cross-module type identity"
status: backlog
sprint: Backlog
created: 2026-06-19
updated: 2026-06-19
priority: medium
feasibility: hard
reasoning_effort: high
task_type: architecture
area: codegen
language_feature: runtime-helpers
goal: architecture
related: [2512, 1046]
blocked_by: external
---

## Problem / proposal

js2wasm emits its runtime helpers — `number_toString`, `__str_concat`, native
string/array/vec helpers, boxing helpers, GC struct accessors, etc. — **inline
into every compiled module** (each only when used, via DCE). Across multiple
compiled modules this duplicates the same helper code.

Proposal: compile the runtime helpers once into a shared `runtime.wasm` and have
user modules **import** them, instead of re-emitting per module.

## The blocker: WasmGC nominal cross-module type identity

Most of these helpers produce or consume **GC objects** (our strings, vecs,
boxed values are WasmGC structs/arrays). WasmGC types are matched per-module: a
String struct defined in `runtime.wasm` and a String struct defined in the user
module are treated as **different types** even when their layout is identical,
because identity is by declaring rec-group/canonicalization, not just structure.
So a helper in a separate module that returns a String cannot hand it back across
the module boundary — the type check fails.

Plain-English framing: two factories build a Widget from identical blueprints but
each stamps its own brand; a machine that accepts "Acme Widgets" rejects an
identical "Beta Widget" because it checks the brand. To interchange them, both
modules must reference **one shared canonical type definition** (shared rec
groups / a common type section), which the toolchain and the Component Model do
not yet coordinate for GC types. This is exactly why the helpers are inlined
today (so the GC types are always module-local and always match).

Contrast: scalar (`i32`/`f64`) and linear-memory (pointer + length) values have
**no identity**, so helpers that only pass those across the boundary are not
blocked — those could be split first.

## Scope / phasing

- Phase 0 (research, architect): survey the state of WasmGC cross-module type
  sharing (shared rec groups, canonical types, Component Model GC ABI) and decide
  whether a shared-runtime module is feasible yet for GC-typed helpers.
- Phase 1 (tractable now): factor out **non-GC** helpers — value-typed /
  memory-based — into a shared module behind a stable interface.
- Phase 2 (blocked): GC-typed helpers (string/array/boxed), pending a
  cross-module GC type-identity mechanism.

## Open questions (route to architect)

- Is there a usable shared-rec-group / canonical-type story in current Binaryen +
  wasmtime + the GC/Component-Model toolchain, or is this strictly future?
- Does linear-memory string backend (`--nativeStrings` / linear target) change
  the calculus (memory-typed strings have no GC identity problem)?
- Dedup payoff is multi-module; quantify against a representative multi-module app
  before investing.

## Notes

Split from #2512 (Node host APIs as separate modules). Same overall direction
("don't inline everything"), but a different blocker: #2512 is byte/scalar-typed
and tractable now; this one is GC-typed and gated on cross-module type identity.
Surfaced while investigating loopdive/js2#389.
