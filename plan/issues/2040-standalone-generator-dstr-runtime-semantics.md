---
id: 2040
title: "standalone: generator/destructuring runtime-semantics residual — rest-pattern iterator consumption, lazy defaults, private elements (~1,750 tests)"
status: done
completed: 2026-07-16
assignee: ttraenkler/fable-beta
sprint: 72
loc-budget-allow:
  - src/codegen/any-helpers.ts
  - src/codegen/context/types.ts
created: 2026-06-10
updated: 2026-07-19
priority: critical
horizon: l
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

## Implementation Plan — unified tag-5 field-4 equality fix (arch, 2026-06-21, consolidates #2040 + #2585)

> Spec covers BOTH the numeric-eq defect (#2040, this file) and the
> proto-identity defect (#2585). The content-eq half (native `__str_flatten`+
> `__str_equals`) lands separately via #1883/#2583 and is **not** in scope here.
> **Spec only — devs implement.**

### Root cause (one sentence)

The tag-5 (string) box's `externval` (field 4 of `$AnyValue`) is overloaded —
`$AnyString` / `$NativeString` / cons-string / host-string / **`$BoxedNumber`** /
object refs all live there under tag 5 (the deliberate #1888 "box-the-externref
as tag-5" `−794` contract, `value-tags.ts:185`) — and the tag-5 arm of BOTH
`__any_strict_eq` (`any-helpers.ts:1607-1624`) and `__any_eq`
(`any-helpers.ts:1436-1452`) unconditionally runs `__str_equals` on the two
field-4 externrefs. That is correct only when both are genuine strings:
- two tag-5 boxes wrapping the same `$BoxedNumber` ⇒ `__str_equals` is
  meaningless ⇒ `a !== a` wrongly true ⇒ every `assert.sameValue`/`notSameValue`
  over a numeric `any` fails (the true #2040 cluster-A driver).
- two tag-5 boxes wrapping the same object/proto ref ⇒ `__str_equals` content-
  compares two non-strings ⇒ object identity silently lost
  (`getPrototypeOf(Object.create(p)) === p` false — #2585).

### Decisive measurement (arch, this session) — REFRAMES the problem

The parked #2585 commit (`7330e3b34`) claims `ctx.nativeBoxNumberTypeIdx == -1`
"in pure standalone", concluding no local `ref.test` can separate a boxed
number from an object and therefore a full representation overhaul (a distinct
boxed-number tag) is required. **That premise is empirically FALSE.** Compiling
the exact #2040 repro under `--target standalone optimize:false`:

```
function f(a:any,b:any){ const d=(1/a===1/b); const n=(a!==a); return n; }
export function main(): number { return f(1,2) ? 1 : 0; }
```
→ the emitted module DOES contain the `__box_number_struct` type def, i.e.
`nativeBoxNumberTypeIdx >= 0`. `addUnionImportsAsNativeFuncs` (`index.ts:9301-
9322`) registers `$__box_number_struct`/`$__box_boolean_struct` and assigns the
type indices under the `(ctx.wasi || ctx.standalone)` gate at `index.ts:8989` —
and it is ALWAYS reached before `ensureAnyHelpers` builds the eq helpers (the
`addUnionImports` at `index.ts:13523` precedes `ensureAnyHelpers` at `13536`).
Any module that has `$AnyValue` + the eq helpers at all has necessarily gone
through union-import registration, so the boxed-number type is present. This is
the SAME `ctx.nativeBoxNumberTypeIdx >= 0` guard that `__any_to_f64`'s working
#1888 recovery arm (`any-helpers.ts:866-905`) already relies on — sd-3 confirmed
that arm recovers the number (`a*2; return a+0` → 5 standalone).

`__box_number` builds an eqref-castable `$BoxedNumber` struct
(`index.ts:9369-9372`), distinct from `$AnyString`/`$NativeString`. So **a local
`ref.test` over field-4 cleanly partitions the overload** — no new tag, no
representation change, no boxing change (the #1888 `−794` invariant is untouched
because we never alter what `__any_box_string`/`boxToAny`/`fallbackStringAny`
emit).

### Decision: POSITIVE string-discrimination in the tag-5 eq arm, NOT a new tag

Reject the "distinct boxed-number tag" approach the task line suggested. It is
(a) unnecessary given the measurement above, and (b) maximally risky — it would
have to touch every tag-5 producer (`__any_box_string`, `__any_from_extern`/
`fallbackStringAny` at `any-helpers.ts:194`, `boxToAny` at `value-tags.ts:178`)
plus every tag-5 consumer (typeof, ToString, `__any_add` concat, `__any_eq`
cross-tag String⇄Number arm at `any-helpers.ts:1330-1357`, the
`__extern_same_value_zero` NaN arm), re-opening the full `−794`/`−788` surface.

Instead, fix ONLY the two equality helpers' tag-5 arms. The arm must classify
the two field-4 externrefs by RUNTIME type and pick the right comparison.
Replace the current "tag5 ⇒ `__str_equals`" body with a 3-way decision:

1. **Both field-4 externvals are genuine strings** (`ref.test` over the string
   carrier types) ⇒ content compare (`__str_equals`, the existing path; or `0`
   when `strEqualsIdx < 0`, unchanged from today).
2. **Either field-4 externval is a `$BoxedNumber`** ⇒ numeric compare:
   `__any_to_f64(a)` + `__any_to_f64(b)` + `f64.eq`. `__any_to_f64` already does
   the `$BoxedNumber` recovery for tag-5 (its #1888 arm), so this is just two
   existing calls + `f64.eq`. This makes `23 === 23.0` correct AND keeps
   `NaN === NaN` FALSE (`f64.eq` over two NaN is 0 — the #1888 `−788` boxed-NaN
   contract is PRESERVED, because `f64.eq` is self-false for NaN exactly as the
   self-inequality bridge requires).
3. **Otherwise** (both eqref objects, neither a boxed number) ⇒ reference
   identity: `any.convert_extern` both, `ref.test`/`ref.cast` the `eq` abstract
   heap type (`-19`), `ref.eq` (this is the #2585 fix). A host externref that is
   not an internal GC eqref (non-standalone `wasm:js-string`) fails the `ref.test`
   and falls back to content compare — preserves host string `===`.

### The classifier (the load-bearing detail)

Order the tests so each case is unambiguous. Compute once per operand into a
local (avoid re-`struct.get`+`any.convert_extern` 6×):

```
;; for each operand i ∈ {a,b}: extern_i = struct.get $AnyValue 4 ; any_i = any.convert_extern extern_i
isStr_i  = ref.test (anyStrTypeIdx)   on any_i      ;; genuine native string
;;          (also accept nativeStrTypeIdx if anyStrTypeIdx is the cons/base supertype —
;;           verify which is the right umbrella with isAnyStringRefType; see note)
isNum_i  = (ctx.nativeBoxNumberTypeIdx >= 0) && ref.test (nativeBoxNumberTypeIdx) on any_i
isObj_i  = ref.test (-19 eq) on any_i  && !isNum_i  ;; eqref object that isn't a boxed number
```

Decision (in the tag-5 then-arm, both operands already known tag==5):
```
if (isNum_a || isNum_b):            ;; numeric branch dominates — a number on either side
    return __any_to_f64(a) f64.eq __any_to_f64(b)
elif (isStr_a && isStr_b):          ;; both real strings
    return strEqualsIdx>=0 ? __str_equals(extern_a, extern_b) : 0
elif (isObj_a && isObj_b):          ;; both internal GC eqref objects
    return ref.eq(ref.cast -19 any_a, ref.cast -19 any_b)
else:                               ;; mixed kinds under one tag (string vs object, host extern, etc.)
    return strEqualsIdx>=0 ? __str_equals(extern_a, extern_b) : 0   ;; conservative: today's behaviour
```

**Why numeric-branch-first is correct and safe:** `f64.eq` over two NaN is 0, so
`NaN===NaN` stays false (#1888 `−788` preserved); `23===23.0` becomes true
(#2040 fixed); a number-vs-string under one tag (`isNum_a && isStr_b`) cannot be
a `===` true anyway, and `__any_to_f64` of a genuine-string box returns the
string's f64val (0 / its #1888 fallthrough) — not equal to the number unless
coincidental, which under strict-eq with both sides tag-5-string-vs-number is a
don't-care for the dstr/sameValue traffic. (If a residual shows up there it is a
separate, smaller arm; do not over-engineer the mixed case now.)

### sd-3's earlier attempt — why it "appeared dead/folded"

sd-3 tried the nativeStrings-gated string-discriminated arm and saw the tag-5
arm fold to a wrong constant even at `optimize:false`. Most likely cause: the
attempt gated the WHOLE new arm on `ctx.nativeStrings`, but the #2040 numeric
repro (`f(1,2)`) does NOT enable native strings, so `strEqualsIdx`/`anyStrTypeIdx`
were `-1` and the arm degenerated to the legacy `i32.const 0` BEFORE the numeric
branch could run. **Fix: the numeric branch (case 2) must be gated ONLY on
`ctx.nativeBoxNumberTypeIdx >= 0` (always true in standalone/wasi), NOT on
`nativeStrings`.** The string branch stays `strEqualsIdx`-gated; the object
branch is unconditional (`-19` is a builtin abstract type, no registration).
This is the single most important correction over the parked prototype.

### Changes

**File: `src/codegen/any-helpers.ts`** — function `ensureAnyHelpers`.

1. Factor a shared local helper inside `ensureAnyHelpers` (after `strEqualsIdx`/
   `toF64Idx` are resolved, ~L504/L917) that returns the `Instr[]` for the tag-5
   3-way decision above, parameterised by the two operand local indices (0 and
   1) and `toF64Idx`/`strEqualsIdx`/`ctx`. Both eq helpers call it so they can
   never drift. Add the per-operand classifier locals to BOTH helpers' `locals`
   lists (two `anyref` temps for `any_a`/`any_b`; reuse if a free slot exists —
   `__any_strict_eq` already has tagA/tagB at 2/3, add 4/5).
2. `__any_strict_eq` tag-5 arm: replace `any-helpers.ts:1607-1624` (the
   `strEqualsIdx >= 0 ? [...__str_equals...] : [i32.const 0]` then-branch of the
   `tag==5` `if`) with the shared 3-way decision.
3. `__any_eq` tag-5 arm: replace `any-helpers.ts:1436-1452` identically. NOTE
   `__any_eq` additionally has the cross-tag String⇄Number arm at L1330-1357
   that calls `__str_to_number(field4)` when one tag is 5 and the other numeric.
   That arm ALSO misfires on a `$BoxedNumber` field-4 (it would `__str_to_number`
   a non-string). **In scope to harden**: before that arm runs `__str_to_number`
   on a tag-5 operand, it should check `isNum` and use `__any_to_f64` instead
   (same classifier). Keep this minimal — only the tag-5 ToNumber sub-reads at
   L1338-1340 / L1355-1357 need the `isNum ? __any_to_f64 : __str_to_number`
   guard.

**No changes** to `__any_box_string`, `boxToAny` (`value-tags.ts`),
`__any_from_extern`/`fallbackStringAny`, `__any_to_f64`, or any boxing site. The
`$AnyValue` struct layout is unchanged. This is purely consumer-side in the two
eq helpers (+ the one `__any_eq` ToNumber sub-read).

### Wasm IR pattern (the object-identity case 3, mirrors binary-ops.ts:2633)

```wasm
;; both field-4 externvals proven eqref (and not $BoxedNumber):
local.get $a  struct.get $AnyValue 4  any.convert_extern  ref.cast (ref eq)
local.get $b  struct.get $AnyValue 4  any.convert_extern  ref.cast (ref eq)
ref.eq
```

### Edge cases

- **`NaN === NaN`** ⇒ MUST stay false. Numeric branch uses `f64.eq` ⇒ 0. Verify
  the #1888 regression test (`#1888-any-extern-roundtrip 'propagates NaN'`) and
  the `__extern_same_value_zero` NaN path (`any-helpers.ts:338-349`) still pass —
  SameValueZero(NaN,NaN)=true is handled by its OWN arm, not by `__any_strict_eq`,
  so it is unaffected.
- **`+0 === -0`** ⇒ true (`f64.eq` gives it). Matches spec strict-eq.
- **`23 === 23.0`** across a tag-2 box and a tag-5 boxed-number ⇒ now true.
- **two distinct objects** ⇒ `ref.eq` false (correct); **same object via two
  reads** ⇒ `ref.eq` true (#2585 fixed).
- **GC/host mode** ⇒ host never reaches `__any_eq`/`__any_strict_eq` (it routes
  `===` through host imports); the object branch's `ref.test -19` also guards a
  `wasm:js-string` host externref so it falls to content-compare. Byte-for-byte
  unchanged for host — assert with a gc-mode regression test.
- **`strEqualsIdx < 0`** (no native strings) ⇒ string/mixed branches return `0`
  exactly as today; only the numeric and object branches add new true-paths.
  This is why the numeric branch must NOT be nativeStrings-gated.

### Test files to verify (full-baseline gated — merge_group, NOT scoped local)

- `#2040` repro: `function f(a:any,b:any){return a!==a;}` after any preceding
  `any`-op ⇒ standalone `f(1,2)` must be `false` (currently `true`).
- `language/statements/class/dstr/*ary-ptrn-rest*` standalone: 6 currently-fail
  `assert.notSameValue(x, values)` rows flip pass (the cluster-A driver).
- `#2585`: `Object.getPrototypeOf(Object.create(p)) === p` standalone ⇒ true.
- The #1888 `−788`/`−794` guard set: `tests/issue-1888*.test.ts`,
  `tests/issue-1472.test.ts -t "#1888 Slice 2"`, and the
  `#1888-any-extern-roundtrip` propagates-NaN test — ALL must stay green.
- Run the FULL standalone test262 lane (CI merge_group), not a scoped check —
  per the escalation, the risk is in the `−788`/`−794` representation contracts
  and only the full baseline can confirm net-positive with zero regression
  bucket >0.

### Risk summary

- **Risk it re-opens #1888 (`−788`/`−794`)**: LOW. No boxing/representation
  change; `f64.eq` preserves NaN-self-false; the object branch is guarded by
  `ref.test -19` so host externrefs are untouched. The contracts are consumer-
  side invariants this fix explicitly honours.
- **Residual mixed-kind tag-5 (`string` vs `object` under one tag)**: deferred to
  the conservative `else` (today's `__str_equals`/`0`) — not a regression, and
  not material to the dstr/sameValue traffic.
- **`reasoning_effort: high`** confirmed — the classifier ordering and the
  nativeStrings-vs-boxNumber gating distinction are the two places a dev will get
  it wrong; both are called out explicitly above.

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

## Cascade landing plan (cascade-lead, 2026-06-22) — re-grounded vs current origin/main

Re-grounded all three tag-5 equality PRs against current `origin/main`
(`d7f0524550`, 31769/43135) after a **215-commit** substrate shift since #1888's
original merge-base (`0e482f2fc`). The shift landed #2611 (funcidx-desync fix),
#2580 M1/M2 substrate, #1461/#54 native search arms, #2615 keystone, etc. — all of
which directly touch the mechanisms the classifier interacts with, so the prior
merge_group regressions (measured 2026-06-21 against the OLD main) are stale.

### Supersession map (PROVEN by byte-diff, not narrative)

- **#1888 is a complete superset of #1883 AND #1864.**
  - `src/codegen/closed-method-dispatch.ts` (+177) and `src/codegen/string-ops.ts`
    (+74) are **byte-identical** between #1888 and #1883 → #1888 contains all of
    #1883's any-array indexOf/lastIndexOf/includes brand dispatch.
  - #1888's `tag5StringEqThen()` already emits #1864's native
    `__str_flatten`+`__str_equals` content-equality (attributed #2583/#2036, same
    code, ref.test-guarded) → #1888 contains all of #1864's boxed tag-5 string
    equality.
  - #1888 adds the unique keystone: `tag5FieldEqDecision` 3-way classifier
    (boxed-number→`f64.eq`, both-strings→content eq, both-eqref→`ref.eq`) that
    #2040 numeric-eq + #2585 proto-identity need.

### Disposition

1. **LAND #1888 alone** (the keystone superset). Order: it is the only PR that
   needs to merge.
2. **CLOSE #1883 as superseded-by-#1888** (its code is byte-identical inside
   #1888). Its issue #2583 is already `status: done`.
3. **CLOSE #1864 as superseded-by-#1888** (its native string-eq is folded into
   #1888's `tag5StringEqThen`). Issue #2579 → fold note.

   Both closes REPORTED to team-lead with evidence — NOT closed unilaterally (they
   are the user's PRs).

### Re-grounded validation (NOT the stale −151 verdict)

A/B faithful runner (`runTest262File(..., "standalone")`) over the classifier's
direct blast-radius cluster (954 files: equals/does-not-equals/strict-equals/
strict-does-not-equals + Object.getPrototypeOf/create/is + Array
indexOf/lastIndexOf/includes), branch (1888 ⊕ current main) vs clean current main:

- branch **400 pass / 327 fail / 18 ce**, main **390 pass / 337 fail / 18 ce**
- per-file diff: **0 regressions, 10 improvements, 0 other flips.**
  - +8 `S11.9.x` equality/strict-equality rows (`A2.1_T1`, `A7`)
  - +2 `15.4.4.{14,15}` indexOf/lastIndexOf rows
- The 3 `logical-conditional-identity` void→NaN **compile** failures are
  PRE-EXISTING on clean current main (verified A/B, identical 3-fail count) — a
  separate void-in-numeric-context defect, NOT a cascade regression.

This cluster sweep is a **pre-flight de-risk only** — the authoritative gate for a
broad-impact value-rep change remains the **merge_group standalone floor** (the
−788/−794 contract can surface outside the sample). #1888 enqueued ONE-SHOT on
CLEAN after the `hold` label is removed; net-positive in-cluster + 0 regressions
means the prior stale park is very likely resolved by the rebase, but merge_group
is the decider.

## Merge_group EJECT + root-cause (cascade-lead, 2026-06-22) — #1888 is net-negative, MUST NOT land as-is

#1888 (rebased onto current main d02038d8) was enqueued, built the merge_group,
and **EJECTED on the standalone-highwater floor gate (#2097)**:
`current pass=24771, mark=24933, floor=24883 → delta -162`. The mark is current
(sha b90560f061, 2026-06-22 13:47; b90560..919cd76 are docs/baseline-only). So
this is a **REAL −162 standalone regression**, NOT stale-baseline drift.

The rolling regression-gate PASSED (net +0) — only the absolute highwater floor
caught it. The floor runs ONLY in merge_group, which is why all PR-level checks +
the scoped equality A/B (which was +10/0) were green: the −162 is in a DIFFERENT
cluster than the A/B sample — **class / class-dstr / generator destructuring**.

### Root cause (isolated by hunk-bisection on the live worktree)

Canary: `language/statements/class/dstr/meth-dflt-ary-ptrn-empty` — spec
`ArrayBindingPattern : [ ]` must NOT iterate; `method([] = iter)` with a generator
default must leave `iterations === 0`. On clean main: PASS. On #1888: FAIL
(`iterations` 0→2 — the empty pattern wrongly iterates the generator default).

Bisection result (faithful runner, standalone target):
- Revert WHOLE any-helpers.ts → main ⇒ PASS. (so it's in any-helpers; #1883's
  closed-method-dispatch.ts + string-ops.ts are CLEAN — proven.)
- Neutralize ALL THREE tag-5 consumers together (classifier call-sites →
  `tag5StringEqThen`, `canNativeStrEq=false`, `tag5ToNumber`→inline) ⇒ PASS.
- Re-enable ONLY the `tag5FieldEqDecision` classifier (others neutralized) ⇒ FAIL.
- **⇒ the `tag5FieldEqDecision` classifier is the cause.** (Each of the three
  consumers independently re-breaks it because they share the mechanism — all do
  `any.convert_extern`+`ref.test`/`ref.cast`/`__any_to_f64` on the tag-5 field-4;
  that is why reverting any ONE in isolation, with the others still active, did
  not fix it.)

### Why the classifier is semantically wrong here

The default-parameter machinery compares the incoming arg against `undefined`
(to decide whether to apply the default) via `__any_eq`/`__any_strict_eq`. When a
tag-5-boxed **non-string GC object** (the generator/iterator default) reaches the
both-tags-5 arm, the classifier's new objectEq (`ref.eq` after `ref.test (ref eq)`)
or numeric (`f64.eq` via `__any_to_f64`) branch returns a DIFFERENT answer than
main's `i32.const 0` stub — flipping the default-application decision so the empty
pattern iterates. This is precisely the −788/−794 representation-contract risk the
spec section + sd-3's earlier shelved attempt flagged: broadening the tag-5 arm to
classify boxed objects/numbers changes equality semantics relied on elsewhere.

### Disposition

#1888 is **net-negative** (+10 equality rows vs −162 dstr) → MUST NOT land as-is.
The classifier needs to be narrowed so it does not change equality results for
tag-5 boxed GC objects consumed by the dstr/default-parameter path (e.g. gate the
objectEq/numeric arms so they only fire for the cases #2040/#2585 actually need
and fall back to the legacy behaviour for everything the default machinery sees).
This is senior-dev design work, gated by merge_group re-validation. Cascade does
NOT collapse to #1888 until then; #1883 (search arms, proven clean) is the lower-
risk standalone-landable subset.

## RESHAPE LANDED (cascade-lead, 2026-06-22) — guard + string arm; numeric/object classifier deferred

Lead+user approved reshaping #1888 to land the net-positive safe subset and defer
the substrate-blocked piece. After full bisection the −162 split into pieces with a
sharper boundary than first thought:

- **FIX 1 (LANDED): restore #1864's `ref.test $AnyString` guard** on
  `tag5StringEqThen`'s native arm (the #1888 `recoverNative` refactor dropped it).
  Banks #2579 boxed-string `===` + #2583 `Array.prototype.{indexOf,…}.call`; `0`
  for non-string tag-5 pairs (main's legacy answer). Alone, this fixes the dstr
  canary AND keeps the search/string-eq wins.
- **DEFERRED (both arms of the `tag5FieldEqDecision` classifier):** not just the
  #2585 object `ref.eq` arm — the **#2040 numeric `f64.eq` arm ALSO regresses the
  class/dstr cluster** (bisection: re-enabling ONLY the classifier, even with
  `i32.and` numeric gating and objectEq removed, re-breaks the dstr canary). Both
  arms change tag-5 boxed-VALUE equality that the destructuring / generator-iterator
  lowering implicitly relies on (it counted on the legacy always-false tag-5
  non-string eq). The whole both-tags-5 classifier (numeric + object) moves to the
  value-rep substrate (#2580 M2 / #35). The cross-tag String⇄Number `tag5ToNumber`
  arm in `__any_add` is dstr-safe and STAYS.

**Validation:** dstr canaries 4/4 PASS (the −162 fix); #2583 search 2/2; A/B over
the equality+search cluster vs clean main = **+2 / 0 regressions** (indexOf +
lastIndexOf). `tests/issue-2040-tag5-field4-eq.test.ts`: 4 classifier cases
`it.skip`ped with the #2580 M2 reference; the rest pass. `tests/issue-2579.test.ts`
folded in (8/8) so closing #1864 loses no coverage. Authoritative gate = the
merge_group standalone floor.

---

## RE-GROUND + RESTAFFING PLAN (architect, 2026-07-12) — supersedes the counts above; this is the dev-executable slicing

Issue stalled since 2026-06-22 (assignee cleared, re-tagged `sprint: current`,
`status: ready`). Everything above is diagnosis HISTORY — accurate but
layered. This section is the current truth against main @ 6dcdf30135 and the
fresh standalone baseline (2026-07-12 JSONL). **Read this section first.**

### Fresh dstr decomposition (all `/dstr/` rows, standalone lane)

5,158 pass / 2,365 fail / 43 CE. The 2,365 fails classify by assertion:

| Slice | Count | Mechanism | Owner |
| --- | ---: | --- | --- |
| A1 `assert.notSameValue(x, values)` rest-identity | 382 | tag-5 `===` object-identity vacuity — `_isSameValue`'s `a===b` over two `any`-boxed refs answers the legacy constant, NOT a rest-copy bug (the rest array IS fresh — proven above). The 3-way classifier is flag-gated OFF pending the dstr-unmask | **BLOCKED on #2580 M2 / #3032 / #3053** — do NOT re-attempt the classifier here (two failed landings above; the −162 eject) |
| A2 `assert.sameValue(initCount, 0)` lazy defaults | 198 | default initializer evaluated (or its counter bumped) when the element value is PRESENT — §8.6.2: default only on `undefined`/done | **THIS ISSUE — slice 1 (fable-now)** |
| A3 obj-rest ToPrimitive (`Cannot convert object to primitive`, `obj-ptrn-rest-*`) | 190 | `{...rest}` copy path coerces a non-primitive-able source property; skip-non-enumerable/getter shapes | **THIS ISSUE — slice 2** (overlaps #2602 rest-object; check its state first) |
| A4 vacuous harness-wrapper | 164 | #2940 reclassification | #3086 (in-progress) — NOT here |
| A5 uncaught wasm exn (`*-step-err`, `*-rtrn-close-err`) | 115 | abrupt iterator step/close errors trap instead of surfacing as catchable | **THIS ISSUE — slice 3** |
| B1 iterCount/callCount wrong (eager gen body / consumption order) | 114 | mostly the eager-buffer gen running at creation | rides **#3164/#3032** — re-measure after they land |
| B2 `Cannot destructure 'null'` in async-gen dstr | 61 | for-await/async-gen binding-init null step value | rides **#3132**; residual → #3178 S4 |
| B3 `Generator.prototype.next requires 'this' be a Generator` brand check | 48 | native gen struct fails the prototype-method brand test | **THIS ISSUE — slice 4** |
| other sameValue / other | 1,093 | heterogeneous; re-classify AFTER slices 1-4 + #3164 land | re-measure |

### Slice 1 (START HERE, fable-now, ~198 rows): lazy default evaluation

Repro family: `language/expressions/function/dstr/dflt-ary-ptrn-elem-id-init-skipped.js`
(`assert.sameValue(initCount, 0)` — `function f([x = (initCount += 1)]) {}`
called with a PRESENT value must not evaluate the initializer).
Ground in `src/codegen/destructuring-params.ts` (the param-pattern element
lowering; the #2574 fix added default-on-`undefined` — the residual is the
CONVERSE: default evaluated eagerly or the guard testing the wrong condition
for iterator-driven bindings). Diagnose ONE file's WAT first: find whether the
initializer instrs are emitted unconditionally before the presence check, or
whether the presence check mis-reads the `done` flag. Spec: §8.6.2
IteratorBindingInitialization, SingleNameBinding step 5 ("if v is undefined
… evaluate Initializer"). Acceptance: the `dflt-*-init-skipped` /
`initCount, 0` family flips (~198), zero host-lane byte delta.

### Slice 2 (fable-now, ~190 rows): object-rest copy ToPrimitive

Repro: `language/expressions/object/dstr/gen-meth-dflt-obj-ptrn-rest-skip-non-enumerable.js`
(`L119: Cannot convert object to primitive value`). The `{...rest}` copy in
the standalone lane routes property VALUES through a primitive coercion it
must not apply (CopyDataProperties, §14.7.5.6 — values are copied as-is).
Check `__extern_rest_object` / the object-rest lowering in
destructuring-params.ts + object-runtime.ts; coordinate with #2602 (for-of
assignment-rest unimplemented) — if #2602 is still open, take only the
binding-pattern (non-assignment) arm here.

### Slice 3 (fable-now, ~115 rows): abrupt iterator-step errors trap

Repro: `language/expressions/class/dstr/async-gen-meth-ary-ptrn-elision-step-err.js`
(uncaught Wasm-GC exception). A throwing `next()`/`return()` during
IteratorBindingInitialization must surface as a catchable error completion
(the tests assert a TYPED error), not a trap. The dstr drive loop needs
try/catch (native `__exn` tag) around the step call with rethrow-as-JS-error.
Ground where the binding-init loop calls `__iterator_next`
(iterator-native.ts consumers + destructuring-params.ts).

### Slice 4 (fable-now, ~48 rows): Generator.prototype method brand check

Repro: `language/statements/class/dstr/gen-meth-ary-ptrn-elem-ary-elision-init.js`
(`TypeError: Generator.prototype.next requires that 'this' be a Generator`).
A native driven-gen frame consumed through `Generator.prototype.next.call(g)`
or an inherited-method read fails the brand test. Extend the brand-check
admission to the native frame structs (`ctx.nativeGenerators` per-producer
`ref.test` arms — same pattern as `__iter_hof_open`'s driven-frame admission,
iter-hof-native.ts).

### Sequencing / dependency notes

- Slices 1-4 are independent of each other and of #3164/#3132 — each its own
  PR, each construct-sample-validated, merge_group floor as decider.
- A1 (382 rows, the headline) is EXPLICITLY not staffable here — it unblocks
  via the #2580 M2 / #3032 / #3053 substrate track. Do not re-litigate the
  classifier (see the two shelved attempts + the −162 eject above).
- B1/B2 re-measure after #3164 + #3132 S2 land; fold the residual back here.
- The old acceptance criteria above are superseded: acceptance is now
  per-slice (the four assertion-family counts → ~0) + dstr standalone fail
  count ≤ 1,800 after slices 1-4.

## A1-unblock map — CORRECTED (sendev-3032, 2026-07-14) — supersedes the "BLOCKED on #2580 M2 / #3032 / #3053" cell above

The 2026-07-12 re-ground lists A1 (382 rows, the headline) as "BLOCKED on
#2580 M2 / #3032 / #3053". Verified against `origin/main @ f1c9069`, that
three-way blocker is **inaccurate**. The corrected map (each verified, not
narrative):

- **#3053 (unified carrier) — LANDED-but-VACUOUS, NOT a near-term A1 lever.**
  U0/U1/U2 (`__dyn_member_get`/`ensureDynMemberGet`/`usesDynMemberGet`/the
  `select.ts` scan) are all ON `origin/main` (fork branches merged; u0/u2 =0
  commits ahead, u1 =+1 baseline-file merge). But #3053's own "U2 LANDED"
  section proves it is corpus-VACUOUS: byte-inert (`prove-emit-identity`
  39/39), claim-delta ~0, because property-access alone never claims the
  `_isSameValue`/reduce comparator (it needs eq + relational + truthiness +
  dynamic-arithmetic forms). The identity payoff (U3 #3037 CS3 / U4 #2175
  V2-S3b) is OWNED by those issues and only materialises once #2949's
  claim-rate forms land. So #3053 does NOT unblock A1 in the near term.
- **#2580 M2 — value-rep rabbit hole, DEFER (not the A1 blocker).** 2388-line
  diagnosis; M1a ejected (−13/13 regr), M2.2c WONT-FIX, most of it deferred to
  the value-rep substrate (#35). Not a tractable near-term A1 lever; remove it
  from the A1 blocker set.
- **#3032 (lazy-first generators) — THE actual A1 lever.** #3032's root cause
  (fully verified) is that the −162 classifier eject "was never a dstr/eq
  dependency — it was eager generator bodies + comparator vacuity". Making
  eager generators lazy turns the classifier-unmasked vacuous passes into
  GENUINE passes, which is exactly what makes the flag-gated 3-way tag-5
  classifier flip floor-safe. Slice 1 (zero-param generator EXPRESSIONS)
  landed. The residual dominant standalone shape is **nested capturing NAMED
  generators** (`function* g(){...}` inside the `export function test()`
  wrapper) — they run their whole body AT CREATION (probe returns 202 not 1)
  via `nested-declarations.ts`'s has-captures eager-buffer arm. See #3032 for
  the corrected route + the TDZ-flag-capture native-threading extension that
  the fix requires (the arch spec's function-body.ts:1052 / route-(a-i)
  pointers are stale — verified 2026-07-14).

**Net:** A1's classifier flip is gated primarily on **#3032**'s remaining
generator-laziness work (specifically the TDZ-flag-capture native-threading
extension), NOT on #2580 M2 or #3053. Keep the tag-5 3-way classifier flag
gated OFF until #3032's standalone generator-laziness clears the merge_group
floor under `JS2WASM_TAG5_CLASSIFIER=1`.

## A1 DEFAULT-FLIP LANDED — issue CLOSED (fable-beta, 2026-07-16)

**PR:** `issue-2040-a1-tag5-classifier-flip`. The #3032 waves the A1-unblock
map named are all on main as of 2026-07-16: W3 TDZ-native-threading
(PR #3115), #3302 capturing generator fn-expressions (PR #3126), W4 method
generators (PR #3136). This PR flips `tag5ValueEqClassifier` to **default ON**
(`create-context.ts`; `JS2WASM_TAG5_CLASSIFIER=0` or
`tag5ValueEqClassifier: false` forces legacy). The emit site stays
standalone/wasi-gated (`any-helpers.ts` `tag5ValueEqThen`) — the JS-host lane
is byte-identical by construction.

### Re-ground: the A1 fail cluster had already dissolved (measured, not narrative)

Paired A/B (same-process env toggle, faithful runner
`runTest262File(..., "standalone")`, branch base = main @ 3186699e68):

- **Eject canaries** (68: the −162 `*ary-ptrn-empty*` dstr family across all
  producers + W3 canary buckets): **0 flips** — 62 pass→pass, 6 fail→fail
  (async-gen rides #3132; `dflt-ary-ptrn-empty` fn/gen pre-existing both-arms).
- **A1 family** (251 sampled sync dstr `notSameValue` files): **0 flips** —
  235 already PASS with the flag OFF on current main. The "382 A1 fails"
  from the 2026-07-12 baseline had already collapsed to ~71 rows by the
  2026-07-14 standalone baseline (mostly `fn-name`/obj-rest buckets — census
  buckets of #3283, not rest-identity vacuity), i.e. the #3032 laziness work
  itself de-vacuized the comparator paths. The flip's value is therefore the
  **honest tag-5 equality substrate** (boxed-number `===`/self-eq, object
  `ref.eq` identity — the previously flag-gated #2040/#2585 semantic cases)
  plus the S11.9.x equality / indexOf-lastIndexOf rows measured +10/0 in the
  2026-06-22 cascade A/B, with the merge_group standalone floor as the final
  decider.
- Remaining A/B sweeps (51 baseline-fail rows, 224-file equality cluster,
  485-file every-97th cross-tree control) recorded in the PR body.

### Residual redirect (why this closes #2040)

Every remaining dstr/generator bucket is owned elsewhere (verified by #3283's
2026-07-14 census): slices A2/A3/A5/B3 → resolved or substrate-blocked per
#3283 (wont-fix, superseded); A4 vacuous-wrapper → #3086; B1 eager-gen
consumption → #3164/#3032 residuals; B2 async-gen dstr → #3132/#3178 S4;
fn-name/PropertyDescriptor rows → unowned track flagged to PO in #3283.
A1 (this flip) was the last bucket owned HERE.

### Salvage re-validation (fable-epsilon, 2026-07-16)

fable-beta died at the session limit after committing the flip; salvaged via
cherry-pick onto a fresh branch off origin/main @ ea91a1b0f4
(`issue-2040-tag5-classifier-flip`). Independent re-validation:

- `tests/issue-2040-tag5-field4-eq.test.ts`: **16/16 pass** (incl. the
  OPT-OUT legacy-arm test and the HOST-LANE byte-inert test).
- Fresh paired A/B (faithful `runTest262File(..., "standalone")`,
  `JS2WASM_TAG5_CLASSIFIER=1` vs `=0`) over the 116-file eject-canary +
  rest-id set (`*ary-ptrn-empty*` + `*ary-ptrn-rest-id` across
  class/function stmt+expr and object dstr): **0 flips** — 115 pass/pass,
  1 fail/fail (`function/dstr/dflt-ary-ptrn-empty.js`, pre-existing both
  arms, matches fable-beta's note).

Authoritative gate remains the merge_group standalone floor.
