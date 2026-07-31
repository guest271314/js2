---
id: 3922
title: "linear backend: 7 String builtins unimplemented — repeat, replace, toLowerCase/toUpperCase, substring, trim, endsWith, includes (blocks 7 benchmarks)"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen-linear
language_feature: string-methods
goal: performance
sprint: current
horizon: l
es_edition: multi
related: [3908, 3904, 3923]
---

# #3922 — linear lane: missing String builtins

## Status: open — from #3908's 26-lane inventory

## Problem

Seven `String.prototype` methods are unimplemented in the linear-memory
backend. Each fails at **compile** time with `Unsupported method call`, so the
benchmark's linear lane never produces a bar.

| method | benchmarks blocked |
| --- | --- |
| `repeat` | `string/concat-long`, `string/indexOf`, `string/includes` |
| `replace` | `string/replace` |
| `toLowerCase` / `toUpperCase` | `string/case-convert` |
| `substring` | `string/substring` |
| `trim` | `string/trim` |
| `endsWith` | `string/startsWith-endsWith` |
| `includes` + `endsWith` | `mixed/text-search` |

These are **missing features, not miscompiles** — the backend correctly reports
it cannot lower them. That makes this a scoping question (how much of the
String surface should the linear lane carry?) rather than a bug hunt.

## Context

Per `docs/architecture/codegen-axes.md` the linear backend is **not** superseded
by WasmGC — the two are alternatives chosen by target, and both stay. So these
gaps are real, not dead code. But the lane's value is WASI/linear targets, so
prioritise by what those targets actually need rather than by benchmark count.

## Scope

1. Decide the intended String surface for the linear lane and record it. If
   some of these are deliberately out of scope, say so and close that portion
   rather than leaving the benchmarks silently absent.
2. Implement what is in scope. `repeat` unblocks three benchmarks on its own
   and is the cheapest win.
3. Cross-reference #3899's i32-kernel work — the WasmGC lane's scan kernels
   (`__str_region_eq`, `__str_ws_start`/`__str_ws_end`) may inform the linear
   equivalents, though the storage model differs.

## Acceptance criteria

1. Each method is implemented or explicitly scoped out with a reason.
2. Benchmarks whose only blocker was a listed method produce a linear bar.
3. Equivalence coverage for whatever lands.

## Provenance

`issue-3908-linear-validation`'s inventory: of 26 previously-absent linear
lanes, 4 are deliberate `dom/*` skips and **22 are real failures** — 16 compile
errors (this issue and #3923) and 5 runtime traps (#3924, #3935). The gap was
structurally invisible until #3904 made failed lanes record themselves instead
of vanishing.
