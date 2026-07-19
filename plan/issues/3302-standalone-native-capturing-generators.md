---
id: 3302
title: "standalone: native lowering for CAPTURING generators — thread enclosing-scope ref cells into the generator state struct (retire the eager-buffer host fallback for #3178 S3) [SENIOR-DEV/opus — design-heavy]"
status: done
completed: 2026-07-16
assignee: ttraenkler/sendev-3302
created: 2026-07-16
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, standalone
es_edition: multi
language_feature: generators
goal: standalone-mode
umbrella: 3178
sprint: 72
horizon: m
related: [3178, 3164, 3032, 2864, 2566, 2662]
# (#3302) Intended growth at the canonical subsystem sites: capturing fn-expr
# generator threading — generators-native.ts (+64: standalone-lane shape-gate
# arm + resume-fn selfCaptureRehydration prologue), closures.ts (+28: the
# rehydration-recipe attachment at the #3164 registration site),
# context/types.ts (+26: NativeGeneratorInfo.selfCaptureRehydration docs),
# iterator-native.ts (+8: the latent #3164 sgDeps-only fill-hole fix +
# comment). No barrel/driver growth.
loc-budget-allow:
  - src/codegen/generators-native.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/iterator-native.ts
origin: "PO groom of #3178 umbrella, 2026-07-16 — slice S3 (capturing generators), the one unspun slice in #3178's map. S1 (#3164) is DONE so the isNativeGeneratorCandidate fn-expr registration seam this extends now exists. Umbrella marks S3 'opus-owned design (needs opus review before staffing)'; the umbrella's S3 design notes are the spec, carried into this file."
---

# #3302 — standalone native capturing generators (#3178 slice S3)

## Problem (from #3178, grounded)

`generatorCapturesOuterScope` (`src/codegen/generators-native.ts:1797` today —
the umbrella cites `:2001`, pre the #3271 generators-native god-file split;
re-locate by symbol name, the line moved) **bails any generator nested in a
function that reads an enclosing binding** to the eager-buffer HOST path
(`env::__create_generator` / `__gen_*`). Because the test262 module wrapper puts
each test inside `export function test(){ … }`, **every wrapped test with a
named generator that touches a test-scope variable is forced onto the host
path** — dragging the whole generator host-import bundle (and, transitively,
`__get_caught_exception`, per #3178) into the standalone binary, so the test
validates-but-can't-instantiate host-free.

This is also #3032's root observation: the eager body runs at **creation**,
violating §27.5.3.1 EvaluateBody (a generator must suspend before any body
statement runs). But S3 is the **leak fix**, distinct from #3032's **semantics
fix**:

- **#3032** (`ready`, unassigned — the umbrella's "in-progress fable-tag5" label
  is stale) makes the eager path LAZY while _keeping_ the host path.
- **This issue (S3)** makes captures NATIVE so the host path is not emitted at
  all. They are complementary, not substitutes. Whoever lands second re-measures;
  if S3 lands first, #3032's remaining scope shrinks to the shapes S1 (#3164) +
  S3 still exclude.

Leaky-pass accounting per #3178: S3 is a **small leaky slice (≤ ~60 leaky
passes)** but carries a **large FAIL/CE value** (the wrapped-generator corpus)
and unblocks #3032's semantics work — the umbrella ranks it by unblock value,
not raw leaky count.

## Why it's tractable now (substrate already exists — compose, don't fork)

Per #3178's substrate inventory (verified on main), the native sync-generator
N-state resume machine is live and is the machine to extend — do NOT build a
second one:

- **Native generator plan + state struct** — `buildNativeGeneratorPlan`
  (`generators-native.ts:384`), lowered onto the N-state resume machine.
- **Admission gate** — `isNativeGeneratorCandidate`
  (`generators-native.ts:1636`); its #3164 fn-expr sub-gate
  `isNativeGeneratorExpressionShape` (`generators-native.ts:1454`) is the
  registration pattern S3 extends.
- **Host-import registration mirror** — `sourceNeedsGeneratorHostImports`
  (`generators-native.ts:1862`). This MUST stay in lockstep with
  `isNativeGeneratorCandidate` (single-source-of-truth discipline — see
  Acceptance).
- **Native factory** — `registerNativeGenerator` (`generators-native.ts:1962`)
  and the #3164 fn-expr variant.
