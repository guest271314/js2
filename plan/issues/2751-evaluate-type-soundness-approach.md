---
id: 2751
title: "Evaluate whether our APPROACH to type soundness is itself sound (meta-evaluation of the #2698/#2750 strategy)"
status: ready
created: 2026-06-27
updated: 2026-06-27
assignee: ""
priority: high
feasibility: medium
reasoning_effort: high
task_type: research
area: architecture
language_feature: type-soundness
goal: platform
sprint: current
es_edition: n/a
parent: 2698
related: [2698, 2750, 2748]
origin: "Stakeholder directive (2026-06-27): distinct from #2750's implementation scope — evaluate whether the chosen STRATEGY (force sound TS settings + defensively patch the unsound holes) actually guarantees JS-runtime-correctness, or only shrinks the surface."
---

# #2751 — Is our type-soundness _approach_ itself sound? (evaluation charter)

> **Research / evaluation charter — the question to be worked, NOT solved here.**
> Distinct from **#2750** (which _implements_ the sound-settings + codegen-
> obligation plan). #2751 steps back and asks whether that _strategy_ is the right
> one. Deliver a **written assessment + a recommendation**, not code.

## The question

js2wasm lowers based on the static TS type — it chooses the Wasm value-rep
(packed `f64`/`i32` vs boxed `externref`) and constant-folds branches from the
declared type. #2698/#2750 propose: **force sound TS settings, then defensively
handle the unsound holes**. Does that strategy actually **guarantee
JS-runtime-correctness**, or only **reduce the surface** of miscompiles? What is
the residual risk, and is there a fundamentally safer model?

## Frame (evaluate each; do not pre-judge)

1. **Guarantee vs surface-reduction.** Does "sound flags + patch known holes"
   _guarantee_ correctness for any checker-accepted program, or just lower the
   probability? Characterize the **residual** — the set of accepted programs that
   still miscompile after #2750 lands.

2. **The core model choice.** Is "**trust TS types, patch the known holes**" right,
   or should the codegen treat TS types as **optimization hints, never a
   correctness contract** — i.e. a **JS-semantics-first** lowering that is correct
   for ANY input the checker accepts, _regardless of declared types_, and uses
   types only to choose a faster rep when it can _prove_ the value matches?
   - **Canonical tension (from #2750, empirically grounded):** `const a: number[] = [1,4,5]; a[4]` is typed `number` but is `undefined` at runtime. Today our
     lowering returns a **sNaN sentinel** (number), `false` (boolean), or **`null`**
     (externref) — **never `undefined`** (verified on current main; see #2750
     Prong 2 #1). So "trust the type" is _already_ insufficient for index access,
     **with strict flags on**. This is the strongest evidence for the
     hints-not-contract model.

3. **Un-closeable-by-flags categories.** Enumerate the unsoundness that **no flag**
   can fix and therefore **must** be codegen-defensive:
   `as` / `as any` / `<T>` assertions; structural-typing escapes; declaration
   merging; `// @ts-ignore` / `// @ts-expect-error`; `JSON.parse(...) as T`;
   `any` re-narrowing; function/method param bivariance (the method-param residue
   `strictFunctionTypes` leaves); external `.d.ts` lying about a host value
   (#2698's "type against the REAL host surface" amplifies this — the declared host
   type may not match the linked runtime). For each: is it defensible cheaply, or
   does it force a value-rep decision?

4. **Enforceable invariant + how to test it.** Propose the _one_ invariant the
   compiler should hold, e.g.: **"every program the checker accepts runs with JS
   semantics."** Design a test for it — a **differential / fuzz harness**:
   generate or sample checker-accepted programs (incl. deliberately-unsound ones:
   OOB reads, lying assertions, optional-absent reads), run wasm output vs a
   reference JS engine (Node/V8), assert observable equality. Specify what
   "observable" means (return value, stdout, thrown type) and where sentinels
   (sNaN, `null`-for-`undefined`) would be caught.

5. **Honest verdict criterion.** Land on one of:
   - **Stay the course** — strict-flags-everywhere + per-hole patches is a
     _complete_ solution (defend why the residual is empty/acceptable);
   - **Partial mitigation** — it shrinks but does not close the surface; pair it
     with a JS-semantics-first fallback on the rep-sensitive paths;
   - **Redirect** — the real principle is **"never trust the type system for a
     runtime correctness decision"**; types are optimization hints guarded by
     runtime checks (`ref.test`/brand) with a JS-semantics default. Strict flags
     then become a _performance_ lever (more provable fast-reps), not a
     _correctness_ mechanism.

## Inputs

- **#2750** findings — especially the empirical OOB result (the index-access case
  proves "trust the type" already breaks today). Read its Prong 2 catalog as the
  starting list of holes.
- **#2748** — the strictNullChecks miscompile that motivated the whole track.
- **#2698** — "type against the REAL host surface, satisfy at link time": note it
  _widens_ the lying-`.d.ts` risk class (declared host type ≠ linked runtime), so
  it is a direct input to category #3.

## Acceptance

A written assessment that (1) characterizes the **residual** miscompile set after
#2750, (2) takes a position on hints-vs-contract using the OOB evidence,
(3) lists the un-closeable categories that must be codegen-defensive,
(4) proposes the enforceable invariant + a concrete differential/fuzz test design,
and (5) gives an honest verdict: **stay the course / partial mitigation /
redirect to JS-semantics-first** — with the reasoning. No implementation; this
charter feeds a later architecture decision.
