# Sprint 73 — plan

**Focus:** pay down the debt that undermines correctness and trust — **complete the
IR migration** (retire the legacy fallback so IR is the only front-end path) and
**restore honest host conformance** under the oracle-v8 rigorous harness, while
lifting the test262-fyi/data score. Proxy-on-standalone is the stretch pillar.

_Follow-on to sprint 72 (frozen: 139 done issues, `sprints/72.md`). Released v0.63.0
(host 65.6% / standalone 63.5%, +2,495 standalone)._

## Priorities (in order)

### P1 — Complete the IR migration (#2855)  · **FIRST PRIORITY** · `model: frontier`
Make the IR path the **only** front-end path. Ratchet the unintended fallback
buckets in `scripts/ir-fallback-baseline.json` to zero (body-shape-rejected,
external-call, call-graph-closure, param-shape-rejected, param/return/type-
resolution-failure), then promote each cleared reason into `STRICT_IR_REASONS`
(`src/codegen/index.ts`) so a regression is a hard compile error, not a silent
fallback. Per-bucket ownership: `plan/log/ir-adoption.md`. TaskList: **#32**.

### P2 — test262-fyi / data score
Land the fyi-runner parity extraction (#3473 / PR #3420), close #3415, then
harvest + fix the top fyi/project-runner parity gaps. TaskList: **#33**.

### P3 — Restore regressed js-host tests (oracle-v8 harness)
- **#3418 + #3472 bundle** (`model: frontier`): closure-own-property substrate +
  native-string LHS coercion — restores ~391 vacuous→honest asserts. **Must land
  together** (#3418 alone regresses ~391; it's held to prevent a solo merge).
  TaskList: **#34**.
- Honest-failure clusters #3428 / #3429 / #3430 / #3470; harvest the next tier.
  TaskList: **#35**.

### P4 — Proxy on standalone (#1472) · `model: frontier` · stretch
Architect pure-Wasm Proxy traps (the #1 standalone blocker, ~27k cited records) —
**below IR migration** per stakeholder call. Spec first; impl follows. TaskList: **#36**.

## Dependencies
- **#3472 depends on #3418** (stacked; #3418 held — merge #3418 first/with #3472). Intra-#34.
- **#3421 (re-baseline, task #12) `blockedBy` #3428 (task #10).**
- **Soft:** P1 (#32, IR migration) touches the front-end broadly and can conflict
  with P3 host-codegen (#34/#35) — sequence or file-lock, don't run blind in parallel.

## Model convention
Tasks tagged `model: frontier` / `[FRONTIER]` run on the **frontier tier** —
**Claude 5 Fable (`claude-fable-5`)** or **GPT-5.6 Sol (`gpt-5.6-sol`)** (see the
`reference_frontier_model_tier` memory). Everyday tasks stay on the normal tier.
Frontier this sprint: **#32, #34, #36**.

## Starting the sprint (follow-up)
This is the forward plan. To make it the live rolling sprint, tag the underlying
issues `sprint: current` + `priority:` (P1→high … ), then
`node scripts/sync-current-tasklist.mjs`. Issues: #2855, #3473, #3418, #3472,
#3428, #3429, #3430, #3470, #1472.
