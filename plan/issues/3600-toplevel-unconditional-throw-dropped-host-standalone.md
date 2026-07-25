---
id: 3600
title: "codegen: unconditional top-level `throw` is silently dropped on gc/standalone lanes — program exits 0 (#2968 fixed WASI only)"
status: ready
sprint: current
created: 2026-07-25
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
horizon: s
area: codegen
language_feature: throw
goal: correctness
related: [2968, 3535, 2992]
---

# #3600 — top-level unconditional `throw` emits no code on gc/standalone lanes

## Problem (measured, 2026-07-25)

A bare, unconditional `throw` statement at module top level compiles to
**nothing** on the JS-host (gc) and plain-standalone lanes. The statement is
skipped, every subsequent top-level statement still runs, and the program
exits 0:

```js
throw new Error("boom"); // never thrown
console.log("still runs"); // runs
```

Verified directly against current main (2026-07-25): compiling the single
statement `throw new Error("boom")` with `deferTopLevelInit: true` succeeds
with **no `__module_init` emitted at all**; embedding
`throw new Test262Error("PROBE")` at the top of a real test262 file compiles,
the throw never fires, and all later statements execute. A _conditional_
throw (`if (x === 0) { throw ... }`) works correctly — only the direct
statement-position `ThrowStatement` at module level is dropped.

## Root cause (exact, already half-documented)

`src/codegen/declarations.ts` ~L1514-1525, the module-level statement
collector for `__module_init`:

```ts
// (#2968) A top-level `throw` under `--target wasi`: collect it into
// `__module_init` ... Gated on `ctx.wasi` so JS-host / plain-standalone
// output stays byte-identical (their pre-existing top-level-throw drop is
// out of scope for this issue).
if (ts.isThrowStatement(stmt)) {
  if (ctx.wasi) ctx.moduleInitStatements.push(stmt);
  continue;
}
```

#2968 fixed exactly this bug for `--target wasi` and deliberately left the
gc/standalone drop in place. This issue removes the gate.

## Why this matters beyond user programs

This bug **defeats throw-probe vacuity auditing**: an injected unconditional
`throw` probe into 43 sampled passing test262 files "passed" 43/43 — not
because the passes were vacuous, but because the probe itself was compiled
away. (Re-run with a conditional probe: 0/43 vacuous — see
`plan/agent-context/fable-test262-false-positives-2026-07-25.md`.) Any
future soundness tooling that injects top-level throws hits the same trap.

Measured conformance impact (baseline JSONL 2026-07-24, joined against
test262 metadata):

- **~0 current passes depend on the drop** — a scan of all 26,336 passing
  non-negative tests found only 5 with a column-0 `throw`, and all 5 are
  inside unindented `if` blocks (conditional — unaffected).
- **~6 current runtime-negative FAILs are direct victims** and should flip
  to pass:
  `language/line-terminators/comment-single-{cr,lf,ls,ps}.js`
  (`// comment<LT>throw new Test262Error();` — the post-line-terminator
  unconditional throw is dropped, runner reports
  "expected runtime Test262Error but succeeded"), plus
  `language/module-code/eval-self-abrupt.js` and
  `language/module-code/eval-export-dflt-expr-err-eval.js` (same shape).

## Fix

In `src/codegen/declarations.ts`, make the ThrowStatement arm unconditional:

```ts
if (ts.isThrowStatement(stmt)) {
  ctx.moduleInitStatements.push(stmt);
  continue;
}
```

`compileThrowStatement` (`src/codegen/statements/exceptions.ts`, dispatched
from `src/codegen/statements.ts` L205) already compiles ThrowStatement
correctly inside `__module_init` — conditional top-level throws (an
`ts.isIfStatement` arm collected two branches above) prove the codegen path
works; only the _collection_ skips the bare statement.

## Edge cases / downstream effects

- **Byte-diff neutrality**: programs with no top-level bare `throw` must be
  byte-identical (same discipline as #2992's delete fix — that arm's comment
  is the template).
- **TS unreachable-code analysis**: statements after an unconditional
  top-level throw may be grayed by TS but are still collected; runtime
  semantics are correct (they never execute because the throw fires).
- **Runtime-negative flips**: expect ~4-6 fail→pass (files listed above) —
  a net-positive baseline diff, no intentional-drop coordination needed.
- **`(start)`-model standalone**: with `deferTopLevelInit` the throw
  surfaces from the explicit `__module_init` call — same classification path
  the worker already has (#3049 C1). For true `(start)`-section standalone,
  see #3535 (throw-from-start rendering) — related but separate.
- **No oracle bump**: runner verdict logic is untouched; row flips come from
  the compiler change and are scored normally by the baseline diff.

## Verify

1. `.tmp` probe: compile `throw new Error("x"); console.log("after")` — WAT
   must contain `__module_init` with a throw; execution must throw before
   logging.
2. Targeted rerun of the 6 listed runtime-negative files → pass.
3. Targeted rerun of 5-10 passing Sputnik-style conditional-throw files
   (e.g. `language/expressions/greater-than/S11.8.2_A4.12_T2.js`) → still
   pass.
4. Equivalence tests + a regression test `tests/issue-3600.test.ts`
   asserting the compiled module's init throws.
