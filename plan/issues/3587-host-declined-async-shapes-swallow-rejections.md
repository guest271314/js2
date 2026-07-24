---
id: 3587
title: "Host lane: async shapes the host-drive engine declines (try/catch across await, non-linear bodies) silently SWALLOW awaited rejections — execution continues past the await"
status: in-progress
assignee: ttraenkler/fable-3587
sprint: current
created: 2026-07-25
updated: 2026-07-25
priority: critical
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: async, promises
goal: async-model
related: [1042, 1796, 2906, 2967, 1373b, 3545]
origin: "2026-07-25 Fable substrate/async review (plan/agent-context/fable-substrate-async-review-2026-07-24.md), probes a5b/a5c/a5d"
---

# Declined async shapes swallow rejections on the default (gc host) lane

## Problem (verified on main 7652f0337, DEFAULT gc host lane)

When `asyncFnNeedsHostDrive` (src/codegen/async-frame.ts:197) declines an
async function — e.g. because `planLinearAwaits` rejects try/catch across an
await — the function falls to the **legacy synchronous pass-through**, where an
awaited REJECTION does not throw: execution **continues past the `await` as if
it fulfilled**, catch blocks never run, `.catch` handlers never run, and the
rejected host promise leaks as an unhandledRejection.

```ts
export async function test(): Promise<number> {
  try {
    await Promise.reject(7);
    return -1; // must not reach
  } catch (e) {
    return e as number; // expect 7
  }
}
// node: 7 · gc host: -1 (reached the must-not-reach line) · SILENT
```

Wider probe (a5c) — all four rejection shapes swallowed in one declined body:

```ts
await p; // p = Promise.reject(1) — continues, no throw
await rejector(); // async fn returning Promise.reject — continues
await Promise.reject(5).catch(handler); // handler NEVER runs
await new Promise((_res, rej) => rej(9)); // continues + leaks unhandledRejection "9"
// node: 9531 · gc host: 7000000 (all three must-not-reach arms hit)
```

## Control (the engine-claimed shape is correct)

Same rejection, no try/catch in the async fn (single-await linear shape →
host-drive engine claims it): correct.

```ts
async function f(): Promise<number> {
  await Promise.reject(7);
  return -1;
}
export async function test(): Promise<number> {
  let out = 0;
  await f().then(
    (_v: number) => {
      out = 100;
    },
    (e: number) => {
      out = e;
    },
  );
  return out; // node AND gc host: 7 ✓  (probe a5d)
}
```

Synchronous `throw` inside a declined async fn DOES propagate (probe a5:
first arm caught 42) — only promise-carried rejections are lost.

## Why this is the worst kind of boundary

The decline predicate is invisible to the user. Adding a `try/catch` around an
`await` — the very construct that signals "I care about this rejection" — is
what flips the function onto the lane that **cannot deliver rejections**. Same
syntax, silently different error semantics, on the DEFAULT lane.

This is a known architectural residue (#1796 scope note: only linear shapes
got the CPS/host-drive model; #2906 is generalizing the machine for
standalone), but no open issue owned the HOST-lane consequence, and none
documented that the declined population swallows rejections rather than
merely being "sync-timed". test262's async harness (`$DONE`) under-detects
this because harness bodies are often engine-claimed shapes.

## Direction

Either (a) extend `planLinearAwaits`/host-drive to claim try/catch-across-await
(the #2906 Gap-3 skeleton, host settle backend), or (b) make the legacy sync
pass-through LOUD for bodies containing an await inside try/catch or any
rejection-observing construct (compile error / diagnostic), so the silent
lane cannot host rejection-sensitive code. (b) is a cheap stopgap that converts
a silent miscompile into a refusal.

## Acceptance

- Probe a5b returns 7 on gc host; a5c returns 9531; no leaked
  unhandledRejection.
- A regression test for rejection delivery through try/catch, `.catch`, and
  the two-callback `.then` on both engine-claimed and previously-declined
  shapes.
