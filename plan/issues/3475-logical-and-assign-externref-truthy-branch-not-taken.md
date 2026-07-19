---
id: 3475
title: "&&= on a defineProperty-added externref/dynamic property never takes the truthy (assign) branch"
status: ready
sprint: current
created: 2026-07-20
updated: 2026-07-20
priority: low
horizon: s
feasibility: medium
task_type: bug
area: codegen
language_feature: logical-assignment-operators
es_edition: es2021
goal: test262-conformance
related: [3430]
origin: "Discovered 2026-07-20 while implementing #3430 (strict compound/logical assignment [[Set]]-failure-throws fix). Isolated as a pre-existing, unrelated bug — NOT caused by the #3430 fix (reproduces identically with #3430's diff removed)."
---

# #3475 — `&&=` never takes the assign branch for a dynamic (externref-fallback) property

## Problem

`obj.prop &&= rhs` on a property that falls through to the externref/host
sidecar path (`compilePropertyLogicalAssignmentExternref` in
`src/codegen/expressions/operator-assignment.ts`) never executes the
"truthy → assign RHS" branch, even when the current value IS truthy. The
property is left unchanged and no write is ever attempted (confirmed via a
compile-time trace on the write-back import selection — it correctly resolves
`__extern_set`/`__extern_set_strict`, but the runtime `if` never takes that
arm).

This is **isolated from #3430** — reproduces identically whether or not
#3430's strict-set fix is applied, so it is not a #3430 regression. `||=` and
`??=` on the exact same property shape work correctly (confirmed via a
side-by-side probe); only `&&=` is affected.

## Repro

```ts
var obj = {};
Object.defineProperty(obj, "prop", { value: 2, writable: true, enumerable: true, configurable: true });
export function test(): number {
  obj.prop &&= 99;
  return obj.prop; // expected 99 (2 is truthy → assign) — actual: 2 (unchanged)
}
```

Contrast with the literal-object-property case, which works correctly (takes
Path A — the compiler's static struct-field `struct.set`, unaffected since it
never reaches the externref fallback at all):

```ts
export function test(): number {
  const obj: any = { prop: 2 };
  obj.prop &&= 99;
  return obj.prop; // 99 — correct
}
```

The defining characteristic that routes into the broken path: the property is
added via `Object.defineProperty` (or otherwise not statically known to
TypeScript on the object literal), so `resolveStructNameForExpr` /
`fields.findIndex` can't resolve a static struct field and
`compilePropertyLogicalAssignment` falls back to
`compilePropertyLogicalAssignmentExternref`.

## Root cause (hypothesis — not yet root-caused)

`emitLogicalAssignmentPattern` in `src/codegen/expressions/operator-assignment.ts`
(~line 961, the `&&=`/else branch) is structurally symmetric with the
`||=` branch (~line 931) — same `emitGet`/`ensureI32Condition`/`if` shape,
just then/else swapped. The write-back's `setName` (`__extern_set` vs
`__extern_set_strict`) resolves correctly at COMPILE time (confirmed via
trace), so the bug is in the RUNTIME condition/branch-taking, not the write
selection. Suspect either:

- `ensureI32Condition`'s truthiness check misbehaves for a boxed-number
  externref value in the specific block/local arrangement `&&=`'s branch
  produces (vs `||=`'s), or
- a Wasm block-structure / local lifetime issue specific to how `tmpKeep`
  is used across the `&&=` then/else split (the `then` arm computes the RHS
  - emits the write BEFORE the `tmpKeep` release, while `||=`'s `then` arm is
    just a bare `local.get` — same declared order but different arm bodies).

Needs an actual root-cause trace (e.g., dump the emitted Wasm for both `&&=`
and `||=` on the identical property and diff the `if` block bytecode) before
implementing a fix.

## Acceptance criteria

- `obj.prop &&= rhs` on an externref-fallback (Path B) property takes the
  assign branch when the current value is truthy, matching `||=`/`??=`
  behavior on the same property shape.
- Regression guard: literal-property (Path A, struct-field) `&&=` and
  element-access (`arr[i] &&= v`) `&&=` behavior stay unchanged.
- Add a focused vitest regression test mirroring the repro above.

## Notes

Low priority / small horizon — a narrow, self-contained bug once root-caused,
but out of scope for #3430 (whose acceptance criteria is about
integrity-level TypeError throwing, not `&&=` branch-taking correctness).
