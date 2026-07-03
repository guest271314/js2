---
id: 2140
title: "stack-balance fixBranchType: coerce-where-possible, throw on impossible (split of #1858-C1)"
status: done
completed: 2026-07-02
assignee: ttraenkler/dev-2875f
blocked_by: [] # 2167 moot — Fable available (owner directive 2026-07-02)
sprint: 69
created: 2026-06-12
updated: 2026-07-03
follow_up: 2991 # unconditional-throw promotion (staged; needs measured-zero evidence)
priority: critical
feasibility: hard
reasoning_effort: max
model: fable
task_type: bugfix
area: compiler
language_feature: compiler-internals
goal: correctness
related: [1858, 2090, 1917]
origin: "2026-06-12 sprint-62 architecture analysis (quality workstream N2); complete implementation plan already written in #1858's 'C1 implementation notes' tail"
---

# #2140 — the keystone silent-wrong-answer mechanism

## Problem

`src/codegen/stack-balance.ts:709-755` (`fixBranchType`) silently
substitutes `drop; f64.const 0` for externref→f64 (`:725-731`) and ref→f64
(`:738-743`) mismatches, while `callArgCoercionInstrs` correctly calls
`__unbox_number` for the same conversion — so a coercion's runtime value
depends on which syntactic context triggered it. This amplifies every
upstream codegen bug into a silent wrong answer instead of a loud failure.
Distinct from #2090 (the `:812` null-patch site).

## Approach

Verbatim from #1858's "C1 implementation notes": thread
`boxNumberIdx`/`unboxNumberIdx` into `fixBranch`→`fixBranchType`; add
coercion arms first; measure CI test262 delta; then convert impossible arms
to a structured compile error.

## Acceptance criteria

- The `()->f64` + `ref.null.extern` repro returns the boxed value or throws
  at compile time.
- test262 delta measured and net ≥ 0.
- No remaining "lossy but valid" comment in fixBranchType.

## Notes

Fable/senior-routed — measured-rollout judgment required. Coordinates with
#1917 Step 0 (which unifies the same coercion tables); land Step 0 first
so this change writes rows into one table, not a fourth copy.

## Reground + Implementation Plan (dev-2875f, 2026-07-02)

**Much of the original scope already landed.** #1917 Step 0 (merged) added
`src/codegen/coercion-plan.ts` — the single ValType table — and
`fixBranchType` now consults it (the headline externref→f64 / ref→f64 lossy
`drop; f64.const 0` arms are GONE; box/unbox idxs are threaded through
`fixBranch`→`fixBranchType`). #1918 (done) added the fixup telemetry
(`recordFixup`/`FixupKind`), the `JS2WASM_STRICT_BALANCE` warn/error mode, and
the `check:stack-balance` corpus ratchet (`scripts/stack-balance-baseline.json`;
today: default-value-lossy 42, call-arg-coerce 7, drop-excess 2, others 0).
AC#3 ("no 'lossy but valid' comment") is already satisfied on main.
Coordination check (2026-07-02): sendev-eq has NO open #1917 PR; Step 0 +
engine slices E3/E6 etc. are merged — this change writes into the landed
table, no fork.

**What is actually still broken (this PR):**

1. **Standalone lane gap — the coerce arms silently don't fire.**
   `stackBalance` finds `__box_number`/`__unbox_number` by scanning
   `mod.imports` ONLY. In standalone/WASI these are DEFINED functions
   (UNION_NATIVE_HELPER natives), so `unboxNumberIdx` is null there → the
   externref→f64 plan row returns null (fall-through, no coerce) and ref→f64
   takes the lossy-NaN fallback row. The audit's "context-dependent coercion"
   is thus STILL live in the standalone lane. Fix: also scan `mod.functions`
   by name (defined idx = numImports + position).
2. **`plan.lossy` is dropped at the record site.** `fixBranchType` records
   `branch-type-coerce` with `lossy=false` unconditionally — the plan's lossy
   rows (funcref→externref; ref→numeric without unbox helper) are mis-reported
   as clean. Propagate the flag.
3. **Unfixable mismatches are silent.** The `return 0` fall-through leaves a
   known type mismatch in the body → the module fails `WebAssembly.validate`
   later with an opaque offset-only error. New `FixupKind:
   "branch-type-unfixable"` recorded (lossy) at the fall-through — visible in
   the per-compile summary, a hard error under `JS2WASM_STRICT_BALANCE=error`,
   and ratcheted by the corpus gate (baseline row 0). Measured rollout: NOT an
   unconditional compile error yet — `inferLastType` inference is heuristic,
   and today a wrong inference at this site is a harmless no-op; promoting to
   an unconditional throw is the follow-up once the corpus row and a CI test262
   delta prove 0 occurrences (exactly the issue's staged approach).
4. **Coverage: any-hierarchy rows.** Table extension (the ONE table, per the
   #1917 coordination note): widen the `ref/ref_null → f64/i32` unbox rows to
   accept `eqref`/`anyref` (same any-hierarchy, same `extern.convert_any` +
   `__unbox_number` sequence). fixBranchType cast arm: produced
   `ref/ref_null/eqref/anyref` → expected concrete `ref/ref_null #N` via
   `ref.cast_null #N` (no extern round-trip — same hierarchy), mirroring the
   existing externref→ref arm.

**Deferred (documented, not this PR):** propagating `plan.lossy` through
`callArgCoercionInstrs`'s `Instr[]` return to the call-arg/local-set/
struct-field record sites (flag-only telemetry gap — the events ARE recorded,
just not flagged lossy); eliminating the 42-count `default-value-lossy`
bucket (each is a distinct producer bug — that's the #1918 ratchet's long
game, not a fixup-pass change); the unconditional throw promotion (needs the
measured-zero evidence above).

**AC#1 note:** the `()->f64` + `ref.null.extern` repro is an emitter-bug
simulator, not reachable from TS source — validated by unit tests driving
`stackBalance` directly on hand-built modules (with and without an
`__unbox_number` import/defined function), asserting the appended instruction
sequence, `WebAssembly.validate`, and the recorded events / strict-mode
diagnostics.
