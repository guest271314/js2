---
id: 3616
title: "standalone: BigInt64Array / BigUint64Array are null in VALUE position — 627 type_error rows"
status: in-progress
assignee: ttraenkler/opus-typeerror-lane
created: 2026-07-25
updated: 2026-07-25
priority: high
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: multi
language_feature: typedarray
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [2401, 838, 3054, 3087, 3177, 1349]
origin: "opus-typeerror-lane triage of the post-#3592 standalone type_error family (3,038 rows), 2026-07-25"
# loc-budget-allow (#3616): src/codegen/dataview-native.ts +25. This file OWNS
# the runtime-kind TypedArray dispatch (TA_VIEW_DECODE, emitDynDecodeDispatch,
# emitDynEncodeDispatch, emitTaCtorValue). The change is two table rows plus the
# int64 flag threaded through the two dispatch builders — an in-place extension
# of this subsystem's own per-kind tables, exactly the shape #3177 was granted.
# Splitting two Record rows into a new module would leave the dispatch loop
# reading its descriptors from somewhere other than the table it iterates.
loc-budget-allow:
  - src/codegen/dataview-native.ts
---

# #3616 — standalone: BigInt TypedArray constructors are `null` in VALUE position

## Problem

Under `--target standalone`, `BigInt64Array` and `BigUint64Array` used in
**value position** (not `new X()`, not type position) evaluate to
`ref.null.extern`. Direct construction already works — #838 landed the native
i64-element vec, so `new BigInt64Array(4).length === 4` — but

```ts
const ctors: any[] = [BigInt64Array, BigUint64Array]; // → [null, null]
const TA = ctors[0];
const s = new TA(4); // → null
s.length; // TypeError: Cannot access property on null or undefined
```

### Root cause

`src/codegen/expressions/identifiers.ts:1220` gates the first-class
`$__ta_ctor` value emission on `taCtorKindOf(name) >= 0`. `taCtorKindOf`
(`src/codegen/registry/types.ts`) indexes `TA_CTOR_KINDS`, which listed only the
**9 non-BigInt** views. Both BigInt names therefore missed the gate and fell
through to the `reportSilentFallback("const-fallback",
"identifiers:unimplemented-global-default")` default at line 1248, which emits
`ref.null.extern`.

The host/gc lane was already fixed by **#3087** — `identifiers.ts:834-862`
routes the same two names through `__extern_get(globalThis, name)`, and its
comment says outright *"Covers the BigInt views too (not in the standalone
`taCtorKindOf` list). Standalone/WASI keeps the native `$__ta_ctor` value
below"*. The native path never grew the BigInt kinds, so only the host-free lane
was left behind.

This is a **third residual of #2401**, distinct from the two already recorded
there (its (a) `BUILTIN_TYPES` method routing and (b) unsigned i64 semantics).

### Why it costs 627 tests

The test262 runner's BigInt harness shim (`tests/test262-runner.ts:2157`) is

```ts
function testWithBigIntTypedArrayConstructors(fn: any): void {
  const constructors = [BigInt64Array, BigUint64Array];
  for (let i = 0; i < constructors.length; i++) fn(constructors[i], __ta_makeCtorArgBigIntCompat);
}
```

so `TA` is `null` in every callback, `new TA(...)` yields null, and the reported
failure is whatever member the test touches next. 627 of the 1,128 standalone
`TypeError: Cannot access property on null or undefined at N:N` rows sit under
BigInt TypedArray paths. Corpus size in the post-#3592 merged standalone
artifact: **pass 28 · fail 685 · compile_error 64**.

## Scope

Structure only. Element **values** in a dynamically-constructed BigInt view stay
on the f64 carrier the rest of the dyn-view substrate uses, NOT i64-branded
BigInts — that representation split is #1349 / #2401(b) and is deliberately out
of scope. This issue buys the non-null identity-stable constructor, the correct
8-byte element width, and working `length` / `byteLength` / MOP, which is what
the harness rows actually gate on. Content assertions keep failing honestly.

