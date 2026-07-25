---
id: 3592
title: "Silent wrong answers: top-level `throw` dropped in every non-WASI lane; under-applied calls through `__apply_closure` never happen (standalone)"
status: in-progress
sprint: current
priority: high
horizon: m
feasibility: hard
goal: standalone-gap
assignee: ttraenkler/senior-dev-vacuity
created: 2026-07-25
# RC2 only: the widening builder lives in the (non-god-file) closure-exports.ts,
# but its call site + import still add 8 LOC to the object-runtime.ts god-file.
loc-budget-allow:
  - src/codegen/object-runtime.ts
# Carried from the RC1 PR that landed on main (kept through the add/add merge).
trap-growth-allow:
  count: 1
  reason: "#3596 reclassification: fixing the dropped top-level `throw` lets await-dynamic-import-rejection.js run past the point it previously stopped, reaching a pre-existing latent unreachable trap. Baseline status is `fail` (negative_test_fail) — the module DID instantiate and return a verdict, so this is the #3596 baseline-did-testify branch, not the #3595 never-instantiated class. fail -> fail, flavour only; the test has never passed. PR net +16 pass, all other trap categories flat."
  tests:
    - test/language/module-code/top-level-await/await-dynamic-import-rejection.js
---

## Problem

Two independent **silent wrong answers** — not harness noise. Both were MEASURED
verify-first on `origin/main` @ `7652f033` on 2026-07-25, and **both refute the
description they were dispatched with**.

### RC1 — a bare top-level `throw` statement is silently dropped (ALL non-WASI lanes)

`src/codegen/declarations.ts:1522` collects a top-level `ThrowStatement` into
`__module_init` **only** under `--target wasi`:

```ts
if (ts.isThrowStatement(stmt)) {
  if (ctx.wasi) ctx.moduleInitStatements.push(stmt);
  continue;
}
```

#2968 added the WASI arm and deliberately left host/standalone alone ("their
pre-existing top-level-throw drop is out of scope"). The consequence is that a
module whose only statement is `throw new Test262Error("HELLO")` **runs to
completion and scores PASS**.

**Correction to the dispatch premise:** this is **not** standalone-specific — the
**JS-host lane drops it too**. Measured A/B (`.tmp/probe-harness.mts`, real
`assembleOriginalHarness` prefix, `deferTopLevelInit`, `__module_init` invoked
after `setExports`):

| lane       | bare top-level `throw Test262Error` |
| ---------- | ----------------------------------- |
| standalone | RAN-TO-COMPLETION → scored **pass** |
| host       | RAN-TO-COMPLETION → scored **pass** |

Without the harness prefix the drop is even more visible: a module whose sole
statement is `throw` emits **no `__module_init` export at all**.

**Correction to the expected direction:** this does **not** inflate the floor.
Exact corpus footprint, TS-parser scan of every non-`_FIXTURE` test262 file
(`.tmp/scan2.mts`): **40 files** carry a top-level ThrowStatement, out of 19,202
that mention `throw` at all. Almost every one is a `negative:` test that
currently scores **FAIL** ("expected Test262Error") _precisely because the throw
never happens_. So the expected flip direction is **fail→pass**.

### RC2 — an under-applied call through `__apply_closure` silently does not happen (standalone/WASI)

`fillApplyClosure` (`src/codegen/object-runtime.ts`) dispatches on the **dynamic
argument count** alone:

```
n = i32(__extern_length(args)); if n==0 → __call_fn_method_0 … if n==8 → __call_fn_method_8; else undefined
```

but `emitClosureMethodCallExportN` (`src/codegen/closure-exports.ts:498`) only
carries closures whose declared formal count is `<= arity`:

```ts
if (info.paramTypes.length > arity) continue;
```

So dispatching an **arity-3** closure at **n = 2** matches no arm, falls through
to the bridge's undefined sentinel — and **the call silently does not happen**.

That is the exact shape of the entire test262 assert harness:
`assert.sameValue(found, expected, message)` is virtually always invoked as
`assert.sameValue(a, b)`.

**Correction to the dispatch premise:** the reported symptom was
"dynamic-string `sameValue` false-positive, while `assert.sameValue(1,2)`
correctly FAILS". That is wrong in both halves. It is not a string bug, and
`assert.sameValue(1,2)` is vacuous too. Measured (numeric channel — the body
records the outcome into a module global read back through an exported
`probeQ()`, so nothing depends on exception rendering; `.tmp/probe5.mts`,
`.tmp/probe7.mts`):

