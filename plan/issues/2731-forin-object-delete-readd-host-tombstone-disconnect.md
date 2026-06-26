---
id: 2731
title: "for-in/$Object: delete routes to host __delete_property tombstone disconnected from native $Object storage — delete+re-add never re-appears"
status: ready
sprint: Backlog
goal: test262-conformance
feasibility: hard
depends_on: []
priority: high
es_edition: ES5
language_feature: for-in
task_type: bug
created: 2026-06-26
updated: 2026-06-26
---
# #2731 — $Object delete tombstone is disconnected from native storage (delete+re-add never re-appears)

## Problem

A property that is **deleted then re-assigned** on a dynamic object never
re-appears in for-in / `Object.keys` / `in`. Minimal repro (host mode, current
`origin/main`):

```ts
const o: any = {}; o.x = 1; o.y = 2;
delete o.x; o.x = 9;
let s = ""; for (const k in o) s += k + ",";   // → "y,"   (expected "y,x,")
```

```ts
const o: any = { a: 1, b: 2 };
delete o.a; o.a = 9;
// 'a' in o  → false   (expected true)
// o.a       → undefined (expected 9)
```

Spec: §10.1.6.3 OrdinaryDefineOwnProperty / §7.3.x — re-adding a previously
deleted property creates it fresh (at the end of insertion order), readable and
enumerable.

## Root cause (verified by instrumentation, esch 2026-06-26)

Split out of #2706. For a native `$Object` (`const o: any = {…}`):

- Property **writes and for-in enumeration are entirely Wasm-native**
  (`src/codegen-linear/object-runtime.ts` — the `$Object` representation). The
  repro module requests **no** `__extern_set` host import; the only host import
  it requests is `__delete_property`.
- But `delete` routes through the **host `__delete_property` import**
  (`src/runtime.ts` ~`name === "__delete_property"`), which records a host-side
  tombstone in `_wasmStructDeletedKeys` and a host sidecar (`_wasmStructProps`)
  — **state that is disconnected from the native `$Object`'s own key storage.**
- A re-add (`o.x = 9`) is a **native Wasm write** that never goes through
  `_safeSet` (where the tombstone-clear lives) and never touches the host
  tombstone. So the host tombstone stays set and the key remains suppressed in
  every host-mediated read/enumerate, even though the native `$Object` holds it.

So the host delete-tombstone and the native `$Object` storage are two sources of
truth that diverge the moment a deleted key is re-added.

## Why this is architecture-scope (route to architect)

This is a **host/wasm-boundary representation defect**, not a localized runtime.ts
patch. The fix must unify the delete/re-add path with the native `$Object`
storage — either:
- route `delete` for a native `$Object` through the **native** object-runtime
  delete (so delete + re-add are both native and consistent), or
- make the native re-add path clear the host tombstone / re-sync the host sidecar.

It overlaps the **value-representation substrate work (#2580 / #2660)** — the
`$Object` reader/writer substrate is the same machinery. Sequence after / with
that substrate rather than bolting a second patch onto the host side.

## Failing tests (blocked by this)

These five `for-in` tests need BOTH the #1830 integer-key fix (landed separately)
AND this delete/re-add fix; #1830 alone closes 0 of them:

```
test/language/statements/for-in/order-simple-object.js
test/language/statements/for-in/order-property-on-prototype.js
test/language/statements/for-in/order-after-define-property.js
test/language/statements/for-in/S12.6.4_A6.js
test/language/statements/for-in/S12.6.4_A6.1.js
```

(e.g. `order-simple-object` improves with the #1830 fix from fully-wrong to
`0,1,2,p2,p4` — missing only the re-added `p1`, which this bug suppresses.)

## Acceptance criteria

`delete o.k; o.k = v` makes `k` readable (`o.k === v`), present (`"k" in o`), and
enumerable at the END of insertion order, for native `$Object` receivers, in both
host and standalone modes. No regression in delete / for-in / Object.keys. The
five `for-in` order tests above pass (with #1830 also landed).

## Notes

- Split from #2706 (which is now `blocked` on this). #2706's #1830 half is landed
  separately as `fix(#1830)`.
- Route to **architect** for a spec; overlaps #2580 / #2660 substrate.
