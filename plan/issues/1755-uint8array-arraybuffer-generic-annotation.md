---
id: 1755
title: "TS annotation: Uint8Array<ArrayBuffer> generic typed-array form not handled"
status: ready
created: 2026-05-30
updated: 2026-05-30
priority: low
feasibility: medium
task_type: bug
area: type-system
language_feature: typed-arrays
goal: platform
related: [389, 1752, 1700]
depends_on: []
sprint: Backlog
---

# #1755 — `Uint8Array<ArrayBuffer>` generic annotation

## Context

From GitHub #389. The contributor's host code annotates the encode helper with
the **generic** typed-array form introduced in recent TypeScript (the
`ArrayBufferLike` type parameter on the typed-array interfaces):

```ts
function encodeMessage(message: object): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(message));
}
```

He linked the upstream rationale: microsoft/TypeScript#62546 and #62240. We
should confirm the js2wasm front-end **accepts and correctly lowers**
`Uint8Array<ArrayBuffer>` (and the other `<ArrayBufferLike>` typed-array
generics: `Uint8Array<ArrayBuffer>`, `Int32Array<ArrayBuffer>`, etc.) — i.e.
treat the type argument as a no-op for codegen and lower identically to the
non-generic `Uint8Array`.

## Scope

- Verify current behavior: does `Uint8Array<ArrayBuffer>` as a param/return/var
  annotation compile, or does the type resolver reject the type argument?
- If it errors or mis-resolves, accept the `<ArrayBufferLike>` type parameter on
  the typed-array types and erase it to the plain typed array for codegen.
- Cover param, return, variable, and field positions.

## Acceptance

- `Uint8Array<ArrayBuffer>` (and the sibling typed-array generics) compile and
  lower identically to the bare typed array, in standalone + WASI modes.
- Regression test with the #389 `encodeMessage` shape (pairs with #1752).

## Notes

Low priority (annotation ergonomics, not a runtime correctness gap) but cheap if
it's a small type-resolver erase. Distinct from #1700 (TypedArray export ABI).