| standalone call                            | args/formals | outcome                     |
| ------------------------------------------ | ------------ | --------------------------- |
| `assert(false)`                            | 1/2 (direct) | threw — CORRECT             |
| `assert.sameValue(1, 2)`                   | 2/3          | returned normally — VACUOUS |
| `assert.sameValue("a", "b")`               | 2/3          | returned normally — VACUOUS |
| `assert.sameValue("" + true, "SHOWME")`    | 2/3          | returned normally — VACUOUS |
| `assert.sameValue(1, 2, "msg")`            | **3/3**      | threw — **CORRECT**         |
| `assert.notSameValue(1, 1)`                | 2/3          | returned normally — VACUOUS |
| `assert.throws(TypeError, function () {})` | 2/3          | returned normally — VACUOUS |

Isolation controls that pin it to _under-application on the closure-carried
property dispatch path_ and nothing else:

| control                                           | standalone  | host    |
| ------------------------------------------------- | ----------- | ------- |
| fn-static 3 formals, called with **3** args       | CORRECT     | CORRECT |
| fn-static 3 formals, called with **2** args       | **VACUOUS** | CORRECT |
| fn-static 3 formals, `(1, 2, undefined)` explicit | CORRECT     | CORRECT |
| fn-static 2 formals, 2 args                       | CORRECT     | CORRECT |
| fn-static 1 formal, **0** args                    | **VACUOUS** | CORRECT |
| PLAIN function, 3 formals, 2 args                 | CORRECT     | CORRECT |
| object-literal method, 3 formals, 2 args          | CORRECT     | CORRECT |

The **JS-host lane already fixed exactly this**, in JS, in #2623 P-7 / B-1:
`_wrapWasmClosureUnknownArity` dispatches at `max(args.length,
__closure_arity(fn))` rather than at the highest emitted dispatcher. The
**in-Wasm** bridge never got the same treatment.

**`verifyProperty` is a SEPARATE root cause — measured, not assumed.** The
lead's hypothesis was that the `verifyProperty`-past-its-a1-gate vacuity is this
same arity bug. It is not: with the RC2 fix ON and OFF, `verifyProperty(Math.abs,
"name", {…writable: TRUE})` (a deliberately wrong expectation) is **identically
non-throwing** in both arms (`.tmp/probe9.mts`). The arity fix un-vacuums the
`assert.*` family only.

## Measurements

### RC1 — exhaustive (population, not a sample)

The exposed population is exactly the 40 files carrying a top-level
`ThrowStatement`, so this is a **complete census**, not an estimate. Local-vs-local
A/B, same runner (`runTest262File`), same process, only the collection toggled:

| lane           |   n | pass→pass | **fail→pass** | fail→fail | CE→CE | **pass→fail** | changed signatures |
| -------------- | --: | --------: | ------------: | --------: | ----: | ------------: | -----------------: |
| **standalone** |  40 |        26 |         **5** |         2 |     7 |         **0** |                  1 |
| **host**       |  40 |        26 |         **5** |         3 |     6 |         **0** |                  2 |

The five gainers are the same in both lanes:
`language/module-code/eval-self-abrupt.js`,
`language/line-terminators/comment-single-{cr,lf,ls,ps}.js`.

The single standalone signature change (`language/module-code/eval-rqstd-abrupt.js`,
`expected TypeError` → `uncaught Wasm-GC exception (non-stringifiable payload)`)
lands in an **already-classified** `STANDALONE_ROOT_CAUSE_BUCKETS` entry
(`scripts/build-test262-report.mjs:782`), so the #3439 hard-0 unclassified gate is
not at risk.

**Net: +5 standalone, +5 host, 0 regressions.**

### RC2 — random sample, honest split

Local-vs-local A/B, standalone lane, **N = 200 uniformly sampled test262 files**
(seed `20260725`, `.tmp/ab.mts`), same runner, same process, only the widening
toggled. **These are sample counts. They are deliberately NOT scaled to a corpus
number.**

| transition                  |  count |
| --------------------------- | -----: |
| skip→skip                   |     39 |
| compile_error→compile_error |      5 |
| pass→pass                   |     85 |
| fail→fail                   |     56 |
| **pass→fail**               | **15** |
| fail→pass                   |      0 |
| same-status signature drift |      0 |

