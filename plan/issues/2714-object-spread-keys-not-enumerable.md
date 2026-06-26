---
id: 2714
title: "Object spread copies values but the copied keys are not enumerable (Object.keys / spread-then-data drop)"
status: ready
created: 2026-06-26
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: object-spread, Object.keys
goal: spec-completeness
sprint: Backlog
parent: 2709
related: [2709, 1551]
---
# #2714 — Object spread keys are copied but not enumerable

Carved out of #2709 sub-case 1 (`call-spread-obj-getter-init.js`). Verified on
current `main` (2026-06-26): the failure attributed to *super-argument* spread is
**not** super-specific — the super-arg path is byte-identical to the non-super
object-literal path. The real defect is in generic object-literal spread codegen
(`src/codegen/literals.ts` / object-expression), independent of `super`.

## Reproduction (current main)

Spread **values are copied correctly** (direct reads work):

```ts
({ ...{ a: 2, b: 3 } }).a            // → 2   ✓ (correct)
({ ...{ a: 2, b: 3 } }).b            // → 3   ✓ (correct)
({ ...{ a: 2, b: 3 }, c: 5 }).a      // → 2   ✓ (correct)
```

…but the spread-copied keys are **not enumerable**, and a data property that
*follows* a spread is also lost from enumeration:

```ts
Object.keys({ ...{ a: 2, b: 3 } }).length        // → 0   ✗ (want 2)
Object.keys({ ...{ a: 2, b: 3 }, get c(){} }).length // → 1   ✗ (want 3 — only the getter `c` enumerates)
Object.keys({ ...{ a: 2, b: 3 }, c: 5 }).length  // → 0   ✗ (want 3)
Object.keys({ a: 2, b: 3, get c(){} }).length    // → 3   ✓ (no spread → correct)
```

So: a **statically-known** object literal (no spread) enumerates correctly via
`Object.keys`, but as soon as a spread (`...o`) participates, the dynamically
copied keys (and any keys that follow the spread) are absent from the object's
enumerable-key shape that `Object.keys` walks.

## Why this blocks #2709 sub-case 1

`test/language/expressions/super/call-spread-obj-getter-init.js` asserts
`Object.keys(obj).length === 3` for `super({...o, get c(){...}})`. The getter is
correctly **not** invoked and `obj.a`/`obj.b` read back correctly, but
`Object.keys(obj).length` returns 1 (only the inline getter `c`), so the test
fails. Fixing the enumeration here also unblocks that super row.

## Root cause (to confirm)

Object-spread lowering copies the source's own-enumerable properties into the
literal (so reads succeed) but does **not** register the copied keys in whatever
shape/key-list `Object.keys` enumerates (CopyDataProperties must add own
enumerable string keys to the target's ordinary-object key order). The
spread-then-data drop (`{ ...o, c: 5 }` → 0 keys) suggests the spread resets or
shadows the literal's static key list rather than appending to it.

## Files to inspect
- `src/codegen/literals.ts` — object-literal + spread lowering (`__copy_data_properties`).
- `Object.keys` builtin (own-enumerable-key enumeration) — `src/codegen/expressions/builtins.ts`.

## Acceptance criteria
- `Object.keys({ ...{ a: 2, b: 3 } }).length === 2`.
- `Object.keys({ ...{ a: 2, b: 3 }, c: 5 }).length === 3`.
- `test/language/expressions/super/call-spread-obj-getter-init.js` passes.
