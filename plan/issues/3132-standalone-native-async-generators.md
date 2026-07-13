---
id: 3132
title: "Standalone native ASYNC GENERATORS — retire env::__create_async_generator leaky-passes (~2,800 files)"
status: in-progress
sprint: current
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: async-generators, yield-star, iterator-protocol
goal: standalone-mode
horizon: xl
umbrella: 2860
related: [3075, 2906, 2865, 2938, 2936, 2980, 2895, 2922, 1042, 3120]
created: 2026-07-10
updated: 2026-07-10
assignee: ttraenkler/opus-asyncgen
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/async-cps.ts
  - src/codegen/expressions.ts
  - src/codegen/async-frame.ts
  - src/codegen/expressions/calls.ts
origin: "FABLE task 30 — env::__create_async_generator touches ~2,800 leaky-passes (largest unowned chunk of the standalone-vs-host gap)."
---

# #3132 — standalone native async generators

## Slice — async-gen binding-PATTERN params (PR #3011, opus-asyncgen2)

Substrate PR (decoupled). `isAsyncGenDriveCandidate` hard-rejected any
binding-pattern param (`async function* f([x]){…}`) → the whole module hit the
#680 native-gen refusal in standalone. Fix threads the #2967
`collectDerivedPatternParams` → `derivedSpillInit` machinery (already used by
the async-FUNCTION path) into `emitAsyncGenerator`, capturing pattern-param
locals as live frame spill fields; the resume fn restores them by name.
Consumer half: `tryEmitAsyncGenNextDispatch` drops the host `__gen_next`
miss-arm on standalone (not just wasi) when no legacy buffer async gen was
emitted — the dispatch is type-gated to async-gen receivers so the arm is
provably dead in an all-driven module (mirrors #2903's `.then` de-leak).

Measured (compile, all 558 `async-generator/dstr` files, standalone): main 174
hard #680 CE + 348 `__gen_`-leaky, 0 gen-host-free → 0 CE, 522 error-free, 498
gen-host-free. **Floor delta ≈ 0** (converted modules still leak
`env::Promise_resolve/Promise_reject/__get_caught_exception`) — value is
retiring the 174 hard CEs + providing the driven substrate. NET≥0 on the floor.

## Stacked follow-on — the actual floor lever (PR-2, measure-gated)

The host-free floor flip is blocked on `widenAsyncGenFallback`
(async-scheduler.ts): `isStandalonePromiseActive = wasi || (standalone &&
!moduleHasAsyncGen)` disables the native `$Promise` carrier for ANY module with
an async gen (#2980's conservative fallback — native `$Promise` mixing into a
host `__gen_*` buffer caused the 07-09 −4). A driven module has NO legacy
buffer, so the carrier is safe there. PR-2 refines the fallback via a
CONSERVATIVE pre-pass drive-candidate gate: keep the carrier ON only when ALL a
module's async gens are provably drive-lowered. Carrier-on ceiling measured
~294 fully host-free; a further ~204-file `env::__make_callback`
(`.then`-callback) front sits beyond the carrier (a later slice). PR-2 gate is
go/no-go on a FULL merge_group standalone-floor A/B, routed through the tech
lead — never a scoped measurement.

## Problem

Async generators under `--target standalone` mostly bail to the **legacy
eager-buffer HOST runtime** (`env::__create_async_generator` + the `__gen_*`
bundle, via `sourceNeedsGeneratorHostImports`). The affected tests PASS with
host imports supplied (leaky-passes — after #3075's HOSTGEN consumer arm), but
are **not host-free**, so they do not count toward the standalone floor.
~2,800 files carry the leak.

The driven native producer (#2906 3d-i / #2865: `emitAsyncGenerator`, the
`$AsyncFrame` carrier + per-gen `__async_gen_next_<stem>` driver) exists but
its admission gate (`analyzeAsyncGen` in async-cps.ts) accepts only flat
top-level plain yields, and only for function DECLARATIONS + EXPRESSIONS.

## Measured decomposition (2026-07-10, static AST scan of all 3,955 corpus files with async-gen syntax; 4,460 decls)

| construct (by FILE)                                                          | files                 | native today?                                     | slice            |
| ---------------------------------------------------------------------------- | --------------------- | ------------------------------------------------- | ---------------- |
| `method:zero-yield` (class/obj-literal `async *m() {}` — assert-only bodies) | 1,725                 | NO — class-bodies/literals not wired to the drive | **S2**           |
| `zero-yield` / `plain-yields` fn decl/expr                                   | 991 + 37 + 82(method) | fn decl/expr YES (driven); methods NO             | (fn ok) / S2     |
| `method:yield*-non-literal`                                                  | 554                   | NO                                                | S3               |
| **`yield*-array-literal` (statically unrollable)**                           | **392**               | NO — `analyzeAsyncGen` rejects every `yield*`     | **S1 (this PR)** |
| `method:has-return` / `has-return`                                           | 172 + 5               | NO (needs settleReturn)                           | S4               |
| `nested-suspend` (control flow)                                              | 90 + 17               | NO (CFG loop states)                              | S3               |
| `yield*-non-literal` fn                                                      | 37                    | NO                                                | S3               |
| `yield-await`                                                                | 3                     | carrier lane only (#2980/#3120)                   | —                |

Verified leak probes (compile → import set): `(async function*(){ yield* [[1]] })()`
leaks `__gen_create_buffer,__gen_yield_star,__create_async_generator`;
`class C { async *m() {} }` leaks; zero-/plain-yield fn decls & exprs are
already host-free (driven).

## Slice 1 (this PR) — `yield*` array-literal unroll + native frame-carrier consumer

Two halves, mirroring #3075's producer/consumer split:

1. **Producer** (`analyzeAsyncGen`, async-cps.ts): accept a top-level
   `yield* [e1, e2, …]` whose elements are suspend-free and non-spread by
   statically unrolling it into per-element plain-yield segments (an elision
   hole ⇒ `yield;` ⇒ undefined — matching §27.5.3 yield* over an array, which
   only forwards `done:false` values). Everything else (`yield*`of a
non-literal, spread elements, nested suspends) keeps the legacy path —
correct-or-legacy. The single-source-of-truth gate propagates automatically
to`isBoundedAsyncGenBody`/`isAwaitFreeAsyncGenBody`/`isAsyncGenDriveCandidate`/`sourceNeedsGeneratorHostImports`, so the
   host-import leak disappears exactly for the newly-admitted bodies.
2. **Consumer** (`iterator-native.ts` fill): an `ITER_KIND_ASYNCGEN` IterRec
   arm — the follow-up banked in #3075. A DRIVEN async-gen frame carrier
   consumed through an identifier (`var it = g(); for await (const [x] of it)`)
   or any dstr binding falls to the legacy sync `__iterator` lowering (the
   3d-ii CFG consumer rejects patterns), which today hard-cast traps on the
   frame struct. Fill a per-producer type-switch over
   `ctx.asyncGenProducers` (stateTypeIdx → `__async_gen_next_<stem>`):
   `__iterator` wraps the frame in an ASYNCGEN record; `__iterator_next`
   calls the matching next-driver, requires the minted `$Promise` FULFILLED
   (await-free producers settle synchronously; pending ⇒ loud trap, unchanged
   failure mode), and reads done/value from the `$IteratorResult` struct.

## Banked slices

- **S2 — async-gen METHODS** (biggest bucket, 1,725+ files): wire class-bodies
  / object-literal method emit into `emitAsyncGenerator` the way #2865 wired
  fn expressions; needs receiver/`this` threading into the frame
  (`readsCurrentThis`). CAUTION: #2938's relax found the class-STATIC sync-gen
  emit path broken — audit the static path before admitting methods.
  - **S2 audit (2026-07-10, fable-3075)**: class methods branch at
    class-bodies.ts ~2258 (`isGeneratorMethod && nativeGenInfo` → native sync
    factory; else legacy buffer). An async route would sit BEFORE the legacy
    buffer arm: `isAsyncMethod && isAsyncGenDriveCandidate(ctx, member)` →
    `emitAsyncGenerator(ctx, fctx, member)`. Open questions: (a) instance
    methods carry the receiver as fctx param 0 — `buildAsyncFrameInfo`
    captures fctx.params into frame param fields, but the RESUME body's
    `this` resolution against a frame field is unproven; start with the
    bounded no-`this`/no-`super`/no-`arguments`/no-capture subset (covers the
    assert-only zero-yield corpus bodies); (b) stem naming/collision — the
    producer registry keys `sanitizeTypeName(asyncFnName(decl))`, which must
    be the `${className}_${methodName}` funcMap key for methods; (c) the
    duplicate-name / computed-name method hazards from #2938 apply verbatim.
    Object-literal methods (literals.ts ~2854) additionally run through the
    closure trampoline — audit `__argc_default` interplay (#2581) first.
  - **S2a SHIPPED (2026-07-10, follow-up PR)**: the receiver-free CLASS-method
    subset (`!genBodyReferencesThis && !bodyUsesArguments &&
isAsyncGenDriveCandidate`) routes through `emitAsyncGenerator` — covers
    the zero-/plain-yield and (with S1) `yield*`-literal method bodies,
    instance AND static, host-free. Probes: zero-yield/plain/static/yield\*
    methods correct with zero gen imports; `this`-reading bodies stay legacy.
    Scans (class/elements async-gen n=10, expressions/async-generator n=31)
    identical to control. REMAINING for full S2: receiver-threading
    (`this`-reading bodies) + object-literal methods (trampoline audit).
- **S3 — general `yield*` / control-flow yields**: CFG loop states over the
  native `__iterator` protocol (runtime loop, not static unroll).
- **S4 — `return` in async-gen body**: needs a settleReturn terminator.

## S-consumer — async-gen CONSUMER drive (2026-07-13, opus-asyncgen)

Measure-first found the producer already drives host-free (S1/S2a); the residual
leak on the `for await (const … of <async-gen>)` files is the CONSUMER, in two
parts landed as two PRs:

- **PR-1 (foundation, #3001, merged)** — (a) `resolveAsyncGenNextHelperName`
  resolves a var-held / IIFE async-gen FRAME source (identifier → var-initializer
  → producer; `(async function*(){})()` → producer-by-decl), not only a direct
  named call; (b) `calleeIsDriveLowered` recognises the standalone async-gen
  consumer drive lane (carrier-independent, returns a native `$Promise`) so the
  CALL site skips the host `Promise_reject`/`__get_caught_exception` try/catch
  wrap. Identifier-binding var/inline/`yield*`-literal sources → host-free.
- **PR-2 (dstr composition, #3007)** — a DESTRUCTURING head over an async-gen
  source now drives natively, composing #2996/#3228's `compileForOfDestructuring`
  delivery into the async-gen consumer CFG (`forAwaitAsyncNeedsDrive` +
  `planForAwaitAsyncCfg`: drop the identifier-only guards; run `destructureElem`
  via `postDeliverEmit` on the `bodyId` state against the `FORAWAIT_ELEM`
  carrier). Flips the ~195 `async-func-dstr-*-async-*` corpus files. The
  consumer whose source is itself an async GENERATOR (`async-gen-dstr-*`, +195)
  is a harder nested shape, banked for a later slice.

## Graveyard discipline

Measure-first honest yield (sample by CONSTRUCT, not directory — the #2938
542-sample lesson), carrier-gated, byte-inert for modules without the
construct, corpus-verified before PR, escalate rather than churn. The full
standalone lane runs ONLY on merge_group — treat scoped-sample green as
provisional.

## Acceptance (S1)

- `yield*`-array-literal async gens compile host-free (no `__gen_*` imports)
  and pass standalone (producer + consumer, incl. dstr bindings).
- The 392-file construct sample flips leaky-pass → host-free pass; no
  regression in either lane; modules without the construct byte-identical.

## S1 Test Results (2026-07-10, PR)

- Import-leak probes: `(async function*(){ yield* [[1]] })()` compiles with
  **zero** `__gen_*` imports (was 3-import leak); non-literal `yield*` keeps
  the legacy imports (control). Identifier-held driven-gen consumption
  (plain + dstr + obj-pattern + elision hole) returns correct values with
  zero gen imports.
- A third gate closed en route: the eager `__gen_*` bundle registration plus
  the #3075 HOSTGEN arm would have PINNED the whole bundle as referenced in
  an all-driven module — the arm now keys on the new
  `ctx.legacyGenBufferEmitted` flag (set at the four legacy buffer emit
  sites), not on funcMap import presence.
- 56-file `dstr-*-async-*` cluster sample: 33 pass / 8 vacuous / 15
  fail-other — pass count identical to the #3075 state, but the passes are
  now HOST-FREE (floor-visible) instead of leaky.
- Adjacent standalone scans exactly identical to upstream/main control:
  for-of/dstr (n=72), for-of (n=30), generators (n=9),
  Iterator.prototype.toArray (n=18), for-await-of non-dstr (n=5),
  expressions/async-generator (n=13). Host lane on the cluster (n=14)
  identical.
- Suites: issue-3132 (7), issue-3075 (6), issue-2038/3100(s4,s5)/3119 (65),
  issue-2865/2906\*/2980/3120 (52) all pass; the 5 failures in
  2865-unwrap/2906-gap3 are WASI-environment pre-existing (identical on
  control).
