---
id: 2040
title: "standalone: generator/destructuring runtime-semantics residual — rest-pattern iterator consumption, lazy defaults, private elements (~1,750 tests)"
status: ready
sprint: 64
created: 2026-06-10
updated: 2026-06-10
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
