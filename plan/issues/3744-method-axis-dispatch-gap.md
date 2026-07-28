---
id: 3744
title: "perf: the `method` axis is 6.21x node — the second-largest remaining gap after #3739"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
language_feature: compiler-internals
goal: performance
related: [3739, 3683, 3684, 3685]
origin: "benchmarks/cross-engine — measured on main 02a5512e0, 2026-07-28"
---

# #3744 — the `method` axis, 6.21x

## Measurement

Same run as #3739 (one container, checksums matching, min-of-5):

| axis      |  node |   js2 |  js2/node |
| --------- | ----: | ----: | --------: |
| method    | 0.552 | 3.433 | **6.21x** |
| tokenizer | 0.076 | 0.725 |     9.54x |

#3739 addressed the tokenizer axis (now 1.92x better there). `method` is
untouched and is now the largest gap.

## Why it is a separate issue from #3739

The tokenizer axis is a fnctor with `this.<field>` state; #3739's levers were
field REPRESENTATION and the boxed arithmetic around it. The `method` axis
(`benchmarks/cross-engine/axes-core.js`) isolates **dispatch** — repeated calls
through a receiver — with far less field traffic, so #3739's two fixes do not
obviously transfer. It needs its own profile before any lever is chosen.

Notably js2 is only 2.61x off Porffor here while being 10.96x BETTER than
Porffor on `prop` — so the deficit is specific to call dispatch, not to object
representation generally.

## First step (do this before proposing a fix)

Dump the WAT for `benchMethod` and resolve every `call` by index, exactly as
#3739 did — that is what turned a guess into a mechanism there. Do not slice the
work before the profile exists; #3739's first two slicings were both wrong and
were corrected only by measurement.

## Acceptance criteria

- [ ] A per-call cost table for the `method` axis, calls resolved by name.
- [ ] The dominant cost named, with WAT evidence.
- [ ] Any fix measured by same-container interleaved A/B behind a kill switch,
      with matching checksums.
