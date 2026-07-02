---
id: 2967
title: "Async engine convergence: retire emitAsyncStateMachine/splitBodyAtAwait onto the #2906 host-drive engine; widen planLinearAwaits gaps once for both lanes"
status: ready
created: 2026-07-02
updated: 2026-07-02
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
goal: async-model
sprint: current
parent: 1042
depends_on: [1042]
related: [2906, 2957, 1373b]
origin: "#1042 host-drive PR (2026-07-02) — deliberate scope cut: the CPS lane was left byte-stable; convergence is its own measured step"
---

# #2967 — One async lowering engine: fold the single-tail-await CPS lane into the host drive, then widen the shared gaps

## Problem

#1042 (2026-07-02) re-targeted the JS-host lane onto the #2906 N-state
`$AsyncFrame` resume machine with a host settle backend (`async-frame.ts`,
`asyncFnNeedsHostDrive`) — but **deliberately only for the shapes the old CPS
lane rejected** (multi-await, try/finally-across-await). The single-tail-await
shapes still take `emitAsyncStateMachine`/`splitBodyAtAwait` (`async-cps.ts`),
so the JS-host lane runs TWO suspension engines:

- `asyncFnNeedsCps` → the legacy `.then`-chaining CPS (single tail await);
- `asyncFnNeedsHostDrive` → the #2906 frame engine (host settle backend).

The July audit's convergence end-state is ONE engine. Single-await is a strict
subset of the N-state machine (N=1), so the CPS lane is retirable — but that
flip changes emitted code for the single-await population (the largest async
population), so it must be measured, not assumed.

## Approach

1. **Flip routing**: make `asyncFnNeedsHostDrive` claim everything
   `planLinearAwaits` accepts (drop the `!asyncFnNeedsCps` exclusion);
   short-circuit `asyncFnNeedsCps` to false (or delete the CPS arm in
   `function-body.ts`). Keep the lone-combinator + spill-safe gates.
2. **Full-corpus A/B** (CI sharded test262, host lane): net must be ≥ 0 with
   no async bucket regression. The engines differ observably: the frame engine
   settles a pre-allocated pending promise via `Promise_settle_resolve`; the
   CPS lane returns `Promise_then2`'s chained promise. Watch promise-identity
   and unhandled-rejection-timing tests specifically.
3. On a measured non-negative net: delete `emitAsyncStateMachine`,
   `splitBodyAtAwait`, `compileNestedAwait`'s CPS arm, the `asyncCpsActive`
   plumbing, and the `collectAsyncCpsImports` CPS-only detection (keep the
   host-drive import registration).
4. **Then** widen the remaining `planLinearAwaits` gaps ONCE for both lanes
   (wasi native backend + host backend inherit together):
   - try/catch-across-await (the reject step adapter already delivers
     ERROR/MODE_THROW; the catch clause becomes a state-arm handler),
   - `return`-in-try (return-through-finally),
   - nested/buried await (await in non-canonical statement positions),
   - await in loops/branches (needs a real CFG, coordinate with #1373b).

## Also filed here (pre-existing, probe-verified on main 2026-07-02)

- `const p = f(); return await p;` — awaiting a promise held in a LOCAL
  (rather than a direct call operand) resolves to `null` on the host lane in
  both source orders. Triage where the identifier-operand await loses the
  promise (likely the call-site wrap / consumed-as-value classification, not
  the suspension engine).
- `tests/async-function.test.ts` fails to LOAD on main (`Cannot find module
  './helpers.js'` — helpers moved to `tests/equivalence/` long ago); the suite
  silently runs 0 tests. Fix the import path or fold the file into
  `tests/equivalence/async-function.test.ts`.

## Acceptance criteria

- One suspension engine on the JS-host lane (`async-frame.ts`);
  `emitAsyncStateMachine`/`splitBodyAtAwait` deleted.
- Full-corpus A/B recorded in this file: async cluster net ≥ 0.
- try/catch-across-await works on BOTH lanes (wasi + host) via the shared
  engine, with tests.
- The two pre-existing bugs above triaged (fixed or split out).
