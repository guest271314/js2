---
id: 2503
title: "standalone ToPrimitive residual (successor to #1910): 2,835 `Cannot convert object to primitive value` on ==/+/array-literal/destructuring receivers"
status: done
assignee: ttraenkler/sd-3
sprint: 64
created: 2026-06-19
updated: 2026-06-21
completed: 2026-06-21
priority: critical
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: to-primitive, operators, destructuring
goal: standalone-mode
parent: 1781
related: [1910, 1525, 1525b, 1716, 1806, 1090, 1253, 1319, 1781]
test262_bucket: standalone-object-to-primitive
test262_count: 2835
origin: "2026-06-19 /harvest-errors on run e9579720 (2026-06-18): the standalone `Cannot convert object to primitive value` bucket grew 784 (#1910) / 1,292 (2026-06-10 gap review) -> 2,835, and is now the single largest standalone runtime-failure bucket. Every historical owner (#1090, #1253, #1319, #1525, #1525b, #1716, #1806, #1910) is `done`, so the residual is currently untracked by any open issue."
---

# #2503 — Standalone ToPrimitive residual on operator / destructuring receivers

## Problem

In the standalone lane (`--target standalone --no-host-imports`,
`nativeStrings`), **2,835** official test262 records fail at runtime with
`Cannot convert object to primitive value` — the single largest standalone
runtime-failure bucket as of run `e9579720` (2026-06-18):

| signature | records |
|---|---|
| `runtime_error: Cannot convert object to primitive value` | 1,612 |
| `runtime_error: L#:## Cannot convert object to primitive value` | 1,223 |
| **total** | **2,835** |

