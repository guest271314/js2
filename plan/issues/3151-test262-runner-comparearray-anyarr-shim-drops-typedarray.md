---
id: 3151
title: "test262 runner: compareArray/assert_compareArray shims typed `any[]` drop dyn-view TypedArray reads — gates the whole TA-harness cluster"
status: done
completed: 2026-07-11
assignee: ttraenkler/fable-sub1
sprint: 71
priority: high
horizon: m
feasibility: medium
area: testing, tooling
goal: standalone-mode
related: [2872, 2860, 3088, 3087, 3086]
origin: "#2872 slice-2 harness-blocker triage (fable-sub1, 2026-07-11)"
---

## FIXED (2026-07-11, fable-sub1) — `any[]`→`any` on the two shims

Changed `compareArray` (~L1692) and `assert_compareArray` (~L1704) shim param
types from `any[]` to `any` in `tests/test262-runner.ts` (option 1). Real-array
callers read identically (verified 111/111 both lanes); dyn-view TypedArrays now
read correctly.

**Measured (real runner, standalone lane, base = origin/main incl. #2894):**
`TypedArray/prototype/{fill,copyWithin,reverse}` (136) — **+23 pass / 0
regressions** vs baseline. This is only the three swept dirs; the shim is used
by the ENTIRE TA prototype cluster, so full CI is expected to show a materially
larger net gain (validated on `merge_group`, not a scoped sweep — this is a
scoring-harness change).

## MERGE-GROUP PARK → LANE-SPLIT FIX (2026-07-12, CI-fix dev)

The global `any[]`→`any` flip above was auto-parked in the merge queue
(`auto-park-bot:merge-group-failure`, run 29175942933): the **JS-host lane**
regressed **15 baseline-pass tests** (all `assertion_fail`, all
compareArray-involving: `concat_*sloppy/strict-arguments`, `with/this-value-boolean`,
`Reflect.ownKeys`/`gOPDs order-after-define-property`, `computed-property-names/basics/symbol`,
4× `spread-obj-spread-order`, `slice/coerced-start-end-shrink`, 2× BigInt-TA)
vs **+1 improvement** — gate fail `net_per_test -14`. The standalone lane was
net **+22 / −3** (the intended win).

**Root cause of the host regressions (probe-pinned):** the "real-array callers
read identically" claim was wrong for one construction context. With `any`
params, callers' **array-literal arguments** are built in an `any`-typed
context, which picks a **lossy representation**: `[1, void 0, 3]` becomes an
f64 array whose `void 0` element is **NaN** (`typeof a[1] === "number"`; even
`a[1] !== a[1]` self-compare fails), and mixed literals (`[1,'z']`,
`[symA, symB]`) misread their non-numeric elements. The corruption happens at
literal **construction**, so no branch inside compareArray's body can recover
it (an `Array.isArray` dispatch was probed and does NOT fix it).

**Fix: lane-split the shim param type** (`dynViewCompare` in `buildPreamble`,
threaded from `wrapTest(source, meta, target)`):

- **standalone/wasi lanes** → `any` params (dyn-view TypedArray reads; keeps
  the +22 TA-harness cluster win).
- **JS-host lane** → `any[]` params, byte-identical preamble to pre-PR main
  (proven: wrapped host output for all regressed-cluster tests is
  byte-identical to `origin/main`'s `wrapTest`) — the 15 host regressions are
  gone by construction. Host TAs are not dyn-views; host TA compareArray tests
  passed at baseline with `any[]`.

Local re-run of the 15 regressed host tests: 12/15 pass, 3 fail only from
local-env gaps (macOS node: resizable-AB RangeError, BigInt-TA harness ctor) —
all 3 proven byte-identical-wrap to main, so CI scores them as baseline.
Follow-up (compiler, out of scope here): array-literal lowering in an `any`
context should not adopt the NaN-lossy f64 representation for literals
containing `undefined`/mixed elements.

# #3151 — runner `compareArray` shim `any[]` typing drops dyn-view TypedArrays

## Problem (root-caused, probe-pinned 2026-07-11)

After #2872 slice-2 landed native standalone `copyWithin`/`reverse` for
`$__ta_dyn_view` receivers, 75/89 (44 non-BigInt) of the
`TypedArray{,Constructors}/prototype/{copyWithin,reverse}` tests STILL failed —
but **not because of a compiler gap**. Every compiler mechanic works in
isolation (proven by 8+ probes): dynamic construction via all three harness
factories (`makePassthrough`/`makeArray(Array.from)`/`makeArrayLike`),
`copyWithin`/`reverse` on every element kind, cross-function-boundary `.length`
/`[i]` reads through an `any` param, and a full multi-factory bound-harness
replica (`ret: 1`, host-free).

**The blocker is in the test262 RUNNER**, not the compiler. The runner's
injected shims

```ts
// tests/test262-runner.ts ~L1692
function compareArray(a: any[], b: any[]): number { … a.length … a[i] … }
// ~L1704
function assert_compareArray(actual: any[], expected: any[]): void { … }
```

type their params **`any[]`**. When a `$__ta_dyn_view` TypedArray flows in
(`assert(compareArray(new TA(makeCtorArg([…])).copyWithin(0,0), […]))`), the
`any[]` annotation makes the compiler emit **WasmGC array** `.length`/`[i]`
ops — a `$__ta_dyn_view` is NOT a WasmGC array, so the reads return wrong
values → `compareArray` returns 0 → the outer `assert` fails → the runner
reports `returned 2 | assert #1`.

### Minimal repro (probe, `--target standalone`)

```ts
function compareArray(a: any[], b: any[]): number { /* real-harness body */ }
function tw(fn:any){ fn(Int8Array); }
let o=-1; tw(function(TA:any){ const r=new TA([3,4,5,6,5,6]); o=compareArray(r,[3,4,5,6,5,6]); });
export function test(): number { return o; }   // -> 0  (BROKEN)
```

Change the sole annotation `a: any[]` → `a: any` and the same program returns
`1`. The real test262 harness's `compareArray` (harness/assert.js) has **no**
type annotation — `a` is effectively `any` — so the runner's `any[]` is an
unfaithful narrowing that the real harness does not have.

## Fix options

1. **Runner-side (bounded, recommended):** change the `compareArray` and
   `assert_compareArray` shim param types from `any[]` → `any` in
   `tests/test262-runner.ts` (and audit sibling shims — `assert_deepEqual`
   etc. — for the same `any[]` narrowing). This routes `.length`/`[i]` through
   the dynamic path, which already recognizes `$__ta_dyn_view` (and still reads
   plain arrays correctly). More faithful to the real (untyped) harness.
2. **Compiler-side (broader):** make `any[]`-typed `.length`/`[i]` fall back to
   the dynamic reader when the runtime value is a `$__ta_dyn_view`. More
   general but touches the hot array-access path; higher regression surface.

Option 1 is the clean unblock.

## Blast radius

- Directly the ~44 non-BigInt `copyWithin`/`reverse` harness tests (the
  BigInt half stays gated on #1349 i64-brand).
- **Much wider**: `compareArray`/`assert.compareArray` is used across the ENTIRE
  `built-ins/TypedArray/prototype/*` cluster (the #2872 umbrella, ~294
  host-pass/standalone-fail) — `set`/`slice`/`subarray`/`sort`/`join`/`fill`/
  `with`/`toReversed`/… all assert results via compareArray. This single shim
  fix plausibly unblocks a large fraction of the cluster at once.

## Validation note (broad-impact)

This changes the SCORING harness → it can shift results for many tests (any
compareArray caller). It MUST be validated on full CI / `merge_group`, not a
scoped local sweep (memory `project_broad_impact_validate_full_ci`): route the
`any[]`→`any` change through a PR and read the merged-report delta for net gain
+ zero regressions before merging. Consider senior-dev review since it touches
the conformance scorer.

## Acceptance

- Runner shims no longer narrow `compareArray` params to `any[]`; dyn-view
  TypedArrays read correctly through them.
- The `copyWithin`/`reverse` non-BigInt harness tests flip to pass on the
  standalone lane; measured net gain across the TA prototype cluster on full
  CI with zero regressions.
