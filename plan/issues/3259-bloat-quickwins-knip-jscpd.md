---
id: 3259
title: "Bloat quick-wins: knip dead-export sweep + jscpd duplication scan of src/codegen"
status: done
completed: 2026-07-14
sprint: 72
priority: high
horizon: s
feasibility: easy
task_type: chore
area: codegen, ci
goal: ir-full-coverage
created: 2026-07-14
related: [3090, 3256]
origin: "sprint-71 bloat audit — automated dead-code + duplication before the self-host epic"
---

# #3259 — Bloat quick-wins: knip + jscpd

## Problem

Before the multi-window self-host epic (#3256–#3258), two cheap automated
passes bank easy −LOC and inform the self-host order.

## Scope

1. **knip dead-export sweep.** `knip` is already wired into quality CI (#3090
   Phase 2b, banked −1,800 LOC). Re-run it (`pnpm run knip` or the wired check),
   delete confirmed dead exports/files, gated by the existing knip config. Land as
   a single deletion PR (merge_group A/B validates zero behavior change).
2. **jscpd copy-paste scan of `src/codegen/`.** Run jscpd over `src/codegen/`
   (the hand-emission families likely share large duplicated `Instr[]`
   sequences). Report the top duplicated blocks. Where a duplicated Instr-sequence
   is a clear helper-extraction, extract it (net −LOC, byte-inert). Where it's an
   artifact of hand-emission that self-hosting will delete anyway, just note it in
   `plan/self-hosting-scale-up.md` to sequence #3256–#3258.

## Acceptance

- knip dead-exports deleted (net −LOC), quality CI green.
- jscpd top-duplication report committed to `plan/log/`; any clean helper
  extractions landed byte-inert.

## Non-goals

- No risky god-file restructuring (calls.ts/index.ts shrink is a byproduct of the
  IR migration #2855 + backend convergence #2953/#2956, not direct editing).

## Outcome (2026-07-14) — no cheap −LOC left; both halves empty

Full run recorded in `plan/log/3259-bloat-quickwins-report.md`. Shipped the
god-file profiler as the durable follow-on tool (#3047):
`pnpm run profile:godfiles` (rank god-file functions by LOC + emission-density,
classify bloat shape → lever) and `pnpm run check:godfiles` (regression gate vs
`scripts/godfile-profile-baseline.json`, 62 tracked functions). #3256/#3257/#3258
use it as their landing-proof meter.

**Half 1 — dead-export sweep.** knip was never actually wired (the premise was
off — #3090 Phase 2b used a purpose-built reachability audit,
`check:dead-exports`, not knip). That gate is clean: **16 known-unreferenced top-
level functions, but all 16 are pinned by unit tests** (issue-1325/1919/2089/
1238/682/2104/2091 + regex-bytecode). #3090 already deleted the truly-dead ones.
**Zero safe deletions.** Two owner-judgment clusters remain (test-only internal
helpers; the whole 299-LOC `regex/vm.ts` reference VM kept alive only by its two
tests) — filed as notes, not deleted here.

**Half 2 — jscpd.** `npx jscpd@4 src/codegen`: **11 clones, 0.64% duplication**,
all small/local. **Critical caveat: jscpd is blind to the god-files** — its
tokenizer silently drops files >~1k lines (regardless of `--max-size`), so it
analyzed only 105/166 files (14% of LOC) and skipped every one of calls.ts /
index.ts / object-runtime.ts / array-methods.ts / native-strings.ts. It cannot
measure the `Instr[]` duplication that matters.

**Conclusion:** no byte-inert automated win available. The real subtraction lever
is the self-host epic #3256–#3258 (deletes the hand-emitted `Instr[]` wholesale);
jscpd offers no sequencing signal because it can't see those files.
