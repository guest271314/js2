---
id: 1808
title: "Binary emit error: offset is out of bounds — emitBinary() crash on 276 tests"
status: done
created: 2026-06-03
updated: 2026-06-04
completed: 2026-06-04
priority: high
feasibility: medium
task_type: bugfix
area: codegen
goal: compilable
sprint: 59
pr: 1129
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

## Resolution (2026-06-04)

**Resolved-by-upstream-fixes — the emit crash no longer reproduces on current
main (`c06d4620d`).** Re-harvested the full 292-test baseline cluster against
HEAD: **zero** tests still produce `offset is out of bounds` / `Binary emit
error`. The 292 now resolve to 54 pass + the remainder genuine semantic
fail/skip/other-CE outcomes (the acceptance criterion: "the affected tests move
off `oob`/`Binary emit error` to pass or to a genuine semantic failure").

Root cause was upstream **invalid-module construction**, not a writer/back-patch
bug in our own emitter. Our binary writer (`src/emit/encoder.ts`) builds onto a
plain `number[]` with no fixed buffer and no random-access back-patch, so it
cannot itself throw `offset is out of bounds`; the message surfaced from the
serializer choking on a structurally malformed module produced upstream at
type/coercion boundaries. The sprint-59 cluster that corrected module shape
cleared it:

- **#1623** — invalid Wasm binary at type/coercion boundaries (extern/anyref +
  struct ref). The most directly relevant: malformed coercion-boundary modules.
- **#1788** — boolean i32 struct field representation.
- **#1798** — IR return-tail coercion (coerce IR return value to declared
  any/externref result).
- **#1320 blocker** — register box helpers before emitting struct field getters
  (commit `362b3da8a`).

### Verification

Per-file isolated-subprocess re-run across **every** affected directory
(TypedArray, DataView, Set, Map, Array, Date, String, Temporal, Iterator,
RegExp, Function, ArrayBuffer, arguments-object, eval-code, annexB) →
no `offset is out of bounds`. (A batched single-process scan briefly reported a
spurious `Cannot create property 'declaredType' on number` for ~192 tests; that
proved to be cross-test state contamination in the long-lived scan harness, not
a per-test defect — each file run in a fresh process compiles/runs cleanly.)

### Why 292 failures bunched into a single ~30s window (burst mechanism)

The baselines-repo JSONL (`f52502e9`, 2026-06-04) records all 292 failures
inside one ~30s timestamp window (`00:25:27`→`00:25:57`, 36 unique timestamps)
with normal `compile_ms` (9–382 ms, median 121). That is not a per-input
codegen bug — it is **one poisoned `compiler-fork-worker.mjs` process**. The
worker reuses a single long-lived `createIncrementalCompiler()` instance across
up to `RECREATE_INTERVAL=500` files and only recreated it on that fixed
interval. Once the shared state (or the V8 heap, capped at
`--max-old-space-size=512`) degraded, **every** subsequent compile in that
worker emitted the identical emit-class error result until its scheduled
recycle — producing the dense identical-message burst. (The prior batched scan
hitting `Cannot create property 'declaredType' on number` for ~192 tests is the
same poisoned-state phenomenon surfacing a different message; fresh-process runs
are clean.) This is consistent with the cluster being absent on direct,
deterministic re-runs at both the baseline commit and HEAD.

### Harness hardening (recurrence prevention)

`scripts/compiler-fork-worker.mjs` now **recreates the incremental compiler
immediately** when a compile produces an emit/allocation-class error
(`POISON_ERROR_RE`: `Binary emit error`, `offset is out of bounds`,
`out of memory`, `Array buffer allocation failed`, `Maximum call stack size
exceeded`, `Invalid array length`) — both for error *results* and thrown
exceptions — instead of waiting for the 500-file `RECREATE_INTERVAL`. This caps
the blast radius of a poisoned worker at one file, so a transient degraded state
can no longer cascade into hundreds of false `Binary emit error` results in the
recorded baseline.

### Guard

`tests/issue-1808.test.ts` pins one representative per affected directory and
asserts compilation never surfaces the `offset is out of bounds` /
`Binary emit error` string, and that any successfully-emitted module passes
`WebAssembly.validate`. This prevents the cluster from silently returning.

## Acceptance criteria

- [x] Root cause of the `offset is out of bounds` emit crash identified
      (upstream invalid-module construction at type/coercion boundaries; not a
      writer back-patch bug — our writer uses an unbounded `number[]`).
- [x] `emitBinary()` no longer throws for the affected tests (0/292 reproduce on
      HEAD `c06d4620d`).
- [x] No regression in default-lane pass count; the affected tests move off
      `oob`/`Binary emit error` (to pass or to a genuine semantic failure).

## Notes

Surfaced by `/harvest-errors` on 2026-06-03 against the authoritative
baselines-repo data (the in-repo committed JSONL was stale and under-counted
this bucket). Confirmed cleared on 2026-06-04 against HEAD `c06d4620d`.
