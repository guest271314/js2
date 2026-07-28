---
id: 3723
title: "WASI async drive lane claims `return await <ident>` and yields NaN — the result $Promise has no drainer"
status: ready
sprint: current
created: 2026-07-27
updated: 2026-07-27
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: async-await
goal: standalone-gap
related: [2865, 2895, 2906, 2980]
origin: "tests/issue-2865-standalone-async-await-unwrap.test.ts — red on upstream/main 2026-07-27"
---

# #3723 — the WASI drive lane claims awaits it cannot deliver

## Problem

Two cases in `tests/issue-2865-standalone-async-await-unwrap.test.ts` are red on
`upstream/main`, both returning `NaN` instead of the resolved value:

```ts
async function f(): Promise<number> {
  let p = Promise.resolve(7);
  return await p;
} // NaN, want 7
async function f(): Promise<number> {
  let n = 8;
  return await (n + 1);
} // NaN, want 9
```

That suite's stated contract is the opposite: "Every case compiles WASI with
ZERO host imports and returns the correct resolved value (no NaN)."

## Diagnosis (measured, exact)

Claiming correlates **perfectly** with failure. Tracing
`asyncFnNeedsDrive`:

| body                                         | drive claims | result  |
| -------------------------------------------- | ------------ | ------- |
| `return await Promise.resolve(5)`            | false        | 5 ✓     |
| `const x = await Promise.resolve(40); x + 2` | false        | 42 ✓    |
| `return await 99`                            | false        | 99 ✓    |
| `let p = Promise.resolve(7); return await p` | **true**     | **NaN** |
| `let n = 8; return await (n + 1)`            | **true**     | **NaN** |

Forcing the drive lane off makes the suite pass **7/7**.

The mechanism: the AG0 path (`expressions.ts`, `isStandalonePromiseActive`)
compiles a WASI async fn **synchronously** and unwraps one level of the native
`$Promise` carrier, so the caller gets the value. The #2895 PATH B drive lane
instead returns a real `$Promise` **externref** — and under WASI nothing drains
it, so a numeric consumer coerces the externref to `f64` = `NaN`.

The gate is:

```ts
const anyRealSuspension = plan.awaitPoints.some((a) => plan.awaitedStaticallyResolved.get(a) !== true);
if (!anyRealSuspension) return false;
```

`awaitIsStaticallyResolved` (`async-static.ts`) is deliberately **purely
syntactic** — it is a leaf module importing only `ts-api` so the IR front-end can
consume it without an import cycle (#3324). It recognises literals,
`Promise.resolve(<static>)`, and static unary/binary trees, and returns `false`
for "a bare identifier (which may hold a pending Promise)". So:

- `await (n + 1)` → `n` is a bare identifier → not static → "real suspension".
  But `n` is a **`number`**; awaiting a non-thenable can never suspend. The
  syntactic analysis cannot see the type.
- `await p` → `p` is a bare identifier → not static. Here it genuinely IS a
  thenable; what makes it non-suspending is that its only assignment is
  `Promise.resolve(7)`.

## Two independent fixes

1. **Type-based (provable, small).** Awaiting a value whose type is not
   thenable cannot suspend — ECMAScript §27.7.5.3. `asyncFnNeedsDrive` has
   `ctx` (hence the checker), so the check belongs at the CALLER, not in the
   checker-free leaf module. Conservative on `any`/`unknown` (may hold a
   thenable at runtime) and on unions (safe only if every constituent is
   non-thenable). Fixes `await (n + 1)`.
2. **Flow-based (larger).** See through a local whose sole initializer is
   statically resolved and which is never reassigned or captured-and-mutated.
   Fixes `await p`. Over-approximating here mis-elides a genuinely-suspending
   await, so it needs care.

## Open design question (blocking a complete fix)

What SHOULD a WASI async function return when the promise is genuinely pending?
AG0 says "compile synchronously, unwrap the carrier"; PATH B says "return a real
`$Promise`". Those two answers are incompatible for the same call shape, and
`#2865`'s suite asserts the AG0 answer. Narrowing the drive lane's claim (fix 1
and 2) resolves the shapes where the await provably cannot suspend, but the
lanes' contract for a truly pending await under WASI still needs a decision —
that is a design call, not a bug fix, so it is recorded here rather than
guessed at.

## Acceptance criteria

- [ ] `tests/issue-2865-standalone-async-await-unwrap.test.ts` passes 7/7.
- [ ] The drive lane is narrowed by a PROVABLE non-suspension test, not by
      disabling it (which would regress the genuinely-suspending shapes #2895
      PATH B exists for).
- [ ] The pending-await-under-WASI contract is stated explicitly in
      `async-activation.ts`.
