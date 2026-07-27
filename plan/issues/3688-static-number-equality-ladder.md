---
id: 3688
title: "perf: `a === b` with both operands statically `number` boxes, unboxes, and does an object→string comparison"
status: ready
created: 2026-07-27
updated: 2026-07-27
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: perf
area: codegen
language_feature: operators
goal: performance
sprint: current
related: [3673, 3686, 3685, 1584, 1852, 2109]
---

# #3688 — Static-`number` equality goes through the generic ladder

## Problem

`tk[i] === 40`, where the checker knows **both** operands are `number`,
does not compile to `f64.eq`. It emits:

- **4 × `__box_number`**,
- **4 × unbox**,
- **an object→string conversion and a string comparison**, per evaluation.

Measured while investigating the WasmGC/linear split (#3687): this ladder
— not the null-check/cast scaffolding of #3686 — is the GC lane's real
~5x on tokenizer-shaped code. A tokenizer compares the current character
against literal codes on *every* token (`=== 40`, `=== 41`, `=== 32`,
`=== 44`, digit and letter range tests), so this is squarely on the
hottest path any parser has.

For scale, from the #3673 ladder: our compiler runs the typed tokenizer
at ~0.100 ms where node does ~0.033 ms and a hand-written WasmGC
equivalent does ~0.015 ms. #3686's scaffolding was priced at +10-16 %;
this is a multiple, and it is the larger prize.

## Why it happens

Equality lowering is generic: it routes through the runtime's
`__any`-style comparison path that must handle any pair of JS values
(§7.2.15 Strict Equality — number/string/boolean/object/null/undefined,
`-0`/`NaN` rules, and the `$AnyValue` tag lanes). That path is correct
and necessary when the operand types are unknown. The defect is that a
site where the checker has already proven BOTH operands are `number`
still pays for it, instead of narrowing to a direct `f64.eq` (or `i32.eq`
once #3673's i32 work lands).

Note the shape of the bug: the boxing is not the whole cost. An
object→string conversion plus a string comparison per token means the
generic path is reaching a stringly-typed comparison arm for two
statically-numeric operands — worth understanding precisely before
optimising, because it may indicate the fast arms are ordered behind a
slower one rather than simply absent.

## Direction

1. **Diagnose first.** Compile `const a: number = 1; const b: number = 2;
   a === b` and disassemble. Establish exactly which arm is reached and
   why the numeric arm is not, before changing anything. If the numeric
   arm exists but is ordered behind the string arm, the fix is ordering,
   not new lowering.
2. **Narrow at the lowering site** when both operand types are proven
   numeric: emit `f64.eq` directly (with the `-0`/`NaN` semantics of
   strict equality — `NaN !== NaN` and `+0 === -0`, which `f64.eq`
   already gives). Compose with #3673's i32 work: when both sides are
   proven i32, `i32.eq`.
3. Apply the same treatment to the other comparison operators
   (`!==`, `<`, `<=`, `>`, `>=`) if they share the ladder — check, do not
   assume. #2109 fixed a related comparison defect and is the precedent
   for how the narrowing was done there.

## Non-goals

- Changing generic equality for genuinely dynamic operands.
- Any deviation from §7.2.15 for `NaN`, `-0`, or mixed-type comparison.

## Acceptance criteria

- `a === b` with both operands statically `number` emits no
  `__box_number`, no unbox, and no string comparison — verified by
  disassembly, not inference.
- Measured on the #3673 harnesses (`.tmp/tokenize-only.mjs`,
  `.tmp/parser-shootout.mjs`, `.tmp/simd-shootout.mjs`) against the
  established ladder (node ~0.033-0.035 ms · hand-written WasmGC ceiling
  ~0.015 ms · ours ~0.100 ms), with a duplicate-baseline control arm and
  the control band reported.
- **Whole-chain or negative** — the #3673 law, confirmed four times
  (#3683 S4a's f64 fields ~1 %; round 33's peephole never fired; round 36
  measured partial narrowing as a **2.7x pessimization**). If narrowing
  the comparison leaves its operands boxed elsewhere, it can measure
  worse. Verify the whole chain or do not land it.
- Full `tests/equivalence` failure set identical by test NAME; corpus 0
  real gaps; canaries `imports: ZERO`. Equality/`-0`/`NaN` conformance
  pins added.
