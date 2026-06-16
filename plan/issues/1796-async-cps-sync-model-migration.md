---
id: 1796
title: "Migrate synchronous-async contract to CPS Promise model (flip ASYNC_CPS_ENABLED)"
status: ready
created: 2026-06-03
priority: top
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: async, promises
goal: spec-completeness
sprint: 63
related: [1042, 1326, 1373, 1373b]
note: "2026-06-15: elevated to TOP priority by stakeholder (Proxy/Promise/async-to-100% epic). Host-mode Promise/async completion linchpin. Needs architect spec + senior-dev; sequenced after #1936 census, gated on #1373b CPS lowering."
---
# #1796 — Migrate the synchronous-async contract to the CPS Promise model

## Context

#1042 PR1 landed the full async/await CPS state-machine lowering **inert**
(`ASYNC_CPS_ENABLED = false` in `src/codegen/async-cps.ts`). The driver
(`emitAsyncStateMachine`), segmentation (`splitBodyAtAwait`), continuation
synthesizer (`compileSyntheticAsyncContinuation`), function-body activation
hook, and AwaitExpression gate are all in place and gated off. Emitted Wasm is
byte-identical to before; existing async tests pass unchanged.

## The design wall (why this is its own issue)

The existing compiler lowers `async function` **synchronously**: a caller does
`f() as any as number` and gets the *unwrapped value* directly (await is an
identity pass-through). See `tests/equivalence/async-function.test.ts` — the
"await expression is identity (pass-through)" test asserts
`test() as any as number === 100` for `const v = await getValue(); return v`.

The CPS lowering changes the async return model to a **real Promise object**
(externref): `emitAsyncStateMachine` rewrites the function's result type to
`externref` and returns the chained `Promise_then2(...)` result. So **flipping
`ASYNC_CPS_ENABLED` to `true` breaks every test that relies on the synchronous
model** — the whole `async-*` equivalence suite plus very likely a large number
of test262 async cases that read the result as a value, not a thenable.

This is not a localized flip; it is a **contract migration** that must be done
as one coordinated change with the test corpus.

## Scope

1. Flip `ASYNC_CPS_ENABLED` → `true` in `src/codegen/async-cps.ts`.
2. Migrate the synchronous-async call/consume sites: every place that treats an
   async-function result as its unwrapped value (`f() as any as number` idiom,
   direct numeric/string/ref use of an async return) must instead await /
   unwrap the Promise. Inventory via the `async-*` equivalence suite + a grep
   for `as any as` on async-call results.
3. Update the async test corpus (`tests/equivalence/async-*.test.ts`,
   `tests/issue-*async*.test.ts`) to the Promise model — the harness must
   `await` the exported entry (or drain microtasks) instead of reading a value.
4. Add `tests/issue-1042.test.ts` — the 5 canonical CPS runtime cases that
   require the gate on: identity await (=42); sequential side-effect ordering;
   try/catch reject; Promise.all interleave; return-await collapse.
5. Re-baseline test262 async buckets; coordinate with the JS-host vs standalone
   Promise paths (#1326 microtask queue is the standalone settle path).
6. Extend coverage beyond the single-tail-await shape `splitBodyAtAwait`
   currently accepts (multiple awaits, awaits in branches/loops, try-across-await
   #1373c, async arrows/methods) — or keep those on the legacy path with an
   explicit `splitBodyAtAwait → null` fallback and a follow-up.

## Acceptance criteria

1. `ASYNC_CPS_ENABLED = true` and the 5 canonical `tests/issue-1042.test.ts`
   cases pass.
2. The async equivalence suite is migrated to the Promise model and green.
3. No net test262 regression in the async buckets (the migration may flip some
   tests both ways — net must be ≥ 0, ideally positive as real Promise
   semantics land).
4. JS-host and standalone (#1326) async paths both produce spec-correct
   ordering.

## Notes

- The driver intentionally uses the `.then`-chaining model (the continuation's
  `return X` is the cb's externref result; `.then` resolves the chained promise
  to it) — no manual settle. The `Promise_new_pending` / `Promise_settle_*`
  runtime primitives committed in #1042 PR1 (e42882074) remain available if a
  future settle model is preferred.
- #1042 issue file `## In-progress work` has the full step-by-step + the
  `__make_callback` contract + verified wiring line numbers.
- **ID note:** filed as #1796 because #1792 was already taken
  (`1792-node-url-builtin-impl.md`); the lead's dispatch said "1792" but that
  collides — using the next free id.
