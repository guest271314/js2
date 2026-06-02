---
id: 1769
title: "generalize nullable primitive union lowering and narrowing"
status: ready
created: 2026-06-01
updated: 2026-06-01
priority: medium
feasibility: hard
reasoning_effort: high
es_edition: n/a
language_feature: type-narrowing
task_type: architecture
area: type-system
goal: platform
related: [389, 1765]
depends_on: []
sprint: 58
origin: "Follow-up to narrow #1765 nullable number typed-array byte-write fix"
---

# #1769 - generalize nullable primitive union lowering and narrowing

## Problem

The narrow #1765 fix intentionally targets one guest271314 GitHub #389 shape:
`number | null` locals used as append-byte sentinels, guarded by a direct or
const-aliased `!== null` check before a `Uint8Array` byte assignment.

That patch is useful but deliberately local. It should not become a pile of
one-off special cases for every nullable primitive position. The compiler needs
a coherent representation and narrowing rule for nullable primitive unions so
ordinary TypeScript control-flow works across reads, writes, calls, returns,
and aliasing.

## Narrow slice already covered by #1765

```ts
let append: number | null = null;
const hasAppend = append !== null;
if (hasAppend) {
  output[cursor] = append;
}
```

#1765 covers this shape by preserving the nullable local sentinel and proving
the RHS non-null for a typed-array byte write. The generalized issue should
absorb that lesson without baking typed-array assignment into the core model.

## Generalization targets

- Represent nullable primitive locals without erasing the null/undefined
  sentinel (`number | null`, `number | undefined`, `boolean | null`, and mixed
  `T | null | undefined` forms).
- Propagate non-null facts through direct guards, boolean guard aliases,
  negated guards, early returns/continues/breaks, loop bodies, and nested
  control-flow.
- Reuse the same proof for expression contexts beyond byte assignment:
  arithmetic, comparisons, function arguments, returns, object/array writes,
  and local reassignments.
- Preserve diagnostic integrity: downgrade TypeScript assignability diagnostics
  only when the compiler has an explicit non-null proof for the concrete use.
- Avoid forcing every primitive into boxed storage. Compile away nullable
  representation when TypeScript proves the value is never observed as
  nullable, and only use a sentinel-preserving representation for live nullable
  values.

## Design constraints

- Keep the core rule representation-driven: codegen should ask whether a value
  is proven non-null in the current flow environment, not whether it is being
  assigned to a specific builtin container.
- Cover locals first; parameters, closure/ref-cell captures, fields, and array
  elements can be staged if the issue needs subtasks.
- Do not invent a broad dynamic tagged-union runtime if the same behavior can
  be compiled away from TypeScript control-flow facts.
- Treat #1765 as a regression seed, not as the full architecture.

## Acceptance

- A test matrix documents nullable primitive behavior for direct guards,
  aliases, negation, early exits, and loop-carried updates.
- `number | null` and `number | undefined` values preserve their sentinel until
  a non-null proof exists, then unbox/coerce correctly in non-null branches.
- Non-null proofs work for at least typed-array writes, arithmetic, function
  calls, and returns.
- Negative tests show unguarded nullable primitive use still reports a useful
  diagnostic or lowers through an intentional nullable representation rather
  than silently erasing the sentinel.
- The #1765 minimal repro remains covered by the generalized mechanism.

## Notes

This is deliberately larger than the #389 production blocker. It is a follow-up
architecture issue to prevent nullable primitive support from accreting as
site-specific patches.
