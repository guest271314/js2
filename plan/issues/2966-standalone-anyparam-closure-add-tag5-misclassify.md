---
id: 2966
title: "Standalone: any-param closure results silently wrong through `+` — __any_add classified every tag-5 box as stringy (re-id of the orphaned #2945 analysis)"
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
language_feature: closures
goal: standalone
related: [2924, 2442, 1888, 2040, 2945]
blocks: [2924]
---

# #2966 — standalone any-param closure `+` misclassification (silent wrong values)

**Re-id note:** the original analysis was filed as `#2945` on dev-f2's branch
(`issue-2924-newfn-mainbase`, PR #2464 vicinity) but id 2945 was subsequently
taken on `main` by an unrelated issue (IR-selector modulo drift, parallel
session). This file carries the analysis over under a fresh `--allocate` id and
records the (deeper) root cause found on current main.

## Problem (measured 2026-07-02 on main `affc55523`)

On the **standalone** lane, values returned by an `any`-typed closure are
silently WRONG the moment they flow through `+`:

```ts
export function test(): number {
  const f: any = function (a: any) {
    return a + 10;
  };
  return f(1) + f(2); // standalone: 0   (host / JS: 23)
}
// f(1,2,3) with (a: any, b: any, c: any) => a + b + c  → NaN (want 6)
// const x = f(1); const y = f(2); x + y                → 0   (want 23)
// x + x                                                → 0   (want 22)
```

Worst defect class: **silent wrong values**, no trap, no CE. Blocks #2924's
standalone enablement (a `new Function`-synthesized function has all-externref
params, so it inherits this bug).

## Root cause — NOT call marshalling

The original #2945 hypothesis (temp-local collision in call marshalling) is
**false on current main**. Narrowing probes showed every call returns the
correct value (`return f(2)` → 12 even as a second call; `x - y` → −1;
`x * y` → 132; `x + 1` → 12). Only **any + any `+`** is wrong, and only when an
operand's payload crossed the open-any boundary:

1. The closure-call result is an externref holding a native `$BoxedNumber`
   carrier (`__box_number`).
2. `compileAnyBinaryDispatch` (binary-ops.ts) boxes each externref operand to
   `$AnyValue` via `boxToAny` → `__any_box_string` — the **deliberate** #1888
   tag-5 "box-the-externref" contract (`value-tags.ts:178-185`; honest
   re-tagging at the boxing site regressed −788/−794 and is forbidden).
3. `__any_add` (any-helpers.ts) classified **every** tag-5 operand as stringy
   (`tag==5 || tag==6`) → §13.15.3 concat arm → `__any_to_string` recovers
   `"11"`/`"12"`, concatenates to a tag-5 string box — and the caller's f64
   coercion reads the tag-5 box's f64 field, which is **0**.

So `f(1)+f(2)` = 0, and inside a 3-any-param closure `a+b+c` = NaN (the
`(a+b)` sub-result is a proper tag-3 numeric box, but `+ c` re-enters the same
misclassification).

Per §13.15.3 ApplyStringOrNumericBinaryOperator, ToPrimitive of a number or
boolean is **not** a string → those operands must take the numeric arm. The
numeric arm's `__any_to_f64` **already** recovers `$BoxedNumber` under tag 5
(the #1888 arm) — the classification was the only missing piece.

## Fix (consumer-side — the #2040 tag-5 payload-classifier pattern)

`src/codegen/any-helpers.ts`:

1. **`__any_add` stringiness classifier**: a tag-5 operand is stringy only if
   its field-4 payload is NOT a `$BoxedNumber`/`$BoxedBoolean` carrier
   (`ref.test` on the payload; scratch anyref local). Tag-6 unchanged. Gated
   ONLY on `nativeBoxNumberTypeIdx >= 0` (the #2040 lesson — never gate on
   nativeStrings); legacy bytes reproduced exactly when the carrier type is
   absent. Fresh `Instr` arrays per arm (no aliasing — the in-place
   index-shift double-remap hazard).
2. **`__any_to_f64` tag-5 `$BoxedBoolean` recovery**, symmetric with the
   existing `$BoxedNumber` arm: ToNumber(true)=1 / ToNumber(false)=0
   (§7.1.4) instead of reading the box's always-0 f64 field.

Explicitly NOT touched (the known traps):

- The boxing site (`boxToAny` externref → tag-5) — producer-side re-tagging is
  the −788/−794 regression.
- `__any_eq` / `__any_strict_eq` — the tag-5 boxed-value equality classifier
  was ejected at −162 (dstr/generator interaction) and is deferred to the
  value-rep substrate (#2580 M2). `f(1) === f(1)` is still false today
  (pre-existing, see residuals).

## Verification (all on this branch, standalone lane)

- Repro family flips: `f(1)+f(2)` 0→23, `f(1,2,3)` NaN→6, cross-statement
  0→23, `x+x` 0→22, chain 0→36, `(f(1)+f(2))-f(3)` −13→10,
  `h(true)+h(true)` 0→2, `f(1)+h(false)` 0→11, `f(0.5)+f(0.25)` 0→20.75.
- Concat arm preserved: `f(1)+"a"` length 3, `"a"+f(1)` length 3,
  `h(true)+"x"` length 5 (boxed-payload ToString recovery pre-existing).
- Controls unchanged: typed-param closure, single call, relational
  (`f(1)<f(2)`), `-`/`*` on dispatched values, plain `any` locals,
  undefined-result + 1 stays NaN.
- **Byte-inertness** (sha256 A/B vs pristine main): host lane on the exact
  repro shape, typed host, typed standalone, plain-any add (both lanes),
  string program standalone — **all byte-identical** (`__any_add` with the
  carrier types present is only built/reached on the affected standalone
  shapes).
- Related suites green: issue-1888 (×3 files), issue-2040-tag5-field4-eq,
  issue-2058-any-plus-string, issue-2059-any-relational,
  issue-1917-any-param-toprimitive, issue-2106-any-array-element-tag —
  73 passed; the 2 issue-2081 failures are **identical on pristine main**
  (pre-existing, `#2043` late-import class per the 1888 notes).
- New suite: `tests/issue-2966.test.ts` (16 cases, host-free asserted).

## Residuals (documented, NOT this fix — same substrate family)

- `typeof x` on a dispatched result returns garbage (tag-5 box → not
  "number"). Same overloaded-tag-5 disease, different consumer.
- `.length` on an any-typed concat RESULT reads 0 (`const s = g("ab") + g("cd");
s.length` → 0, pre-existing on main) — the $AnyValue dynamic-read gap.
- `f(1) === f(1)` false — the deferred #2580 M2 eq classifier (deliberate).
- `undefined + 1` stringifies to "[object Object]"-ish instead of NaN in the
  concat arm when undefined crosses the boundary as a null externref
  (pre-existing; NaN-ness preserved in the numeric context probe).

After this lands, #2924 can re-test its standalone gate
(`tryCompileConstantFunctionCtor`'s `ctx.standalone || ctx.wasi` early return)
— the all-externref-param synthesized function should now compute correctly
through `+`.
