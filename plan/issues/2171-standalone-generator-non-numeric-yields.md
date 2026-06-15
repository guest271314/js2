---
id: 2171
title: "standalone: native generator only supports numeric yields — string/boolean/object yields bail (#680)"
status: ready
sprint: 62
created: 2026-06-15
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: iterators-generators
goal: standalone-mode
parent: 2157
depends_on: [2079]
related: [2072]
---

# #2171 — non-numeric yields (SF-4 of #2157)

## Problem

```ts
function* g(){ yield "a"; yield "b"; }   // standalone: #680 CE
```

The native generator state struct spills and the result value slot are typed
f64; non-numeric yields bail to the #680 diagnostic.

## Fix direction

Widen the generator result `value` slot (and any non-numeric spilled locals) to
a boxed representation (native `$AnyString` / `anyref` / `externref` per the
declared yield type), and make the for-of / `next()` value extraction unbox by
the static element type. Coordinate with the value-rep work (#2072 family) so
the boxing/unboxing tags are consistent across the AnyValue helpers.

## Acceptance criteria

- `tests/issue-2157-*.test.ts` SF-4 `it.todo` passes, zero host imports.
- Mixed-type yields (`yield 1; yield "a";`) iterate with correct values.

## Source

Triage of #2157 (2026-06-15, sdev5), SF-4.
