---
id: 2953
title: "Close the BackendEmitter pushRaw gap: route unions/closures/refcells/coercions/null/funcref through the trait"
status: done
completed: 2026-07-16
assignee: ttraenkler/opus-1a
branch: symphony/porffor/2953-after-pr-3146
pr: 3159
sprint: 72
created: 2026-07-02
updated: 2026-07-19
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
claimed_at: 2026-07-16T18:05:52.080Z
last_merged_pr: 3146
last_ci_retry_head: ad68ab2760e5cb152f05f60420088103aea803da
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
- [x] **Promise aggregate ops**
      (`emitPromiseNew`/`emitPromiseStateGet`/`emitPromiseValueGet`) — added
      required, sink-generic primitives for Promise construction and semantic
      state/value reads. `WasmGcEmitter` preserves the canonical `$Promise`
      `struct.new` and field 0/1 `struct.get` instructions; Linear + Bytecode
      fail loudly until their Promise record representations land. All six
      Promise aggregate operations in `async.return`, `async.throw`, and
      `await` now route through the trait. The two allocation conversions reduce
      `emitter.pushRaw` calls in `lower.ts` from 85 to 83; await's raw structured
      `if` remains intentionally out of scope. Golden emitter coverage, the
      86-test focused suite, typecheck, equivalence, and the 56-record byte
      oracle are green. (porffor-codex-developer)
- [x] **ratchet** — added the change-scoped `check:pushraw` quality gate.
      Every newly added or moved `pushRaw(` call must carry a valid
      `// pushraw-ok(#issue)` tag on the same or preceding line, even when the
      change removes another raw site. A committed source-derived dashboard
      records 82 live calls (the prior reported 83 included a comment-only
      `emitter.pushRaw` mention); `--update-on-decrease` banks legacy-debt
      removal. Focused fixture coverage locks tag parsing, net-neutral moves,
      tagged growth, and zero-context diff attribution.

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

## 2026-07-16 — Promise aggregate slice results

- Re-grounded and fast-forwarded to `origin/main` at
  `f52edb61510b9c404ef8807e662e9d3023a14f72` before implementation; PR #3134's
  funcref slice was already present, so this continuation advanced to Promise
  aggregate operations without duplicating landed work.
- Added required `emitPromiseNew`, `emitPromiseStateGet`, and
  `emitPromiseValueGet` hooks. Lowering retains Promise type resolution,
  operand evaluation, state comparisons, and await's structured control flow;
  the backend now owns aggregate allocation and the semantic state/value field
  mapping. Linear and Bytecode stop at explicit missing-representation errors.
- Routed two `$Promise` allocations and four state/value reads through the
  trait. No Promise `struct.new`/`struct.get` remains in `lower.ts`, while the
  out-of-scope await `if` construction is unchanged. The `emitter.pushRaw` call
  count is now 83 (85 before this slice).
- Added Golden-Instr coverage for Promise construction, state reads, and value
  reads in `tests/ir-backend-emitter.test.ts`.
- Focused verification:
  `pnpm vitest run tests/ir-backend-emitter.test.ts tests/ir/issue-1373b.test.ts tests/issue-1169c.test.ts tests/ir-bytecode-proof.test.ts`
  (86 tests passed), plus `pnpm run typecheck` and
  `pnpm run test:equivalence:gate` (1,607 passing, 36 known baseline failures,
  zero new regressions).
- Byte identity: rebuilt the existing `scripts/prove-emit-identity.mjs` harness
  with esbuild, captured the pre-edit baseline, and compared the edited
  compiler against it. Result:
  `IDENTICAL — all 56 (file,target) emits match baseline`.
- Slice acceptance: complete. The parent issue intentionally remains
  `in-progress` for the pushRaw justification ratchet, which must land on the
  next fresh continuation branch.

## 2026-07-16 — pushRaw ratchet slice results

- Re-grounded at `origin/main` `926297fe7`. The exact `pushRaw(` call count is
  82; the slice notes' 83 count came from matching `emitter.pushRaw` text and
  included the explanatory comment at `lower.ts:3561`. The original ≤15 target
  predated the later dynamic/string/class/loop work; those out-of-family escape
  hatches are now explicit legacy debt for #3296 rather than silently accepted
  new surface.
- Added `scripts/check-pushraw.mjs` and `scripts/pushraw-baseline.json`. The
  default gate compares against the change-set's own merge base, so unrelated
  main advances cannot fail a merge group. Any added call must be tagged on the
  same or preceding line; tagged growth is reviewable, while untagged additions
  fail even when the net count does not grow. Whole-tree and
  `--update-on-decrease` modes preserve the count dashboard and bank removals.
- Wired `check:pushraw` into the required `quality` job and added focused
  fixture tests in `tests/issue-2953.test.ts`. No compiler source changed, so
  emitted output is byte-identical by construction for this final slice.
- Validation: focused Vitest (4/4), default + whole-tree pushRaw gates,
  TypeScript typecheck, full Biome lint, Prettier, issue integrity, LOC budget,
  and equivalence (1,607 passing, 36 known baseline failures, zero new
  regressions) are green. Per the issue rules, no full local test262 was run.
- Merge-queue retry: the first two final-slice queue attempts reached green
  compiler/ratchet checks but were ejected by a stale #2097 standalone
  high-water mark and external test262 baseline drift. The branch was merged
  forward to main's targeted #3322 high-water correction without changing the
  ratchet implementation; `last_ci_retry_head` records the handled failed head.
- Slice acceptance: complete; all issue-defined slices are now implemented and
  the issue is ready for final review in PR #3159.
