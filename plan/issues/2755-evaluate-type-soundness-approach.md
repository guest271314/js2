---
id: 2755
title: "Decide the type-soundness approach: trust-the-type-and-patch vs JS-semantics-first"
status: done
sprint: 69
created: 2026-06-28
updated: 2026-07-03
completed: 2026-06-28
decision: hybrid
priority: high
feasibility: medium
reasoning_effort: high
task_type: decision
area: codegen, checker, type-system
language_feature: none
goal: correctness
owner_role: product-owner
related: [2698, 2748, 2750, 2754]
---

# #2755 — Decide the type-soundness approach (direction call)

> **This is a DECISION issue, not an implementation issue.** It exists so the
> project lead / stakeholder picks ONE of two directions before more code is
> written under the #2698/#2750/#2754 "soundness" track. The #2750 S2 slice
> surfaced concrete evidence that the two directions diverge in practice — that
> evidence is captured below as the deciding data point.

## Background

TS is **deliberately unsound** in several places (array index access, `as`
casts, covariant arrays, `any`, bivariant method params, …). This compiler
*lowers TS types to Wasm value representations*, so wherever it **trusts a TS
type that does not hold at runtime**, it can emit a Wasm binary that computes the
wrong answer (a miscompile), not merely a type error. #2748 was the canonical
incident: a `T | null` collapse folded null/undefined guards and produced an
infinite-loop miscompile; the fix pinned `strictNullChecks`.

The #2698/#2750/#2754 track generalized that point-fix into a policy with two
prongs:

1. **Prong 1 (type-level):** force the *sound* TS flags ON for both `.ts` and
   `.js` (e.g. `strict: true`), so the checker hands codegen the most accurate
   types it can. (This is **#2750 S1**, landed on PR #2205 — corpus-byte-neutral,
   uncontroversial, and orthogonal to the question below.)
