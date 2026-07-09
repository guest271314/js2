---
id: 3120
title: "Standalone async-generator: plain `yield <promise>` skips the §27.6.3.8 implicit Await(operand) — yields the promise object (NaN) instead of awaiting; a rejecting operand doesn't reject"
status: ready
sprint: current
model: fable
created: 2026-07-09
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, standalone
language_feature: async-generators, iterators
goal: standalone-mode
umbrella: 2860
related: [2906, 2865, 2980]
origin: "2026-07-09 fable-3100s4 — split from the #2906 3d-iii premise-check. Found while root-causing the #2980 async-gen −4 (which turned out to be the Promise-lane, not the drive). This is a genuine, orthogonal async-gen-drive conformance gap."
---

# #3120 — async-gen implicit AsyncGeneratorYield await of the operand

## Problem (verified against main, 2026-07-09, wasi direct-drive)

§27.6.3.8 AsyncGeneratorYield(value) performs `Await(value)` on the yield
OPERAND before suspending. The native async-gen drive (#2906 3d-i) handles
`yield await P` (explicit await → suspend+settleYield, rejection routes to a
rejected next()-promise), but a plain `yield E` skips the implicit await and
yields the operand DIRECTLY. When `E` is a promise this is wrong:

Direct-drive proof (`__async_gen_next_g` → drain → read IteratorResult):

```ts
async function* g() {
  yield Promise.reject(99);
} // next1 = FULFILLED value=NaN  (want REJECTED)
async function* g() {
  yield Promise.resolve(7);
} // next1 = FULFILLED value=NaN  (want value=7)
async function* g() {
  yield await Promise.reject(99);
} // next1 = REJECTED  ✓ (explicit await works)
async function* g() {
  yield 5;
} // next1 = FULFILLED value=5  ✓ (non-promise)
```

The promise operand is coerced to f64 → NaN and fulfilled; a rejecting
operand fulfills-NaN instead of rejecting + closing the generator.

## Root cause

`analyzeAsyncGen` (async-cps.ts ~L2175) classifies `yield E` into
`awaited: P` (from `yield await P` → suspend+settleYield) vs `plain: E`
(from `yield E` → settleYield directly, NO await). A plain `yield <promise>`
takes the `plain` path and never awaits.

## Fix

Classify a `yield E` whose operand `E` is statically a Promise/thenable type
(or `any` that could be a thenable) as `awaited: E` — routing it through the
EXISTING, proven `suspend(E) → settleYield(fromSent)` machinery (which already
rejects the current next()-promise + closes the gen on a rejected operand,
per the landed 3d-i `yield await Promise.reject` test). Keep genuinely-non-
promise operands (`yield <number>`) on the fast `plain` path so
`isAwaitFreeAsyncGenBody` (the standalone-off carrier gate, #2865) stays valid
for non-promise bodies. Needs `ctx.checker` at the classification site (route
via `const { checker } = ctx`), or thread the promise-typed decision from a
checker-having caller into `analyzeAsyncGen`.

## Acceptance

1. `yield Promise.reject(e)` rejects the current next()-promise + closes the
   gen (done=true on the next next()); `yield Promise.resolve(v)` yields `v`.
2. Host-free wasi direct-drive tests (mirror `issue-2906-3di-asyncgen-producer`).
3. `yield <number>` (non-promise) stays byte-identical (await-free fast path).
4. Byte-inert on gc/host/normal-standalone.

## Scope / non-goals

Orthogonal to the #2980 flip — the async-gen −4 flip-blocker is the Promise
lane (native construction × host `.then` × legacy async-gen), NOT the drive;
the −4 files are legacy function-expression gens the drive never touches. This
is a pure host-free async-gen conformance win. `yield*` async delegation +
method-form async-gen producers are separate (their own follow-ups).
