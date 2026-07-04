---
id: 2979
title: "Standalone: native gen-result done `.value` reads back as 0/garbage — canonical-undefined carrier (UNDEF_F64 sentinel producer + sentinel-aware readers)"
status: done
completed: 2026-07-02
assignee: ttraenkler/fable-3
sprint: 69
created: 2026-07-02
updated: 2026-07-03
priority: high
horizon: m
feasibility: hard
task_type: bug
area: codegen
language_feature: generators
goal: standalone
related: [2938, 2920, 2106, 2966]
blocks: [2938]
---

# #2979 — canonical undefined for the native generator done-result `.value`

> **Provenance**: formerly #2970; re-id'd because id 2970 was taken on main by
> the import-meta per-module identity issue (parallel session, #2531 allocator
> race). Code comments and the test file were renamed in the same commit.

Carved out of the #2938 revival (task #4). **This fix stands alone on main**:
the exhausted **with-yield** native generator `.value` is wrong on current main
today, independent of the parked no-yield relax (PR #2445).

## Problem (measured on main `fa399fd70`, standalone)

```ts
function* foo(): any {
  yield 42;
}
const g: any = foo();
g.next();
const v: any = g.next().value; // exhausted → JS: undefined
v === undefined; // → false (want true)
v === 0; // → TRUE  (value-space collision — silent wrong value)
v * 2 + 5; // → 5 (want NaN)
v == null; // → false (want true)
```

## Root cause

The native gen done-result (`__NativeGeneratorResult_f64 {value: f64, done}`)
stored `f64 0` as the absent value ("consumer never reads value when done" —
false). Every reader then surfaced a genuine-looking `0`; `undefined` was
unrepresentable in the f64 carrier. Standalone's canonical undefined is the
**null externref** (`__extern_is_undefined` = `ref.is_null`,
object-runtime.ts) — the closure-boundary undefined control compares correctly,
proving the canonical rep works; the gen-result path just never produced it.

## Fix design (producer-side canonical marker + reader canonicalization)

Producer-side chosen over consumer recovery because the f64 field cannot carry
the canonical undefined directly — the repo's designed answer is the
**UNDEF_F64 sentinel** (`value-tags.ts`, #2106 lineage: a signaling-NaN bit
pattern JS arithmetic can never produce). Numerically it is already NaN
(= ToNumber(undefined)), so typed f64 reads become spec-correct with no
observer wiring; only the f64→externref crossing points need sentinel
awareness (bounded — NOT the #2106 40-site wiring):

1. `generators-native.ts` `defaultElemValueInstrs` (f64 arm → sentinel; other
   carriers already canonical), used by `emptyResult`/`emptyResultForType`;
   `emitExpressionAsF64` no-expr default (bare `return;` / `.next()` /
   `.return()` no-arg) → sentinel (still NaN-class, numerically identical).
2. `tryCompileNativeGeneratorResultProperty`: the no-static-info / ref-typed
   `.value` read (the `g: any` harness shape — previously fell into the f64
   fast path where undefined was unrepresentable) → new
   `buildOpenResultValueReadExtern` chain over ALL result carriers, returning
   externref: f64/i32 elems box via `sentinelAwareF64BoxInstrs` (sentinel →
   null externref, else `__box_number`); ref elems `extern.convert_any`
   (null ref → null extern). Statically-NUMERIC `.value` keeps the historical
   f64 fast path (byte-identical reader; sentinel reads as NaN).
3. `member-get-dispatch.ts` `fillMemberGetDispatch`: gen-result-struct f64
   `value` candidates box sentinel-aware (`isNativeGeneratorResultStruct`
   guard); f64 scratch local appended ONLY when the arm is used (host bytes
   unchanged).
4. `object-runtime.ts` `__extern_is_undefined`: second arm — a `$BoxedNumber`
   carrying the sentinel bits is undefined (covers sentinel values boxed by
   sentinel-blind f64→externref sites, e.g. the read-site inline f64 chain).
   Gated on `nativeBoxNumberTypeIdx >= 0`; JS arithmetic cannot forge the
   bits; host mode never builds this native.

## Validation so far (probes in `.tmp/probe-2938-*.mts`, branch `issue-2938-genresult-undefined-carrier`)

- Identity matrix (exhausted with-yield, standalone): `=== undefined` → true,
  `== null` → true, `=== null` → false, `=== 0` → false, `v*2+5` → NaN,
  `v+1` → NaN, truthiness → falsy. ALL JS-correct (main: all wrong).
- Controls: first `.value` 42 ✓, return-arm `.value` 7 ✓, `.done` ✓.
- test262 `language/statements/generators/{no-yield,return}.js`: pass (were
  already pass on main via host path; the RELAX branch's native path broke
  them — this fix repairs exactly that signature, "returned 2").
- `language/expressions/generators/*`: still fail on main's host path
  (pre-existing, generator-EXPRESSION lowering is not native here; expected to
  flip on the relax branch where they become native).
- Byte-inertness A/B vs main: ALL host-lane cases identical; standalone
  non-generator typed identical; standalone member-get-dispatch case differs
  ONLY by the intended `__extern_is_undefined` body change.
- `typeof <any>` TRAPS — **pre-existing on main for every any-typed value**
  (non-generator control traps too); separate issue, not this scope.

## Final validation (2026-07-02, fable-3 — resumed after budget restore)

(The interim "Suspended Work" state was superseded by the resume; kept here as
the completion record.)

- `npx tsc --noEmit` clean; prettier + `biome lint` clean on all touched files.
- `tests/issue-2979.test.ts` (new, 16 cases): exhausted-`.value` identity
  matrix (===undefined / ==null / ===null / ===0 / arithmetic NaN / truthiness /
  default-param application), real-value preservation (first yield 42, yielded
  0 stays 0 and is NOT undefined, return-arm 7, computed-NaN NOT undefined —
  sentinel unforgeable, `.done`, typed for-of), `.return()` no-arg → undefined /
  `.return(5)` → 5. All pass, host-free asserted.
- Scoped generator suites: issue-2170 (yield\* delegation), issue-2171 (string
  yields), issue-2571 (native method generators), issue-2864 (any carrier),
  issue-2941 (class-static funcIdx) — 44/44 pass.
- Byte-inertness (sha256 A/B vs main): all HOST-lane cases identical; the only
  standalone diff outside generator modules is the intended
  `__extern_is_undefined` body change.
- Gate checks: `check:any-box-sites`, `check:coercion-sites`,
  `check:stack-balance` — no unsanctioned growth.

## Next (the #2938 revival — task #4, separate PR)

Merge main (incl. this PR) into `issue-2933-noyield-relax` (PR #2445, parked
`hold`, BEHIND); the two relax bails are already relaxed there; re-run the 4
repros + the readVal probe (expect native pass); re-check the OTHER two parked
blockers (negative-test early-error miss, async-from-sync invalid module — see
the #2938 file's VERDICT section on that branch); re-validate on a
CONSTRUCT-STRIDED corpus (class-static / no-yield / return-arm /
async-from-sync / negative-test shapes — the 542-directory sample lied);
#2941 on main already covers 16/20 of the old class-static regressions. When
the full merge_group-equivalent is clean: ONE re-admission of PR #2445 via the
shepherd (bot park-hold rules apply — diagnose before unlabel).
