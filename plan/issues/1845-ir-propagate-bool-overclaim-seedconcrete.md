---
id: 1845
title: "IR propagate: && / || over-claim BOOL; seedConcrete omits i32/u32"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: low
feasibility: low
task_type: bugfix
area: ir
goal: correctness
sprint: 59
---
# #1845 — IR type-propagation minor unsoundness

## Defects
- `src/ir/propagate.ts:615-617`: `a && b` / `a || b` infer `BOOL` whenever operands
  are `boolCompatible` (incl. optimistic `unknown`), but the result is the operand
  value, not a boolean — can seed a non-boolean param/return as `bool`, then
  `lowerBinary` emits `i32.and`/`i32.or` on it.
- `:315-319`: `seedConcrete` is true only for f64/bool/string/object, not i32/u32 —
  currently inert, latent once integer-domain seeding is added.

## Fix
Infer `BOOL` for `&&`/`||` only when both operands are concretely `bool` (treat
`unknown` as dynamic / join); include i32/u32 in `seedConcrete` (or document why not).

## Resolution
`src/ir/propagate.ts`:
- **`&&`/`||` rule** (was `boolCompatible(l) && boolCompatible(r) ? BOOL : DYNAMIC`):
  `a && b` / `a || b` evaluate to one of the *operand values* (ECMAScript
  §13.13/§13.14), not a coerced boolean. New rule: `BOOL` only when both operands
  are concretely `bool`; if either side is `unknown`/`dynamic` → `DYNAMIC` (can't
  prove the result shape — `join` would optimistically adopt the other side);
  otherwise `join(l, r)` (the tightest sound type for "one of two concrete
  values", e.g. `f64 && f64 → f64`). This stops a non-boolean param/return being
  seeded as `bool` and then lowered with `i32.and`/`i32.or`.
- **`seedConcrete`**: added `i32`/`u32` alongside `f64`/`bool`/`string`/`object`,
  so an integer-domain seed retains authority over an unresolved (`dynamic`) body
  return once integer-domain seeding is enabled (`JS2WASM_IR_I32_DOMAIN=1`).
  Currently latent (the TS checker seeds `number` → `f64`), fixed for correctness.

## Test Results
`tests/issue-1845.test.ts` (4 cases, exercises `_internals.inferExpr` with a
custom param lattice scope):
- both operands concretely bool → BOOL (preserved).
- `unknown && bool` / `bool || unknown` / `unknown && unknown` → DYNAMIC (was the
  BOOL over-claim).
- `f64 && f64` / `f64 || f64` → F64 (was DYNAMIC — now the tighter sound join).
- mixed `f64 && bool` → never BOOL.

Pre-fix: the unknown-over-claim and the f64-join cases fail (verified by reverting
the rule). Post-fix: 4/4 pass. `ir-propagate-i32*.test.ts` and
`ir-frontend-widening.test.ts` remain green; pre-existing unrelated IR equivalence
harness failures (`__box_number` LinkError; `func.params is not iterable`) are
identical with and without this change.

