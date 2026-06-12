---
id: 2130
title: "delete o.prop is a no-op and `in` answers against the static struct shape — post-delete / dynamic-key / object-rest all wrong"
status: ready
sprint: 61
created: 2026-06-12
updated: 2026-06-12
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: object-literals
goal: property-model
related: [1821, 492, 1112, 1991]
renumbered_from: "residual of #1821 (done) — surfaced by #1971 re-validation"
origin: "2026-06-12 #1971 PO re-validation vs main c19a2e9c1"
---

# #2130 — `delete` / `in` ignore runtime object shape (static-struct resolution)

## Problem

`in` is resolved at **compile time** against the source object's struct shape,
and `delete` on a literal object is a no-op on the underlying struct. So any
object whose runtime shape differs from its declared struct (post-delete
objects, object-rest objects) answers `in` wrong, and the deleted value is
still readable.

```ts
// delete is a no-op on the struct: value survives AND `in` stays true
const o: any = { a: 1, b: 2 };
delete o.a;
o.a                      // wasm: 1      node: undefined
"a" in o                 // wasm: true   node: false

// dynamic-key delete also a no-op
const k = "a";
delete o[k];
"a" in o                 // wasm: true   node: false

// object-rest: rest has no `e`, but `in` answers from the SOURCE struct shape
const { e, ...rest } = { e: 3, f: 4 };
"e" in rest              // wasm: true   node: false
// (rest CONTENTS are correct: rest.e === undefined, Object.keys(rest) === ["f"])
```

## Root cause

`in` lowering resolves the key against the receiver type's struct fields at
compile time and emits an `i32.const` (`src/codegen/binary-ops.ts:486-583`,
the `InKeyword` path). It never consults the runtime `__delete_prop` /
presence sidecar, so a property that was deleted at runtime — or never existed
on a rest object whose declared type still carries the field — is reported
present. The `delete` codegen for literal objects similarly doesn't clear the
struct field or mark the sidecar (#1821 fixed only the literal-key
`__delete_prop` sidecar for the *dynamic-key element-access* read path, not
the struct-field case, and not `in`).

This is the **false-positive** mirror of **#1991** (`in` never consults the
prototype chain → false negatives for inherited members). A unified fix would
route `in` through a runtime presence check that combines: own struct fields,
the runtime presence/delete sidecar, and (per #1991) the prototype chain.

## Acceptance criteria

- `const o:any={a:1,b:2}; delete o.a; o.a` → `undefined`
- `… "a" in o` after `delete o.a` → `false`
- dynamic-key `delete o[k]` removes the property (`in` → `false`, read →
  `undefined`)
- `const {e,...rest}={e:3,f:4}; "e" in rest` → `false` while
  `Object.keys(rest)` stays `["f"]`
- No regression on `in` for present own properties or array index `in`
- Equivalence tests under `tests/`

## Notes

`feasibility: hard` — touches the `in` lowering, `delete` lowering, and the
runtime presence model; coordinate with #1991 so both directions land on one
presence predicate rather than two divergent paths. Verified on main
`c19a2e9c1` via `.tmp/triage.mts` / `.tmp/triage2.mts` (branch
`po-1971-triage`). JS-host mode, default options.
