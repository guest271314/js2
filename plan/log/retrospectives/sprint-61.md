# Sprint 61 Retrospective

**Sprint**: 61
**Dates**: 2026-06-05 (sprint-61/begin, dcc423c90) → 2026-06-12 (sprint/61, ce737b2cb)
**Theme**: npm-library support + architecture hardening; AnyValue host-bridge cluster

---

## Results

| Metric | Value |
|--------|-------|
| test262 at start (sprint-61/begin) | 30,585 / 43,135 (70.9%) |
| test262 at close (boundary ce737b2cb) | 31,267 / 43,135 (72.5%) |
| Net gain | **+682 passes** (+1.6 pp) |
| Issues marked done | 91 (0 wont-fix) |
| Issues carried to sprint 62 | 84 |

(Close number measured at main HEAD 2026-06-15; the sprint-61 boundary is
ce737b2cb, the parent of sprint-62/begin. Sprint 62 is architecture-focused
with an explicitly-flat test262 headline, so the figure reflects sprint 61's
landed work rather than early sprint-62 contribution.)

---

## What landed

- **AnyValue host-bridge cluster** (#2063 → #2058 → #2059): spec'd (PR #1377 +
  Fable addendum), implemented per-site externref tag dispatch
  (`__host_eq`/`__host_add`/`__host_compare`) — the −788 comparator trap
  structurally avoided rather than patched.
- **Deep-audit queue**: ~45 fixes — optional chaining, spread, switch, block
  scope, for-of/for-in, regex VM PROGRESS/CLEAR opcodes, native strings, linear
  backend %/truthiness/strings/array-growth, IR reordering, fmod, hypot,
  isStaticNaN.
- **Object-literal cluster**: #1971 triage bred #2126–#2132; #2126/#2127/#2128
  fixed same-day; presence-predicate joint spec for #2130 + #1991 (PR #1394,
  staged A→D).
- **Pipeline hardening**: 4 rot mechanisms fixed (cla-check SHA stranding,
  queue-wedge detection, fork-run auto-approval, draft-rot flagging — PR #1408)
  + baseline-meta SHA fix (PR #1413), after three live queue wedges and a
  ~90-run approval strand.
- **Symphony takeover**: claims released; acorn gate (#1712) blocker PR #1345
  un-drafted + landed; ex-Symphony in-review triage carried to 62.
- **Architect specs**: optional-chain undefined representation (PR #1393) and
  presence predicate (PR #1394), both adversarially reviewed.

---

## What went well

- Spec-first discipline on the AnyValue cluster turned a recurring −788
  regression class into a structural fix.
- Pipeline rot was caught and fixed mid-sprint rather than allowed to strand the
  merge queue indefinitely.
- High throughput: 91 issues closed in a week-long cycle.

## What to improve

- **Wrap-up debt**: sprints 55–60 closed without formal `wrap_checklist`, retro,
  or diary entries; sprint 61's wrap-up itself was completed retroactively on
  2026-06-15. The deterministic `check-sprint-closed.mjs` gate now enforces this
  going forward.
- **Worktree sprawl**: ~90 stale worktrees accumulated across sessions; cleanup
  was deferred. Sprint 62 should budget a sweep.
- **Two-store task drift**: stale tasks in the `js2wasm` team store required
  manual reconciliation at sprint boundary.

## Carry-over to sprint 62 (84 issues)

IR front-end fixes incl. the TCO re-lowering regression; #1965 super() (suspended
mid-work); #1983 name collision (needs discriminator spec); #2119 sourceType
design; #2130/#1991 implementation; acorn #1712 acceptance completion;
linear-backend follow-ups (&&/|| operand values, UTF-16 length); object-literal
residuals; ex-Symphony triage; spec-sweep remainder. Sprint 62 reorganized these
into the "Fable architecture sprint" lanes (value-rep, coercion engine, IR
verifier, single pipeline driver, backend symmetry).
