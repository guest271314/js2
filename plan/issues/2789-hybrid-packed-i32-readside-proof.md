---
id: 2789
title: "Hybrid fast-path Row 3: packed-i32 array read-side soundness — demote overflow/-0 writes to f64 (miscompile fix)"
status: done
sprint: 69
created: 2026-06-28
completed: 2026-06-28
updated: 2026-07-03
assignee: ttraenkler/senior-developer
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: array-number-i32
goal: correctness
related: [2762, 1197, 1236, 1126]
---

# #2789 — Packed-i32 array read-side soundness (hybrid fast-path audit Row 3)

## Problem

`#1197` lowers a `let arr: number[] = []` (or `new Array(...)`) local to an
`array<mut i32>` backing instead of `array<mut f64>` when every element write
looks "i32-safe", removing the per-element f64↔i32 round-trip. The gate lives in
`src/codegen/array-element-typing.ts`:

- `collectI32SpecializedArrays` — collects the candidate `number[]` locals and
  disqualifies on escape / non-`push` methods / nested capture / non-i32 writes.
- `isI32SafeExprForArray` — the per-write i32-safety predicate.

The hybrid fast-path audit (`plan/log/hybrid-fastpath-audit.md`, Row 3) flagged
this path **`undischarged` — miscompile risk**: the gate checked the WRITE side
but its predicate was an _over-approximation_ that admitted values whose i32
image differs from their true f64 value, and it ignored the READ side entirely.

Packing a `number[]` into an i32 array is **unsound** if any element value is
fractional / NaN / ±Inf / `|v| ≥ 2³¹` / `-0`, OR if any read observes a
distinction i32 erases. A too-loose gate **miscompiles** (ships a wrong number),
not merely deoptimizes.

### Concretely (confirmed by probe on `origin/main`)

`isI32SafeExprForArray` accepted `+`/`-`/`*` of i32-safe operands with the stale
comment _"overflow wraps mod 2^32"_, and accepted `-0` (unary minus of `0`).
`collectI32SpecializedArrays` accepted arithmetic compound writes (`+=`/`-=`/`*=`)
when the RHS was i32-safe. But codegen evaluates `number op number` as **f64**
and stores it into the i32 slot via `i32.trunc_sat_f64_s`, which **saturates**
on overflow rather than wrapping; and i32 cannot represent `-0`.

| Source                             | `origin/main` (i32-backed) | Correct (f64) |
| ---------------------------------- | -------------------------- | ------------- |
| `arr.push(a*b)`, `a*b = 2.5e9`     | `2147483647` (saturated)   | `2500000000`  |
| `arr.push(a+b)`, `a+b = 4e9`       | `2147483647`               | `4000000000`  |
| `arr.push(-0); 1/arr[0]`           | `+Infinity`                | `-Infinity`   |
| `arr[0] += 2e9` after `arr[0]=2e9` | `2147483647`               | `4000000000`  |

This is exactly the **#1236** saturation miscompile that was fixed for _scalar_
i32 locals (`collectI32CoercedLocals` in `function-body.ts` rejects `+`/`-`/`*`)
— but the fix was **never applied to the array element path**.

## Root cause

The fast path trusted the _TypeScript type_ `number[]` plus a syntactic
write-shape approximation, instead of proving the stored value is representable
losslessly as i32. The `+`/`-`/`*` and `-0` forms break the invariant that "the
i32-stored value, read back as f64, equals the value the f64 backing would have
stored."

## Fix — conservative narrowing (the actually-sound discharge of `P`)

Tighten `isI32SafeExprForArray` / `collectI32SpecializedArrays` so the surviving
set admits **only canonical i32 producers** — expressions whose value `v` is an
integer in `[-2³¹, 2³¹)` with `v` bit-identical to its f64 image (so not `-0`,
not fractional, not NaN/±Inf, not `|v| ≥ 2³¹`):

1. **Reject `+`/`-`/`*` arithmetic** in `isI32SafeExprForArray` (was: recurse and
   accept). f64 arithmetic stored via `i32.trunc_sat_f64_s` saturates on
   overflow → demote the whole array to f64.
