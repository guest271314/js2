---
name: project-wasm-linking-core-over-component
description: "Modularizing js2wasm host-API shims / shared runtime — use core-wasm linking (#2527), not the Component Model (#2525); GC cross-module identity is already there via runtime canonicalization"
metadata: 
  node_type: memory
  type: project
  originSessionId: fab8c15e-42ba-4dae-b2f8-dc6dcc1155b9
---

For factoring js2wasm's inlined-per-module code into shared/linkable modules
(host-API shims #2512; shared runtime helpers like `number_toString`/string/vec
GC helpers #2514), the decided mechanism is **core-wasm module linking in a
shared store** (#2527, implement first) — **not** the Component Model (#2525,
deferred).

Key fact (corrects an earlier "GC sharing is blocked" mis-framing): **WasmGC is
structural-with-canonicalization** — shipped runtimes (e.g. V8) canonicalize
structurally-identical rec groups from separately-compiled modules into one
runtime type. So two core modules sharing the **same frozen canonical rec group**
exchange GC objects **zero-copy, same type** — cross-module GC identity is already
provided by the engine, not a standards gap. The remaining work is ABI
engineering: freeze a versioned canonical rec group and keep Binaryen (`wasm-opt`)
from reordering/merging it (which would break canonical equality).

Why NOT the Component Model for the GC runtime: its **Canonical ABI copies**
values across the component boundary and doesn't pass core GC objects — fine for
the byte/scalar host-API boundary (#2512, where WIT worlds embedded in the
`component-type` custom section are the clean declared-dependency mechanism), but
it would copy the GC strings/vecs and defeat zero-copy sharing for #2514. See
[[project_toprimitive_nominal_struct_gap]] is unrelated; relevant issues: #2512,
#2514, #2527 (core, chosen), #2525 (component, deferred), #2528 (web/node target).
