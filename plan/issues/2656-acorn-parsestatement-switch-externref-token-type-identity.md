---
id: 2656
title: "acorn parseStatement: switch(this.type) on an externref token-type fails === identity vs the tt singleton → infinite re-entry (7th dogfood blocker)"
status: ready
sprint: 66
created: 2026-06-24
updated: 2026-06-24
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: switch
goal: acorn-dogfood
related: [1712, 2608, 2655, 2063]
depends_on: [2655]
origin: "Surfaced by sd-acornloop while root-causing the acorn tokenizer hang (#2655/PR #2038). Masked behind #2655 until that lands; documented as a follow-up note in #2655, promoted here to a tracked issue."
---

# #2656 — acorn `parseStatement` switch on an externref token-type never matches its `tt` singleton

## Problem

This is the **7th acorn-dogfood blocker**, exposed once #2655 (PR #2038) fixes the
tokenizer `this.pos` read/write storage divergence so `parse()` advances past
`readWord1` into `parseStatement`.

In acorn, `parseStatement` does `switch (this.type) { case types._var: … }`, where
`this.type` is a **token-type object** (an externref-typed value) and `types._var`
(`tt._var`) is a **module-level singleton**. The compiled `switch` compares the
externref against the singleton by `===` **reference identity**, and the match
**fails** — no `case` is selected, the default path re-enters, `next()` is never
called, and `parseStatement` loops forever.

Observed (per-process, after #2038, on `parse("var x = 1;")`): `PARSESTMT type=var
pos=3` repeats indefinitely; the token is correctly `var` and `pos` is correct
(so this is *not* #2655 or the #2608 empty-input loop), but the `switch` never
dispatches to the `var` case.

## NOT a duplicate of #2063

#2063 (`switch-strict-equality-violation`, **done**, sprint 61) is the *inverse*
class: it was about **primitive cross-type coercion** in `switch` (`switch(true){case
1:}`, `"1"` matching `case 1:`). This is **object/externref reference identity** —
two references that should be `===` (the token-type value and its singleton) are
not recognized as identical in the compiled `switch` dispatch. Different root
cause, different fix.

## Root cause (to confirm/extend before fixing — verify-first per-process)

The compiled `switch`-on-externref dispatch does not establish reference identity
between the token-type value flowing through the tokenizer and the module-level
`tt.*` singleton it is compared against. Candidate mechanisms (decode the WAT for
the `parseStatement` switch + the `tt._var` singleton construction):
- the token-type singleton is re-materialized (a fresh struct/externref per read)
  instead of canonicalized, so `ref.eq` / `===` is structurally-distinct;
- the `switch` lowers the case comparison via a value/coercion path rather than
  `ref.eq` on the externref;
- a boxing/extern-convert roundtrip on one side breaks identity.

## Acceptance

- `parse("var x = 1;")` dispatches into the `var` case of `parseStatement` and
  returns a `Program` AST (the #1712 differential-AST gate becomes runnable on the
  first fixture).
- A reduced unit repro: a `switch` on an externref whose case is a module-level
  object singleton selects the matching case.
- Full merge_group / test262 (switch-dispatch is a broad-impact path).

## Notes

- Blocked on #2655/PR #2038 landing (the tokenizer must advance to reach
  `parseStatement`). Pick up once #2038 is on main.
- This is the next wall on the acorn dogfood path (#1712); 6 prior blockers
  cleared (#1712 blockers 1-3, #2582, #2608, #2655).
