---
id: 2040
title: "standalone: generator/destructuring runtime-semantics residual — rest-pattern iterator consumption, lazy defaults, private elements (~1,750 tests)"
status: in-progress
sprint: 64
created: 2026-06-10
updated: 2026-06-21
assignee: sdev-vecdispatch
priority: critical
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: generators, destructuring, classes, private-names
goal: standalone-mode
related: [1665, 680, 1326c, 2038, 2037]
test262_bucket: standalone-dstr-generator-runtime
test262_count: 1750
es_edition: es2015
origin: "2026-06-10 standalone-vs-host baseline diff: 1,112 dstr-directory + 639 generator/class-elements runtime assertion failures that compile and instantiate fine in standalone but compute wrong values."
---

# #2040 — standalone generator/destructuring runtime-semantics residual

## Problem

The largest *runtime* (not compile) residual in the standalone lane:
~1,750 gap tests compile, instantiate, and run, but fail assertions. Host mode
passes all of them. Two clusters:

**A. `dstr/` directories (1,112 rows)** — destructuring evaluation semantics
through the native (pure-Wasm, #1665) generator/iterator machinery:

| Count | Failing assertion | Meaning |
| ---: | --- | --- |
| ~450 | `assert.notSameValue(x, values)` (assert #6, `returned 7`) | array **rest** pattern `[...x] = values` must create a *new* array from the iterator ([§8.6.2 IteratorBindingInitialization, BindingRestElement](https://tc39.es/ecma262/#sec-runtime-semantics-iteratorbindinginitialization)); standalone aliases the source array |
| ~165 | `assert.sameValue(x, <n>)` element/default values | iterator-driven element binding gets wrong value (off-by-one `next()` consumption or default applied when value present) |
| ~120 | `returned 2`/`L#:#` empty error in `meth-ary-ptrn-rest-*` | rest-pattern via method params |
| ~90 | `array element access out of bounds [in C_method()]` | rest/elision indexing past materialized length |
| rest | `dflt-*` lazy-default families | defaults evaluated eagerly or not at all |

Example: `language/statements/class/dstr/async-gen-meth-static-dflt-ary-ptrn-elem-ary-rest-iter.js`
returns 7 (assert #6 `assert.notSameValue(x, values)`) on main @ 936d1ac51 —
the rest binding `x` IS the source iterable instead of a fresh array.

**B. generator / class-elements (639 rows)** — generator-object semantics:

| Count | Failing assertion | Meaning |
| ---: | --- | --- |
| ~140 | `assert.sameValue(executed, false)` / `assert.sameValue(accessed, false)` | eager evaluation of code that must be lazy (generator body runs at call instead of first `next()`, or property getter probed during compile-time dispatch) |
| ~220 | `assert.sameValue(c.m().next().value, 42)` / `C.m().next().value` | generator **methods** (incl. static, private-name `#m`, computed) return wrong `value` — plain `function*` passes, the method/private forms diverge |
| ~50 | `assert.sameValue(inst.getPrivateReference(), 'get string')` etc. | private accessor/method references inside generator bodies |
| ~48 | `"arguments" in this === false` (eval-code/direct) | overlaps #1066 eval scope — exclude from this issue |

## Why one issue

Both clusters sit on the same machinery: the native generator state machine
(#1665) + IteratorBindingInitialization codegen. A dev fixing rest-pattern
copy semantics and `next()` consumption order will touch the same
`src/codegen` generator/destructuring lowering for A and most of B's
`next().value` rows. If the architect prefers, split A (destructuring
evaluation order, ~1,100) from B (generator-object/private-elements, ~590)
after the first WAT-level diagnosis.

## Suggested approach

1. Start with the highest-leverage single bug: **BindingRestElement must
   `ArrayCreate` + append from the iterator**, never alias. (~450 rows.)
2. Then audit `next()` consumption order for `ary-ptrn-elem-*` with defaults:
   spec order is: call `next()` once per element, use default only when
   `done` or value `undefined`.
3. For B: compare WAT of `class C { *m() { yield 42; } }` (passes) vs the
   failing `new-sc-line-gen-rs-privatename-identifier-initializer.js` form to
   find where method-position generators diverge.

## Investigation (sd-3, 2026-06-21) — cluster A rest-identity diagnosis

Reproduced on current origin/main via `runTest262File` (HOST vs STANDALONE):
`class/dstr/*ary-ptrn-rest*` → **HOST 12/12 pass, STANDALONE 6/12**; the 6 fails
are all `assert.notSameValue(x, values)` (`returned 7`, assert #6): the rest
array `x` reads as **reference-identical** to the source `values`.

**Ruled OUT — the codegen DOES build a fresh rest array in BOTH lanes:**
- Typed `method([...x]: number[])` → fresh (`array.new_default`+`array.copy`+
  `struct.new`, the `__rest_arr` build at destructuring-params.ts:1644-1681).
- UNTYPED `method([...x])` (the exact test262 shape, externref param arm) →
  the full `$C_method` WAT *also* contains `array.copy:1` + `array.new_default:5`:
  the externref param is materialized to a fresh `resultLocal` vec, then the rest
  copies that into `x`. So `x` is a copy-of-a-copy — structurally NOT the source.

**So the alias is NOT a missing rest copy. PROVED via pure-standalone probes
(no harness, bare `{}` instantiate):**
- `class C { method([...x]){ x.push(99); ... } }; method(values)` → after the
  call `values.length === 3` and `x.length === 4`: **`x` is structurally a fresh,
  independent array** (mutating it does not touch `values`).
- `Object.is(x, values)` for the rest case returns **`0` (NOT same)** — correct;
  `Object.is(distinct arrays)`=0, `Object.is(same)`=1, `===` on distinct arrays=0
  all correct standalone.

**Conclusion: the destructuring rest codegen AND `Object.is`/reference-identity
are CORRECT in pure standalone.** The `assert.notSameValue(x, values)` failure
manifests ONLY through the test262 **harness-wrapped** path (the harness
`assert.js` + `env`-import instantiate the runner provides; a bare `{}`
instantiate of the harness traps on `Import #0 "env"`). So the headline ~450-row
cluster A is most likely NOT a destructuring/generator lowering bug at all — it is
either a `harness/assert.js` `notSameValue` lowering issue or a host-bridge
marshaling-identity artifact specific to the runner, surfacing only when the two
vecs cross the `env` boundary for the assert.

**NEXT SESSION (re-scope before coding):** run ONE failing file under the runner
with the rest binding replaced by an in-wasm `Object.is(x, values)` return (no
`assert`) to confirm the codegen value is right and isolate `assert.notSameValue`;
then inspect `assert.notSameValue`/`SameValue` lowering + the runner's `env`
marshaling (`__make_iterable`, vec→JS) for an identity collapse. The fix is very
likely in the marshaling/`SameValue` path, NOT destructuring-params.ts — which
would re-scope cluster A's count substantially. The `directCastInstrs` fast-path
(destructuring-params.ts:1122-1126, `resultLocal = param` no-copy for an already-
`__vec_externref` param) was checked and is NOT the cause (the rest still builds a
fresh vec downstream: the untyped `$C_method` WAT has `array.copy:1`).

Orthogonal smaller slice found: `const [a=9] = [undefined]` → NaN (default not
applied when the element value is `undefined`); spec §8.5.3 applies the default on
`undefined`, not just `done`. Filed as **#2574**.

## ROOT CAUSE FOUND — standalone `__any_strict_eq`/`__any_eq` tag-5 number bug (sd-3, 2026-06-21, supersedes the "harness/marshaling" hypothesis above)

NOT the runner, NOT marshaling, NOT destructuring. The harness `assert._isSameValue`
(`if(a===b){return a!==0||1/a===1/b;} return a!==a && b!==b;`, `a`/`b` `any` params)
miscompiles in **standalone ONLY** (wasi + host both correct).

**Minimal repro (no if / no destructuring):**
```ts
function f(a:any,b:any){ const d=(1/a===1/b); const n=(a!==a); return n; }
f(1,2)   // standalone: true (WRONG)   wasi/host: false
```
Also breaks with `String(a)` / `a*2` / `a-1` in place of `1/a` — i.e. **ANY
`any`-op that ensures the AnyValue type before a self `===`/`!==`.**

**Mechanism (WAT-proven):**
1. `a!==a` ALONE → the correct abstract-eq cascade (`__typeof_number`→
   `__unbox_number`→`f64.eq`, 15 calls) → right answer.
2. After a preceding `any`-op, `ctx.anyValueTypeIdx >= 0`, so the gate at
   `binary-ops.ts:967-980` routes the SAME `a!==a` through
   `compileAnyBinaryDispatch` → `__any_strict_eq` instead.
3. `compileAnyBinaryDispatch` boxes each operand via `boxToAny`
   (`value-tags.ts:178-186`), which — by the **deliberate #1888 policy**
   ("box-the-externref as tag-5"; honest recovery flipped −794 baseline) — boxes a
   NUMBER externref as **tag 5 (string)**.
4. The tag-5 arm of `__any_strict_eq` / `__any_eq` (`any-helpers.ts` ~1607 / ~1339)
   compares the two field-4 externrefs with `__str_equals`. For two tag-5 boxes
   wrapping the SAME number externref that is meaningless → "unequal" → `a!==a`
   true. `_isSameValue` then wrongly returns true → EVERY `assert.sameValue`/
   `notSameValue` over a numeric `any` fails (a huge fraction of test262 — likely
   ≫ 450 rows). This is the true cluster-A driver.

**Proven-viable fix direction (but #1888-pinned — needs full-baseline validation):**
- `__any_to_f64(tag5BoxOfNumber)` DOES recover the number (its #1888 $BoxedNumber
  arm) — confirmed: `a*2; return a+0` → 5 standalone. So the tag-5 EQUALITY arm in
  BOTH helpers should disambiguate by the RUNTIME externref: `__str_equals` only
  when BOTH field-4 externrefs `ref.test ctx.anyStrTypeIdx` (genuine native
  strings); otherwise `__any_to_f64` both + `f64.eq`.
- sd-3 attempted exactly this (both helpers, nativeStrings-gated) but the emitted
  tag-5 arm still returned wrong in a way the local WAT couldn't fully explain (the
  arm appeared dead/folded even with `optimize:false`), so it was **REVERTED** to
  avoid a half-fix in the #1888-pinned representation. The boxing itself
  (`__any_box_string` for externrefs) MUST NOT change (−794). The fix belongs in the
  equality helpers' tag-5 arm and must be gated by the full standalone baseline
  (merge_group), not a scoped local check.

**ESCALATED to tech lead** — high value (top-tier standalone unlock), high risk
(#1888 794-test representation). Wants an architect spec + full-baseline gate before
landing. The `directCastInstrs` rest-copy theory was ruled out (the rest IS fresh;
the failure is purely the equality helper).

## Acceptance criteria

- `assert.notSameValue(x, values)` family passes: rest pattern yields a fresh
  array (≥400 rows).
- `dflt-ary-ptrn-elem-*` default-evaluation rows pass (lazy, spec-ordered).
- Private/static generator-method `next().value` rows pass.
- Standalone baseline runtime-fail count in `dstr/` halves (≤550); host
  unchanged.

## Cluster-A EQUALITY angle — SHELVED (sd-3, 2026-06-21, evidence-backed)

The cluster-A `assert.sameValue/notSameValue` failures were chased to the
standalone AnyValue tag-5 equality path. Two fixes were implemented + validated;
BOTH are net-negative on CURRENT main, and the case they targeted is ALREADY
handled. **Verdict: SHELVE the equality fix; PR #1863 stays held/closed.**

**Decisive finding:** the architect's premise (mixed-tag `assert.sameValue(z,
<literal>)` — z=tag-5 `$box_number_struct`, literal=tag-3 — fails the `{2,3}`
numeric-class gate) is **FALSE on current `origin/main`.** Direct test of the
runner's shim shape `isSameValue(o.z, 7)` (tag-5 box_number vs tag-3 literal) on
CLEAN current main → **already PASSES** (and `o.z===8`→0, any-param→1). The
mixed-tag case is no longer broken — current main absorbed it via the
#2503/#2358/#2187/#2574 merges that landed AFTER #1863's original +311 baseline.

**Validation of both fix layers (vs CLEAN current main):**
- Tag-5-arm 3-way cascade (PR #1863): net **−151** on the full merge_group floor.
  Carrier is `$box_number_struct` (ref.test-able — sd-3's "4th carrier"
  hypothesis ruled out by arch-2040), but the tag-5 arm (i) can't reach the
  dominant mixed-tag `===` rows and (ii) bakes native-string-helper funcIdx into
  the eq helpers → reconcileNativeStrFinalizeShift desync surface
  (#1677/#2039/#2043).
- Numeric-class-gate broadening (arch-2040's tractable re-scope: admit `tag==5 &&
  ref.test field4 $box_number_struct` to the `{2,3}` numeric arm of
  `__any_strict_eq`): **14 regressions / 0 improvements** on the class/dstr
  sample. 0 improvements because nothing is broken to fix; 14 regressions because
  it mis-classifies cases that pass today.

`__any_to_f64` itself is fine (`Number(o.z)` recovers correctly). The +311 is NOT
lost — it is already realized on main. Any equality-helper change now is pure
regression risk → **leave the equality helpers untouched.** The OTHER #2040
residuals (cluster-B generator-object semantics, the rest-identity rows) are
separate and unaffected by this verdict. A SEPARATE pre-existing compiler
stack-overflow on nested-obj-pattern-default in (static) methods (the source of
several of the 13 `wasm_compile` floor entries) is filed as **#2587**.

## Implementation Notes (sdev-vecdispatch, 2026-06-21) — tag-5 3-way classifier

Implements arch-tag5's "unified tag-5 field-4 equality fix" spec (PR #1886) — the
equality half of #2040 + the #2585 proto-identity fix. Stacks on #1883/#2583
(which added `tag5StringEqThen()` and is the content-eq base).

**Why this is NOT the rejected "numeric-class-gate broadening" above.** The prior
−788/−794 verdict ("leave equality helpers untouched; 14 regressions / 0
improvements") was for admitting `tag==5 && ref.test field4 $box_number` into the
`{2,3}` numeric arm of `__any_strict_eq` — which reclassifies tag-5-vs-tag-2 cross
cases and mis-fires (14 regressions). arch-tag5's measurement REFRAMED it: the
defect is *within* the both-tags-5 arm (overloaded field-4), and
`nativeBoxNumberTypeIdx >= 0` is TRUE in standalone (sd-3's "−1" premise was
false). So the fix is a 3-way classifier *inside* the tag-5 arm (only reached when
both operands are tag 5) — it never touches the cross-tag path, so it cannot cause
the 14-regression mis-classification.

**What changed** (`src/codegen/any-helpers.ts`, consumer-side only — no boxing /
`$AnyValue`-layout / −788/−794 change):
- `tag5FieldEqDecision(a,b,anyA,anyB)` shared by the tag-5 arm of BOTH `__any_eq`
  and `__any_strict_eq`: (1) EITHER field-4 is `$BoxedNumber` → `__any_to_f64` +
  `f64.eq` (numeric branch, gated ONLY on `nativeBoxNumberTypeIdx >= 0`, never
  `nativeStrings` — the gate that killed sd-3's attempt); (2) BOTH field-4 are
  genuine strings → existing `tag5StringEqThen()`; (3) BOTH eqref objects →
  `ref.eq` (#2585); else conservative `tag5StringEqThen()`.
- `f64.eq` preserves `NaN===NaN` false (−788) while fixing `23===23.0` true.
- Two `anyref` scratch locals (4/5) added to both helpers.
- `__any_eq` cross-tag String⇄Number sub-read hardened: tag-5 ToNumber now routes
  a `$BoxedNumber` field-4 through `__any_to_f64`, only genuine strings through
  `__str_to_number` (`tag5ToNumber()`).

This also FIXED a latent trap #1883 introduced: `tag5StringEqThen`'s
`ref.cast $AnyString` traps ("illegal cast") on a tag-5 boxed-number/object — the
classifier guards every cast with the runtime type test, so those cases never
reach the string cast.

**Verified** (`tests/issue-2040-tag5-field4-eq.test.ts`, 12/12): 23===23.0,
a!==a-post-numeric-op, boxed===boxed, NaN===NaN false, +0===-0, proto-identity
(#2585), object identity, loose 23==23.0. eq/array/identity regression suites
green. Pre-existing-and-unrelated (verified by reverting any-helpers.ts —
identical fail count on the #1883 base): `issue-1888-any-extern-roundtrip` (5,
open-any dispatch bridge NaN), `issue-1888.test` 2-4-arg closure (1), `issue-2081`
wasi loose-eq (#2043 late-import shift, 10), `logical-conditional-identity` void→NaN (3).

**MUST be full-baseline (merge_group) gated** — the risk is in the −788/−794
representation contracts; only the full standalone test262 lane confirms
net-positive with zero regression bucket. Folds in #2585 (close it).
