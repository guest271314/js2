# Soundness track — context handoff (S2 rework under the hybrid)

_Written 2026-06-28 by sendev-soundness, on stand-down. For the fresh owner of
the #2750 S2 rework once the architect scopes it under the chosen **hybrid**
direction (#2755). This is pointers + framing, not a spec._

## Where the track stands

- **#2755** — type-soundness direction decision. Project lead chose the
  **HYBRID**: adopt JS-semantics-first as the correctness *invariant* (a TS type
  may only change emitted Wasm when the value provably can't violate it at
  runtime; otherwise lower the JS-correct way), keeping the type-directed fast
  paths as a *proven-safe optimization*. Decision artifact merged (PR #2207).
  Architect is producing the roadmap that scopes the S2-under-hybrid rework.
- **#2750 S1** (`.js` → `strict: true`) — DONE, merged (PR #2205). Corpus-neutral.
- **#2750 S2** — PARKED. Lives on **PR #2198** (`hold` label, bot-park). Do NOT
  re-enqueue #2198 as-is; the rework should supersede it (close #2198, new PR).
- **#2754** "sound TS settings" spec — lives on PR #2195 (not yet on `main`),
  parked/`hold`, CI-clean (dup-id fixed). Its prescription should be revised to
  the hybrid framing before it lands.

## What S2 was, and exactly why it's not a clean re-land

S2 (in PR #2198) flipped `useUndefinedSentinel` from `false`→`true` at **two**
`emitBoundsCheckedArrayGet` call sites in **`src/codegen/property-access.ts`**
(in `compileElementAccessBody`, the two plain externref-element-array read sites;
on `origin/main` at the time they were ~lines 6303 and 6358 — search
`emitBoundsCheckedArrayGet(... , false, ...)` / now the comments reference #2001
S1 and #2593). Intent: out-of-bounds read of an `any[]`/`string[]`
(externref-element) array returns JS `undefined` (`__get_undefined`) instead of
`null` (`ref.null.extern`).

**Measured effect (merge_group, 2026-06-27):** net **+6** test262 (7 improvements,
1 regression) but it tripped the **10% regression-ratio gate** (1/7 = 14.3%) and
auto-parked. The single regression is REAL and PR-caused (wasm-hash changed;
baseline content-current):
`built-ins/Array/prototype/map/15.4.4.19-8-b-2.js` — generic
`Array.prototype.map.call(obj, cb)` on an **array-like whose `length` getter
side-effect adds an element mid-iteration**; `testResult[2]` returns `2`,
spec wants `false`.

**Decisive attribution:** test262 compiles with `fileName:"test.ts"`
(`tests/test262-runner.ts` → `isJs=false`), so S1 is a NO-OP on the corpus —
BOTH the +7 and the −1 come from **S2 alone**. So the "surgical" sentinel flip
is **not** surgical: it perturbs a generic `Array.prototype.map`-on-array-like
path, not just genuine OOB. That blast radius is the concrete evidence behind the
#2755 decision (it's in the decision doc as the deciding data point).

## How to rework S2 under the hybrid (framing, not a spec)

Don't re-land the raw sentinel flip. Two angles the architect roadmap will likely
formalize — pick per their scope:

1. **Make OOB-correctness fall out of the safe default (Direction-B style).** The
   JS-correct answer for an out-of-bounds property read is `undefined`,
   *uniformly* — it should not be a per-element-kind sentinel toggle bolted onto
   the typed fast path. The element-read lowering should produce `undefined` for
   any absent index by construction, and the typed fast path should only be taken
   where the index is provably in-bounds (or the element kind provably can't be
   asked for OOB). That removes the "flip a flag and hope it's surgical" failure
   mode that caused the map regression.

2. **If keeping the flag-flip (A-style), prove byte-identity off-OOB.** The map
   regression shows the flip changed a NON-OOB path. If the flip is retained, it
   must be gated so it is byte-identical on every in-bounds / non-OOB read, and
   the `15.4.4.19-8-b-2.js` map-on-array-like case must be green. Treat that test
   as the regression gate.

Either way: packed `number[]`/`boolean[]` OOB (the f64/i32 type-default sentinel)
is the deferred **S5** `noUncheckedIndexedAccess` epic — out of S2 scope.

## Validation discipline for the rework (it's broad-impact)

- This touches a hot element-read path → **broad-impact**. Validate on the
  **merge_group** (test262 merge shard reports + standalone-floor), never a scoped
  sweep (memory: `project_broad_impact_validate_full_ci`).
- The dev-self-merge **ratio gate** (≥10% regressions blocks even net-positive)
  is what parked S2. A net-positive-but-ratio-tripping result is an escalation /
  judgment call, not an auto-merge.

## My session's adjacent work (already merged — context, not rework)

- **#1336** (PR #2211, merged): symbol-keyed object *literals* now create real JS
  Symbols (`__box_symbol` via the externref hint at the #2126 computed-key sites
  in `literals.ts`) instead of number-boxed keys.
- **#2714** (PR #2215): spread literals in shapeless contextual types route to the
  host plain-object path so `Object.keys`/enumeration see spread keys (and the
  inline-spread `struct.new` underflow crash is gone). Same file (`literals.ts`)
  the S2/hybrid object-representation work will touch — coordinate.
