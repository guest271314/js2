---
id: 2953
title: "Close the BackendEmitter pushRaw gap: route unions/closures/refcells/coercions/null/funcref through the trait"
status: in-progress
assignee: ttraenkler/opus-1a
branch: agent/2953-unions-boxing
pr: 3108
sprint: current
created: 2026-07-02
updated: 2026-07-16
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
loc-budget-allow:
  - src/ir/lower.ts
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

## Slice progress (one PR per family)

- [x] **(a5) ref-cell family** — `emitRefCellNew`/`emitRefCellGet`/`emitRefCellSet`
  promoted from declared-optional to REQUIRED on `BackendEmitter`, implemented
  byte-identically on `WasmGcEmitter` (struct.new / struct.get / struct.set over
  the cell's typeIdx/fieldIdx), stubbed (`notImplemented`/throw) on Linear +
  Bytecode emitters, and the 3 `refcell.new/get/set` pushRaw sites in `lower.ts`
  converted to trait calls. pushRaw in lower.ts: 77 → 74. Golden-Instr unit
  coverage added (`tests/ir-backend-emitter.test.ts`); cross-backend + closure
  runtime suites green. (opus-1a)
- [x] **(a6) unions/boxing** (`emitBox`/`emitUnbox`/`emitTagLoad`) —
  `emitBox` now receives the already-lowered value in a dedicated backend sink,
  allowing `WasmGcEmitter` to synthesize the canonical tag and append tag/value
  in layout field order before `struct.new`. Unbox and tag loads route through
  typed primitives; tag constants/comparisons use existing typed core methods.
  Backends without a union representation fail through legality/missing-hook
  errors, with no raw Wasm fallback. `emitter.pushRaw` sites in `lower.ts`:
  104 → 98. Golden union lowering stayed instruction-identical, and the emitted
  Wasm oracle matched clean main for all 56 `(file,target)` records across gc,
  standalone, wasi, and linear. (ttraenkler/codex-2953-unions-boxing)
- [ ] closures (`emitClosureNew`/`emitClosureFuncGet`/`emitCaptureGet`)
- [ ] coercions/null (`emitNull`/`emitToExternref`/`emitFromExternref`)
- [ ] funcref (`emitFuncRef`)
- [ ] Promise ops
- [ ] ratchet: pushRaw count check + `// pushraw-ok(#issue)` justification tag

## 2026-07-16 — unions/boxing slice results

- Re-grounded against `main` at `398c59e6c418306b86b14e5ceab41c0ad8e7d37e`;
  the current seam uses generic backend sinks and optional representation hooks,
  rather than the older string-emission shape described by stale line numbers.
- Implemented `WasmGcEmitter.emitBox`, `emitUnbox`, and `emitTagLoad`. The box
  primitive owns `IrUnionLowering.tagFor(member)` and field ordering; lowering
  owns operand evaluation and passes its emitted sink to the backend.
- Kept `linear-emitter.ts`, `linear-integration.ts`, `codegen-linear/**`, and
  #2956-specific tests untouched. Linear/Bytecode union nodes are rejected by
  backend legality; a focused test locks the Linear loud-failure boundary.
- Focused verification:
  `pnpm vitest run tests/issue-2953-unions-boxing.test.ts tests/ir-backend-emitter.test.ts tests/ir-frontend-widening.test.ts tests/ir/phase3c.test.ts`
  (51 tests passed), plus `pnpm run typecheck`.
- Byte identity: `scripts/prove-emit-identity.mjs` was run against a detached
  clean-main baseline via Vite's TypeScript loader because `tsx` is not installed
  in this checkout. Result: `IDENTICAL — all 56 (file,target) emits match baseline`.
