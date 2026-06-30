---
id: 2906
title: "Standalone: generalize the async drive layer → multi-state, CFG-aware CPS resume machine (unlocks try/finally-across-await, for-await, multi-await)"
status: ready
assignee: null
created: 2026-07-01
priority: high
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: xl
related: [2895, 2867, 2864, 2865, 2367]
umbrella: 2860
architect_spec: authored
---

# Generalize the async drive layer to a multi-state CFG-aware CPS resume machine

## Problem

The landed host-free async **drive layer** (#2895 slices 1a–1c, PRs #2393/#2394)
is **single-await by construction**. It only drives the three canonical shapes
that `async-cps.ts splitBodyAtAwait` accepts and rejects everything else:

```ts
// src/codegen/async-cps.ts:594  splitBodyAtAwait(...)
if (plan.awaitPoints.length !== 1) return null; // L596 — multiple awaits → reject
if (plan.hasTryAcrossAwait) return null; // L597 — try/finally/catch around an await → reject
// supported shapes only: `return await P` | `const x = await P; <rest>` | `await P; <rest>`
```

`asyncFnNeedsCps` (async-cps.ts:292) gates on `splitBodyAtAwait`, so an async
function whose body has **any** richer control flow around an await — a
`try/finally` across an await, a `for-await-of` loop, or simply two awaits — is
**not driven**: it falls back to the synchronous AG0 one-level unwrap, which
returns the pending `$Promise.value` (null/stale) for a genuinely-pending await.

`async-frame.ts ensureAsyncResumeFunction` (L317) hard-codes a **2-state**
machine (entry segment + single continuation) built from that single split — it
has no finally-region routing, no loop back-edge, and no general br_table over N
suspend points.

This blocks the two remaining standalone-async carrier gaps and the count-move:

- **Gap 3** (#2867) — `try/finally`-across-await: the finally region must run on
  the normal continuation AND on the abrupt (throw / rejected-await / return) arms
  after resume.
- **Gap 5** (#2867) — `for-await-of` / async-generator drive: awaits iterated
  inside a loop body (the AG2 generator/async-frame convergence).
- multi-await-in-linear-code (`const a = await p; const b = await q; ...`).

All three need the **same** thing: a general resume machine. They cannot each be
bolted onto the 2-state machine as inert slices without re-deriving the same
generalization three times (a partial machine strands — the #2367 graveyard). So
this is one XL substrate issue that **unlocks Gap 3 + Gap 5 + multi-await
together**, after which those become bounded slices and the slice-1d carrier
widen can finally be measured.

## Root cause / design (the general machine)

Replace the single-await `splitBodyAtAwait` + 2-state resume with a **CFG-numbered
multi-state** lowering, reusing the existing substrate (do NOT fork it):

1. **Suspend-point numbering.** Walk the async body and assign each `await` (and
   each loop-iteration await) a distinct **state id**. State 0 = entry. The body
   is lowered into a `br_table` over `frame.STATE_FIELD` (frame-core ABI), exactly
   the dispatch shape `generators-native.ts ensureNativeGeneratorResumeFunction`
   (L1781) already uses for `yield`. Reuse `frame-core.ts`
   `setStateInstrs`/`storeSpills`/`defaultSpillInstr` verbatim; the `$AsyncFrame`
   struct (`buildAsyncFrameInfo`) already carries `STATE`/`SENT`/`MODE`/`ABRUPT`/
   `ERROR` + params + spills + `result_promise`.

2. **Structured control flow → state transitions.** Lower the async body's
   statement tree to segments split at each suspend point, preserving structure:
   - **sequence**: segment N runs to the next await, suspends (storeSpills + set
     STATE=N+1 + register reaction + return), resumes at segment N+1.
   - **`try/finally`-across-await (Gap 3)**: the finally block is emitted as a
     **shared finally region** reached from (a) the normal end of the try body and
     (b) every abrupt completion that crosses it — a `throw` in the try, a
     rejected-await (`MODE_THROW` arm, already wired by Gap 2), and a `return`
     inside the try (route the `asyncDriveReturn` settle through finally first).
     Model abrupt completion with the frame `MODE_FIELD`/`ABRUPT_FIELD`/`ERROR_FIELD`
     (frame-core already defines them) — finally runs, then the pending completion
     is replayed (re-throw / settle-return). `try/catch` is the same skeleton with
     a catch target instead of/in addition to finally.
   - **`for-await-of` / loops (Gap 5)**: a loop with an await in its body is a
     back-edge in the state graph — the continuation after the body's await branches
     back to the loop-head state. for-await-of additionally drives the async
     iterator protocol (`[Symbol.asyncIterator]()` → `next()` returns a `$Promise`
     of `{value,done}`), each `next()` await being a suspend point. Async generators
     converge the `$Frame` (generators-native) and `$AsyncFrame` (async-frame) — the
     AG2 convergence noted in #2895/#2865.

3. **Settle / reject routing.** Reuse `async-scheduler.ts` `__promise_fulfill`/
   `__promise_reject` + the microtask ring + `$PromiseCallback` reactions verbatim
   (the same primitives Gap 1/2/4 already compose). The step adapters
   (`__async_step_f<name>_{fulfill,reject}`) and the call-site shim
   (`emitAsyncFrameStateMachine`) generalize from 2 states to N with no ABI change.

## Hazards to spec against (cite in the build)

- **funcIdx / type-index stability** (#1677/#1809/#1899): reserve the resume-fn +
  step-adapter funcIdx slots with placeholder bodies BEFORE emitting the body —
  `compileStatement` lazily appends helper functions. The N-segment body emits more
  helpers than the 2-state machine, widening this window. Register all shared types
  (`$Promise`, `$PromiseCallback`, `$AsyncFrame_<name>`) up-front.
- **stack-balance type-repair** (#2895 codegen lesson): narrow an awaited
  `$Promise` into a single typed `(ref $Promise)` local once; repeated
  `local.get externref; any.convert_extern; ref.cast` confuses the repair pass.
- **liveness across multiple awaits**: the spill set must include every local live
  across ANY suspend point (union over states), not just one await's suffix
  (`computeAsyncSpills` currently computes for the single split — generalize to the
  CFG).
- **carrier-gating + the −16/−29 corpus guard**: keep every new path gated on the
  carrier (`isStandalonePromiseActive`, wasi-only until slice 1d) so gc/host and
  still-host-backed standalone stay **byte-identical** (verify by binary hash, the
  discipline Gap 4 / the drain-hook used). The slice-1d widen is a SEPARATE final
  step, measured NET-POSITIVE on the full `merge_group` standalone corpus.

## Suggested slicing (each inert, carrier-gated, independently mergeable)

1. **multi-await-in-linear-code** — generalize numbering + br_table for ≥2
   sequential awaits, no try/loop. Smallest validation of the N-state machine.
2. **Gap 3 — try/finally-across-await** — add the shared finally region + abrupt
   routing on the normal + reject + return arms.
3. **Gap 5 — for-await-of** — loop back-edges + the async-iterator protocol drive.
4. **Gap 5 — async generators** — the `$Frame`/`$AsyncFrame` AG2 convergence.
5. **slice-1d widen** (owned by #2895/#2867) — widen `isStandalonePromiseActive` +
   `isStandaloneThenChainNativeActive` to `standalone`, measured net-positive.

## Predecessors (LANDED)

Drive layer #2393/#2394 (async-frame.ts), carrier Gaps 1/2 (#2867), Gap 4 native
combinators (#2867, PR #2403), the `__drain_microtasks` runner hook (#2895, PR
#2404), the Test262Error native carrier (#2397), and the stored-`Promise<T>`
consumption contract (#2402/#2905) are all on `main` — so the eventual widen sees
the compounded async unlock.

## Test plan

Per slice, host-free wasi tests (`__drain_microtasks`, `result.imports` empty)
covering the new shape, plus the byte-hash inertness proof (gc/host + standalone
unchanged). The slice-1d widen is gated on the full `merge_group` standalone
corpus (sr-pathb's 74-file async-function + the 150-sample for-await/async-gen/
Promise.then/all cluster) measuring NET-POSITIVE — the authoritative gate.
