---
name: feedback_verify_first_beats_architect_spec
description: Deep-tracing devs with per-process binaryen WAT verification beat architect-spec-first; verify the mechanism on current main before implementing; a verified scope+handoff is a valid result; refuse speculative 0-payoff broad-impact PRs
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

Sprint 65 (2026-06-24): the **architect-spec-first** model produced WRONG specs
3× on the value-rep / Promise substrate — #2623-A (capture box-depth), #2623-B
(class-extends-Promise identity), and #2580-M3-A all **mis-attributed the failing
mechanism**, and the M3 "168-row fnctor `.prototype=` lap" framing was wrong (the
real lever is the `Object.defineProperty` accessor cluster — 181 of 266 files;
the fnctor lap is 51 files and the hardest/last slice). Deep-tracing senior-devs
who **binaryen-decoded the emitted WAT + ran the per-process sharded runner**
found the real causes and landed regression-free slices (M3 B-acc = **+35 rows**,
0 regressions).

**Why:** a spec is a *hypothesis* until the emitted WAT confirms it. Shallow
scoping mis-attributes the mechanism, and the failure surface also MOVES between
sessions as sibling PRs land (e.g. #2618 Proxy START-timing was real but became
test262-unreachable once the harness wrapped proxies post-`setExports`).

**How to apply:**
- Before implementing a hard substrate issue, **re-ground per-process on CURRENT
  main** — binaryen WAT decode + the sharded fork-worker (`compiler-fork-worker.mjs`,
  one fork/test). NEVER an in-process `runTest262File` loop — it falsely reports
  ~42 `compile_error: …reading 'kind'` from cross-compile state bleed.
- A **verified scope+handoff** (row delta 0, with WAT evidence + a proper
  architecture spec, e.g. epic #2637) is a VALID, non-wasted result — strictly
  better than a speculative broad-impact PR that banks 0 rows on a hot path
  (the #1888-class standalone-floor #2097 eject hazard).
- Route architecture-scale items to **deep-tracing devs who write the
  implementation plan**, not shallow architect specs.
- See [[feedback_reground_spec_against_current_main]],
  [[feedback_verify_fix_in_git_not_narrative]],
  [[project_broad_impact_validate_full_ci]],
  [[project_standalone_floor_only_on_merge_group]].
