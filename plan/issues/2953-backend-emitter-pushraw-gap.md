---
id: 2953
title: "Close the BackendEmitter pushRaw gap: route unions/closures/refcells/coercions/null/funcref through the trait"
status: in-progress
assignee: ttraenkler/opus-1a
branch: symphony/porffor/2953-after-3129
pr: 3134
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
claimed_by: porffor-codex-developer
claimed_at: 2026-07-16T13:41:17.751Z
last_merged_pr: 3129
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
- [x] **closures** (`emitClosureNew`/`emitClosureFuncGet`/`emitCaptureGet`) —
      promoted from declared-optional to required on `BackendEmitter`, implemented
      byte-identically on `WasmGcEmitter` (`struct.new` for construction and the
      canonical `struct.get` fields for function/capture reads), and stubbed loudly
      on Linear + Bytecode until their closure representations land. The 3 closure
      aggregate `pushRaw` sites now use the trait, reducing `emitter.pushRaw` calls
      in `lower.ts` from 98 to 95. The existing `ref.func` and `ref.cast` sites stay
      in their dependency-ordered funcref/coercion slices. Golden emitter tests,
      the 31-case IR closure suite, cross-backend proof, equivalence gate, and the
      56-record byte oracle are green. (porffor-codex-developer)
- [x] **coercions/null** (`emitNull`/`emitToExternref`/`emitFromExternref`) —
      promoted the three reserved hooks to required, sink-generic primitives and
      restored the audited `emitDowncast` seam for non-extern reference narrowing.
      `WasmGcEmitter` now owns typed `ref.null*`, `extern.convert_any`, and the
      canonical `any.convert_extern` + `ref.cast` sequence; Linear + Bytecode fail
      loudly until their nullable/reference representations land. Const-null,
      generator bridges, closure casts, mode-aware `coerce.to_externref`, and the
      coercion/null portions of Promise construction/await now use the trait. This
      reduces `emitter.pushRaw` calls in `lower.ts` from 95 to 86; Promise aggregate
      allocation/field ops remain for their dedicated slice. Golden emitter tests,
      closure + cross-backend suites, equivalence, and the 56-record byte oracle
      are green. (porffor-codex-developer)
- [x] **funcref** (`emitFuncRef`) — promoted the optional, `Instr[]`-specific
      hook to a required sink-generic primitive. `WasmGcEmitter` materializes
      the resolved function index with the canonical `ref.func`; Linear and
      Bytecode fail loudly until their table/VM-callable handle representations
      land. The sole raw `ref.func` in `closure.new` now routes through the
      trait, reducing `emitter.pushRaw` calls in `lower.ts` from 86 to 85.
      Golden emitter coverage, closure + cross-backend suites, typecheck,
      equivalence, and the 56-record byte oracle are green.
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

## 2026-07-16 — closure slice results

- Re-grounded and fast-forwarded to `origin/main` at
  `b2b30a02336c1cf6deaa8941a383598ead35d586` before implementation.
- Made the three closure aggregate hooks required and sink-generic. Lowering
  continues to own evaluation order: it emits the lifted `ref.func`, captures,
  and subtype/typed-funcref casts in the same positions, while the backend owns
  only the terminal closure allocation or field read. Linear and Bytecode
  implementations throw instead of falling through to WasmGC-shaped raw ops.
- Added Golden-Instr coverage for closure construction, function-field reads,
  and capture-index mapping in `tests/ir-backend-emitter.test.ts`.
- Focused verification:
  `pnpm vitest run tests/ir-backend-emitter.test.ts tests/issue-1169c.test.ts tests/ir-bytecode-proof.test.ts`
  (69 tests passed), plus `pnpm run typecheck`, focused Biome + Prettier checks,
  and `pnpm run test:equivalence:gate`.
- Byte identity: bundled the existing `scripts/prove-emit-identity.mjs` harness
  with esbuild because `tsx` is absent, captured the pre-edit baseline, and
  checked the edited compiler against it. Result:
  `IDENTICAL — all 56 (file,target) emits match baseline`.
- Slice acceptance: complete. The parent issue intentionally remains
  `in-progress` for coercions/null, funcref, Promise ops, and the pushRaw
  justification ratchet.

## 2026-07-16 — coercions/null slice results

- Re-grounded and fast-forwarded to `origin/main` at
  `d2cb1922bdd7eb306f73ca98729c77aab0c7d227` before implementation.
- Made `emitNull`, `emitToExternref`, and `emitFromExternref` required and
  generic over the backend sink. Added the original #1713 audit's
  `emitDowncast` hook so closure subtype/funcref narrowing also leaves
  `pushRaw`; `emitFromExternref` composes conversion + narrowing in canonical
  Wasm order. Operand evaluation and the host/native-string externref no-op
  decision remain in shared lowering.
- Routed all matching `lower.ts` sites, including typed const-null,
  `gen.epilogue`, reference-shaped `gen.setReturn`, `coerce.to_externref`, the
  null/extern conversion edges around Promise allocation, and await's external
  Promise cast. Promise struct allocation and state/value field access remain
  untouched for the later Promise-ops slice.
- Added Golden-Instr coverage for typed nulls, to/from-externref, standalone
  downcasts, and the const-null delegation in
  `tests/ir-backend-emitter.test.ts`.
- Focused verification:
  `pnpm vitest run tests/ir-backend-emitter.test.ts tests/issue-1169c.test.ts tests/ir-bytecode-proof.test.ts`
  (74 tests passed), plus `pnpm run typecheck`, the coercion-site and test262
  hard-error quality gates, and `pnpm run test:equivalence:gate` (1,607 passing,
  36 known baseline failures, zero new regressions).
- Byte identity: bundled the existing `scripts/prove-emit-identity.mjs` harness
  with esbuild because `tsx` is absent, captured the pre-edit baseline, and
  compared the edited compiler against it. Result:
  `IDENTICAL — all 56 (file,target) emits match baseline`.
- Slice acceptance: complete. The parent issue intentionally remains
  `in-progress` for funcref, Promise ops, and the pushRaw justification ratchet.

## 2026-07-16 — funcref slice results

- Re-grounded and fast-forwarded to `origin/main` at
  `2a77b7131c6239e980029f5a870ab43b70f354ae` before implementation.
- Made `emitFuncRef` required and generic over the backend sink. Lowering still
  resolves the lifted function name and owns closure operand order; the backend
  now owns materializing that resolved handle as a first-class callable value.
  WasmGC emits the exact former `{ op: "ref.func", funcIdx }` instruction, while
  Linear and Bytecode stop at explicit missing-representation errors instead of
  accepting a raw WasmGC instruction.
- Routed the `closure.new` materialization site through the trait and added a
  Golden-Instr assertion for `WasmGcEmitter.emitFuncRef` in
  `tests/ir-backend-emitter.test.ts`. The `emitter.pushRaw` call count in
  `lower.ts` is now 85 (86 before this slice).
- Focused verification:
  `pnpm vitest run tests/ir-backend-emitter.test.ts tests/issue-1169c.test.ts tests/ir-bytecode-proof.test.ts`
  (75 tests passed), plus `pnpm run typecheck` and
  `pnpm run test:equivalence:gate` (1,607 passing, 36 known baseline failures,
  zero new regressions).
- Byte identity: rebuilt the existing `scripts/prove-emit-identity.mjs` harness
  with esbuild, captured the pre-edit baseline, and compared the edited compiler
  against it. Result:
  `IDENTICAL — all 56 (file,target) emits match baseline`.
- Slice acceptance: complete. The parent issue intentionally remains
  `in-progress` for Promise ops and the pushRaw justification ratchet.
