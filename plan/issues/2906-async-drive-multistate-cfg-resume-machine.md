---
id: 2906
title: "Standalone: generalize the async drive layer → multi-state, CFG-aware CPS resume machine (unlocks try/finally-across-await, for-await, multi-await)"
status: in-progress
assignee: ttraenkler/sendev-async-multistate
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

## Slice 1 — multi-await-in-linear-code (LANDED, host-free wasi lane)

**What shipped.** The single-await 2-state resume machine
(`async-frame.ts ensureAsyncResumeFunction`) is generalized to a **general
N-state machine** driving a LINEAR async body with any number of sequential
awaits (no try/finally, no loops — those stay Gap 3 / Gap 5). New surface:

- `async-cps.ts planLinearAwaits(fn, plan)` — the multi-await generalization of
  `splitBodyAtAwait`. Splits a linear body into ordered suspend segments (one per
  await at a canonical top-level position: return-arg / single-var-init /
  expr-stmt). Returns `null` (→ legacy/AG0 fallback) for try-across-await, awaits
  in loops/`if`/expressions, two awaits in one statement, or dead code after
  `return await`. **`splitBodyAtAwait` is left UNCHANGED** so the JS-host CPS
  path + `asyncFnNeedsCps` stay byte-identical.
- `async-frame.ts asyncFnNeedsDrive(ctx, fn, plan)` — drive-layer eligibility.
  For a SINGLE await it returns the same verdict as `asyncFnNeedsCps` (identical
  real-suspension + Promise-combinator gates), so wasi single-await routing is
  unchanged; ≥2 awaits are newly accepted. `function-body.ts` swaps the drive
  branch from `asyncFnNeedsCps` → `asyncFnNeedsDrive`.
- The resume machine is now a `try { block { loop { if-chain } } } catch $exn`
  dispatch (mirrors `generators-native.ts emitTrampoline`): STATE `s` (0..N-1)
  runs await `s` — FULFILLED delivers SENT + `br`s to re-dispatch at `s+1`
  (chaining synchronous fast-path awaits within one call), REJECTED arms
  MODE_THROW + advances (next prelude re-throws), PENDING spills + registers the
  reaction + `return`s. STATE N settles. The advance `br`-to-loop depth is
  `stateId + 2` (validated at runtime).

