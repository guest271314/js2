---
id: 3195
title: "bloat S5: runtime.ts — one parameterized closure-iterable drainer (fold the 3 copies + truthyEnv dup)"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: high
feasibility: medium
task_type: refactor
area: runtime
es_edition: n/a
language_feature: iterable-drain
goal: maintainability
sprint: current
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
