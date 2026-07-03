---
id: 2714
title: "Object spread copies values but the copied keys are not enumerable (Object.keys / spread-then-data drop)"
status: done
assignee: ttraenkler/sendev-soundness
created: 2026-06-26
updated: 2026-07-03
completed: 2026-06-28
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: object-spread, Object.keys
goal: spec-completeness
sprint: 69
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

## Verify-first re-scope + fix (2026-06-28, sendev-soundness)

**Re-probed on current `main` (714b8d1). The behavior shifted since 2026-06-26 —
the bug is narrower than the original framing, but it now includes a Wasm-validation
CRASH.** Probe matrix:

| form | result | 
|------|--------|
| `const t:any = {...o}; Object.keys(t)` (assigned) | **2 ✓** |
| `const t:any = {...o}; for(k in t)` / `getOwnPropertyNames(t)` | **2 ✓** |
| `Object.keys({ ...o })` (var src, DIRECT call-arg) | **0 ✗** |
| `Object.keys({ ...{a,b} })` (inline src, DIRECT call-arg) | **CRASH ✗** (`struct.new need 2 got 0`) |
| `Object.keys({ ...{a,b}, c:5 })` | 3 ✓ (already fixed) |
| `{...o}` value reads (`o.a`) | ✓ |

### Root cause (confirmed)

The failure is **not** generic "spread keys non-enumerable" — every
**assigned-to-variable / `any`-context** spread literal already routes to the host
plain-object path and enumerates correctly. The defect is a spread literal used
**directly in a NON-SPECIFIC contextual type** — most importantly as a direct call
argument like `Object.keys({...})`, whose contextual type is the **shapeless
`object` param (zero own properties)**. That context made `compileObjectLiteral`
take the **struct-spread path** (`compileObjectLiteralForStruct`), which lays out
fields from the literal's STATIC type only — so spread-copied (dynamic) keys are
absent from the key list `Object.keys` walks (→ 0), and an inline spread source
consumed directly underflows the struct-spread assembly's `struct.new` (→ crash).

### Fix (routing)

`src/codegen/literals.ts`, `compileObjectLiteral` — route a spread-containing
literal to the host plain-object path (`compileObjectLiteralWithAccessors`, which
copies via `__object_assign` → a real enumerable object) when its contextual type
does **not** pin a concrete object SHAPE: `any`/`unknown`/`object`, no contextual
type, OR a shapeless object type with `getProperties().length === 0`. A CONCRETE
target (`const x: { a: number } = { ...o }`, ≥1 property) keeps the struct path so
typed consumers still receive a struct. This generalizes the routing that
assigned/`any`-context spread literals already used to the direct-call-argument
position.

### Tests / checks
- `tests/issue-2714.test.ts` — 8 cases (inline-spread `Object.keys` crash repro,
  var-spread, spread-then-data, data-then-spread, value-read, getOwnPropertyNames,
  + no-spread and concrete-struct-target controls). All pass.
- Local regression sweep (suites importing the compiler directly): `object-literals`,
  `computed-props`, `issue-2151-{spread-literal,mixed-spread,dynamic-spread}`,
  `issue-2026-dynamic-new-spread` — 51/51 green. (`new-expression-spread`,
  `sparse-array-spread`, `spread-in-new-expressions`, `object-literal-getters-setters`
  error on a pre-existing `./helpers.js` resolution quirk in the shallow worktree;
  validated by CI on a full clone.)
- `prettier`, `biome lint`, `tsc --noEmit` clean.
- **Broad-impact** (changes spread-literal routing): the test262 regression gate +
  standalone-floor (merge_group) are the authoritative validation; the
  `call-spread-obj-getter-init.js` super row (#2709 sub-case 1) is confirmed by CI.
