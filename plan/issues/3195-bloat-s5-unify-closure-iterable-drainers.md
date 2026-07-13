---
id: 3195
title: "bloat S5: runtime.ts — one parameterized closure-iterable drainer (fold the 3 copies + truthyEnv dup)"
status: done
completed: 2026-07-12
assignee: ttraenkler/dev-find-wasm
created: 2026-07-12
updated: 2026-07-13
priority: high
feasibility: medium
task_type: refactor
area: runtime
es_edition: n/a
language_feature: iterable-drain
goal: maintainability
sprint: 71
horizon: s
umbrella: 3182
related: [1849, 928, 3029, 3102]
---

# #3195 — bloat S5: one parameterized closure-iterable drainer

Slice **S5** of the #3182 code-bloat-elimination epic (from #1849). See
#3182 §D4.

## Problem

Three near-duplicate closure-iterable drainers in `src/runtime.ts`:

- `_drainClosureIterableToArray` (`runtime.ts:2938`)
- `_drainWasmClosureIterable` (`:3031`)
- `_drainIterable` (`:10605`)

The divergences (different loop caps, #928 buffer-drain semantics, field
resolution, wasm-exports access) are the **parameters**, not reasons to keep
copies. Call sites: `:3008`, `:11457`, `:11460`, `:11471`, `:12724` (wasm
variant) and the `_drainIterable` local at `:10605`.

Trivial rider: `truthyEnv` is a **verbatim** dup — `src/codegen/index.ts:1438`
vs `src/codegen/fallback-telemetry.ts:73` (both used at multiple sites in each
file). Fold into one export.

## Approach (verified anchors)

- Unify the three drainers behind one function with a strategy/options param
  (loop cap, field resolution, wasm-exports access). Diff the three first —
  the loop caps and #928 buffer-drain semantics become options.
- Export a single `truthyEnv` (leaf util) and import it in both index.ts and
  fallback-telemetry.ts.

## Acceptance criteria

- Zero test-diff; three drainers → one; single `truthyEnv` export.
- `pnpm run typecheck` clean.

## Coordination

`runtime.ts` is touched by Promise/async work (different regions — the
`NewPromiseCapability` / combinator dispatch is `:12445`, `:13341-13465`; the
drainers are `:2938-3031` and `:10605`). Low collision risk but re-merge
`origin/main` before enqueue.

## Resolution (2026-07-12, dev-find-wasm)

**Drainers → one loop.** Extracted `_stepClosureIterator(iteratorObj, exports,
opts)` + the shared `_resolveIterProp` field-resolver in `runtime.ts`. All three
drainers now delegate their step loop to it:
- `_drainClosureIterableToArray` → `{ cap: 1_000_000, nullOnMalformedNext: true }`
- `_drainWasmClosureIterable` → `{ nullOnMissingCallFn0: true }`
- `_walkWasmIterator` → `{ limit, closeOnStop: true }`

Each keeps its own distinct ENTRY (iterator acquisition: raw-closure vs
wrapper-vs-raw vs native-vs-wasm dispatch); only the triplicated step loop
folded. The historical divergences became the `opts` (cap, limit, `closeOnStop`
IteratorClose, `nullOnMalformedNext`, `nullOnMissingCallFn0`) — verified 1:1
against each original. `_resolveIterProp` is functionally equivalent to the old
`_readIterResultField` for the inputs `_drainClosureIterableToArray` actually
sees (always wasm-struct iterators/results, per its precondition), so switching
it in is behavior-preserving.

**truthyEnv → one export.** The verbatim dup (`index.ts` vs
`fallback-telemetry.ts`) folded: `truthyEnv` is now exported from the leaf
`fallback-telemetry.ts` (index.ts already imports that module — no cycle) and
imported into `index.ts`.

Net −17 LOC.

## Test Results

- `tests/issue-3195.test.ts` — 4/4 (spread, Array.from, bounded destructuring,
  for-of over a compiled closure `[Symbol.iterator]` — the three drainer paths
  end-to-end). Passes identically on base (drainers reverted).
- Zero test-diff: 15 drainer-exercising suites (#1320, #928/#929 generator-forof,
  #3023, #1219, #1592, spread/destructuring, flatmap, …) report identical
  pass/fail on base vs change (99/8 — the 8 pre-existing `string_constants`
  local-harness failures are unrelated). runtime.ts is host-side glue, not
  compiled into the wasm, so emitted binaries are unchanged by construction.
- `tsc --noEmit` clean; `check:loc-budget` OK (−17 LOC).