**15 of the 100 tests that passed standalone before the fix flip to fail** — i.e.
**15 % of the sampled standalone pass set was vacuous through this one
mechanism**. Every flip cites a harness assertion at the failing line
(`assert.sameValue` / `assert.throws` / `assert.compareArray` / `throw new
Test262Error()`), so these are **honest flips**, not collateral.

New-signature classification of the 15:

| signature family                                                      | count | classified?                                      |
| --------------------------------------------------------------------- | ----: | ------------------------------------------------ |
| `uncaught Wasm-GC exception (non-stringifiable payload)`              |    11 | YES (existing bucket)                            |
| `Test262:AsyncTestFailure:Test262Error: …SameValue…`                  |     3 | needs check                                      |
| `RuntimeError: illegal cast … ← __call_fn_method_3 ← __apply_closure` |     1 | **NEW — invalid-Wasm class, not an honest flip** |

That last one is the one real hazard the fix introduces: a missing formal is now
supplied as the `undefined` sentinel, and a callee whose param was inferred to a
concrete WasmGC ref type **traps** on it instead of seeing `undefined`. Before
the fix the call simply never happened. Both are wrong; the trap is a different
failure class and must be separated from the honest flips per the F1 recipe.

> **SUPERSEDED — see "RC2 re-measure" below.** The `illegal cast` row above was
> classified as a _widening-introduced_ invalid-Wasm class on the strength of the
> stack trace alone. Two controls run on 2026-07-25 show it is **pre-existing**
> and merely unmasked. The claim, and the follow-up item it generated, are
> withdrawn.

### RC2 re-measure (2026-07-25, task #10) — the blocker is REFUTED

#### 1. The cited `illegal cast` is NOT caused by the widening

Repro:
`built-ins/TypedArrayConstructors/ctors-bigint/buffer-arg/byteoffset-is-negative-throws-sab.js`
→ `RuntimeError: illegal cast in __closure_57() at source L618 (via
__closure_50@L507 ← __call_fn_method_3@L24 ← __apply_closure@L622)`.

| control                                                             | widening | arity of the `assert.throws` call | result             |
| ------------------------------------------------------------------- | -------- | --------------------------------- | ------------------ |
| as reported                                                         | ON       | 2 of 3 (under-applied)            | trap               |
| **A** — add the 3rd argument (`assert.throws(RangeError, fn, "m")`) | ON       | 3 of 3 (exact)                    | **identical trap** |
| **B** — same, plus the widening force-disabled                      | OFF      | 3 of 3 (exact)                    | **identical trap** |

A defect that reproduces with the change **disabled** is not caused by the
change. `__closure_50` is the harness's `assert.throws`; `__closure_57` is the
test's own callback, `function () { new TA(sharedArrayBuffer, -1); }`. The
widening's only role is that `assert.throws` now actually invokes `func()`,
which reaches a pre-existing defect in the BigInt-TypedArray-over-SAB
constructor path. That makes it an **honest flip that happens to surface as a
trap**, not a new invalid-Wasm class.

#### 2. The discriminator to use instead of "the trace mentions `__apply_closure`"

A widening-**introduced** trap can only arise inside the dispatcher's own
argument conversion, so it must have **`__call_fn_method_N` as the INNERMOST
frame** — the function named right after `illegal cast in `. In the repro above
`__call_fn_method_3` is two frames _out_, with a user closure innermost. Use the
innermost frame, not the presence of `__apply_closure` anywhere in the chain.

#### 3. The stated fix shape is not implementable as written

"Give the missing-argument case its own arm in `buildArgConversion`" cannot be
done there: `__call_fn_method_N` receives **N externrefs and no argument count**.
Only `__apply_closure` knows how many arguments were really supplied. Any real
fix has to live in the widening (i.e. decide _whether_ to widen), not in the
dispatcher's per-argument conversion.

#### 4. Value-correctness — verified BY VALUE, host-free

