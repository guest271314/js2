---
name: reference_1927_pipeline_pass_gates_fresh_errors
description: "#1927 pipeline driver — each validation pass must gate on its OWN fresh errors, not the whole accumulated array (non-hard TS errors like TS2678 are tolerated)"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

#1927 unified compileSourceSync/compileMultiSource/compileFilesSource into one
`runPipeline` core (`src/compiler.ts`). The load-bearing subtlety: the
early-errors / safe / hardened validation passes MUST gate on the errors each
pass freshly produced, NOT on the whole accumulated `errors` array.

**Why:** the pre-collected `errors` array already holds non-fatal TS diagnostics
of severity `"error"` that the single-source path has ALWAYS tolerated — e.g.
TS2678 "Type '2' is not comparable to type '1'" on a switch case. The compile
succeeds and leaves the diagnostic in `errors`. The legacy single-source driver
gated each pass on that pass's fresh output (`earlyErrors.some(...)`); the legacy
MULTI driver wrongly gated on `errors.some(severity === "error")` (whole array).
My first cut copied the multi semantics into the shared core → 9 NEW equivalence
regressions (strict-equality NaN edge cases + switch-fallthrough) because every
tolerated non-hard TS error became a hard compile failure.

**How to apply:** in `runPipeline`, collect each pass's output into a local
array, push it to `errors`, then gate via `hasNewError(added)` = `added.some(e
=> e.severity !== "warning")`. NEVER gate a pass on the whole `errors` array.
The equivalence-gate (`scripts/equivalence-gate.mjs`, the merge-queue/CI
`equivalence-gate` check) is what catches this — it failed fast on the 9
regressions; the fix also flipped 50 baseline failures to PASS (multi paths
gained the same correct tolerance). Related: [[project_type_index_shift_and_deadelim]].
