---
id: 2009
title: "structurally identical struct types share field names at the host boundary — Object.assign/spread/JSON.stringify mislabel keys, spread override order broken"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: host-interop
language_feature: objects
goal: core-semantics
related: [1989, 905, 1971]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2009 — ref.test field-name resolution collides under iso-recursive canonicalization

## Problem

```ts
const a: any = { aa: 1 }; const b: any = { bb: 2 };
JSON.stringify(a) + "|" + JSON.stringify(b)
// wasm: {"aa":1}|{"aa":2}      node: {"aa":1}|{"bb":2}

Object.assign({a:1}, {b:2})            // wasm: {"a":2}  node: {"a":1,"b":2}
({...{x:1,y:2}, ...{y:3,z:4}, x:9})    // wasm: {"x":3,"y":4}  node: {"x":9,"y":3,"z":4}
```

Three-source assign drops middle sources entirely.

## Root cause

`src/codegen/index.ts:2058-2140` (`emitStructFieldNamesExport`) keys field
names by `typeIdx` and resolves them via a `ref.test` chain — but WasmGC
iso-recursive canonicalization makes structurally identical struct types
(`{aa:number}` vs `{bb:number}`) indistinguishable to `ref.test`, so every
same-shape struct gets the first-registered shape's names. All
host-boundary enumeration (`__object_assign` via `src/runtime.ts:6829` +
`_wrapForHost`, spread via `src/codegen/literals.ts:185/1134`,
`JSON.stringify(any)`, `Object.keys(any)`) inherits the wrong names.
Secondary: `src/codegen/literals.ts:1372` resolves spread field values as
"last spread wins" without honoring source-order interleaving with named
props (`x:9` after spreads loses).

## Fix direction

Field names must travel with the *instance*, not the canonical type — e.g.
a hidden shape-id field stamped at construction keying the name table, or
per-literal distinct brand fields preventing canonical merging. Same
disease family as #1989 (valueOf keyed by type name). Architect spec
recommended; intersects #905 (versioned shapes) and #1852.

## Acceptance criteria

- All three repros match Node
- Spread/named-prop source order honored (later wins)
- No regression in struct field access perf on typed paths

## Dupe check

No issue covers canonical-type name collision (#1557 in-code comment is
method-signature dedup; #905 is shape evolution). New.