**Why one machine, no fork (the #2367 graveyard rule).** The two microtask step
adapters are **STATE-agnostic** — they only write SENT/ERROR then call resume,
which routes by STATE — so N states reuse the SAME two adapters with **no ABI
change**. The 2-state `buildEntrySegment`/`buildContinuationSegment` were
**deleted**, not left beside a parallel multi-await path: single- and multi-await
both flow through the one general machine, which is the substrate Gap 3
(finally-regions) and Gap 5 (loop back-edges) extend.

**Spill correctness (the multi-await-specific hazard).** The spill set is now the
UNION over every await `k` of the locals live across await `k`'s suspend, minus
params and minus await `k`'s OWN resume binding (delivered fresh from SENT). A
resume binding from an EARLIER await that survives a later await IS spilled — the
core case `const a = await p; const b = await q; use(a)`. Such a spilled binding
reuses its spill local (no double-`allocLocal`) and is typed via
`resumeBindingValType` so the frame field and local round-trip. Iterating awaits
in order over insertion-ordered Sets + skipping only each await's own binding
keeps a single-await body's spill list byte-identical to pre-#2906.

**Slice-1 scope guard.** A resume binding that must be SPILLED across a later
await is required to have a spill-safe type (`i32`/`f64`/`i64`/`externref`/
`ref_null`); a non-null GC-ref binding would need an invalid `ref.null`
field default, so those fall back to legacy (a later slice can widen this).

**Byte-inertness proof (the −16/−29 discipline).** Compiled 4 representative
programs (single-await, 2×multi-await, plain) under gc(default) / standalone /
wasi and sha256'd the binaries before vs after:

| program     | gc | standalone | wasi |
| ----------- | -- | ---------- | ---- |
| singleAwait | identical | identical | CHANGED (general machine) |
| multiAwait  | identical | identical | CHANGED (new drive) |
| pendingMulti| identical | identical | CHANGED (new drive) |
| plain       | identical | identical | identical |

gc/host + standalone are **byte-identical** — the drive branch is gated on
`isStandalonePromiseActive` (wasi-only), so neither lane reaches the changed
code. Only wasi (the native-`$Promise` carrier lane) changes, which is the
intended unlock. The slice-1d `isStandalonePromiseActive` widen stays LAST,
after Gaps 3/5, gated on a NET-POSITIVE full `merge_group` standalone corpus.

**Verification.** `tests/issue-2906-async-multiawait.test.ts` (6 host-free wasi
tests: 2/3 sequential fast-path awaits, spilled-binding-across-suspend, bare-await
sequences, `return await` as final segment, and the critical two-genuinely-pending
chain resolving to 4142 via `__drain_microtasks`). All 10 pre-existing
`issue-2895-async-frame` / drain-hook tests still pass (single-await parity). The
2 `issue-2865` + 2 `promise-combinators` failures are **pre-existing on
upstream/main** (verified in a base worktree), not #2906 regressions.

**Unblocks.** Gap 3 (try/finally-across-await) and Gap 5 (for-await-of /
async-gen) now extend this ONE N-state machine instead of re-deriving the
generalization; multi-await-in-linear-code works host-free today. The count-move
carrier widen (slice 1d) remains gated on all resume-machine slices + a
net-positive standalone corpus.

## Slice 2 — Gap 3: try/finally-across-await (LANDED, host-free wasi lane)

**What shipped.** `try { …awaits… } finally { F }` spanning an await is now
driven on the N-state machine (previously `planLinearAwaits` rejected it via the
`hasTryAcrossAwait` gate → AG0). The finally runs on **all four completion
paths**, reusing the generator's `activeFinalizers` model (not a re-derivation):

- **`async-cps.ts`** — `planLinearAwaits` is now **recursive + try-region-aware**
  (`lowerLinearStatements`): it recurses one level into a `try` body carrying the
  finally as the active finalizer, weaving the finally into the post-try lead for
  the **normal path** and tagging every statement with a per-statement
  `leadInTry`/`tailInTry` flag (covers the outer→in-try entry AND the
  in-try→finally exit boundaries within one lead — a `throw` between the last
  in-try await and the finally still runs it).
- **`async-frame.ts`** — a resume-local `inSrcTry` flag records whether control is
  inside the try region (toggled per statement by the `leadInTry` flags; armed in
  the rejected-predecessor `MODE_THROW` prelude). The resume function's outer
  `catch` runs the finally (compiled a SECOND time, fresh Instr[]) before
  rejecting **iff `inSrcTry`** — so a synchronous throw or a rejected await that
  crossed the try runs the finally, while a throw outside it (or in the finally
  itself) does not. Normal completion runs the inline copy woven into the lead.

**Four paths, all verified** (`tests/issue-2906-gap3-tryfinally.test.ts`, 6
host-free wasi tests): normal completion, synchronous throw after the await,
synchronous throw before ever awaiting, pending-then-rejected (finally runs on the
`MODE_THROW` resume via `__drain_microtasks`), pending-then-fulfilled, and
post-try statements ordering (finally before them).

**Bounded slice (everything else falls back — correct-or-legacy).** Single,
non-nested `try/finally`, one per fn, await-free finally, **no `catch`**, **no
`return` in the try body**. `planLinearAwaits` returns `null` for anything richer
(try/catch, nested/second try, await-in-finally, return-through-finally), so those
stay on the legacy/AG0 path — no wrong finally semantics, ever. try/catch and
return-through-finally are the immediate follow-ups (they reuse this same
`inSrcTry` + abrupt-completion machinery).

**Byte-inertness proof.** gc/host + standalone are **byte-identical to `main`**
for every program (single/multi-await/plain via slice 1; `try/finally` verified
directly against a `main` worktree: gc `3e42…`/standalone `116a…` unchanged).
Non-try async **wasi** output is byte-identical to slice 1 — Gap 3 adds **zero
churn** to non-try async; only a `try/finally`-across-await program's wasi bytes
change (the intended unlock). All Gap-3 machine instrs are guarded on
`hasFinalizer`, so the non-try path emits the slice-1 machine unchanged.

**Stacked on slice 1 (#2413)** — branch `issue-2906-gap3-tryfinally` from the
slice-1 branch; enqueue after #2413 lands. Gap 5 (for-await / async-gen) builds on
this same abrupt-completion machinery; the slice-1d widen stays LAST.


## Reconciliation note (shepherd, 2026-07-01)

Landed slices: **slice 1** general N-state async resume machine (PR #2413), **slice 2 / Gap 3** try/finally-across-await on the N-state machine (PR #2416). Issue stays `in-progress` for the remaining slices.
