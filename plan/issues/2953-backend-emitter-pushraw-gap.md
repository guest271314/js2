---
id: 2953
title: "Close the BackendEmitter pushRaw gap: route unions/closures/refcells/coercions/null/funcref through the trait"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [1852, 1713, 2954, 2956, 2949]
origin: "2026-07-02 July Fable audit §5 (77 pushRaw sites; #1852-G1 slice text had no issue)"
---

# #2953 — 40% of IR lowering bypasses the backend trait

## Problem

`src/ir/lower.ts` makes ~59 typed `emitter.*` calls but has **77 `pushRaw`
escape-hatch sites** pushing raw WasmGC-shaped instructions directly:
unions (`struct.new` at lower.ts:1053), closures (:1196), refcells (:1266),
Promises (:2149, :2167), `ref.cast` (:1212), plus `null`/externref
coercions and funcref materialization. The corresponding trait methods
(`emitBox`/`emitUnbox`/`emitTagLoad`, `emitNull`, externref coercions,
`emitFuncRef`, closure/refcell ops — `src/ir/backend/emitter.ts:155-174`)
are declared-optional and **unimplemented even on WasmGcEmitter**. Every
raw site is a hole in the "backends differ only at lowering" seam and a
blocker for any second backend consuming these families (#2954/#2956), and
for #2949's dynamic-value lowering contract.

This is #1852-G1 in the value-rep spec's slice list — never filed.

## Approach

Pure refactor, one PR per family (unions/boxing → closures → refcells →
coercions/null → funcref → Promise ops):

1. Implement the declared-optional methods on `WasmGcEmitter` emitting
   **byte-identical** sequences to today's raw pushes.
2. Convert the family's pushRaw sites to trait calls.
3. Guard with the existing byte-identity corpus diff (the #2138 flag-off
   harness pattern) + equivalence suite.
4. Ratchet: add a lint/count check so new pushRaw sites need a
   `// pushraw-ok(#issue)` justification tag; record the count in the
   ratchet dashboard.

Loop/try/await trait bypass (lower.ts:300-333) is **out of scope** here —
that's control-flow-shaped and lands with #2952/#1373b; this issue is the
value/aggregate families.

## Acceptance criteria

- pushRaw count in lower.ts reduced from 77 to the justified residue
  (target ≤ 15, each tagged), enforced by the new count check.
- Byte-identical output on the 233-file corpus; equivalence green.
- `emitBox`/`emitUnbox`/`emitTagLoad`/`emitNull`/`emitFuncRef` + closure
  and refcell methods implemented on WasmGcEmitter with unit coverage.
