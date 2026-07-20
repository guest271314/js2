---
id: 3502
title: "Lower landing string construction and char methods through shared IR"
status: in-progress
sprint: current
created: 2026-07-20
updated: 2026-07-20
priority: high
horizon: l
complexity: L
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir, strings, codegen-linear, porffor
goal: backend-agnostic-ir
depends_on: [3497]
related: [2956, 3498, 3501]
assignee: ttraenkler/codex-3502-shared-string-build-method-lowering
origin: "#3498 post-#3497 exact string-hash native-route probe"
---

# #3502 — Shared string build and character methods

## Problem and evidence

Exact `website/public/benchmarks/competitive/programs/string-hash.js` passes
JSDoc signature selection after #3497. The shared builder then rejects its
first `text += ...` with:

```text
ir/from-ast: compound assign to non-f64 slot "text" (i32) not in slice 6 (run)
```

The direct linear fallback has no `charAt` or `charCodeAt` method arm. These
are representation/lowering gaps, not benchmark support cells. The source is
not to be rewritten.

## Root cause

- `string.const`, `string.concat`, and `string.len` already exist in typed IR,
  but compound assignment decides from the slot carrier alone and accepts only
  scalar `f64`. In the linear lane a semantically-string local is carried as
  `i32`, so lowering must combine checker/producer evidence with that carrier
  rather than treating the carrier as the JavaScript type.
- `from-ast.ts` currently represents string methods as backend-selected helper
  calls. The linear resolver recognizes only `charCodeAt` and `slice`, while
  the Porffor legality/backend cannot consume the linear helper call. The
  source-derived module therefore has no backend-neutral char operation for
  both linear consumers.
- Linear strings already use the `string:utf8-bytes-v1` layout and helpers.
  `charAt` and `charCodeAt` are specified over UTF-16 code units, including
  surrogate halves and distinct out-of-range results (`""` versus `NaN`).
  This issue does not replace that representation. The exact benchmark's
  literals, `charAt` results, and concatenations are closed ASCII, which
  `analysis/encoding.ts` can prove. The first shared native claim is therefore
  gated on ASCII; non-ASCII and lone-surrogate inputs reject with a stable
  diagnostic until a separately tested general representation slice exists.

The existing `__linear_ir_str_char_code_at` helper is useful evidence but is
not the shared solution: it is a linear-Wasm helper selected by name and does
not give the Porffor emitter a typed operation. No prior attempt lowered the
untouched benchmark through the source-derived Porffor route.

## Implementation plan

### Slice 1 — disjoint semantic/lowering/runtime contract

1. Define exact typed evidence for non-coercive `string += string`, `charAt`,
   and `charCodeAt`, including omitted-index and numeric-type requirements.
   Keep JavaScript semantic evidence from checker/producer state separate from
   the backend carrier so an `i32` linear slot can still be proven string.
2. Define a backend-neutral string emitter contract and symbolic runtime
   operations, bound to the source-derived `LinearMemoryPlan` layout and
   allocation-site decisions without Wasm instructions, Porffor enums, C, or
   runtime symbol names.
3. Freeze UTF-16 index/bounds semantics in focused reference tests. Reuse the
   existing encoding lattice and linear layout, accepting only proven ASCII in
   this backend slice and testing stable rejection for broader encodings. Keep
   the exact initial rejection as evidence until producer wiring lands.

### Slice 2 — shared producer and backend wiring

1. After #3501 releases `src/ir/from-ast.ts`, lower typed string `+=` to the
   existing `string.concat` instruction and add typed `string.char_at` and
   `string.char_code_at` instructions for static string receivers.
2. Route all string instructions through `StringBackendEmitter` rather than
   `pushRaw`. Preserve the WasmGC/native-string behavior and reject dynamic,
   coercive, or prototype-overridden cases before claim.
3. Bind linear-Wasm to symbolic runtime operations and the exact existing
   `LinearMemoryPlan` layout/helpers. Preserve `charAt` empty-string bounds and
   `charCodeAt` NaN bounds. Reject unproven/non-ASCII encodings; do not claim
   general Unicode execution without tests through both linear Wasm and
   Porffor native.
4. After #3501 releases `src/ir/backend/porffor/assembler.ts`, lower the same
   planned string layout and operations to Porffor IR nodes. Do not emit RawC,
   use Porffor-native object/string layouts, or statically import the optional
   renderer.

### Slice 3 — exact-source four-lane acceptance

1. Compile the untouched landing file and assert the exact source-derived
   `IrModule` and `LinearMemoryPlan` contain `run` with no rejection or direct
   fallback.
2. Compare representative outputs across Node, JS2 WasmGC, shared linear Wasm,
   and the exact `(IrModule, LinearMemoryPlan)` lowered through Porffor IR to C.
3. Stress the JS2-to-Porffor native executable under ASan/UBSan and retain
   source hash, IR operation, plan, and sanitizer evidence.

## Acceptance criteria

- [ ] Exact `string-hash.js` reaches Node-equal, sanitizer-clean native
      execution from shared source-derived IR with no source rewrite.
- [ ] Node, JS2 WasmGC, shared linear Wasm, and JS2 IR/plan → Porffor IR → C
      agree for representative inputs including `0`, `1`, `100`, and `20000`.
- [ ] Typed string append, `charAt`, `charCodeAt`, bounds, omitted indices, and
      UTF-16 code units are explicit in the semantic IR contract. The first
      backend claim is proven ASCII; broader encodings reject stably unless
      exercised through both linear Wasm and Porffor native.
- [ ] Linear allocation/layout decisions come only from `LinearMemoryPlan`.
- [ ] Porffor remains optional; no RawC, benchmark-name special case, second
      parser, or Porffor-specific planner vocabulary is introduced.
- [ ] Existing string, linear-memory, WasmGC, and Porffor tests remain green.

## Test results

Disjoint contract checkpoint:

- `pnpm exec vitest run tests/issue-3502-string-contract.test.ts` — 4 passed.
- `pnpm run typecheck` — passed.
- Prettier write/check over the six checkpoint files — passed.
- `pnpm run check:issues` — passed.

Production wiring remains blocked on #3501 ownership release for
`from-ast.ts` and Porffor `assembler.ts`. #3501 remains `related` rather than
`depends_on` until its issue file lands on this branch; the issue audit rejects
dangling dependencies.
