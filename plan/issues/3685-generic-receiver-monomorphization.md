---
id: 3685
title: "perf: generic receiver monomorphization — generalize #3683's typed-`this` beyond `this`"
status: ready
created: 2026-07-27
updated: 2026-07-27
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: perf
area: codegen
language_feature: compiler-internals
goal: performance
sprint: current
related: [3683, 3673, 1947, 1946, 1584, 1852, 2660]
---

# #3685 — Generic receiver monomorphization

## Problem

#3683 proved the mechanism on ONE receiver: `this` inside a write-once
fnctor prototype method. Measured on compiled acorn, that program
delivered a ~20 % wall-clock win (S3 alone: method-call bridge 18.1 % →
9.6 % self time) and, just as importantly, made Binaryen effective for the
first time — `-O3` was worth ~0 % before #3683 S2, ~5 % after S2, and
**7.1 % after S3** (#3673 rounds 27/30), exactly the "cast removal +
devirtualization start firing" outcome #1947 predicted.

But the mechanism stops at the `this.` prefix. The #3673 round-26 profile
shows what that leaves on the table:

- **`__extern_get` 8.8 % self time** — property reads whose receiver is
  *not* `this`: `node.start`, `parser.options.locations` (once per AST
  node, from `Node`'s constructor), `state.pos`, `refDestructuringErrors.
  shorthandAssign`. Every one is a call returning a boxed value, where the
  `this.` form is a bare `struct.get` of an f64 slot.
- The residual call machinery after S3/S3b — a call whose *callee* is
  proven but whose *receiver* expression is a local, parameter, or field
  rather than `this`.

Both are the same missing capability: **prove that an arbitrary expression
denotes an instance of a known fnctor/class struct, then reuse the
lowering #3683 already built.**

## Scope

Generalize the receiver proof, NOT the lowering — the lowering exists:

1. **Receiver-flow analysis** (new, standalone module — the "land the
   analysis inert first" pattern that worked for `numeric-property-
   analysis.ts` and `user-method-names.ts`). For each expression position,
   answer: is this provably an instance of exactly one registered fnctor
   struct? Sources of proof, cheapest first:
   - a `new F(...)` result flowing to a `const`/never-reassigned `let`;
   - a parameter whose every call site passes such a value (acorn's
     `Node(parser, …)` — `parser` is always `this` at the call site);
   - a field read whose slot is typed `(ref $__fnctor_F)`;
   - `this` itself (subsumes #3683's case as the degenerate one).
   Everything unproven falls back to today's dynamic path — no exceptions,
   no runtime name guards.
2. **Read/write lowering**: a proven receiver + a declared field of that
   struct → `ref.cast` + `struct.get`/`struct.set`, composing with #3683
   S4a's f64 slots so a numeric field read is unboxed end to end.
3. **Call lowering**: a proven receiver + a write-once method of that
   class → the #3683 S3 direct-call trampoline, unchanged.
4. **Guard placement**: one `ref.test` per receiver *binding*, not per
   access — the win is destroyed if each field read re-tests.

## Non-goals

- Speculative/deoptimizing specialization (V8's model). Everything here
  stays statically proven with a dynamic fallback.
- Changing the boxed representation of unproven values — that is #1947
  (externref laundering) and #1584/#1852 (value representation), which
  this issue composes with rather than replaces.

## Why now

The #3673 scaling decomposition (round 27) showed the remaining gap to
node-acorn is **entirely per-byte throughput** (32.5x/KB, size-independent)
and that ~two thirds of it is the parser's own compiled bodies, not runtime
helpers. Receiver monomorphization is the largest identified lever inside
those bodies, and #3683 has already paid the cost of building the lowering
and the admission machinery it needs.

## Slices

- **S1 — receiver-flow analysis, inert.** New module + unit tests + a
  debug tally over compiled acorn ("how many read/call sites would this
  admit, by proof source"). No lowering change; safe to land alone.
- **S2 — read/write lowering** for proven receivers (composes with #3683
  S4a f64 slots). Gate: the #3673 acorn corpus + full equivalence diffed
  by name.
- **S3 — call lowering** through the #3683 S3 trampolines.
- **S4 — binding-level guard hoisting** (one `ref.test` per binding).

## S1 result (2026-07-27) — analysis landed inert

`src/codegen/receiver-flow-analysis.ts` + 17 pins. **Tallied over real
acorn (226 KB), the analysis was rebuilt three times against the tally —
each rebuild driven by a shape the unit tests did not have:**

| iteration | verdicts | non-`this` accesses admitted (of 2,363) |
| --- | --- | --- |
| initial rules (const + params + this) | 0 | **0** |
| + prototype-ALIAS map | 3 | 20 |
| + return-class inference, `var` bindings, call-return initializers | 50 | **150** |

Three findings worth keeping:

1. **The direct `F.prototype.m = …` form is essentially absent from
   shipping code.** acorn's dist has NINE `var pp$N = Parser.prototype`
   aliases and assigns every method through one. The first tally admitted
   literally zero receivers for this reason alone — the unit tests used
   the textbook form. Any future analysis in this family must model
   aliases from the start.
2. **`const`-only admission is worthless on real code.** acorn's dist is
   ES5 `var`. Safety now comes from the DEMOTION pass (any binding written
   after its initializer is withdrawn), not from the declaration keyword —
   which is both stronger and applicable. Pinned both ways.
3. **Return-class inference is what unlocks the dominant shape.**
   `var node = this.startNode()` → `finishNode(node, …)` is how acorn
   moves Nodes around; without it, every `node` parameter and binding is
   unproven. Requires a fixed point (a return can depend on a parameter
   verdict) and must refuse any method with a bare `return` path.

Admitted classes: `Node` 130 accesses, `Parser` 20 — i.e. exactly the
per-AST-node `node.start`/`node.end` traffic the profile blamed. The
2,213 still-unproven accesses are dominated by `this.options.<x>` (a
FIELD read — an explicit S1 non-goal, needs the slot's declared type)
and by `state.<x>` in the RegExp validator (a parameter whose call sites
pass a field read). Both are S2-or-later work.

Cost: 365 ms for 226 KB, single pass, no checker queries.

## Acceptance criteria

- `__extern_get` self time on the #3673 deep-warm acorn profile drops
  materially (target: below 4 %, from 8.8 %).
- Devirtualization/inline tallies reported per slice, as #3683 did.
- Every slice measured with #3673's duplicate-baseline control-arm
  methodology; a delta inside the control band is reported as
  indistinguishable from zero.
- No new host imports; standalone canaries keep `imports: ZERO`.
- Full `tests/equivalence` failure set identical by test NAME to the
  merge parent.
