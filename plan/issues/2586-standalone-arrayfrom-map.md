---
id: 2586
title: "Array.from(Map) traps illegal_cast under --target standalone"
status: done
sprint: 65
assignee: ttraenkler/sdev-vrep
feasibility: hard
reasoning_effort: max
completed: 2026-06-21
goals: [standalone]
---

## Problem

Under `--target standalone` (pure-Wasm, no JS host), `Array.from(map)` traps at
runtime with `RuntimeError: illegal cast`:

```ts
const m = new Map<string, string>();
m.set("k", "v");
const a = Array.from(m); // a should be [["k", "v"]]
a[0][0]; // → illegal cast (even a.length traps)
```

Discovered while re-probing the s65 post-keystone object-value read-back cluster
(task #25). Of the cluster targets, `Object.values` / `Object.entries` /
`Object.keys` / `Array.from(Set)` / `catch (e).message` **already pass** in true
`--target standalone` post-keystone (#2187/#2576/#2579). Only two were genuinely
still broken: this `Array.from(Map)`, and `Object.assign({}, …)` with an **empty
object-literal target** — the latter is the dot-vs-bracket dual-storage substrate
owned by #2584 (task #28) and was escalated, not fixed here.

## Root cause

A Map's default iterator is its `entries()` (§24.1.3.12 → §24.1.5.3), so
`Array.from(map)` must yield one `[key, value]` pair per live entry.

`Array.from` codegen (`src/codegen/expressions/calls.ts`, the `Array.from`
intercept) already routes `Array.from(Set)` through the native
`emitCollectionIteratorVec` driver, but explicitly left **Map** to fall through
to the generic native `__iterator` drain (`#2169c`). That generic drain is built
**VEC-ONLY** under noJsHost (`src/codegen/iterator-native.ts` — "a non-vec
subject hard-casts → illegal cast"): it does `ref.cast $Vec` on its subject. A
Map lowers to a `ref $Map` struct (field 0 is NOT a `$length`), so the cast
traps.

## Fix

Route `Array.from(Map)` through the **same** `emitCollectionIteratorVec` driver
the `[...set]` / `.values()` / `.entries()` paths use, in `"entries"` mode. That
mode materializes a canonical externref `$Vec` whose slots are 2-element
`$ObjVec` `[key, value]` pairs — exactly the host `__array_from` contract, with
**zero host imports**.

The materialized result is handed back as a **plain externref** (via
`coerceType(..., externref)`), NOT the raw `ref $Vec`. The consumer then reads it
through the dynamic `__extern_get_idx` / `__extern_length` arm
(`a[i][0]` / `[k, v]` destructure). Returning the raw `ref $Vec` instead makes a
`const a: [K,V][]` binding run the typed tuple-vec materialization, which cannot
bridge an `$ObjVec` pair into a type-resolved tuple struct → invalid `struct.new`
("expected (ref null 6), found if of type f64").

One-line change in `compileCallExpression`'s `Array.from` block; no new helpers.

### Why gated to `ctx.standalone` (not `noJsHost` / `nativeStrings`)

The `entries`-mode `$ObjVec` pair materialization tickles a **pre-existing**
substrate limitation that the stricter targets surface but this slice does not
own — both reproduce on `main` for `[...m.entries()]` independently of this
change:

- **nativeStrings-WITH-JS-host** → a late-registered object-runtime funcidx
  (`__defineProperty_value`) desyncs (function-index-out-of-range at emit). Also
  breaks `[...m.entries()]` there.
- **`--target wasi`** (strict-no-host) → the same desync, **plus** a
  `global_Array` declared-global request that the host-import allowlist rejects.

Under `--target standalone` the path lowers to a **zero-import, fully-native**
module (verified: `WebAssembly.Module.imports(binary).length === 0`), so the fix
ships there. The `entries`-mode late-registration desync + `global_Array`
interaction is escalated as the entries-mode substrate follow-up (relates to the
#2583/#2584 `$Vec`-dispatch substrate work).

## Test Results

`tests/issue-2586-standalone-arrayfrom-map.test.ts` — 8 tests, all green:

- length / string-key+string-value / string-key+number-value / multi-entry
  order / number-key+number-value pairs read back; each emits **0 imports**.
- regression guards: `Array.from(Set)`, `Array.from(array)`, `Array.from(string)`
  remain native + host-free.

Existing suites re-run green: `issue-1103a-standalone-map`,
`issue-1470-string-iteration-standalone`, `issue-2162b-array-entries-spread`,
`issue-2157-iterator-generator-residual`.

## Out of scope / escalated

- `Object.assign({}, {a:"x"})` empty-target string/number value read-back → dual
  storage substrate, #2584 (task #28). Confirmed: even `Object.keys(t).length`
  returns 0 for the assign result; `{...{a:"x"}}` spread works (builds a real
  `$Object`), so only `Object.assign` into an empty `{}` is affected.
- `Array.from(Map)` under `--target wasi` / nativeStrings-with-JS-host → blocked
  on the entries-mode late-registration desync above.
