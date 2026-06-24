# Sprint 65 Retrospective

**Sprint**: 65
**Dates**: 2026-06-21 (sprint-65/begin, 20:28 +0200) → 2026-06-24 (sprint/65, close)
**Theme**: architecture epics + value-rep substrate (architect-led) — the #2580
dynamic-read spine, the #1917 single-coercion-engine series, Proxy/Promise
identity slices.

---

## Results

| Metric | Value |
|--------|-------|
| test262 at start (sprint-65/begin) | 31,678 / 43,135 |
| test262 at close (origin/main 5ca4931a7) | 31,776 / 43,135 (73.7%) |
| Net gain | **+98 passes** |
| Issues marked done | 43 (0 wont-fix) |
| Issues carried to sprint 66 | 32 |

The architecture-epic spine is substrate work whose payoff is unlock-shaped, not
row-shaped this window; the +98 reflects the conformance-visible slices that
landed while the substrate epics were staged.

---

## Headline win — the #1917 single-coercion-engine series COMPLETED

The marquee s65 architecture deliverable. The four divergent coercion matrices
were unified into one engine, landed as a staged, regression-free series:

- **Steps 1–3** — `emitToString` / `emitToNumber` / `emitToBoolean` unification
  (**#1960 / #1962 / #1963**), byte-neutral.
- **Equality E3** (**#1989**) merged; **E6** (**#1992**) + the **#2045** presence
  work (**#1991**) rode the merge queue at close.

This banks the single-coercion-engine spine the s62 "Fable architecture sprint"
set out to land — and it landed byte-neutral / regression-free, proving the
trace-first + per-process-validate discipline scales to a broad-impact
shared-helper rewrite, not just narrow slices.

---

## The defining process lesson — architect-spec-first mis-fired 3×

An architect-spec-first model produced **WRONG specs three times in a row** on
the substrate, and deep-tracing senior-devs with per-process binaryen
verification are what actually shipped regression-free slices.

1. **Architect-spec-first mis-fired 3× on the substrate.** #2623-A (async
   box-depth), #2623-B (Promise-subclass identity), and #2580 M3 Stage A were
   each handed off with a spec that **mis-attributed the mechanism**. In all
   three a senior-dev had to deep-trace the actual failing path to find the real
   cause (single-box of an already-boxed capture; capability-ctor identity
   unification; inline-literal proto link) before a correct, regression-free
   slice could land.
   **Takeaway:** for value-rep/substrate work, route through a
   *verify-the-mechanism-first* trace, not a spec written from the issue
   narrative. A spec is a hypothesis until the binaryen output confirms it.

---

## Process keepers for s66

1. **Verify-first, per-process — NEVER in-process loops.** The in-process
   test262 loop falsely reports ~42 `compile_error reading 'kind'` (cross-test
   state bleed); the **per-process sharded runner is the only trustworthy
   signal**. Every s65 landing was validated per-process.

2. **The `merge_group` standalone floor (#2097) earned its keep.** It catches
   broad-impact regressions that PR-level checks miss (the standalone floor runs
   only on `merge_group`). Every substrate slice this session was a broad-impact
   change; the floor is what made "0 regr" a measured claim, not a hope.

3. **Substrate epics → trace-first, spec-as-hypothesis.** Senior-dev (Opus) owns
   the trace; the architect documents the *confirmed* mechanism.

4. **One-shot enqueue, never re-enqueue.** No merge-queue churn this session.

5. **The dedicated PR-queue shepherd role held.** Driving open PRs to merged as
   a standing teammate (vs ad-hoc lead attention) kept the queue moving without
   stranding green PRs.

---

## Mid-sprint correction — M3 cluster composition

The earlier "168-row functor lap" framing for #2580 M3 was wrong. The real lever
is the **`Object.defineProperty` accessor cluster (181 of 266 files)** plus the
already-closed `__make_callback` leak; the functor `.prototype=` lap is only
**51 files** and is the **hardest / last** slice (escape-analysis-gated, with a
real #1888-floor-eject risk). s66 sequences M3 by that corrected composition —
accessors first, functor-lap last — not by a row-count lap.

---

## Carry-over

The 32 not-done `sprint: 65` issues were moved into [sprint-66.md]
(`plan/issues/sprints/66.md`). They are the architecture-continuation slate:
the #2580 value-rep spine (M3→M4), the IR effect-model lane (#1373b/#2134/#2135/
#2138/#2140/#2141), async/Promise (#1042/#2613/#2614), Proxy (#1355/#2618), the
standalone residual tails, and the type-oracle / pipeline refactors.
