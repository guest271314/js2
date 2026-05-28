---
id: 1684
title: "Iterator-result object literal `{ value, done }` from a nested closure reads back value=0 / done never truthy (closure-backed iterator value round-trip)"
status: done
created: 2026-05-27
updated: 2026-05-28
completed: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: iterators, closures, wasmgc-struct, Array.from
goal: spec-conformance
sprint: Backlog
related: [1320, 1620, 1633, 983d]
---
# #1684 — Iterator-result struct value-readback from a nested closure

## Problem

An iterator-result object literal `{ value: 42, done: false }` **returned from a
nested closure** (the typical `next()` body of a hand-rolled iterator) compiles
to a WasmGC struct whose fields do not read back correctly when the struct
escapes to the JS host:

- `__sget_value` reads **0** (not `42`), and
- the `done` field never flips truthy.

So a **non-empty** closure-backed iterator cannot round-trip its yielded values
through the host bridge, even after the "items[Symbol.iterator] is not a
function" error is cleared (that part is the #1320 host-bridge layer).

## How it was found

Carved out of #1320 (2026-05-27, dev-1605). The #1320 host bridge
(`_drainWasmClosureIterable` in `src/runtime.ts`) drives a closure-backed
`@@iterator` by invoking it and its returned iterator's `.next` through
`__call_fn_0`, then reads `value`/`done` off each result via `_safeGet` /
`__sget_*`. The 4 tests #1320 targets all use **empty / trivial** iterators
(`{ done: true }`, no real value), so they dodge this bug. Any iterator that
actually yields a value exposes it.

## Suspected root cause

The iterator-result object literal is allocated inside a nested closure body.
The struct field initializers (`value`, `done`) appear to be written into a
different struct instance / ref-cell than the one returned, OR the field
load (`__sget_value`) targets the wrong type index, so the host reads the
zero-initialized default instead of the assigned value. Overlaps:

- the iterator-result-struct work in #1620 (multi-value `__iterator_next`),
- the iterator bridge family #1633,
- and the live-mirror struct-field readback in #983d.

## Reproduction sketch

```ts
var items: any = {};
items[Symbol.iterator] = function() {
  var i = 0;
  return {
    next: function() {
      if (i < 1) { i++; return { value: 42, done: false }; }
      return { value: undefined, done: true };
    },
  };
};
export function test(): number {
  const arr = Array.from(items); // host bridge drains via __call_fn_0
  return arr[0]; // EXPECT 42 — currently reads 0
}
```

## Acceptance criteria

1. A non-empty closure-backed iterator round-trips its yielded values through
   the `Array.from` / `Iterator.from` host bridge: the repro returns `42`.
2. The `done` field read by the host reflects the value written in the closure.
3. No regression in `tests/issue-1320.test.ts` (empty-iterator cases) or the
   iterator-bridge family (#1620 / #1633).
4. Focused test: closure `next()` returning `{ value: N, done: false }` then
   `{ done: true }`, drained to a JS array `[N]`.

## Out of scope

- The host-bridge "not a function" layer (#1320 — done for the listed tests).
- Generator-based iterators (`function*` on a prototype) — that is the
  `Iterator.from` / primitive-coercion facet, tracked under #1633.
