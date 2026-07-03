---
id: 3007
title: "any-context computed-index read desyncs __vec_get funcIdx → invalid Wasm (f64.convert_i32_s on externref)"
status: done
sprint: 69
priority: medium
assignee: ttraenkler/agent-a7e5749647e8f1219
created: 2026-07-03
completed: 2026-07-03
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: element-access, dynamic-dispatch, any, late-imports
goal: spec-completeness
related: [2767, 2784]
predecessor: 2767
horizon: s
---

# #3007 — any-context computed-index read desyncs `__vec_get` funcIdx → invalid Wasm

Surfaced by the #2768 measure-first investigation: `tests/issue-2767.test.ts` had
6/11 tests failing on `main` with `Invalid Wasm binary`, independent of the
bare-`var` safelist mechanism. The precise V8 error, on the minimal repro

```ts
export function test(): any {
  var d; d = new Date(0);
  const __s = d.toISOString();
  return __s[__s.length - 1];   // returned in an `any` context
}
```

is:

```
CompileError: f64.convert_i32_s[0] expected type i32, found local.get of type externref
```

## Root cause — a late-import funcIdx desync in the vec-fast element read

The receiver `__s` is statically `any` (evolving-`any` binding: the TS checker
types `d.toISOString()` as `any`, so `__s` is `any` → externref). A computed
numeric read `__s[idx]` on an externref receiver in host/GC mode routes through
the `(#2784 S3)` native-vec-aware fast path in
`compileElementAccessBody` (`src/codegen/property-access.ts`). That path:

1. captured `__vec_get` / `__extern_get` / `__box_number` funcIdxs and flushed
   the pending late-import shifts, THEN
2. compiled the **index expression** `__s.length - 1`.

But compiling that index is itself a dynamic `.length` read on an externref,
which **registers late imports** and shifts every DEFINED-function index —
including `__vec_get`. Because `__vec_get` was captured in step 1 (before the
index compile in step 2) and never re-resolved, the `then` arm's
`call __vec_get` desynced and the emitted instruction stream was corrupted into
`f64.convert_i32_s` applied to the externref receiver — invalid Wasm.

Confirmation (host mode):

| repro | before | after |
| --- | --- | --- |
| `__s[0]` (literal index — no imports) | compiles | compiles |
| `__s[__s.length - 1]` (index adds imports) | **INVALID** | compiles |
| `const i = __s.length - 1; __s[i]` (index pre-stored) | compiles | compiles |

Only the middle case — where the index expression itself registers late
imports — was broken, pinpointing the capture-before-compile ordering.

It regressed silently because `tests/issue-2767.test.ts` is not wired into the
required `quality`/test262 gates, and the actual Date/`toISOString` test262
cluster (15/17 host) never exercises this `any`-return-of-a-string-index shape.

## Fix

`src/codegen/property-access.ts`, the `(#2784 S3)` block in
`compileElementAccessBody`: **compile the index expression first, then register
the fast-path imports, flush once, and resolve `__vec_get` — so no funcIdx is
captured before an import-adding index compile.** The receiver is stored into
`__nve_recv` first (unchanged local numbering); a defensive fallback emits the
generic host read from the stored locals if the fast-path imports are somehow
unavailable (unreachable in host mode). For a non-import-adding index (e.g. a
literal) the import order is identical, so valid output is byte-for-byte
unchanged.

## Acceptance criteria

- `tests/issue-2767.test.ts` goes from 6/11 failing to 11/11 passing.
- New `tests/issue-3007.test.ts` covers the `any`-context computed-index read on
  a string, a native-vec receiver, and a plain externref, incl. the
  import-adding index shape.
- Byte-inert: outputs for programs not exercising this exact path are unchanged.
