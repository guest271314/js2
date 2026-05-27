---
id: 1684
title: "Iterator-result object literal `{ value, done }` from a nested closure reads back value=0 / done never truthy (closure-backed iterator value round-trip)"
status: blocked
created: 2026-05-27
updated: 2026-05-27
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

## Investigation 2026-05-27 (dev-1605, branch issue-1684-iter-readback)

Root-caused on current main. The bug splits into **two independent halves**;
only the first is a localized runtime fix.

### Half A — closure-backed iterable not drained (RUNTIME, fixed on branch)

The issue file assumed #1320 Layer 1+2 had landed. **They had not** — only a
docs commit landed; the closure-value bridge code was never merged. On current
main `_materializeIterable` (`src/runtime.ts`) passes a plain JS object whose
`[Symbol.iterator]` is an opaque Wasm closure struct straight to native
`Array.from`, which throws `items[Symbol.iterator] … be a function`. So #1684's
readback bug was *masked* by the still-present #1320 Layer-1 error and could not
even be observed on main.

Fixed on this branch by `_drainClosureIterableToArray` + `_readIterResultField`
in `src/runtime.ts`: when a plain JS object's `[Symbol.iterator]` is a Wasm
closure struct, drive the iterator protocol through `__call_fn_0` (mirroring the
existing `__iterator` host import), reading `.next` via `__sget_next` and each
result's `value`/`done` via `__sget_<field>`. Real JS iterables (arrays, Sets,
strings, generators) pass through unchanged — verified no regression.

### Half B — iterator-result struct unreadable (CODEGEN, NEEDS ARCHITECT)

After Half A drains correctly, the `{ value: 42, done: false }` returned from
the nested `next()` closure still reads back **wrong**:

- `__struct_field_names(res)` → **null** (the struct is not in the named-field
  registry at all),
- `__sget_value(res)` → **null** (expected 42), `__sget_done(res)` → 0.

A *direct* `var o: any = { value: 42, done: false }; return o;` from a closure
reads back `value=42` correctly. The difference: when the object literal is the
return value of a closure whose inferred return type is `any` (→ externref /
the generic any-object struct), it is **not** allocated as a named
`{value,done}` field-struct. `emitStructFieldGetters`
(`src/codegen/index.ts:1284-1290`) explicitly skips `Wrapper*` / `$AnyValue`
struct names, so no `__sget_value` arm matches the any-object struct, and the
`ref.test` chain falls through to the else-default (null/0).

The `__call_fn_<arity>` return ABI itself is fine — it boxes a `ref` return via
`extern.convert_any` (lossless, `src/codegen/index.ts:2158-2160`). The loss is
upstream: the object literal under an `any`-typed closure return is allocated
as the opaque any-object rather than a field-typed struct, so the struct field
getters can never see it.

**Recommendation:** Half A is a correct, self-contained runtime fix worth
landing (unblocks the "is not a function" error and any closure-iterable drain).
Half B is the load-bearing part for the 3 residual #1320 tests and is **not a
localized fix** — it is the object-literal-representation-under-`any` decision
shared with #1620 (iterator-result struct), #983d (struct-field readback) and
#1630 (struct-target descriptor model). Needs an architect spec on how
`any`-typed object literals get a stable, field-readable struct identity across
the closure-return / Wasm→host boundary. Branch `issue-1684-iter-readback` holds
the Half-A runtime drain.
