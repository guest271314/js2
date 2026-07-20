---
id: 3501
title: "Infer typed linear vectors from empty-array read/write evidence"
status: in-progress
sprint: current
created: 2026-07-20
updated: 2026-07-20
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
task_type: bug
area: ir, codegen-linear, porffor, benchmarking
language_feature: evolving-empty-arrays
es_edition: multi
goal: backend-agnostic-ir
depends_on: [3497, 3499]
related: [1804, 1977, 2956, 3478]
origin: "2026-07-20 explicit user request: run the exact landing array-sum source through shared linear IR and Porffor native"
assignee: ttraenkler/codex-3501-empty-array-element-inference
files:
  - src/codegen-linear/runtime.ts
  - src/ir/analysis/linear-memory-plan.ts
  - src/ir/array-element-inference.ts
  - src/ir/from-ast.ts
  - src/ir/backend/porffor/assembler.ts
  - tests/issue-3501-empty-array-element-inference.test.ts
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/backend/porffor/assembler.ts
---

# #3501 — Infer typed linear vectors from empty-array evidence

## Problem

The exact public landing program
`website/public/benchmarks/competitive/programs/array-sum.js` declares
`const values = []`, then establishes its element type through indexed numeric
writes and reads. After #3497 lands its JSDoc signature, the selector claims
`run`, but AST lowering rejects the initializer because the empty literal has
no vec-typed hint.

TypeScript reports the initializer itself as `never[]`, the declaration as
`any[]`, the early write receiver as `any[]`, and the later read receiver as
`number[]`. Lowering the initializer in source order therefore cannot infer the
element representation from the literal or declaration alone.

## Root cause and failed approaches to avoid

The existing #1804 path intentionally requires a vec hint before emitting
`vec.new_fixed([])`. Supplying a hard-coded f64 default would silently
miscompile mixed, escaping, or genuinely unresolved arrays. Rewriting the
source with a `number[]` annotation would bypass the shared front end and would
not solve aliases or branch joins. Building a benchmark-named IR module would
also evade the source-to-IR contract and allocation registry.

The evidence has to be closed before lowering while preserving the existing
allocation site. The backend must continue consuming that same source-derived
IR and `LinearMemoryPlan`; it must not introduce a Porffor-only array carrier.

## Implementation design

1. Add a function-local, path-insensitive array evidence pass. Build a
   may-alias graph for empty/non-empty literals, declarations, assignments,
   aliases, and conditional joins before collecting evidence.
2. Gather concrete element facts from the checker oracle, indexed writes,
   indexed reads, joined literals, and `.push`. Resolve only the currently
   supported `number -> f64` vector representation.
3. Reject conservatively when evidence contains multiple concrete kinds, an
   alias escapes through a return/call/capture/aggregate, a binding joins an
   external or non-array value, or no supported element fact closes the group.
   Diagnostics are stable and identify the source binding and rejection class.
4. Feed a resolved element type into the existing `vec.new_fixed` builder path
   and use the same inference fact at scalar linear-pointer read/write/length
   gates. Do not mutate the AST or mint a second allocation.
5. Bind the already-emitted grow-store/read/length operations in the Porffor
   adapter using the canonical vector layout and plan operations. The helper
   suffix must be the linear backend's supported f64 vector sentinel and the
   plan must contain exactly one matching allocation site; helper/layout or
   allocation ambiguity rejects instead of selecting the first site. Growth
   mirrors #1977 forwarding so aliases holding an old header continue to
   observe the relocated vector. Emit ordinary Porffor
   `Alloc`/`Load`/`Store`/control-flow nodes only; no `RawC`, native Porffor
   arrays, or benchmark cases.
6. Keep the relocation tag and replacement-pointer offset in one shared linear
   forwarding contract consumed by both direct linear Wasm and Porffor. Assert
   that the forwarding record fits before the planned vector fields. Inferred
   linear reads must carry the existing counted-loop in-bounds proof; otherwise
   they demote instead of choosing a backend-specific OOB sentinel. The
   generated getter still uses NaN defensively for OOB f64 reads.
7. Prove the helper independently with alias/join and mixed/escape/unresolved
   tests, prove planned growth/forwarding with a small source-derived vector
   program, then run the untouched public source through Node, WasmGC, linear
   Wasm, source-derived Porffor IR, C, ASan, and UBSan.

## Downstream note

The first exact Porffor probe exposed typed JS bitwise composites
(`js.shr_u`, `js.bitxor`, `js.bitand`, `js.bitor`) as an independent legality
gap. That work belongs to #3499 and its owned files; #3501 does not duplicate or
modify that lowering. Final exact-source native validation waits for #3499 to
land on `origin/main` and merges that landed commit before running.

## Acceptance criteria

- [x] One numeric element type is inferred from checker/read/write evidence
      across local aliases and joins.
- [x] Mixed, escaping, externally joined, and unresolved empty arrays remain
      conservative with stable diagnostics.
- [x] The inferred literal uses the allocation registry and canonical
      `LinearMemoryPlan` vector layout/operations.
- [x] WasmGC and linear Wasm execute the exact public source with Node-equal
      results, including vector growth beyond initial capacity.
- [x] Focused source-derived Porffor tests prove allocation, indexed growth,
      alias forwarding, reads, and length independently without `RawC`.
- [x] Non-f64 helper suffixes, a second same-layout allocation, and unproven
      OOB reads reject conservatively with focused coverage.
- [x] Direct linear Wasm and Porffor consume the same asserted forwarding
      record contract; the adapter contains no duplicated tag/offset literals.
- [ ] The exact public source renders through landed #3499 Porffor lowering and
      executes Node-equal native C under ASan/UBSan.
- [ ] Focused/regression checks, typecheck, lint, formatting, and repository
      policy checks pass on the final merge of `origin/main`.

## Test results

- `pnpm exec vitest run tests/issue-3501-empty-array-element-inference.test.ts`
  — 8 passed, 2 optional native tests skipped without an initialized Porffor
  checkout.
- `JS2WASM_PORFFOR_ROOT=... PORFFOR_NATIVE_REQUIRED=1
PORFFOR_NATIVE_SANITIZERS=1 pnpm exec vitest run ... -t "allocation growth
and alias-forwarded"` — focused native vector runtime passed under combined
  ASan/UBSan.
- `pnpm exec tsc --noEmit --tsBuildInfoFile /tmp/js2-3501-tsconfig.tsbuildinfo`
  — passed.

Final exact-source sanitizer and regression evidence will be recorded after
the #3499 dependency is present on landed `origin/main`.