- **Mutable-capture representation already exists** — ref cells
  (`struct (field $value (mut T))`) threaded by `src/codegen/closures.ts`;
  `compileArrowAsClosure` (`closures.ts:1675`) already receives captured cells
  as extra factory args. S3 reuses this exact machinery.

(All line numbers are current-as-of-2026-07-16. Where they diverge from #3178's
citations, the umbrella's numbers pre-date the #3271/#3270/#3278 god-file
break-ups — always re-locate by symbol name.)

## Design direction (from #3178 S3 notes — the spec)

1. **Extend the native generator state struct with N extra immutable fields**
   holding the captured **ref cells** (captured-_by-reference_, so writes inside
   the generator body stay visible outside — the eager host path snapshotted
   _by value_, which is itself subtly WRONG for post-creation mutation; native
   cells fix that too). The factory (`registerNativeGenerator` / the #3164
   fn-expr variant) receives the cells as extra args exactly like
   `compileArrowAsClosure` captures do.
2. **Relax the gate in lockstep.** Move `generatorCapturesOuterScope` from
   "bail" to "collect capture list" in BOTH `isNativeGeneratorCandidate` and
   `sourceNeedsGeneratorHostImports` **in the same commit** (the lockstep rule —
   a gate/mirror skew silently re-registers a host import for a body that no
   longer emits it, or vice-versa: invalid module or leak).
3. **Read-only uses of module globals already work** (they are not captures) —
   don't re-route them. The risk surface is captured-binding read/write ordering
   across suspends; the ref-cell indirection makes each access go through the
   cell, so suspends are transparent.

### Scope boundary (keep the slice bounded — horizon M)

- Capture kinds in scope: enclosing `let`/`const`/`var`/parameter bindings read
  and/or written by the generator body (the ref-cell form the closure path
  already mints).
