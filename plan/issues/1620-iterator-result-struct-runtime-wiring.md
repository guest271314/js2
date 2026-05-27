---
id: 1620
title: "$IteratorResult struct: eliminate __iterator_done/__iterator_value host imports (runtime wiring gap)"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature+bugfix
area: codegen+runtime
language_feature: iterators, for-of
goal: host-independence
sprint: 56
renumbered_from: 1323
supersedes_pr: 347
---
# #1323 — $IteratorResult struct (runtime wiring gap)

Replace the `__iterator_done` / `__iterator_value` host imports with a Wasm-native
`$IteratorResult` struct returned by `__iterator_next`. The original attempt
(PR #347, closed) implemented the codegen side but left a runtime wiring gap that
**regresses conformance** — it must be re-done with the runtime fixed.

## Why PR #347 was closed (root cause — verified by sendev-432-347, 2026-05-24)

PR #347's conflict resolution against current main was clean, but the feature
itself is broken independent of the merge:

- #1323 changed the **legacy codegen path** (`src/codegen/statements/loops.ts`)
  so `__iterator_next`'s result is **unconditionally** `any.convert_extern` +
  `ref.cast` to `$IteratorResult`.
- But the runtime `__iterator_next` (`src/runtime.ts` ~L5904) only returns a real
  `$IteratorResult` struct when it can reach
  `callbackState.getExports().__make_iterator_result`.
- In the **default** `buildImports(imports, undefined, stringPool)` usage — which
  is what the tests (and most callers) use — `callbackState` is absent, so it
  hits the "defensive fallback" that returns the **raw JS object**, which then
  fails the `ref.cast` with a runtime `illegal cast`.
- The fallback's comment ("legacy host-import path still works") is **false**:
  the legacy path was rewritten to require the struct.

**Proven regression:** `tests/iterators.test.ts` (5 string for-of) +
`tests/symbol-iterator-protocol.test.ts` (custom iterable) **PASS on origin/main**
but **FAIL with #1323** (`illegal cast`). Same failures reproduce on the PR's
pre-merge tip — so it's the feature, not the merge.

## What a correct implementation needs

1. **Runtime must construct `$IteratorResult` without depending on `callbackState`** —
   OR the legacy codegen path must keep working (return the raw object / not cast)
   when `__make_iterator_result` is unreachable. Pick one; the cast and the
   constructor must be consistent across all `buildImports` usages, including the
   default (no callbackState) path.
2. **Update the stale test assertions**: `tests/iterators.test.ts:90-91` still
   assert the WAT contains `__iterator_done` / `__iterator_value` — the very
   imports #1323 removes. Update them to assert the struct path.
3. Reconcile with `__iterator_rest` (#1052) in `addIteratorImports` (both-sides-add
   in `src/codegen/index.ts`) — PR #347 already resolved this cleanly (keep both
   the `__iterator_rest` import and the `__make_iterator_result` helper/export;
   `makeFuncIdx` index math stays correct).

## Files
- `src/codegen/statements/loops.ts` — the unconditional cast site
- `src/runtime.ts` ~L5904 — `__iterator_next` / the `callbackState`-dependent
  `__make_iterator_result` reachability + defensive fallback
- `src/codegen/index.ts` — `addIteratorImports` (coexist with `__iterator_rest`)
- `tests/iterators.test.ts`, `tests/symbol-iterator-protocol.test.ts` — fix stale
  assertions + confirm string-for-of / custom-iterable pass

## Acceptance
- `__iterator_done` / `__iterator_value` host imports eliminated.
- `tests/iterators.test.ts` + `tests/symbol-iterator-protocol.test.ts` pass
  (no `illegal cast`) in the **default** buildImports path.
- Stale WAT assertions updated.
- No test262 regression (string for-of currently passes on main — must stay green).

PR #347's clean conflict resolution is preserved at local commit `4b9f14e30` if a
future dev wants the index.ts reconciliation as a starting point.

## Implementation Plan

### Root cause (re-verified against current main + commit `4b9f14e30`)

`__iterator_next` cannot build a WasmGC `$IteratorResult` struct in pure JS —
the struct is a typed GC object, constructable only by the Wasm `struct.new`
inside the **exported** helper `__make_iterator_result(i32, externref)`. The
runtime reaches that export via `callbackState.getExports().__make_iterator_result`.

`buildImports` *always* creates `callbackState = { getExports: () => wasmExports }`
(runtime.ts:7393), but `wasmExports` starts `undefined` and is only populated
when the caller invokes the returned `setExports(instance.exports)` callback
(runtime.ts:7475-7477). Two facts decide everything:

1. The real driver (`src/index.ts` runner, runtime.ts:7690-7691) **does** call
   `setExports`. The shared equivalence helper (`tests/equivalence/helpers.ts:198,209`)
   **does** call `setExports`. So `symbol-iterator-protocol.test.ts` — which uses
   `compileToWasm` — would actually work under the struct path.