The formal the real harness under-applies (`assert.throws`'s `message`) is
**string-typed by its own body** (`message = ''` / `message += ' '`), so it is
exactly the concrete-ref lowering the hazard was postulated about. Probe compiled
`target: "standalone"`, **import manifest asserted empty**, instantiated with
`{}`; the callee records which branch it took in a module global:

| arm          | `seen` | `msgLen` | meaning                                              |
| ------------ | -----: | -------: | ---------------------------------------------------- |
| widening OFF |      0 |       -1 | the call never happened (the vacuity)                |
| widening ON  |      1 |        0 | `message === undefined` was TRUE; `message = ''` ran |

`seen === 2` would have meant the missing formal arrived as something other than
`undefined`; it does not. Pinned by
`tests/issue-3592-apply-closure-arity.test.ts` ("a missing STRING-typed formal
reads as undefined in the callee (harness shape)").

#### 5. A real hazard that is NOT (yet) reached — record it, do not guard it

A codegen census of the blocker module's closure funcTypes
(`JS2WASM_DUMP_CLOSURE_PARAMS=1`, uncommitted) found formals with **no undefined
inhabitant**:

```
11x arity=2 kinds=[externref,externref]      5x arity=1 kinds=[externref]
 3x arity=0 kinds=[]                         1x arity=3 kinds=[externref,externref,externref]
 1x arity=2 kinds=[i32,ref]     ← hazard     1x arity=1 kinds=[ref]     ← hazard
```

If the bridge ever under-applies one of those, the dispatcher's own conversion
traps: a non-nullable `(ref $T)` formal takes `any.convert_extern(null)` →
`ref.cast $T` (**illegal cast**), and an `i32` formal takes
`__unbox_number(null)` → NaN → `i32.trunc_f64_s` (**invalid conversion to
integer**). This is the same "a non-nullable `(ref N)` has no undefined
inhabitant" line #3548 established, so a pad cannot fix it — the fix would be to
**widen only when sound** (probe returns `declArity` plus a `minSafeN` = one past
the last formal with no undefined inhabitant; widen only when `argc >= minSafeN`).

**No such trap has been observed** — 0 occurrences in the N = 4,000 A/B below.
Per MEASURE-NEVER-EXTRAPOLATE, no guard code was written. The landing agent must
re-run the innermost-frame classifier on the fresh full-corpus A/B and implement
the `minSafeN` widening **only if it fires**.

#### 6. A/B on a seeded uniform sample, N = 4,000 (2026-07-25)

**Sample counts against the sample denominator. Deliberately NOT scaled to a
corpus number** — the landing needs its own fresh run against the `main` of the
day (see "Decision"), so a corpus figure produced now would be stale on arrival.

Selection (reproducible): all 48,088 non-`_FIXTURE`, non-`.imports.js` `.js`
files under `TEST_CATEGORIES`, sorted, Fisher-Yates shuffled with mulberry32
`seed = 20260725`, first 4,000 taken; 4 strided shards. Both arms run in ONE
process, ONE runner (`runTest262File(..., "standalone")`), ONE file at a time,
with only `JS2WASM_DISABLE_APPLY_ARITY_WIDENING` (an **uncommitted** codegen-time
switch) toggled between them. Never diffed against the committed baseline JSONL.

| OFF → ON                      |   count |
| ----------------------------- | ------: |
| pass → pass                   |   1,939 |
| fail → fail                   |   1,068 |
| **pass → fail**               | **453** |
| skip → skip                   |     401 |
| compile_error → compile_error |     131 |
| pass → compile_error          |       3 |
| fail → compile_error          |       2 |
| compile_error → pass          |       2 |
| compile_error → fail          |       1 |

Per-arm: **pass 2,395 → 1,941**, fail 1,070 → 1,522, compile_error 134 → 136,
skip 401 → 401.

**Honest flips: 453 of the 2,395 sampled standalone passes = 18.9 % of the
sampled pass set was vacuous through this one mechanism.** Every one of the 8
status changes that involves a `compilation timeout` in either arm is a
**contention artifact** (the box sat at load ~18 during the run, not the change);
the 453 figure already excludes the 3 that are `pass → compile_error`. Genuine
gains are **0** — both `compile_error → pass` rows are the same timeout artifact.

**Invalid Wasm introduced by the widening: 0.** Classifier = the innermost frame
(the function named right after `illegal cast in `); a widening-introduced trap
must be `__call_fn_method_N` itself. Of the 453 flips, **445 carry no wasm frame
at all** (plain harness assertion failures) and **8 carry one — every one a user
closure or a runtime helper, never a dispatcher**:

```
__closure_36  built-ins/SharedArrayBuffer/negative-length-throws.js
__closure_57  built-ins/TypedArrayConstructors/ctors-bigint/buffer-arg/excessive-offset-throws-sab.js
__closure_39  built-ins/Array/prototype/copyWithin/return-abrupt-from-this-length.js
__closure_37  built-ins/Array/prototype/findLast/return-abrupt-from-this-length-as-symbol.js
__closure_34  built-ins/TypedArrayConstructors/BigInt64Array/prototype/not-typedarray-object.js
__closure_40  built-ins/WeakSet/iterator-next-failure.js
__anon_0_f    language/eval-code/direct/gen-meth-fn-body-cntns-arguments-lex-bind-declare-arguments.js
__get_member_done  built-ins/Iterator/concat/throws-typeerror-when-generator-is-running-next.js
```

`findLast/return-abrupt-from-this-length-as-symbol.js` was additionally put
through the same two controls as the original repro (exact-arity with the
widening ON; exact-arity with it OFF) — **identical trap in both**, independently
confirming the classifier.

What the failing line of each flip cites — all harness assertions, i.e. honest:

| cited at the failing line       | count |
| ------------------------------- | ----: |
| `assert.sameValue`              |   151 |
| `assert.throws`                 |   139 |
| `throw new Test262Error`        |   110 |
| (no cited line — async channel) |    38 |
| `assert.compareArray`           |    12 |
| `assert.notSameValue`           |     2 |
| `assert(`                       |     1 |

The 38 with no cited line are `Test262:AsyncTestFailure:Test262Error: …` rows
(the async completion channel reports no source line) plus two
`assert.compareIterator` sites.

**fail → fail error-signature delta: 6 of 1,202** non-pass→non-pass rows change
signature. Three are the timeout artifacts; the other three are a
`dereferencing a null pointer` → `uncaught Wasm-GC exception`, an
`Expected resolve() to throw` → `Expected SameValue(…)`, and an
`uncaught Wasm-GC exception` → `object is not iterable`. This is the population
#3439's hard-0 unclassified gate could park on, and it does not:

#### 7. Signature routing — **no new `STANDALONE_ROOT_CAUSE_BUCKETS` entry is needed**

Both arms' rows were run through the real router
(`node scripts/build-test262-report.mjs --target standalone
--max-unclassified-root-causes 0`):

| arm | non-pass non-skip | classified | **unclassified** | gate |
| --- | ----------------: | ---------: | ---------------: | ---- |
| OFF |             1,204 |      1,204 |            **0** | PASS |
| ON  |             1,658 |      1,658 |            **0** | PASS |

16 ON-arm error signatures have no OFF-arm counterpart, but **all 16 route into
buckets that already exist**. 32 existing buckets absorb the growth; the largest
are `class-prototype-private-descriptor` +172, `standalone-iterator-protocol`
+44, `eval-new-function` +44, `generator-async-iteration` +36,
`object-property-semantics` +22, `array-typedarray-buffer` +18. Exactly one
bucket (`super-spread-receiver`) was empty in the OFF arm and populated in the
ON arm — it is a **pre-existing bucket definition**, not a new one.

**This refutes the earlier expectation that 3/15 flips would need a new
`Test262:AsyncTestFailure:Test262Error: …SameValue…` bucket.** All 23 (at N=3,020)
/ 30-odd `AsyncTestFailure` rows classify. The reason is structural: the
standalone bucket matchers are predominantly **path**-based
(`class-prototype-private-descriptor` matches `language/statements/class`,
`/class/`, `private`, …), so a _new error signature on an already-covered path_
routes automatically. Only a signature on an uncovered path can reach
`unclassified`.

## Decision (scoping)

**RC1 lands now** (this PR): exhaustively measured, purely positive, zero park
risk, ~10 lines.

**RC2 does NOT land in this budget window.** A ~19 %-of-passing de-inflation is a
deliberate honest-floor landing (park = measurement; separate honest-flips from
invalid-Wasm; cluster-route every new signature into
`STANDALONE_ROOT_CAUSE_BUCKETS`; bump `ORACLE_VERSION` if verdict logic changes)
— see `reference_f1_honest_floor_deinflation_landing_recipe` and #3523. That is
an XL landing, not the M this task was sized for. The fix is complete and
verified on a **ready branch**.

## Implementation

### RC1 (in this PR)

`src/codegen/declarations.ts` — drop the `ctx.wasi` gate so a top-level
`ThrowStatement` is collected into `__module_init` in every lane.

### RC2 (ready branch `issue-3585-apply-closure-arity`, NOT merged)

- `src/codegen/closure-exports.ts` — extract `collectClosureArityEntries` and add
  `buildClosureArityProbe(ctx, valueLocal, anyLocal, funcLocal)`: the **inline**
  twin of the `__closure_arity` export, leaving the declared formal count (or
  `-1`) on the stack.
- `src/codegen/object-runtime.ts` — `fillApplyClosure` widens the dispatch index
  to `max(argc, declaredArity)` before the arity switch.

**Why inline rather than `call __closure_arity`:** the export is minted at
`index.ts:3975`, _after_ `fillApplyClosure` runs at `:3817`. Minting a function
inside that finalize window is the #1839/#117/#1886 late-registration
index-shift hazard that `fillApplyClosure`'s own "S1 pulls no new machinery"
carve-out exists to avoid. Inlining shifts nothing.

**Why widen rather than pad the arg vector:** at `N === closureArity` the #820l
argc/extras plumbing takes its `arity <= closureArity` branch (`__argc =
closureArity`, `__extras_argv = null`) — byte-for-byte what an arity-matched call
sets, so `arguments.length` reflection is unchanged. Padding to the highest
dispatcher would populate `__extras_argv` with synthetic `undefined`s, which is
the exact regression #2623 P-7 was written to remove.

Non-closures probe as `-1`, so `max` leaves `n` untouched: over-application,
exact-arity and not-a-function are byte-identical, and modules with no closures
emit no probe at all. The host/GC lane is untouched — `__apply_closure` is only
ever reserved under standalone/WASI.

## Acceptance criteria

- [x] RC1: top-level `throw` executes in host + standalone (measured, both lanes)
- [x] RC1: exhaustive A/B over the complete 40-file exposed population, 0 regressions
- [x] RC2: root cause isolated to arity under-application, with host/plain-fn/object-method/explicit-`undefined` controls
- [x] RC2: `verifyProperty` measured as a SEPARATE root cause (identical A/B arms)
- [x] RC2: honest pass/fail split reported with denominators, not extrapolated
- [x] RC2: the reported illegal-cast "blocker" measured — **pre-existing, not
      widening-introduced** (exact-arity control + widening-off control, ×2 files)
- [x] RC2: widening-introduced invalid Wasm **= 0** at N = 4,000 (innermost-frame classifier)
- [x] RC2: missing formal verified BY VALUE to read as `undefined`, host-free,
      for the concrete-ref (string) lowering; pinned by a test
- [x] RC2: signature routing settled — **0 unclassified in both arms**, no new
      `STANDALONE_ROOT_CAUSE_BUCKETS` entry required
- [ ] RC2: honest-floor landing per the F1 recipe (needs a FRESH corpus A/B
      against the `main` of the landing day — the numbers above are a sample and
      will be stale)

## Landing checklist (for whoever schedules RC2)

1. **Wait for a quiet queue.** Do not land alongside an in-flight
   `ORACLE_VERSION` bump — the two together can wedge the merge queue.
2. **Re-measure fresh, full corpus, local-vs-local** with the uncommitted
   `JS2WASM_DISABLE_APPLY_ARITY_WIDENING` switch. Budget: **~2.0 s per file-pair**
   single-process (measured), 48,088 files ⇒ ~26.7 CPU-hours. Never diff against
   the committed baseline JSONL.
3. **Run the innermost-frame classifier** over the pass→fail flips. If any flip's
   innermost frame is `__call_fn_method_N`, that IS a real blocker → implement the
   `minSafeN` widening from §5 before landing. It did not fire at N = 4,000.
4. **Re-run the routing gate** (`--max-unclassified-root-causes 0`) on the ON arm.
   It passed at N = 4,000 with no new bucket.
5. **Exclude `compilation timeout` rows** from the flip accounting — they are
   machine-contention artifacts, not flips (8 of them at N = 4,000).
6. Park = measurement; expect a bot park-hold on the merge-group floor gate and
   treat it as the measurement, per
   `reference_f1_honest_floor_deinflation_landing_recipe`.

## Follow-up

1. **Land RC2 deliberately** as an honest-floor de-inflation (XL).
2. ~~**Fix the `undefined`-into-a-typed-formal trap** surfaced by RC2~~
   **WITHDRAWN 2026-07-25** — measured as pre-existing (two controls; see "RC2
   re-measure" §1). A missing formal already reads as `undefined` for the
   concrete-ref case that actually occurs (§4). The _unreached_ `i32` /
   non-nullable-`ref` hazard is recorded in §5 with the `minSafeN` fix sketch;
   implement it only if the innermost-frame classifier fires on the landing run.
3. **`verifyProperty` vacuity is unexplained** and is NOT the arity bug — it needs
   its own investigation (4,735 files call it).