## Fix

1. `src/codegen/registry/types.ts` — **append** (never insert) `BigInt64Array`,
   `BigUint64Array` to `TA_CTOR_KINDS` as kinds 9/10, and `8, 8` to
   `TA_CTOR_BYTES`. Appending is load-bearing: the `kind` index is baked into
   the `$__ta_ctor` singleton globals and into every `if`-chain arm of the
   decode / encode / `BYTES_PER_ELEMENT` dispatches, so an insertion would
   silently repoint every existing kind.
2. `src/codegen/dataview-native.ts` — two `TA_VIEW_DECODE` rows with
   `bytes: 8, float: false, int64: true` (signed / unsigned). The `int64` flag
   is required: without it an 8-byte non-float read takes the
   `f64.reinterpret_i64` path, which is correct for `Float64Array` and garbage
   for an integer view. The rows are **inert for the static lane** —
   `taViewDecode` resolves names via `getTaViewName` over `ctx.taViewTypeMap`,
   and #838 gave the BigInt views a native i64 vec rather than a
   `$__ta_view_<name>`, so no static BigInt view type is ever registered.
3. Same file — `emitDynDecodeDispatch` / `emitDynEncodeDispatch` thread
   `int64: desc.int64` into `emitReadBytes` / `emitWriteBytes`; the decode arm
   appends `f64.convert_i64_s` / `_u` after the read. Necessary because
   `emitReadBytes` deliberately LEAVES the i64 on the stack for an `int64`
   accessor (that is the DataView `getBigInt64` BigInt carrier), while every arm
   of this dispatch's `if` is typed `f64` — the BigInt arms must converge to the
   same carrier. Convert, not reinterpret.

`f64.convert_i64_s` / `_u` are already in the `Instr` union
(`src/ir/types.ts:258-259`); no union extension needed.

## Acceptance criteria

- Standalone: `[BigInt64Array, BigUint64Array]` contains two distinct non-null
  values; `BigInt64Array === BigInt64Array` (singleton identity holds via the
  `$__ta_ctor` per-kind global, as #3177 established for the other 9).
- Standalone: `const TA = ctors[i]; new TA(4)` is non-null with `.length === 4`
  and `TA.BYTES_PER_ELEMENT === 8` for both BigInt views.
- Measured before/after count on a stride sample of the BigInt TypedArray
  corpus, net positive, recorded below.
- JS-host lane byte-neutral (the change is gated behind the standalone-only
  `emitTaCtorValue` path; the host lane keeps #3087's `__extern_get` route).

## Verification probes

Standalone lane, via `.tmp/p1.mts` (note `compile()` is async):

- `.tmp/t5.ts` — six ctor names in an array. **Before: returns 104**
  (`names[4]`, i.e. `BigInt64Array`, is `null`). **After: returns 1** — all six
  non-null and dynamic `new TA(4)` gives `.length === 4` for each.
- `.tmp/t2.ts` / `.tmp/t3.ts` — reproduce the exact harness shape; returned 21
  ("sample is null") before the fix.
- `.tmp/t1.ts` — direct `new BigInt64Array(4)` already worked before the fix,
  isolating the defect to the VALUE-position path.

## Adjacent finding (NOT this issue)

`new names[i](4)` — `new` applied directly to an element-access callee —
returns null even for the **non-BigInt** views, while
`const TA = names[i]; new TA(4)` works (`.tmp/t6.ts`). Separate, narrower gap;
the test262 harness uses the working shape, so the yield is low. File separately
if anyone wants it.

## Test Results

Pending — the before/after batch measurement was interrupted by a capacity
pause. BEFORE is captured (`.tmp/before.json`: 14 fail / 8 pass on the 22-test
stride sample) and matches the CI artifact exactly, confirming the local harness
is faithful. AFTER must be run before this PR opens; see
`plan/agent-context/opus-typeerror-family.md` for the resume steps.

## Source

`opus-typeerror-lane` triage of the post-#3592 standalone `type_error` family
(3,038 rows), 2026-07-25.