2. **Reject arithmetic compound writes** (`+=`/`-=`/`*=`, and `>>>=`) in
   `collectI32SpecializedArrays` (was: accept when RHS i32-safe). Same
   read-modify-write-through-f64 saturation. Only the five canonical-i32
   bitwise/signed-shift compounds (`|=`, `&=`, `^=`, `<<=`, `>>=`) survive.
3. **Fix `-0`**: unary `-` now admits **only a non-zero integer literal** (a
   `-1`-style sentinel) — a strict subset of the prior acceptance. `-x`
   (identifier, could be 0) and `-(expr)` demote.

Bitwise (`|`, `&`, `^`, `<<`, `>>`), signed-shift, comparison, `~`, i32-locals,
non-negative integer literals, and the wrap-canonicalising idiom **`(expr) | 0`**
are unchanged — their value is a canonical i32 that matches both backings. The
common perf-sensitive hash/mask patterns (`arr[i] = (h*31 + c) | 0`) keep the
i32 fast path because the top-level op is bitwise.

### Why this discharges the READ-side proof for free

The audit asks for a read-side proof that "no read observes a distinction i32
erases." Once every WRITE yields a canonical i32, this is **vacuously true**: for
every element `v`, the i32-backed read promoted to f64 equals `v` exactly (i32→f64
is lossless on `[-2³¹, 2³¹)`), which equals what the f64 backing stores. So _any_
downstream read — float op, return to a `number`/`any` sink, comparison,
`Number.isInteger`, stringify, `1/x` — produces the identical result under both
backings. There is no distinction left to observe. A separate read-side AST
dataflow gate was considered and **deliberately not added**: it would be
redundant for soundness and risk over-deopting, and a buggy/incomplete read-side
analysis is precisely the "risky gate" this row warns about. The sound, minimal
discharge is to make the write side _actually_ canonical (not approximate).

### Why this can only fix or deopt — never introduce a new miscompile

Every change is a strict **narrowing** of the promoted set (removes names from
`collectI32SpecializedArrays`'s result). A demoted array falls to the default,
well-tested f64 backing, which is correct for any `number` value. So conformance
can only improve or stay equal; the only cost is losing the i32 fast path on the
(rare, and previously _wrong_) overflow/`-0` arrays.

`new Array(n)` holes are **not** a divergence source: both backings use
`array.new_default` (zero-init), so an unwritten slot reads `0` either way —
verified by probe.

## Files

- `src/codegen/array-element-typing.ts` — `isI32SafeExprForArray` (reject
  `+`/`-`/`*`; `-0`-safe unary minus) and the arithmetic-compound disqualifier
  in `collectI32SpecializedArrays`. Doc comments updated to state the
  canonical-i32 contract.
- `tests/issue-2789.test.ts` — runtime + WAT-level proofs.

## Test Results

`npx vitest run tests/issue-2789.test.ts` → 18/18 pass. Covers:

- the four previously-miscompiled cases (`*`/`+`/`-` overflow, `+=` overflow)
  now returning the spec-correct f64 value;
- `-0` preserved via `push` and via element-assign (`1/x === -Infinity`);
- a read-side observation (`arr[0] / 2` on an overflowed value);
- guard cases that were already correct (division → fractional, `0/0` → NaN);
- **preservation**: `(a*b)|0`, non-zero negative literals, bitwise writes and
  bitwise compounds still pack (WAT: `$__vec_i32` present) and stay correct;
- **WAT-level proof**: overflow / `-0` / arithmetic-compound arrays are
  f64-backed (`$__vec_i32` absent); `(a*b)|0` / bitwise arrays keep i32.

Existing i32 tests (`i32-fast-mode`, `issue-1236`, `i32-loop-inference`) were
A/B-checked: failure counts are **identical** with the original vs the patched
`array-element-typing.ts`, i.e. this change introduces no new failures (those
files have pre-existing, unrelated failures on `origin/main`).
