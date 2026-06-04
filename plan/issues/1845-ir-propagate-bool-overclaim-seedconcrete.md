---
id: 1845
title: "IR propagate: && / || over-claim BOOL; seedConcrete omits i32/u32"
status: ready
created: 2026-06-04
updated: 2026-06-04
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

