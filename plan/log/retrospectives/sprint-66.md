# Sprint 66 Retrospective

**Sprint**: 66
**Dates**: 2026-06-24 (sprint/65 close) → 2026-06-26 (sprint/66 close, `sprint/66` tag)
**Theme**: architecture continuation — value-rep substrate + IR/async/Proxy epics;
conformance conformance residuals; acorn dogfood.

---

## Results

| Metric | Value |
|--------|-------|
| test262 at start (sprint/65 close) | 31,853 / 43,135 (73.9%) |
| test262 at close (sprint/66, origin/main) | 32,158 / 43,135 (74.6%) |
| Net gain | **+305 passes** |
| Issues marked done | 22 |
| Issues marked wont-fix | 1 (#1762 — linear-memory string backing, deferred) |
| Issues carried to sprint 67 | 54 |

The +305 net is the direct payoff from the correctness fixes and conformance
slices that landed across the 2-day sprint. The 54 carried issues are the
architecture-scale substrate epics that inherently span sprints.

---

## Headline wins

### merge_group standalone floor caught THREE host-masked regressions

The most consequential process result of s66: the `merge_group` standalone
floor gate (#2097) rejected **three separate PRs** that were green at the
PR-level CI — regressions invisible to host-mode checks but exposed only
under the standalone floor:

- **PR #2124** (`issue-2669`) — nested-array destructuring default-init:
  the initial fix materialized the closure-capture ref-cell box in a
  conditionally-skipped arm, poisoning captured reads in not-taken branches
  (the "capture-box-on-not-taken-arm" pattern). Recovered by scoping the
  fix to pure literal/identifier defaults only; the call/IIFE/generator
  default arm is now tracked in `reference_conditional_default_arm_capture_box_poison.md`.
- **PR #2134** (`issue-2671e`) — RegExp `lastIndex` coercion: a protocol-depth
  carve-out was needed after the host-mode standalone floor detected an
  over-eager coercion regression.
- A third PR in the #2140-#2142 range also required a diagnose→narrow→re-validate
  cycle before the floor accepted it.

Each cycle followed the same discipline: read the floor run, identify the
failing cluster, narrow the fix, re-validate per-process, re-enqueue once.
No re-enqueue loops; no churn.

**Takeaway**: the standalone floor is not a bureaucratic gate — it has now
caught five consecutive host-masked regressions across s65+s66. Every
broad-impact PR must clear it; there is no safe "host only" exception.

### Verify-first architecting shrank "hard substrate" issues to small confirmed fixes

Two issues framed as requiring large substrate rebuilds turned out to be
single-guard edits after verify-first tracing:

- **#2724 accessor-rep** (`docs(#2724): spec object-literal accessor
  representation`) — the s65 framing suggested a repr-layer rebuild;
  verify-first found one guard site. Landed as 1 edit, closes #1642.
- **#2722 nested-optional Path A** (`docs(#2722): Path A impl spec —
  #1589A guard false-positive + literal union-strip`) — expected ~150 LOC;
  actual fix was 2 edits to the guard logic.

Both architect specs were commissioned *after* per-process tracing confirmed
the actual failure site, not before. This is the s65 retro "spec-as-hypothesis"
principle applied end-to-end: trace → confirm site → document the confirmed
mechanism → implement.

### Conformance slice landings (2026-06-26 session)

The final session of s66 landed a dense batch of correctness fixes:

- **#1551** — SuperCall argument-list evaluation: speculative-rollback-eats-side-effects
  defect fixed; arg-eval now protected by a try-region guard. Sub-case 2
  (#2709, `super[super()]` PutValue/update ReferenceError) also landed.
- **#2671** (three sub-areas) — JSON.stringify wrong-type replacer + circular-structure
  crash; Date `set*` methods clobbering `[[DateValue]]` during `ToNumber`;
  RegExp `lastIndex` value-preserving data slot (host mode) + protocol-depth
  carve-out (standalone).
- **#2692** — Closure-capture ref-cell box must be materialized eagerly at
  declaration, not lazily at first call site. This is the fix that also
  informed the #2669 capture-box-on-not-taken-arm recovery.
- **#2713** — IR↔legacy parity correctness twins: correctness bugs that were
  fixed on the legacy codegen path but not replicated to the IR path (and
  vice versa) now have paired test coverage that fails on divergence.
- **#2711** — Standalone↔host differential parity CI gate: an advisory gate
  that compares host and standalone output over the builtin surface; wired
  as a non-blocking CI job to surface future divergences early.
- **#2710 slices 0–1** — Late-bind module indices foundation:
  byte-identical refactor establishing the handle infrastructure for the
  index-shift elimination epic (#1916). Slices 0+1 land with zero behaviour
  change, verified byte-identical.

### Earlier s66 landings (before the 2026-06-26 session)

- **#2045** — Linear Uint8Array WASI: silent-corruption holes (name-keyed
  buffer registry, no bounds checks) + escape-analysis demotion gaps. Critical.
- **#2637** — Promise capability executor-body protocol re-architecture.
- **#2652/#2654** — Standalone `parseInt`/`parseFloat` ToString + decimal
  precision (1-ULP drift).
- **#2656** — `++this.field` / `this.field--` on an `any`/`externref`
  receiver silently dropped the write (NaN-fallback). Fixed; unblocked the
  acorn tokenizer `nextToken()` advance (7th dogfood blocker).
- **#2664** — Acorn 8th dogfood blocker resolved.
- **#2665** — Dashboard: landing-page feature-support labels now derived from
  test262 pass-rates, not hardcoded HTML.
- **#2667** — Mapped arguments object non-configurable/non-writable property
  + `[[Delete]]` semantics (≤ES3 residual).
- **#2675** — `++/--` on computed object key (`obj[keyExpr]++`): NaN/no-update
  + double `ToPropertyKey` defect.
- **#2677** — Fnctor/class ctor chained `this`-assignment drops non-outermost
  fields (`this.a = this.b = expr` → b missing from struct).
- **#2678** — `Date.parse` / `new Date(str)` NaN stubs in HOST mode now
  route to the JS-string externref native parser.
- **#2679** — `ToNumber`/`ToPrimitive` invokes `valueOf` with the WRONG
  `this` (receiver identity lost).
- **#2683/#2684** — Native Messaging node:process + Deno stdio host surface.
- **#2083** — Per-module exported host-glue suite size: `wasm-opt`-unstrippable
  bulk reduced.

---

## Process keepers (carry into s67)

1. **merge_group standalone floor is non-negotiable for broad-impact PRs.**
   It has now caught host-masked regressions in every sprint since it was
   wired (#2097). No broad-impact change ships without clearing it. Dev
   agents must anticipate a diagnose→narrow→re-validate cycle; one-shot
   enqueue only after the floor passes.

2. **Verify-first, spec-as-hypothesis — before an architect spec is written.**
   For any issue whose root cause involves value-rep, IR, or substrate:
   per-process binaryen WAT trace first, architect documents the *confirmed*
   mechanism second. The s65 retro codified this; s66 confirmed it scales
   to "large" issues (#2724 → 1 guard; #2722 → 2 edits).

3. **One-shot enqueue, never re-enqueue.** No merge-queue churn this sprint.

4. **Dev CI-watchers lag on the final enqueue step — lead-shepherd one-shot
   enqueue is the backstop, not optional.** Dev agents complete their fix,
   push the PR, and watch CI, but the enqueue step often falls to the lead.
   This is a structural gap: the dev agents' context window closes before
   the CI-green signal arrives, leaving the PR stranded. A dedicated
   PR-queue shepherd is the mitigation; the lead backstop is the floor.

5. **Commission architect specs as the frontier opener.** Once the easy
   conformance queue drains, the way forward is not to send devs into the
   substrate blind — it is to commission verify-first architect specs that
   confirm the actual mechanism before implementation. s66 opened the
   accessor-rep and nested-optional frontier this way; s67 inherits
   #2710/#2722/#2724 as the substrate anchors.

---

## What didn't go well

### 54-issue carry rate (70% of the sprint slate)

The inherent tension between architecture-scale epics (which span sprints by
design) and the sprint closure metric (done/total) shows as a 54:23 carry
ratio. This is expected and accepted for a substrate sprint, but it means the
sprint metric alone is a poor health signal. The more useful signals are:
(a) is the substrate unlock-queue advancing? (Yes — #2710/#2722/#2724 unblock
the index-shift and accessor-rep lanes.) (b) are the PRs that land
regression-free? (Yes — floor cleared on all merges.)

### Dev enqueue lag (structural)

Dev agents complete fixes, push PRs, and watch CI, but the final enqueue
step frequently falls to the lead or shepherd. Root cause: the CI-wait
window (10–20 min) often outlasts the dev agent's active context. This is
a known-structural gap (documented in `feedback_dev_silence_protocol.md`)
and the dedicated PR-queue shepherd role is the designed mitigation. The
shepherd role should be staffed at s67 sprint start.

### statusline-sprint bug (pre-planned sprint hijacked the badge)

A pre-planned sprint 67 was created mid-s66 for planning purposes, and it
caused the statusline to report s67 metrics while s66 was still active.
Fixed by the statusline-sprint guard commit (2026-06-26), but the root
cause is that the sprint badge logic did not distinguish `status: planned`
from `status: active`. The fix (`set s67 planned`) is in place; this class
of bug should not recur with the new guard.

---

## Action items

These are proposed improvements, not unilateral changes. Discuss with tech
lead and PO before applying.

- [ ] **Rename the `end_tag_pushed` wrap_checklist item** to
  `end_tag_created` in `plan/issues/sprints/67.md` and future sprint docs —
  the tag is now created via the GitHub API (not a local `git push`), so
  "pushed" is a misnomer. Minor but avoids confusion next close cycle.
  File: `scripts/check-sprint-closed.mjs` and the sprint-doc template.

- [ ] **Add a wrap_checklist item `shepherd_staffed`** as a reminder to
  staff the PR-queue shepherd role at sprint start, not mid-sprint. The
  dev enqueue lag is structural; making shepherd staffing a checklist item
  at sprint-start would eliminate the lag before it accumulates. File:
  `plan/method/session-start-checklist.md`.

- [ ] **Add a `status: planned` guard to the statusline sprint badge logic**
  so that a pre-planned sprint doesn't hijack the active-sprint display.
  This is already fixed in the codebase (the 2026-06-26 commit); document
  it as a standing rule in `CLAUDE.md` or `plan/method/team-setup.md` under
  Sprint planning.

---

## Carry-over

54 issues carrying `sprint: 66 → 67`. They are the architecture-continuation
slate: the #2580 value-rep spine (M3→M4), #2660 fnctor-reconstruct, the IR
effect-model lane (#2134–#2141), async/Promise (#2613/#2614), Proxy
(#1355/#2618), the standalone residual tails, the type-oracle/pipeline
refactors, and the newly-unblocked substrate slices (#2710/#2722/#2724
architect work → developer implementation in s67). See
[`sprints/67.md`](../sprints/67.md) for the sequenced slate.
