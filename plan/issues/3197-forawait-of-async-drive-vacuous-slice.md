---
id: 3197
title: "default lane: drive the for-await-of / async-dstr callback chain to completion (383 vacuous fails)"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: ES2018
language_feature: for-await-of
goal: core-semantics
sprint: current
horizon: m
umbrella: 3184
related: [3184, 2940, 3086, 2669, 3021]
origin: "2026-07-12 Fable codebase audit §F1; slice of #3184"
---

# #3197 — for-await-of / async-dstr drive slice (383 vacuous)

Sub-slice of **#3184**. This slice owns the **for-await-of** half; the
Promise-combinator half is **#3198**.

## Problem

On the default (JS-host) lane, `language/statements/for-await-of` has **489
non-pass** tests, of which **383** carry `vacuous: harness-wrapper callback
never executed (#2940)`: the compiled test returns "success" while the async
callback chain — and every assertion — **never runs**. Sampled files are
dominated by destructuring-in-async shapes:

```
language/statements/for-await-of/async-func-decl-dstr-array-elem-nested-array-null.js
language/statements/for-await-of/async-func-dstr-var-ary-ptrn-elem-id-iter-val-err.js
language/statements/for-await-of/async-func-dstr-var-obj-ptrn-prop-id-init-unresolvable.js
language/statements/for-await-of/async-gen-decl-dstr-obj-id-put-unresolvable-no-strict.js
```

The runner is NOT the gap — it implements the async protocol (`$DONE`
`tests/test262-runner.ts:1890`, `asyncTest` `:1899`, detection `:2568-2569`).
The failure is compiler-side: the host-lane async machinery never drives the
`asyncTest(fn)` body to completion for for-await-of / async-destructuring
shapes.

## Reproduction path (verified anchors)

For-of/for-await statement dispatch enters at `src/codegen/statements.ts:180-181`
(`ts.isForOfStatement` → `compileForOfStatement`, imported at `:39`); the
await-modifier lowering and its host-Promise drive live inside that path.
First diagnostic step: compile one sampled vacuous test on the default lane
and trace whether (a) the wrapped `asyncTest` callback is ever invoked, (b) the
for-await loop's first `IteratorNext` promise is ever awaited, or (c) an early
silent rejection is swallowed by the host bridge (`Promise_then` /
`__make_callback` family in `src/runtime.ts`).

## Acceptance criteria

1. Root-cause note in this file: which link of the chain drops the callback
   (asyncTest wrapper → async fn body → for-await drive → $DONE).
2. The 383 vacuous for-await-of records: ≥ 250 flip to genuine pass OR to
   honest assertion failures (no longer vacuous) on the default lane.
3. `language/statements/for-await-of` non-pass drops below 250 (from 489).
4. No standalone-lane regressions (the standalone carriers #2865/#3132 own
   that lane; do not touch their emit paths).
5. If the same root cause explains the async-function/async-generator vacuous
   slice (~91), note the measured overlap; do not scope-creep into the
   Promise-combinator slice (that is #3198).

## Audit cross-link

`plan/log/2026-07-12-fable-codebase-audit.md` §F1.
