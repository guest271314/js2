---
id: 3222
title: "standalone: native closed-shape struct field enumeration — Object.keys/values/entries/spread/rest all return empty for typed objects (~989 test262 files touch the surface)"
status: ready
sprint: current
model: opus
created: 2026-07-13
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime
language_feature: objects, property enumeration, spread, destructuring
goal: standalone-mode
related: [3218, 2515, 1472, 2714, 987, 2158]
test262_bucket: standalone-closed-struct-enumeration
---

# #3222 — native closed-shape struct field enumeration (standalone)

## Problem (verified on current main, target standalone)

Under `--target standalone`/`wasi`, native property ENUMERATION of a
**closed-shape struct** object (a typed object, e.g. an object literal whose
inferred type is `{a:number,b:number}`) is broken across the board. The
enumeration helper `__object_keys(externref)` only walks the open-`$Object`
hash-map; it has **no closed-struct arm**, so once a typed object is erased to
externref (or read at a site that routes through the runtime enumeration path),
every enumeration returns EMPTY:

| Expression (standalone) | Result | Host |
| --- | --- | --- |
| `Object.keys({a:1,b:2,c:3}).length` | **0** | 3 |
| `{...closedStruct}` spread | **empty** | 3 |
| `const {a,...rest} = {a:1,b:2,c:3}` (rest) | **empty** | correct |
| `Object.values` / `Object.entries` / `Object.assign` on a typed object | empty / wrong | correct |

The host import path enumerates closed structs via `__sget_<field>` reflection +
a struct field-name registry (`_getStructFieldNames`, `src/runtime.ts`). The
standalone native path has no equivalent.

This is the substrate gap that blocks the DOMINANT test262 object-rest pattern
(`var {a,b,...rest} = {x:1,y:2,a:5,b:3}`) — see #3218, which added the native
`__extern_rest_object` de-leak that is correct for open-`$Object` sources but
inherits this enumeration gap for closed-struct sources. It ALSO blocks
`Object.keys`/`values`/`entries`/spread standalone for typed objects.

## Leverage (test262 syntactic-usage upper bounds)

| Surface | Files touching |
| --- | ---: |
| object-rest only | 417 |
| `{...spread}` | 383 |
| `Object.keys` | 244 |
| `Object.entries` | 239 |
| `Object.assign` | 39 |
| `Object.values` | 30 |
| **union (keys/values/entries/assign/spread/rest)** | **989** |

Fixing enumeration uniformly is ~2.4× the rest-only surface — the real
high-leverage substrate lever, not a rest-only point fix.

## Candidate approaches

1. **Static enumeration at known-type sites (bounded, low-risk, partial).**
   When `Object.keys`/`values`/`entries`/spread/rest sees a source whose
   **static** type is a known closed struct, emit the field list directly (the
   compiler already has `ctx.structFields.get(typeName)` at those sites — see
   `statements/destructuring.ts:745-752`). No runtime metadata, no representation
   change. Misses the erased-to-externref-across-a-fn-boundary case, but that is
   the minority for keys/spread/rest (literals + typed locals dominate).
2. **Runtime closed-struct arm in `__object_keys` (the complete fix, medium-large).**
   Add a generated dispatch: given an externref that `ref.test`s one of the
   registered struct types, return that type's field-name vec. Handles the erased
   case too; needs per-struct-type field metadata + a dispatch (mirrors how the
   host `_getStructFieldNames` works, but Wasm-native).
3. **Typed object literals as open `$Object` in standalone (broad, higher-risk).**
   Make typed literals compile to the open hash representation in standalone so
   ALL enumeration Just Works via the open-hash path. Cleanest conceptually but
   HIGH blast radius (changes core object representation + every field read/method
   call for standalone typed objects) — not a bounded safe first slice on its own.

**Recommended sequencing:** land approach (1) first (bounded, safe, captures the
literal/typed-local majority for keys/values/entries/spread/rest), then approach
(2) for the erased-externref tail. Approach (3) only if (1)+(2) prove insufficient
and the representation tradeoffs are acceptable.

## Notes

- `ctx.standalone`/`ctx.wasi`-gated; host/gc byte-identical.
- Broad-impact → validate on the merge_group standalone floor.
- Once landed, #3218's `__extern_rest_object` handles closed-struct sources
  automatically (it delegates to `__object_keys`).