2. `tests/iterators.test.ts:12` hand-rolls `WebAssembly.instantiate` and **never
   calls `setExports`**. So in that one harness `wasmExports` stays `undefined`,
   `make` is `undefined`, `__iterator_next` returns the **raw JS object**, and the
   codegen's **unconditional** `any.convert_extern` + `ref.cast $IteratorResult`
   (loops.ts in #347, ~L3406-3410) traps with `illegal cast`.

So the "proven regression" is two distinct defects:
- **(a) a brittle/unconditional `ref.cast`** in codegen that assumes the struct is
  always present, with no guard, and
- **(b) a test-harness wiring gap** (`iterators.test.ts` forgets `setExports`).

Fixing (b) alone makes the existing tests pass, but leaves (a) as a latent
foot-gun: any future embedder that forgets `setExports` gets a hard trap instead
of a graceful fallback. We fix both.

### Chosen approach — **Option C, hardened** (struct is the single path; cast is guarded; wiring gap closed)

Rationale for rejecting A and B:

- **Option A is impossible as literally stated.** The runtime cannot synthesise a
  typed GC struct in JS; it *must* call the Wasm export. "Make the runtime aware
  of `__make_iterator_result` earlier" reduces to "ensure `setExports` is called",
  which is exactly the wiring gap (b).
- **Option B re-introduces the imports we are removing.** To read `done`/`value`
  from a *raw JS object* fallback, codegen would still need `__iterator_done` /
  `__iterator_value` host imports — defeating the issue's primary acceptance
  criterion ("imports eliminated"). A conditional `ref.test`+branch in codegen
  cannot dispatch to a JS-object reader without those imports.

**Option C** keeps the single struct path (imports gone), and addresses the two
defects with the smallest possible surface:

1. **Close the wiring gap (b)** so the struct is *always* reachable wherever the
   for-of struct codegen runs: make `iterators.test.ts` call `setExports`, exactly
   like the equivalence helper already does. This is the actual fix for the proven
   regression.
2. **Harden the cast (a)** so a missing struct degrades to a clear thrown error
   rather than a raw `illegal cast` trap, AND so the value field round-trips
   correctly: guard the `ref.cast` with `ref.test` and, on the (should-not-happen)
   false branch, throw a `TypeError` via the existing exn tag. This is defence in
   depth; under correct wiring it is never taken.

This minimises test churn (only the two stale WAT assertions + one harness line
change), keeps the import surface reduced, and removes the latent trap.

### Changes

**File: `src/codegen/index.ts` — `addIteratorImports` (current ~L6716)**
- Port the #347 version verbatim from commit `4b9f14e30:src/codegen/index.ts`
  (~L6402-6483): register the `__IteratorResult` struct type (fields
  `done: i32` immutable, `value: externref` immutable), store its idx on
  `ctx.iteratorResultTypeIdx`, add it to `ctx.structMap`/`ctx.structFields`,
  and define+export the Wasm helper `__make_iterator_result(i32 done, externref value)`
  returning `(ref null $IteratorResult)` via `struct.new`.
- **Remove** the three legacy imports `__iterator_done`, `__iterator_value`, and the
  now-unused `extToI32` func-type registration (current L6730-6741).
- **Keep** `__iterator`, `__iterator_next` (still `externref→externref`),
  `__iterator_return`, and `__iterator_rest` (#1052). Order: keep `__iterator_rest`
  registered before defining `__make_iterator_result` so `makeFuncIdx =
  ctx.numImportFuncs + ctx.mod.functions.length` (read live) stays correct — this
  is the index reconciliation #347 already proved clean.
- Verify `ctx.iteratorResultTypeIdx` exists on the codegen context type
  (`src/codegen/context/types.ts`); #347 added it there — port that field too.

**File: `src/codegen/statements/loops.ts` — `compileForOfIterator` (current ~L3330-3465)**
- Replace the three-import sequence (`nextIdx`/`doneIdx`/`valueIdx` lookups +
  the `call doneIdx` / `call valueIdx` reads) with the struct path from
  `4b9f14e30:src/codegen/statements/loops.ts` (~L3286-3416):
  - Look up `const iterResultTypeIdx = ctx.iteratorResultTypeIdx;` (error out if
    undefined, same as today's missing-import guard).
  - `__iterator_next(iter)` → `local.set resultLocal` (still `externref`).
  - **done read (guarded):** recover the struct, then read field 0:
    ```wasm
    local.get $result
    any.convert_extern              ;; externref -> anyref
    ref.test (ref $IteratorResult)  ;; guard before cast (avoids illegal_cast)
    if (result i32)
      local.get $result
      any.convert_extern
      ref.cast (ref $IteratorResult)
      struct.get $IteratorResult 0  ;; done: i32
    else
      ;; wiring gap: __make_iterator_result was unreachable. Throw a clear
      ;; TypeError instead of trapping. (ref.null.extern + throw <exnTag>)
      ref.null.extern
      throw $exnTag
    end
    ```
    Use `ensureExnTag(ctx)` (already imported/used at L3283) for the tag.
  - **value read:** identical guard pattern, `struct.get $IteratorResult 1`
    (`externref`) on the true branch; the false branch is already handled by the
    done read short-circuiting via throw, so value read may assume the struct is
    present (it executes only after `done` was successfully read this iteration).
    Keep it simple: `any.convert_extern` + `ref.cast` + `struct.get … 1` (the done
    guard one line above guarantees testability this iteration).
- Update the doc-comment pseudo-code block (current L3231-3238 / #347 L3188-3195)
  to describe the struct path, not `__iterator_done`/`__iterator_value`.
- Leave all the surrounding machinery untouched: null-check (L3279-3312),
  iterator-close `finallyStack` entry, break/continue depth math, the 1M-iteration
  guard, destructuring branches. #347 already preserved these; do not re-derive
  the depth arithmetic.

**File: `src/runtime.ts` — `__iterator_next` (current ~L5865-5893)**
- Replace with the consolidated #347 body (`4b9f14e30:src/runtime.ts` ~L5858-5912):
  resolve `next` (own/sidecar/`__sget_next`/`__call_fn_0`/`__call_next`), capture
  `raw`, extract `done` (own/sidecar/`__sget_done`) and `value`
  (own/sidecar/`__sget_value`), then:
  ```ts
  const exports = callbackState?.getExports();
  const make = (exports as any)?.__make_iterator_result;
  if (typeof make === "function") return make(done ? 1 : 0, value);
  return raw; // defensive only; codegen now throws TypeError if this path is hit
  ```
- **Delete** the `__iterator_done` (L5894-5903) and `__iterator_value`
  (L5904-5913) import branches entirely — they are no longer registered, so
  leaving them is dead code; remove for clarity.
- Fix the misleading comment: the fallback no longer keeps a "legacy host-import
  path" working (there is none); reword to "defensive only — codegen guards with
  ref.test and throws TypeError if the struct is unreachable (host forgot
  setExports)".

**File: `tests/iterators.test.ts`**
- **Wiring fix (the actual regression fix), L12:** after `instantiate`, call
  `setExports`, mirroring the equivalence helper:
  ```ts
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  if (typeof (imports as any).setExports === "function")
    (imports as any).setExports(instance.exports);
  ```
- **Stale WAT assertions, L90-91:** delete the two `expect(result.wat).toContain("__iterator_done")`
  and `__iterator_value` assertions; replace with assertions that prove the struct
  path:
  ```ts
  expect(result.wat).toContain("__make_iterator_result");
  // optionally: expect(result.wat).toContain("IteratorResult");
  ```
  Keep the `__iterator` and `__iterator_next` assertions (L88-89) — both imports
  still exist.

### Test assertions to update
- `tests/iterators.test.ts:90-91` — swap `__iterator_done`/`__iterator_value`
  for `__make_iterator_result` (struct path). (Required by acceptance.)
- `tests/iterators.test.ts:12` — add the `setExports` call (harness wiring).
- Audit for any other test asserting on the removed imports:
  `grep -rn "__iterator_done\|__iterator_value" tests/` — update/remove each hit
  the same way. (None expected outside `iterators.test.ts` per the issue, but
  verify before pushing.)

### Estimated test impact
- **Stays green (was the proven regression):** all 5 string for-of cases in
  `tests/iterators.test.ts` and the custom-iterable cases in
  `tests/symbol-iterator-protocol.test.ts` — no more `illegal cast` once the
  struct is the single path and `setExports` is wired.
- **No test262 regression expected:** string for-of and generic-iterable for-of
  run through `src/index.ts` / equivalence-style harnesses that already call
  `setExports`, so the struct is always reachable there. The codegen `ref.test`
  guard converts the (unreachable-under-correct-wiring) failure mode from a hard
  trap into a thrown `TypeError`, which is strictly safer.
- **Net conformance:** neutral-to-slightly-positive (fewer host calls per step:
  3 → 1). The primary win is host-independence: `__iterator_done` /
  `__iterator_value` imports eliminated, satisfying the `goal: host-independence`.

### Risks / coordination
- **`addUnionImports` index shift:** `__make_iterator_result` is a *defined &
  exported* Wasm function, not an import, so it does not participate in import
  index shifting; but confirm `makeFuncIdx` is computed live
  (`ctx.numImportFuncs + ctx.mod.functions.length`) and not cached before any
  later import additions. #347 got this right — preserve it.
- **`ctx.iteratorResultTypeIdx` field:** must exist on the codegen context type
  (`context/types.ts`). Porting #347's addition is required, or `addIteratorImports`
  won't compile.
- **No conflict with `__iterator_rest` (#1052):** both coexist; keep both. Already
  proven clean in `4b9f14e30`.
- **Async iterator path:** `compileForOfIterator` also serves `for await…of`
  (`stmt.awaitModifier` → `ensureAsyncIterator`). `__async_iterator` /
  `__gen_next` results must flow through the same `$IteratorResult` struct read.
  Verify the async path also lands its `next` result through `__iterator_next`
  (or an equivalent that calls `__make_iterator_result`); if `__async_iterator`'s
  iterator is consumed via a *different* `next` import, that import needs the same
  struct-construction treatment, or its for-of read must keep a separate path.
  Check `ensureAsyncIterator` and async-iterator tests before assuming parity.
