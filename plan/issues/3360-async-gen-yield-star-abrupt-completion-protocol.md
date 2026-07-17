---
id: 3360
title: "default lane: async-generator `yield*` delegation drops iterator-protocol abrupt completions (690 honest fails, oracle-7 #3227 S5)"
status: ready
sprint: current
priority: high
horizon: l
feasibility: hard
model: fable
reasoning_effort: high
task_type: bug
area: codegen
es_edition: es2018
language_feature: async-generators, yield-star, iterator-protocol
depends_on: [3227]
related: [3227, 1259, 1346]
created: 2026-07-17
updated: 2026-07-17
origin: "2026-07-17 /harvest-errors against the FRESH oracle-7 baseline (loopdive/js2wasm-baselines run 20260717-111717, host 32,138/43,106). Default (JS-host) lane. This is the concrete feature-fix that #3227's slice plan names as its 'S5+ feature-fix clusters' — the abrupt-completion delegation bugs that #3227 S4's honest CI scoring newly exposes."
---

# #3360 — async-generator `yield*` delegation drops iterator-protocol abrupt completions

## Summary

Under the fresh **oracle-7** baseline, **690 `yield-star-*` test262 files fail
honestly** in the default (JS-host) lane (0 vacuous — every one is a real
assertion failure, not a harness-callback artifact). They are the largest
coherent honest-fail family the oracle-7 async re-scoring (#3227 S1/S4) exposed:
these tests previously "passed" only because a premature synchronous verdict
was read before the delegated async iteration ran. Now that the verdict is read
post-drain, the underlying delegation bug is visible.

The bug is in **`yield* <delegate>` inside an `async function*`**: our
delegation path does not correctly **validate the delegate's iterator protocol
and propagate abrupt completions** out of the `yield*`. #3227 S3 already fixed
the *happy-path* "inner async-generator drained zero values" case
(`__gen_yield_star` draining an inner that carries only `Symbol.asyncIterator`);
what remains — and what this issue tracks — is the **abrupt / malformed-protocol
half** of §27.6.3.8 (AsyncGeneratorYield / yield* runtime semantics).

This is the S5 feature-fix follow-on to **#3227** (whose S1–S4 are the
runner/oracle *infrastructure* that made these honest; the fix here is the
compiler/runtime *feature* work). It `depends_on: [3227]` only so the honest CI
scoring is in place to measure the delta.

## Distribution (690 total, default lane, all `status: fail`, all honest)

| Count | Sub-family (filename token)     | Mechanism                                                                                       | Sample file                                                                                     |
| ----- | ------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 182   | `yield-star-getiter-async-*`    | GetIterator(async): delegate `[Symbol.asyncIterator]()` returns non-object / throws → must TypeError | `expressions/class/elements/async-gen-private-method/yield-star-getiter-async-returns-boolean-throw.js` |
| 144   | `yield-star-getiter-sync-*`     | GetIterator(sync-fallback): delegate `[Symbol.iterator]()` returns non-object → must TypeError   | `expressions/async-generator/yield-star-getiter-sync-returns-number-throw.js`                    |
| 108   | `yield-star-next-then-*`        | `iterResult = await iter.next(...)`; the result's `.then` is non-callable / non-object handling  | `expressions/class/async-gen-method-static/yield-star-next-then-non-callable-string-fulfillpromise.js` |
| 84    | `yield-star-next-not-*`         | delegate `.next` is not callable → must TypeError, closes iter                                   | `expressions/async-generator/yield-star-next-not-callable-undefined-throw.js`                    |
| 36    | `yield-star-next-call-*`        | `iter.next()` itself returns an abrupt completion → propagate                                    | `expressions/async-generator/yield-star-next-call-returns-abrupt.js`                             |
| ~90   | `sync-throw` / `sync-return` / `async-throw` / `async-return` / `next-get` / `next-non` / `sync-iterator` / `async-iterator` (12 each) | throw()/return() delegation + IteratorResult `done`/`value` reads on the settled result | `statements/async-generator/yield-star-next-non-object-ignores-then.js`                          |
| ~46   | remainder (`expr-abrupt`, `normal-notdone`, `before-newline`)                                    | | `expressions/async-generator/yield-star-expr-abrupt.js`                                          |

