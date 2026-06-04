---
id: 1808
title: "Binary emit error: offset is out of bounds — emitBinary() crash on 276 tests"
status: ready
created: 2026-06-03
updated: 2026-06-03
priority: high
feasibility: medium
task_type: bugfix
area: codegen
goal: compilable
sprint: 59
---
# #1808 — Binary emit error: "offset is out of bounds" (emitBinary crash)

## Symptom

**276 test262 tests** (default JS-host lane) fail with the *identical* error:

```
L1:1 Binary emit error: offset is out of bounds
```

Discovered by `/harvest-errors` against the fresh baselines-repo run
(`loopdive/js2wasm-baselines`, gitHash `f52502e9`, 2026-06-03). All 276 carry
the exact same string at source position `L1:1` — i.e. the failure is at
**module binary-emit time**, not source-position-specific. This is one codegen
defect hit by many inputs, not 276 distinct bugs.

(A further ~15 tests show the same message at other source lines — likely the
same root cause surfacing on slightly different module shapes; total ≈ 291.)

## Where it's thrown

`src/compiler.ts` wraps Binaryen's binary writer:

```ts
// src/compiler.ts:773 (also 1051, 1302)
`Binary emit error: ${e instanceof Error ? e.message : String(e)}`,
```

The inner `offset is out of bounds` originates inside Binaryen's
`module.emitBinary()` (BufferWithRandomAccess back-patch / `writeAt`), so the
module we hand Binaryen has a section/function/segment whose serialized size or
back-patched offset overflows the writer's bounds. The module passes our own
construction but blows up at serialization.

## Affected surface (top dirs, of 276)

| Count | Path prefix |
|------:|-------------|
| 29 | `built-ins/Array/prototype/*` |
| 11 | `built-ins/String/prototype/*` |
| 10 | `built-ins/TypedArray/prototype/*` |
| ~45 | `built-ins/Temporal/*` (PlainDate/Duration/PlainDateTime/PlainTime/ZonedDateTime/PlainYearMonth) |
| 7 | `annexB/language/eval-code/*` |
| 6 | `built-ins/DataView/prototype/*` |
| 5 | `language/eval-code/direct/*` |

Representative samples:
- `test/built-ins/TypedArray/prototype/slice/detached-buffer.js`
- `test/built-ins/Array/prototype/at/index-non-numeric-argument-returns-undefined-throws.js`
- `test/built-ins/TypedArray/prototype/subarray/return-abrupt-from-end-symbol.js`

The breadth across unrelated features points at a single emit-layer bug
(offset/size encoding in a section the writer back-patches), triggered whenever
the compiled module crosses some size or structural threshold — not a
per-builtin semantic gap.

## Not a duplicate of

- **#203** (LEB128 overflow for large *type indices*) — done 2026-03; that was
  malformed varints ("extra bits in varint" / "length overflow"), a *different*
  Binaryen error. This one is `offset is out of bounds` from the writer's
  random-access back-patch, not varint decoding.
- **#1310** (vm.createContext sandbox isolation) — test-infra, unrelated despite
  a stray string match.

## Suggested investigation

1. Reduce one sample (e.g. `TypedArray/prototype/slice/detached-buffer.js`) to
   the minimal source that still trips `emitBinary()`; capture the Binaryen
   stack (the catch at `compiler.ts:1051/1302` already includes `e.stack`).
2. Determine which section the offending offset lives in — likely a
   back-patched size placeholder (function body, code section, or a data/elem
   segment) whose computed length exceeds the writer's addressable range, or a
   negative/overflowed relative offset.
3. Check whether it correlates with module size (many emitted functions →
   large code section) vs a specific construct shared by these tests
   (detach/abrupt-completion harness includes such as `detachArrayBuffer.js`,
   `testTypedArray.js`).

## Acceptance criteria

- [ ] Root cause of the `offset is out of bounds` emit crash identified
      (which section / which offset overflows).
- [ ] `emitBinary()` no longer throws for the 276 affected tests.
- [ ] No regression in default-lane pass count; the 276 move off
      `oob`/`Binary emit error` (to pass or to a genuine semantic failure).

## Notes

Surfaced by `/harvest-errors` on 2026-06-03 against the authoritative
baselines-repo data (the in-repo committed JSONL was stale and under-counted
this bucket). Re-harvest after a fix to confirm the cluster clears.
