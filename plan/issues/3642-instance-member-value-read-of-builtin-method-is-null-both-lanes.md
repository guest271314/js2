---
id: 3642
title: "An instance member value-read of a builtin prototype method reads as null — on BOTH lanes (`var a=[1]; a.fill` → null)"
status: ready
sprint: current
created: 2026-07-26
priority: high
horizon: m
feasibility: hard
task_type: bug
area: codegen
language_feature: function-dispatch
goal: core-semantics
related: [3638, 3571, 3603, 2984, 2773]
origin: "measured while fixing #3638 (opus-loop-c, 2026-07-25)"
---

# Instance member value-read of a builtin method is `null` — both lanes

> **This is a CROSS-LANE compiler correctness gap, not a standalone-lane gap.**
> It is filed separately from #3571 and #3638 precisely so it is not read as a
> footnote on a standalone trap bucket. Both numbers below were measured, on
> both lanes, in the same process shape.

## Measured (2026-07-25, `upstream/main`)

Same source, same harness, only the compile target differs:

| expression                          | standalone | host  |
| ----------------------------------- | ---------- | ----- |
| `var a=[1]; var f=a.fill; f ? 1 : 0`   | **0**      | **0** |
| `… (f === null \|\| f === undefined)`  | **1**      | **1** |
| `var f=Array.prototype.fill; f ? 1:0`  | 1          | 1     |
| `var a=[1]; a.fill === Array.prototype.fill` | 0    | 0     |
| `var a=[1,2]; a.fill(9); a[0]` (direct call) | 9    | 9     |

So: the **direct call** `a.fill(9)` works, and the `.prototype` **value read**
works — but the **instance value read** `a.fill` is null on both lanes, and
`a.fill !== Array.prototype.fill` where §23.1.3 requires identity (an instance
has no own `fill`; the read must reach `Array.prototype.fill` through the
prototype chain and yield the same function object).

## Why it matters beyond one method

Any idiom shaped `<instance>.<method>.call(…)` / `.apply(…)` / `.bind(…)` is
built on this. That includes the reflective-call family (#3571, #3603 S1) and
ordinary user code (`var m = arr.map; m.call(arr, f)`).

It also caused a **trap** until #3638: the reflective `.call` lowering cast that
null receiver unconditionally, producing an uncatchable `illegal cast`. #3638
compensated **at the call site** by resolving the instance spelling to the same
singleton the `.prototype` spelling reads. **That is a compensation, not a fix
— this issue is the fix.** With it closed, #3638's `isInstanceMemberProtoRead`
special case can be reconsidered, and its pinned KNOWN GAP
(`var f = [].fill; f.call(o, 1)` still traps) closes for free, because the
identifier would then hold a real function value.

## Where it is

`tryCompileStandaloneBuiltinProtoMemberRead`
(`src/codegen/builtin-value-read.ts`) requires the base to be literally
`<Ident>.prototype`:

```ts
if (!ts.isPropertyAccessExpression(inner)) return undefined;
if (inner.name.text !== "prototype") return undefined;
```

There is no instance-receiver counterpart, so the read falls through to the
dynamic member path (`__extern_get(vec, "fill")`), which has no entry for a
prototype method on a vec receiver and yields null. The host lane reaches the
same null by its own route (it is NOT the same code path — that needs
confirming before a shared fix is designed).

## Acceptance criteria

- `var a=[1]; a.fill` is a callable function value on both lanes.
- `a.fill === Array.prototype.fill` (§23.1.3 identity — the singleton, not a
  fresh wrapper per read; `pushBuiltinFnSingletonValueInstrs` is the existing
  mechanism, cf. #2175 V2-S2).
- `var f = arr.map; f.call(arr, fn)` works.
- The #3638 KNOWN-GAP test flips (it is written to fail loudly when this lands).

## Method notes for whoever takes this

- **Assert identity, not truthiness.** "It returns something callable" is the
  weaker claim and would be satisfied by a fresh `struct.new` per read, which
  breaks `===` and was already rejected once (#2175 V2-S2).
- **Do NOT verify with a `typeof x === "function"` string compare on
  standalone** — dynamic-string `===` false-positives there (measured; see the
  #2984 handoff). Use a numeric discriminant.
- The host lane must be measured separately, not assumed to share the cause.