2. **Prong 2 (codegen-level):** enumerate the remaining unsoundness holes (the
   ones no flag closes — array OOB, etc.) and **patch each hole in codegen** so
   the emitted Wasm matches JS runtime semantics. (This is **#2750 S2…S5**.)

**The question this issue decides is about Prong 2's *shape*.**

## The two directions

### Direction A — "trust-the-type-and-patch" (the current #2750 plan)

Keep lowering on the TS type, and close the known unsoundness holes one at a time
in codegen (S2 = externref-array OOB → `undefined`; S5 = packed `T|undefined`
representation; etc.). The type stays a **correctness contract**; we audit and
patch the places where the contract is a lie.

- **Pro:** preserves the type-directed codegen that makes this compiler fast
  (packed `number[]`, monomorphic struct fields, no boxing) — most of the perf
  story depends on trusting types.
- **Pro:** incremental; each hole is a small slice.
- **Con:** the hole catalog is **open-ended and not obviously enumerable** — you
  only learn a hole exists when a test regresses. Each patch risks perturbing a
  shared path (see the data point below).
- **Con:** "sound flags + patch the holes" gives **no guarantee** of
  JS-runtime-correctness; it reduces the surface without bounding it.

### Direction B — "JS-semantics-first"

Treat TS types as **optimization hints, never a correctness contract**. Codegen
defaults to JS-runtime-correct behavior; a type only *unlocks a faster lowering*
when the compiler can prove (or the mode asserts) the value can't escape the
type. Where it can't prove it, fall back to the dynamic/`any`/externref path that
is correct by construction.

- **Pro:** correctness is the **default**, not a property you chase hole-by-hole.
  No open-ended catalog.
- **Pro:** matches the dual-mode architecture (the dynamic path already exists).
- **Con:** large refactor of the type-directed fast paths; risks regressing perf
  unless the "prove it's safe to specialize" analysis is good.
- **Con:** the boundary "when is it safe to trust the type as a hint" is itself
  subtle — moves the hard problem rather than removing it.

## Deciding data point — #2750 S2's blast radius (concrete evidence)

S2 was the *first* Prong-2 hole-patch attempted: flip externref-array
out-of-bounds reads from `null` to JS `undefined` (`useUndefinedSentinel=true` at
two `emitBoundsCheckedArrayGet` call sites in `src/codegen/property-access.ts`).
It looked surgical. In the merge_group it produced:

- **+7 test262 improvements, −1 regression, net +6** — but it tripped the 10%
  regression-ratio gate (1/7 = 14.3%) and was auto-parked (PR #2198).
- The single regression is **real and PR-caused** (wasm-hash changed; baseline
  content-current): `built-ins/Array/prototype/map/15.4.4.19-8-b-2.js` —
  `Array.prototype.map.call(obj, cb)` on an **array-like whose `length` getter
  side-effect adds `obj[2]` mid-iteration**; `testResult[2]` now returns `2`,
  spec wants `false`.
- Attribution is decisive: the corpus compiles via `test.ts`
  (`tests/test262-runner.ts` → `isJs=false`), so **S1 is a no-op on the corpus**;
  both the +7 and the −1 come from **S2 alone**.

**What this tells us:** a "surgical" OOB sentinel flip did **not** stay confined
to genuine OOB — it perturbed a **generic `Array.prototype.map`-on-array-like**
path. That is exactly the failure mode Direction A's critics predict: patching
one hole shifts a shared representation and opens another. A single data point is
not proof, but it is the strongest available signal that "patch the holes" is
**leaky in practice**, not just in theory.

## Recommendation (senior-developer)

**Hybrid, sequenced — adopt Direction B as the *default/invariant*, keep
Direction A's type-directed fast paths as a *proven-safe optimization*:**

1. **Land Prong 1 unconditionally** (#2750 S1, PR #2205) — sound flags are pure
   upside and direction-independent.
2. **Adopt the Direction-B *framing* as the correctness invariant:** "a TS type
   may only change the emitted Wasm when the value provably cannot violate the
   type at runtime; otherwise lower the JS-correct way." This makes correctness
   the default and turns every existing fast path into a thing we must *justify*,
   not assume.
3. **Re-evaluate each Prong-2 hole-patch (S2…S5) under that invariant** instead
   of as standalone codegen edits. S2 specifically: don't re-land the
   sentinel-flip as-is; either (a) make OOB-correctness fall out of the general
   element-read path (B-style), or (b) prove the flip is byte-identical on every
   non-OOB read before shipping. The map-on-array-like regression must be green
   either way.
4. **Do NOT pursue a full perf-path rewrite up front** — that is the expensive,
   risky part of B and isn't justified by one data point. Convert paths to
   "prove-then-specialize" opportunistically, regression-gated.

Rationale: pure-A is open-ended and leaky (the S2 evidence); pure-B is a large
speculative refactor that risks the perf story this compiler is built on. The
hybrid keeps A's speed where it's *provably* safe and gets B's
correctness-by-default everywhere else.

## Decision (RECORDED — 2026-06-28, project lead)

- [x] **Picked: the HYBRID.** Adopt Direction B as the *default/invariant* and
  keep Direction A's type-directed fast paths only as a *proven-safe*
  optimization.

  > **The hybrid invariant (HI):** *"A TS type may only change the emitted Wasm
  > when the value provably cannot violate it at runtime; otherwise lower the
  > JS-correct way."* Correctness is the default; **specialization must be
  > proven**. Keep type-directed fast paths only where provably safe.

  The merged implementation roadmap is
  [`docs/architecture/hybrid-soundness-ir-roadmap.md`](../../docs/architecture/hybrid-soundness-ir-roadmap.md).
  It binds this soundness decision to the **#1530 IR-migration** finish line:
  the legacy direct AST→Wasm path is the "trust-the-type" approach we are
  retiring; the typed IR (`src/ir/`) is the chokepoint where "prove-then-
  specialize" belongs, so the IR fallback is redefined as *"fall to the SAFE
  JS-correct default, never the legacy trust-the-type path."*

- [x] **Dispositions of the open soundness PRs/issues:**
  - **PR #2198 (S1+S2 code)** — **keep S1** (sound flags, corpus-neutral);
    **rework S2 under HI**. Do **NOT** re-land the shared-helper
    `useUndefinedSentinel` flip (it leaked into the generic
    `Array.prototype.map`-on-array-like path — the deciding data point that
    "patch-the-holes" is leaky). Instead make OOB-correctness **fall out of the
    safe default element-read path** at the `compileElementAccessBody` call sites
    (`property-access.ts:6303,6352`), scoped to the dynamic plain-array value
    read so typed-array / subview / array-method internal callers keep their own
    correct OOB semantics. The map-on-array-like case
    (`built-ins/Array/prototype/map/15.4.4.19-8-b-2.js`) must be green. Tracked
    as roadmap floor fix **F1** → follow-up issue **R1** (see below).
  - **PR #2195 / issue #2754 (the "sound TS settings" spec)** — **revise to the
    HI framing**: Prong 1 stays as-is; Prong 2 is reframed from "enumerate &
    patch the holes" to "SAFE JS-correct default + proof-gated specialization."
    The roadmap doc above is the authority for Prong 2.
  - **#2698 (checker track) — Prong 2 re-scoped to HI.** The codegen Prong-2 work
    is now governed by the roadmap doc, not a standalone open-ended hole catalog.

### Follow-up issues created (sprint: current, status: ready)

These make the first roadmap steps dispatchable (see the roadmap's "Sequencing
summary & follow-up issues" table):

- **R1 — #2760**: floor fix F1 (plain-array OOB → JS `undefined`, HI-style; the
  #2198/S2 rework, NOT the shared-helper flip) + F2 hole-read audit + F3 doc.
- **R2 — #2766**: first IR step — `ElementAccessExpression` under HI: port the
  `safeIndexedArrays` counted-loop in-bounds proof into the IR so `vec.get`
  fires only when in-bounds is proven; otherwise emit the SAFE bounds-checked
  read (F1 reused as the IR SAFE lowering).
- **R3 — #2762**: migration-cost audit as a living checklist — annotate every
  type-directed fast path (roadmap §(d)) with its discharged/undischarged proof
  status; this is the backlog generator for the M/L specialization items.

The `substrate/value-identity` workstream (roadmap §(e): acorn #2681/#2686 +
#1627 class-instance tail + #2740 instanceof clusters) and the sibling
`substrate/closure-box` (#2758 under #2692) are tracked under their own lineages,
not folded together — see the roadmap's §(e) architect verdict.

## Notes

- #2750 S1 (PR #2205) is **independent of this decision** and should land
  regardless — it only forces already-sound flags and is corpus-byte-neutral.
- This issue supersedes the inline "evaluate the approach" research charter that
  PR #2195 tried to add as `2751-evaluate-type-soundness-approach.md` (that id
  collided with the budget-windowed-sprint issue already on `main`; this is the
  freshly-allocated id).
