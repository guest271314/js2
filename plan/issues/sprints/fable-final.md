---
sprint: fable-final
model: fable
starts: 2026-07-17T21:00Z
ends: 2026-07-19T21:00Z
horizon: 2 days
strategy: spec-first
---

# Fable Final Sprint — spec-first (frontier design, Opus builds)

**Window:** starts ~21:00 UTC 2026-07-17 (in ~2h), runs 2 days → ~21:00 UTC 2026-07-19.
**Model:** `fable` (frontier).

## Strategy — Fable specs, Opus implements

The frontier model is the scarce, expensive resource; spend it on the
**design bottleneck**, not on typing. The preceding Opus sweep proved the split:
Opus implemented cleanly wherever an implementation plan existed (#684, #1032,
#2961) and **only** deferred issues that lacked a spec or needed live design
decisions (#802, #3108, #3337, #1378-B, #2690, #2916 …). So the highest-leverage
use of the last Fable window is a **spec factory**:

> **Fable writes the `## Implementation Plan` for each hard issue → Opus
> implements it in a follow-on wave.**

A good spec is exactly what converts an "architect-only" issue into an
Opus-implementable one, and Fable can spec **many more** issues in 2 days than it
could build directly — a throughput multiplier. Only the **deepest few**, where
design and implementation are inseparable (CPS lowering, frame suspension,
ABI-wide value-rep), should Fable implement itself.

Two tracks, encoded per-issue in the `fable_role:` frontmatter field:

- **`fable_role: spec`** — Fable produces a complete, Opus-actionable
  `## Implementation Plan` (exact functions, files, Wasm patterns, edge cases,
  test plan, regression risks). Does **not** implement. → feeds the Opus wave.
- **`fable_role: implement`** — Fable designs *and* builds it; irreducible
  frontier complexity + high in-implementation regression risk.

### What "done" means this sprint
- A `spec` issue is **done for Fable** when its `## Implementation Plan` is
  written and the issue is flipped `status: ready` (Opus-dispatchable). Fable
  does NOT open a code PR for it.
- An `implement` issue is done the normal way (code PR merged).

---

## Track I — Fable implements directly (8) — deepest substrate

The async engine + value-rep ABI. Design and implementation are inseparable;
a spec wouldn't de-risk the build enough for Opus.

- **#1373** — IR async Phase C: CPS lowering for await + async-return (the shared async engine; everything below depends on it)
- **#2895** — standalone genuinely-pending await → true frame suspension
- **#2570** — lazy/suspending async-generator runtime
- **#2865** — standalone Wasm-native async-generator / for-await carrier
- **#2662** — retire the host (gc) EAGER-buffered generator backend (fixes default lane too)
- **#2039** — (CRITICAL) standalone invalid-Wasm residual bucket
- **#2773** — [EPIC] value-rep substrate: retire externref boxing
- **#745** — tagged-union representation (the concrete #2773 mechanism)

## Track S — Fable specs → Opus implements (21)

Design is the whole difficulty; once spec'd these are tractable Opus builds.
Fable's deliverable is the `## Implementation Plan` per issue.

**Umbrellas (Fable decomposes into spec'd, Opus-dispatchable children):**
- **#3178** — retire the generator/async/Promise HOST machinery (standalone) — top conformance lever
- **#2860** — close the standalone-vs-js-host test262 gap (~20k) — scoreboard

**Standalone builtins / MOP / prototype representation:**
- **#2963** reify builtins as first-class values · **#2651** builtin ctor+prototype as value · **#2175** builtin-prototype object representation · **#2916** native `instanceof` + intrinsic identity · **#2917** native `class extends <Builtin>` super · **#2622** native `extends Set/Map/WeakMap` · **#2984** gOPD-on-builtin descriptor MOP · **#3037** object-identity canonicalization · **#3053** unified dynamic-reader carrier · **#3055** `any === any` boxed-number equality

**Value-rep extensions (on top of the Track-I #2773 substrate):**
- **#2141** retire tag-5 box-the-externref ABI · **#2106** undefined observability (UNDEF_F64) · **#2763** instanceof value-rep (cross-realm / dynamic Function.prototype)

**Property model + re-routed from the Opus sweep:**
- **#739** Object.defineProperty correctness (262 tests) · **#802** dynamic prototype (Object.setPrototypeOf; spec the conditional-`$__proto__` struct-layout change + the #799a −2,788-regression avoidance) · **#1378** Error-subclass fidelity (sub-issue B) · **#2690** param-type widening in usage-inference (JS/allowJs monomorphization) · **#1046** separate ES-module compilation · **#3108** decompose the `ensure*` giant emitters (spec module boundaries; Opus does the mechanical move) · **#3196** de-inline standalone dynamic-HOF onto steppers · **#3337** WASI `args_get` argv materialization

---

## Opus follow-on wave (after / overlapping the spec track)

As each Track-S `## Implementation Plan` lands (`status: ready`), it becomes an
Opus-dispatchable task. Run a standard Opus fleet against the spec'd issues
exactly like the preceding sweep — coordination-checked, contained per the spec,
one PR per issue/slice. This is where the volume of implementation happens; the
Fable specs are the force multiplier that makes it safe. Tag spec-completed
issues `sprint: current` to feed the Opus TaskList.

## Audit — leverage ranking (unchanged; drives which specs come first)

| Rank | Theme | Track | Why |
|------|-------|-------|-----|
| 1 | Standalone async/generator/Promise host-machinery retirement (#3178) | I (engine) + S (children) | Largest test262 gap (5,715 leak records); frontier-only build |
| 2 | Standalone builtins-as-values + prototype/MOP (#2963/#2916/#2651…) | S | Unblocks a large standalone cluster; ideal spec→Opus |
| 3 | Value-rep substrate — retire externref boxing (#2773/#745) | I | Foundational; every boxed-value bug traces here |
| 4 | Property/MOP correctness (#739 / Proxy #1355) | S | Countable wins once spec'd |
| 5 | Monomorphization + whole-program type-flow (#773/#743) | S | Critical architecture; too cross-cutting for un-spec'd Opus |

**Sequence the specs by leverage:** Fable writes the #3178-cluster + builtins/MOP
specs first (biggest Opus wave), while a second Fable track implements the async
engine (#1373/#2895) and value-rep substrate (#2773). #2039 (critical) slots in
early.

## Logistics

- **Dispatch:** issues are tagged `sprint: fable-final` + `model: fable` +
  `fable_role: spec|implement`. Fable agents pull `fable_role: spec` first
  (multiplier), plus the Track-I implement issues.
- **Two Fable tracks that don't collide:** Track-A = spec factory (builtins/MOP/
  property); Track-B = async-engine + value-rep implementation.
- **Guardrails (carried from the Opus sweep):** never `git stash` (shared
  worktree stack); push to the `fork` remote; direct `prettier` binary (RTK
  masks it); coordination-check both remotes + sibling assignees; PRs to
  `loopdive/js2` base `main`; watch merge-queue baseline staleness (a manual
  "Baseline Refresh (scheduled + emergency)" dispatch clears a deadlock).

## Appendix — role assignment (29 tagged)

- **implement (8):** #1373 #2895 #2570 #2865 #2662 #2039 #2773 #745
- **spec (21):** #3178 #2860 #2963 #2651 #2175 #2916 #2917 #2622 #2984 #3037
  #3053 #3055 #2141 #2106 #2763 #739 #802 #1378 #2690 #1046 #3108 #3196 #3337

(#1046 was not in the initial 29 tag pass — include it when tagging. The full
open `model: fable` inventory is ~42; the ~130 hard/max candidates beyond these
become Opus work once Fable spec coverage extends in future windows.)
