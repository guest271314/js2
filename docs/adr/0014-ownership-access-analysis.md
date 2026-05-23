# ADR-0014: Ownership and access-semantics analysis on IR values

Status: Accepted

## Context

The typed SSA IR (ADR-0012) with explicit allocation sites (ADR-0013) gives a
stable place to attach per-value facts, but nothing yet *computes* them.
Several compiler enhancements want to know, for each value: how many references
exist, whether the value outlives the current function, and how it is used
(read / written / compared by identity). Today each would re-derive this ad hoc
or pessimize:

- **Escape analysis** — stack-allocate / scalar-replace allocations that never
  escape.
- **Closure specialization** — read-only captures can be inlined as constants.
- **Built-in dispatch** — skip defensive copies for read-only arguments.
- **Tier-up (#1584)** and **lifetime analysis for a linear-memory backend
  (#1585)** both want ownership facts as a foundation.

JavaScript semantics forbid a Rust-style *rejection* of programs that fail
ownership rules. What we can do is *infer* where ownership and access
properties provably hold.

## Decision

Add a flow-sensitive, intra-procedural, may-escape analysis
(`src/ir/analysis/ownership.ts`) that annotates each IR value with two
independent lattice values (`src/ir/analysis/lattice.ts`):

- **Ownership** — a total order, BOTTOM→TOP:
  `owned ⊑ borrowed ⊑ shared ⊑ escaped`. Join = the more conservative state.
- **Access** — the powerset of `{ read, write, mutate, identity, escape }`
  ordered by ⊆; join = set union.

The analysis is a monotone worklist over the control-flow graph. Allocations
(instrs carrying an `alloc` id, ADR-0013) seed at `owned` / `{}`; imported
references (params, captures, globals) seed at `shared` / `{ read }`. Each
operation widens its operands (field read → `read`; field write → `write` and
the stored value escapes; opaque call / return / capture → operands escape).
States join at CFG merges and across branch-args; the result is the
meet-over-all-paths join.

Results are written to the `AllocSiteRegistry` `ownership` namespace (ADR-0013)
for allocated values and exposed per-function via `OwnershipResult.of(value)` /
`.ownershipOf` / `.accessOf`.

### Conservative defaults (the safety property)

Anything the analysis cannot reason about gets the **TOP** element of each
lattice: `shared` ownership, full access set. **No consumer may assume a
tighter annotation than the analysis returns** — consumers check whether the
result is tight enough for their optimization and otherwise take the
conservative path. This is what makes the pass purely an optimization aid:
removing it cannot change observable behavior.

### Not a borrow checker

"Ownership" here is *inferred classification*, not a *declared type*. Programs
that would fail Rust's borrow checker compile fine; they simply receive
conservative annotations. The Rust framing is deliberately disclaimed.

### Inert + gated

The pass does **not** mutate the IR; registry annotations are inert at
lowering. It runs only behind `JS2WASM_IR_OWNERSHIP=1` during rollout. The
demonstration consumer (`analysis/stack-alloc.ts`) is likewise annotation-only
in Phase 1: it marks proven-`owned`-non-`escaped` small allocations as
stack-allocation candidates without changing the emitted representation. The
actual stack/scalar lowering is a follow-up.

### Phasing

Phase 1 (this ADR): intra-procedural analysis, both lattices, registry
integration, one annotation-only consumer. Phase 2: inter-procedural function
summaries. Phase 3: precision (better loops, conditional refinement,
escape-via-exception) and joint analysis with encoding tracking (#1588).

## Consequences

- Downstream consumers (escape analysis, closure specialization, tier-up,
  lifetime analysis) get a shared, conservative, composable source of ownership
  facts instead of each recovering them.
- Soundness risk is bounded by the conservative-default rule: a precision bug
  costs an optimization, never correctness, as long as no consumer assumes
  tighter-than-returned.
- Arrays/closures/strings are not Phase-1 stack-alloc candidates (kept small and
  conservative); broadening is a follow-up once a dedicated `array.new` IR instr
  lands (ADR-0013 notes arrays route through `object.new` today).
- Prior art: V8 TurboFan escape analysis, SpiderMonkey alias-set analysis,
  Rust MIR borrow analysis — cited for style, not ported.