Dominant honest-fail assertion shapes (from `error_signature`):

- `throw new Test262Error('abrupt completion closes iter')` — 208
- `assert.sameValue(done, true, 'the iterator is completed')` — 78
- `throw new Test262Error('completion closes iter')` — 56
- `assert.sameValue(v.constructor, TypeError, "TypeError")` — 36 (getiter returns-null-throw shape)

## Root-cause pointer

- `__gen_yield_star` in **`src/runtime.ts`** (around L12510 — the `name ===
  "__gen_yield_star"` arm) is the delegation helper. #3227 S3 changed it to
  drain an eagerly-buffered inner async-generator's remaining buffer and rethrow
  a `pendingThrow`. That covered the *values-present, normal-completion* path.
  It does **not** cover: (a) a delegate whose iterator-method *return value* is
  not an Object (must `TypeError`), (b) a `.next` that is not callable / returns
  abrupt, (c) a delegate `throw`/`return` protocol step, (d) reading `done`/
  `value` off a malformed IteratorResult.
- The async `yield*` lowering lives in **`src/codegen/async-cps.ts`**; confirm
  whether GetIterator-validation should happen there (at lowering) or in the
  runtime helper.

## Slice plan (dispatchable; both touch `__gen_yield_star` — do sequentially, one owner)

- **S-a — GetIterator return-value validation (326: getiter-sync 144 +
  getiter-async 182).** When the delegate's `[Symbol.asyncIterator]()` (or the
  sync `[Symbol.iterator]()` fallback via CreateAsyncFromSyncIterator) returns a
  non-Object, throw a `TypeError` and let it propagate out of the `yield*`
  (§7.4.1 GetIterator step 5). Repro from
  `yield-star-getiter-sync-returns-number-throw.js` /
  `yield-star-getiter-async-returns-boolean-throw.js`.
- **S-b — IteratorNext / step protocol abrupt completions (~360: next-then 108,
  next-not 84, next-call 36, next-get/non 24, sync/async throw/return/next
  ~100).** `.next` not callable → TypeError; `iter.next()` returning an abrupt
  completion → propagate; malformed IteratorResult (`.then`/`done`/`value`) →
  the §27.6.3.8 handling. Repros: `yield-star-next-not-callable-undefined-throw.js`,
  `yield-star-next-call-returns-abrupt.js`, `yield-star-next-then-non-callable-string-fulfillpromise.js`.

## Acceptance criteria

- `.tmp/` repros for one file from each of S-a and S-b confirm the abrupt
  completion is now thrown/propagated with the correct error type (TypeError for
  the non-callable / non-object cases).
- The `yield-star-*` default-lane failing count drops materially from 690 — target
  **≥ 400 of the 690 flip to pass** (S-a ~300 + a first tranche of S-b), measured
  against the oracle-7 baseline once #3227 S4 has landed.
- No regression to the #3227 S3 happy-path async-gen delegation
  (`tests/issue-3227-s3.test.ts`) or to sync-generator `yield*` (#1259).
- No new standalone-lane regression in the `yield*` cluster (the standalone lane
  refuses async generators earlier; verify no crash-shape change).

## Notes

- **Relationship to #3227**: #3227 (in-progress, assignee fable-s4) owns the
  *oracle/runner* honesty infra (S1 post-drain re-read, S4 CI-lane parity) plus
  the S2/S3 compiler fixes. #3227's own slice notes name these abrupt-completion
  `yield*` clusters as "the S5+ feature-fix clusters" but leave them un-carved.
  This issue is that carve-out so the family is independently claimable and
  trackable. Coordinate with the #3227 owner before starting — the fix lands in
  the same `__gen_yield_star` helper S3 last touched.
- Spec: §27.6.3.8 (AsyncGenerator yield* / AsyncGeneratorYield), §7.4 iterator
  abstract operations, §7.4.1 GetIterator.
</content>
