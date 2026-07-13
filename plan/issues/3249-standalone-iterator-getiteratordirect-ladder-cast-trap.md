---
id: 3249
title: "Standalone __iterator GetIterator ladder illegal_cast on bare-{next}/get-next iterators (Iterator.from/prototype.*/concat) — ~28 host-free FAILs"
status: ready
created: 2026-07-13
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: Iterator-helpers
goal: standalone-mode
umbrella: 1781
needs_architect_spec: true
sprint: Backlog
related: [1781, 2038, 3100, 3119, 3146, 3164, 1320]
es_edition: ES2025
---
# #3249 — Standalone `__iterator` ladder illegal_cast on GetIteratorDirect (bare-`{next}`) iterators

## Problem

~28 host-free (0 env imports) standalone test262 FAILs are `illegal_cast` traps
inside the `__iterator` runtime helper (GetIterator ladder). Confirmed on the
fresh standalone baseline (2026-07-13) + reproduced in the standalone lane
(`compile target:standalone` → instantiate `{}` → run; genuine
`WebAssembly.RuntimeError: illegal cast`, frame `__iterator`).

Affected surface (all trap in `__iterator`):
- `Iterator.from(x)` — every arg shape (bare-`{next}`, `get next()` accessor,
  even a native array iterator) → `__iterator` ← `__js2wasm_Iterator_from`
  (`__j2w_iter_rec` intrinsic).
- `Iterator.prototype.map|filter|flatMap.call(plainIterator, fn)` where
  `plainIterator` is a bare `{ next() }` / `{ get next() }` object
  (`this-plain-iterator.js` family).
- `Iterator.concat(...)`, `Iterator.zip/zipKeyed(...)` with plain-iterator
  sources.
- A few `Array.from(<user-iterator>)` variants.

## Root

`__iterator` (src/codegen/iterator-native.ts, `buildIteratorBody`) implements
GetIterator §7.4 with a runtime classification ladder over the carrier kinds:
`ITER_KIND_VEC` / `USER` (registered closed-struct `@@iterator`) / `OBJ`
(#3119 — plain `$Object` **with** a truthy `@@iterator` property) / `HOSTGEN` /
`ASYNCGEN` / `GENSTATE`. There is **no arm for a bare iterator** — a plain
object that has a `next` method but **no `@@iterator`** (the GetIteratorDirect
case, §7.4.2, where the object IS its own iterator). Iterator.prototype.*
methods and `Iterator.from`/GetIteratorFlattenable must use GetIteratorDirect
(call `this.next()` directly), but our lowering funnels them through
`__iterator` (GetIterator, which looks up `@@iterator`). For a bare-`next`
receiver the ladder finds no matching kind and falls through to a hard
`ref.cast` → illegal_cast trap.

## Why this needs an architect spec (not a quick guard fix)

- The fix is an **extension of the `__iterator` GetIterator ladder** with a
  GetIteratorDirect / bare-`{next}`-OBJ arm — NOT the `notIterTest`
  guard-widen in `closed-method-dispatch.ts` (that guard is the array-HOF
  any-receiver path, a different dispatch).
- `__iterator` is the single most intertwined runtime helper: 7 carrier kinds
  wired into for-of, spread, array-from, destructuring, generators, async
  generators, and `for await` (#2038/#3100/#3119/#3146/#3164). A new ladder
  arm + matching `__iterator_next` step arm risks regressions across all of
  those.
- **Resists minimal reduction**: the isolated operation
  (`Iterator.prototype.map.call({get next(){…}}, fn)` in a bare standalone
  module) does NOT trap — it throws a *catchable* exception. Only the
  **full test262-harness-wrapped** source (strict prefix + assert helpers +
  type env) traps. So debugging must be done against the harness-wrapped
  source (via `scripts/runner-bundle.mjs` `wrapTest` + `parseMeta`), not a
  reduced snippet. A blind ladder change without a faithful repro is
  high-risk.

## Fix direction (for the architect)

1. In `buildIteratorBody` (iterator-native.ts), add a GetIteratorDirect arm:
   when the receiver is a plain `$Object` that lacks `@@iterator` but has a
   callable `next` (dynamic `__extern_get(recv, "next")` truthy + callable),
   build an `ITER_KIND_OBJ`-style IterRec that steps by calling `recv.next()`
   directly (reuse the #3119 OBJ step arm's property-dispatch, keyed on `next`
   instead of `@@iterator`→`next`).
2. Ensure `__iterator_next` has the matching step arm for that kind (or reuse
   OBJ's, since OBJ already steps via `__extern_get(iterObj,"next")` +
   `__call_fn`).
3. Gate additions to `ctx.standalone || ctx.wasi` (host lane uses runtime.ts
   polyfills, #1464). Byte-neutral for the JS-host lane.
4. Validate against the harness-wrapped Iterator/* files (repro harness in
   this issue's investigation: standalone-lane driver over the baseline's
   Iterator illegal_cast file list). NET≥0, merge_group standalone floor is
   the gate.

## Repro (harness-faithful)

```
# host-free Iterator illegal_cast file list from the standalone baseline:
#   test/built-ins/Iterator/{from,prototype/{map,filter,flatMap},concat,zipKeyed}/...
# drive via scripts/runner-bundle.mjs wrapTest+parseMeta, compile target:standalone,
# instantiate {}, run exported test → WebAssembly.RuntimeError "illegal cast" in __iterator.
```

## Scope / value

- ~28 host-free FAILs (standalone conformance / `host_free_pass`).
- Part of opus-leak3's diffuse crash cluster #3; this is the one coherent
  shared-root sub-cluster. The rest of that cluster (illegal_cast/null_deref,
  516 total) is genuinely diffuse (verified: isolated reductions of generic
  receiver / null-this / poisoned-getter / Proxy hypotheses run fine).