- OUT of scope (do not widen here): async generators (#3132 / #2865 lane),
  `this`/`super`/`arguments` captures if they need a distinct carrier, and the
  lazy-first-resume semantics fix (#3032). If a capture kind needs new carrier
  machinery beyond the existing ref cell, split a follow-on rather than growing
  this PR.

## Acceptance criteria

- A named/anonymous **sync** generator nested inside a function that reads or
  writes an enclosing binding compiles under `--target standalone` with **ZERO**
  `env::__create_generator` / `__gen_*` / `__get_caught_exception` family
  imports, and `WebAssembly.instantiate(binary, {})` succeeds.
- Write-through visibility holds: a binding mutated inside the generator body is
  observable outside after resumption (ref-cell by-reference semantics, not the
  host path's by-value snapshot).
- **Lockstep gate proof**: `isNativeGeneratorCandidate` and
  `sourceNeedsGeneratorHostImports` are changed in the SAME commit; add/adjust a
  targeted check that the admission gate and the host-import mirror agree for
  the capturing-generator shape (no shape admitted by one and refused by the
  other).
- Construct-sampled corpus flip (leaky-pass → host-free pass), never
  directory-sampled (the #2938 lesson). Sample tests (wrapped-generator shapes
  that touch test-scope vars) MUST move from leaky/CE to host-free pass.
- `prove-emit-identity`: gc/host lane byte-identical, wasi lane unchanged
  (`ctx.standalone`-gated → NET ≥ 0 by construction). Modules without a
  capturing generator: byte-identical (carrier-gate discipline).
- Full standalone lane runs ONLY in `merge_group` (standalone-highwater floor
  #2097) — scoped-green is provisional; the floor is the decider.
- Zero host-mode regression; coordinate with #3032 (semantics) and #3132
  (async-gen) — re-measure their residual after landing.

## Notes for staffing

- **SENIOR-DEV / opus-tier.** #3178 marks S3 "opus-owned design (needs opus
  review before staffing)"; the design notes above are that spec, but the
  ref-cell-into-state-struct extension + the lockstep gate relaxation are
  core-codegen changes on the shared generator machine. Do not dispatch to a
  general dev without the opus design review this file carries.
- Predecessor: S1 (#3164, done) — its fn-expr native registration
  (`isNativeGeneratorExpressionShape`) is the seam this extends. Branch from
  `origin/main` (S1 already landed).

## Re-grounding + implementation (sendev-3302, 2026-07-16, post-#3032-W3 main)

The umbrella's "whoever lands second re-measures" applied: #3032 W3 (merged
2026-07-16, PR #3115) landed FIRST and already delivered the DECLARATION half
of this slice. Measured on post-W3 main before this change:

- **Named capturing generator DECLARATIONS** (incl. TDZ-flagged `let`/`const`
  captures): already NATIVE in standalone via W3's TDZ-native-threading —
  ZERO `env::` imports, `WebAssembly.instantiate(binary, {})` OK, lazy. The
  `sourceNeedsGeneratorHostImports` decl-branch over-registration is corrected
  by unused-import pruning, so no mirror change was needed there.
- **Capturing generator FUNCTION EXPRESSIONS** (the dominant dstr-fixture IIFE
  `var iter = function*(){ iterations += 1; }();`): still EAGER + leaking the
  full family (`__gen_create_buffer`, `__gen_push_f64`, `__create_generator`,
  `__gen_next`, `__get_caught_exception`) — validate-but-can't-instantiate.
  **This was the residual scope.**

### What changed

1. **`generators-native.ts` — `isNativeGeneratorExpressionShape`**: the
   `generatorCapturesOuterScope` bail is now HOST-lane-only
   (`!noJsHostTarget(ctx) && ...`). Standalone/wasi admits capturing fn-exprs.
   Lockstep is BY CONSTRUCTION: the emit site (closures.ts #3164 gate), the
   host-import mirror (`sourceNeedsGeneratorHostImports` fn-expr branch), and
   `registerNativeGenerator` all consult the same
   `isNativeGeneratorCandidate` predicate — no second gate to skew. (Under a
   JS host a fn-expr never reaches the shape gate — the host-lane candidate
   block admits only FunctionDeclarations — so host is byte-identical.)
2. **Capture threading — `NativeGeneratorInfo.selfCaptureRehydration`**: the
   fn-expr's captures live as `__self` closure-struct FIELDS (values at 1..N,
   TDZ flag boxes at N+1..N+K — the closures.ts prologue invariant), NOT as
   extra wasm params (the closure ABI is fixed). The closures.ts registration
   site attaches the rehydration recipe (struct/cast typeIdx +
   `selfCaptureLayout.entries` + `boxedCaptures`/TDZ-flag snapshots);
   `ensureNativeGeneratorResumeFunction` re-runs the capture prologue from the
   rehydrated `__self` local and re-applies the `boxedCaptures` /
   `boxedTdzFlags` + `tdzFlagLocals` registrations. This is the EXACT
   mechanism the async drive lane already uses (async-frame.ts #2865
   re-materialization) — composed, not forked. Mutable captures re-fetch the
   shared cell (identity-stable ⇒ write-through to the enclosing frame, and
   `a === a` across two instances of the same generator); immutable ones
   re-read the immutable field (stable across suspends).
3. **`iterator-native.ts` — latent #3164 fill bug (root-caused via
   setter-trap + emit-time instrumentation)**: `buildIteratorNextBody`'s
   vec-only early return was missing `!sgDeps` — a module whose ONLY
   step-driven carrier is a native sync generator (exactly the minimal
   capturing-fn-expr module this slice enables) got a GENSTATE-wrapping
   `__iterator` but a vec-only `__iterator_next` → `ref.as_non_null(null)`
   trap on the first for-of resume. Every prior driven-native-generator
   module happened to also carry `deps`/`objDeps`, which is why it never
   fired. One-line guard fix.

### Validation (local)

- Import-leak probes: IIFE fixture / for-of drain / named / TDZ shapes all
  ZERO gen-family imports + `instantiate({})` OK in standalone.
- Behavior battery 13/13 relevant (lazy creation 201→1, drain+write-through
  233, first-resume 11, named 32, TDZ 42, `next(7)`→107 two-way, shared-cell 212) — host lane byte-identical controls green; the ONE host-lane
  divergence (`next(v)` sent-value drop under the eager buffer) reproduces
  identically on clean main (#3032 W6 scope, pre-existing).
- `tests/issue-3302.test.ts` — 10/10 (incl. the host-free instantiate
  assertions and the sgDeps-only fill-hole regression case).
- Suites: issue-3032-w3 / 3050 / 2203 / generator-iife / 1665 / 2079 /
  2169×2 / 2157 / generators — 85/85.
- Scoped test262 A/B (generator dirs + construct-sampled dstr-fixture files,
  branch vs current main, both lanes): see PR body for final counts.