This is a genuine runtime throw produced by the emitted Wasm (not a classifier
over-match, and not the eager-throw *spec* behaviour #1525 implemented): the
standalone native `ToPrimitive` path is not wired for ordinary-object receivers
reached through core operators and binding forms. Default (JS-host) lane is
healthy here — only **48** records — so the host import is masking the gap.

## Why this is untracked

All historical owners are `done`:

- `#1525` / `#1525b` — eager-throw on object args + method trampoline / step-6.
- `#1806` / `#1900` — standalone native ToPrimitive slices.
- `#1716` — residual object property-key coercion.
- `#1090` / `#1253` / `#1319` — ToPrimitive / OrdinaryToPrimitive / Symbol.toPrimitive.
- `#1910` — "standalone ToPrimitive residual bucket after #1900/#1525b"
  (recorded count `784`; the 2026-06-10 gap review measured `1,292`).

The bucket has since **grown to 2,835** with no open owner. This issue is the
current successor (the same way #1910 succeeded #1900/#1525b).

## Sample failures (core paths, not edge cases)

```
test/language/expressions/equals/S11.9.1_A7.7.js                       # ==  (abstract equality)
test/language/expressions/addition/order-of-evaluation.js              # +   (ToPrimitive order)
test/language/expressions/array/S11.1.4_A1.4.js                        # array literal element coercion
test/language/expressions/arrow-function/dstr/ary-ptrn-elem-ary-empty-init.js   # destructuring default init
test/language/expressions/object/dstr/gen-meth-dflt-obj-ptrn-rest-skip-non-enumerable.js
```

The clustering on `==`, `+`, array-literal evaluation, and destructuring
defaults points at the operator/binding lowering invoking `ToPrimitive` on an
object receiver without routing through the standalone native
`OrdinaryToPrimitive` (valueOf / toString / @@toPrimitive) closure.

## Suggested approach

1. Reproduce a minimal case per cluster (`({}) == 1`, `({}) + ""`,
   `[{}]`-with-default-dstr) under `--target standalone` and capture which
   lowering site emits the throwing path.
2. Confirm whether the native `ToPrimitive` trampoline (#1525b) is reachable
   from the operator/dstr paths, or whether those paths short-circuit to a
   generic "not a primitive → throw" before consulting valueOf/toString.
3. Wire the missing call sites to the existing native ToPrimitive closure;
   add scoped equivalence tests for ==, +, array-literal, and destructuring
   defaults over object receivers in standalone mode.
4. Re-measure the bucket; split any genuinely-distinct residual (Date,
   template, RegExp coercion) into separate child records if it does not fall
   to ~0.

## Acceptance criteria

- The standalone `Cannot convert object to primitive value` bucket drops
  substantially from 2,835 (target: operator/dstr clusters → ~0).
- Scoped standalone equivalence tests cover `==`, `+`, array-literal, and
  destructuring-default object receivers.
- Default (JS-host) lane unchanged (no regression from the 48 baseline).

## Implementation (sd-3, 2026-06-21)

### Reproduction — the cited "core path" clusters were mostly already fixed

On current `origin/main`, the `+`, `obj+obj`, destructuring-default, and
`any`-param-valueOf cases from the issue's "Sample failures" table **already
pass** standalone (prior ToPrimitive work — #1910/#1525b/#2358 PR-1 —
substantially closed them). The genuine open residual reproduced through the
real test262 runner (`runTest262File(..., "standalone")`) is the **string side
of abstract equality `==`/`!=`**: `equals/S11.9.1_A7.7.js` (`"1" == new
Boolean(true)`, …) was HOST=pass / STANDALONE=fail with `Cannot convert object
to primitive value`.

### Root cause — `string == object/any` was statically mis-routed past §7.2.15

The `==` lowering in `src/codegen/binary-ops.ts` routed a **static-string LEFT**
operand against an `any`/object/wrapper RIGHT into `compileStringBinaryOp` (a
pure native-string content compare) via the catch-all third disjunct of the
left-string arm (~line 1064). That arm never consults `ToPrimitive`/`ToNumber`,
so for `"x" == {valueOf:()=>"x"}` the object failed the string `ref.test` and the
compare returned a spurious `false` (NOT a throw); for `new String/Number/Boolean`
wrappers (`wrapperEquality`) it fell to the `else if (isEqOp)` f64 path, which ran
`__str_to_number` on the string operand → NaN → wrong `false`. This is the exact
**mirror** of the reverse `any == "lit"` shape that #2503b deliberately routed
through the runtime-tag cascade; the forward shape was the un-fixed half.

### Fix (3 surgical edits in `src/codegen/binary-ops.ts`, all standalone-gated)

1. **Don't string-route a loose-eq forward shape with an abstract RIGHT** (~line
   1064): for `==`/`!=` where the RIGHT is `any`/`unknown` (not statically
   string-ish), skip `compileStringBinaryOp` and fall through to the native
   abstract-equality cascade. STRICT `===`/`!==`, `+`, and relational ops keep
   the content-compare route.
2. **Box a string-ref vs. any/struct-ref/wrapper into the cascade** (the #2503b
   externref-boxing arm, ~line 1860): broadened `otherEqType.kind === "externref"`
   to also accept a nominal STRUCT ref (`ref`/`ref_null`) — the static `"x" ==
   (obj as any)` shape — so `coerceType(structRef→externref)` runs, which
   materializes a user-ToPrimitive struct as `$Object` (#2358 PR-2) for
   `__to_primitive`. Also permitted the `wrapperEquality` case through this arm
   **only when `noJsHost`** (standalone/WASI), since the JS-host wrapper arm's
   `__host_loose_eq` import is unsatisfiable there and the cascade's
   `__to_primitive` already reduces wrappers via their `[[PrimitiveValue]]` slot.
3. **String⇄Number → String⇄(Number-or-Boolean)** in the cascade's loose arm
   (~line 2345): §7.2.15 step 8 — once an Object operand reduces to a boolean via
   ToPrimitive (`"1" == new Boolean(true)`), ToNumber the boolean side (0/1) and
   compare numerically. Previously the reduced boolean fell to the identity arm →
   spurious `false`.

### Results (regression-free)

Scoped standalone test262 over the operator families (this branch vs `origin/main`):

| family | base SA pass | fixed SA pass | Δ |
|---|---|---|---|
| equals | 19 | 21 | +2 |
| does-not-equals | 18 | 20 | +2 |
| addition / less-than / greater-than | — | — | 0 (unchanged) |

`Cannot convert object to primitive` throws: equals 8→6, does-not-equals 8→6.
**No family regressed**; host lane unchanged. `tests/issue-2503.test.ts` (12
cases) green; the existing #1111/#1134/#1525/#1910/#1917/#1986/#2081/#2160/#2358/
#2503b equality+wrapper suites still pass (159/159; the one pre-existing
`#2081 null==undefined` any/any failure and the missing-`helpers.js` collection
errors reproduce identically on `origin/main` and are unrelated). Hard-error
gate: 0 hard errors, no growth.

### Remaining residual → tracked under #2358 (engine half) and separate gaps

The full 2,835 bucket is dominated by an **engine** gap this routing fix does not
touch: `__to_primitive` cannot reduce a `$Vec` ARRAY (`"1,2" == [1,2]`,
`[obj] + x`) — it only recognises `$Object` (the addition family's `ctp=11` is
this). That is the `#10` array-ToPrimitive fold already specced in **#2358**.
Two further out-of-cluster items observed: `String(obj)` builtin null-deref, and
`valueOf`-returns-object / Date / template coercion. None are the operator
RECEIVER mis-routing #2503 scoped; the operator/binding routing portion is closed.

## Harvest update — 2026-06-24 (run `426e28e8`) — bucket grew; residual is substrate, NOT this issue

`/harvest-errors` on the 2026-06-24 standalone baseline measured the
`Cannot convert object to primitive value` bucket at **3,622** records
(`runtime_error: …` 2,348 + `runtime_error: L#:## …` 1,274) — **up from the
2,835 this issue was filed against** (2026-06-18). It remains the single
largest standalone runtime-failure bucket (host lane: 48).

**This is not a regression of #2503's landed fix, and #2503 stays `done`.** The
operator/binding ToPrimitive *routing* slice this issue scoped (string `==`
object/wrapper) is closed and did not regress. The growth is **diffuse and
substrate-level** — clustering by test directory shows it is no longer
operator-shaped at all:

| cluster | records | nature |
|---|---|---|
| `built-ins/Object/{defineProperty,create,getOwnPropertyDescriptor,defineProperties}` | ~720 | shared ToPrimitive/ToPropertyKey path in property-descriptor APIs (old ES5 string-key tests — substrate, not object-key bug) |
| `built-ins/{Array,String,TypedArray}/prototype` | ~690 | ToPrimitive on built-in method args |
| `built-ins/RegExp/prototype` | 121 | coercion in RegExp methods |
| `language/{statements,expressions}/class` + dstr + for-of | ~330 | class field / destructuring coercion |

Two reads on *why it grew*: (1) **exposure** — as upstream standalone blockers
cleared, more tests now compile+run far enough to reach the shared ToPrimitive
throw (cf. memory `feedback_regression_analysis` — growth can be progress
elsewhere); (2) the dominant residual is the **standalone ToPrimitive/ToNumber
*substrate*** reached through many built-in entry points, which is owned by the
**open sprint-65** coercion work, **not** a focused operator fix:

- **#1917** "one coercion engine" (in-progress, sendev-eq) — unifies the four
  divergent coercion matrices; the `ref→f64` NaN-vs-0 / `__to_primitive`
  divergence behind this bucket is exactly its scope.
- **#2160** standalone String/Number coercion residual (ready, `depends_on:
  [1917]`) — owns the `String/TypedArray.prototype` method-arg slice.

The earlier sd-3 hand-off line pointing the array half at "#2358" is stale —
local #2358 (`__to_primitive` nominal object structs) is `done`, and the "#10"
it cited is the **upstream GitHub** issue, not local #10. No new focused issue
is filed: fragmenting a substrate gap already covered by #1917/#2160 would add
issue-number sprawl without adding signal. Tracked here as a drift note + the
downstream cross-link added to #1917.
