---
id: 3060
title: "Object.hasOwn(structLiteral, key) returns false in host mode — __object_hasOwn host import skips wasm-struct marshalling (~24 default-lane fails)"
status: in-progress
created: 2026-07-06
updated: 2026-07-06
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: object-hasown
es_edition: 2022
goal: spec-completeness
sprint: current
horizon: s
test262_category: built-ins/Object/hasOwn
test262_fail: 24
related: [965, 2130]
---

# #3060 — Object.hasOwn returns false for statically-shaped objects (host mode)

## Source

Default (JS-host) lane test262 harvest, 2026-07-06
(`.test262-cache/test262-current.jsonl`). All ~24 `built-ins/Object/hasOwn`
fails share assert #1: `Object.hasOwn(o, "foo")` returns `false` for an object
whose property demonstrably exists.

## Root cause

`Object.hasOwn(obj, key)` compiles (in host mode) to the host import
`__object_hasOwn` (`src/runtime.ts` ~L10702), which did:

```js
return (Object.hasOwn ? Object.hasOwn(obj, key) : ...) ? 1 : 0;
```

i.e. it called `Object.hasOwn` on the **raw** value. When `obj` is a WasmGC
struct (a statically-shaped object literal like `{ foo: 42 }`, or a `{}` given
an accessor via `Object.defineProperty`), the struct's fields/sidecar/descriptor
data are invisible to native `Object.hasOwn` → always `false`.

By contrast the method-call path `o.hasOwnProperty(key)` dispatches to the
`__hasOwnProperty` host import, which routes a wasm struct through
`_wasmStructHasOwn(obj, key, exports)` (the shared own-property predicate:
tombstone + sidecar + descriptor + class methods + struct shape) and a plain JS
object through `Object.prototype.hasOwnProperty.call`. That is why
`o.hasOwnProperty("foo")` and `"foo" in o` succeed on the same literal while
`Object.hasOwn(o, "foo")` did not.

`Object.hasOwn(O, P)` is spec-equivalent to
`HasOwnProperty(ToObject(O), ToPropertyKey(P))` — identical to
`Object.prototype.hasOwnProperty.call(O, P)` — so the two host imports must use
the same presence predicate.

## Fix

Rewrite the `__object_hasOwn` host import to mirror `__hasOwnProperty`:
ToPropertyKey the key, then arguments-object arm → non-struct
`hasOwnProperty.call` arm → wasm-struct `_wasmStructHasOwn` arm. Host-import
only; the standalone native `emitHasOwn` `$Object` body is untouched (no
standalone regression risk).

## Acceptance

- `built-ins/Object/hasOwn` `hasown_own_*` + `symbol_property_*` clusters pass.
- No regressions in `Object.prototype.hasOwnProperty` / `in` behaviour.
