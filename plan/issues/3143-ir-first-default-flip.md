---
id: 3143
title: "Flip IR-first (JS2WASM_IR_FIRST) to default — clears gate G1 of the legacy-frontend retirement"
status: done
sprint: 71
assignee: ttraenkler/sendev-3143flip
created: 2026-07-11
updated: 2026-07-13
completed: 2026-07-13
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
depends_on: [3167, 3168]
related: [2138, 3090, 2855, 2856, 3153, 3156]
origin: "plan/bloat-reduction-battle-plan.md slice 4; gate G1 in plan/log/3090-phase0-legacy-delete-list.md"
loc-budget-allow:
  - src/codegen/index.ts
  - src/ir/integration.ts
---

<!-- loc-budget-allow rationale (#3131): the flip's +21 in the barrel/driver
`src/codegen/index.ts` is the `explicitlyDisabledEnv` escape-hatch helper +
the gate-7/8 docblock and gate lines, which structurally belong to the IR-first
pipeline block in `generateModule`. Gate-7/8's own scan helpers went into the
subsystem module `src/codegen/ir-first-gate.ts`, not the barrel. The +69 in
`src/ir/integration.ts` is the #3143 union-import pre-registration fix
(`preregisterDynamicSupport` + `UNION_IMPORT_FUNC_NAMES` + the
`__extern_is_undefined` batch flush) — it MUST live in `integration.ts`
because that is where the Phase-3 pre-registration seam is (the sibling
`preregisterStringSupport`/`preregisterIteratorSupport` passes), and it fixes
the IR-first-exposed dual-compile import-registration gap in place. -->

# #3143 — Make IR-first compilation the default (gate G1)

## Problem

Today the IR is an **overlay**: legacy compiles every function first, then IR-compiled
bodies replace legacy bodies (`src/codegen/index.ts` overlay block ~:2096). #2138
(done) built the inversion behind `JS2WASM_IR_FIRST=1` — legacy emission is skipped
for claimed functions — but it is **not the default**. Gate **G1** in
`plan/log/3090-phase0-legacy-delete-list.md`: _no live legacy handler can be deleted
until IR-first is the default_, because the overlay keeps every handler reachable.

## Implementation Plan (architect — re-sequenced 2026-07-12 audit)

> **Audit note (2026-07-12, verified @ upstream/main adc65cfc65):** the
> original precondition on #2856 was too strong. Under IR-first, selector
> REJECTS (body-shape-rejected etc.) are **never in the skip set**
> (`computeIrFirstSkipSet` only skips CLAIMED functions) — they keep their
> legacy bodies and demote safely pre-claim. The only hard-error population
> is **post-claim throws** (claimed + skipped, then from-ast/lower throws —
> "never a silent legacy demote", codegen/index.ts:2147–2172). So the true
> flip gate is **zero post-claim demotions on the corpora**, measured by the
> #3153 meter. #2856 (blocked epic, 14 residual body-shape rejects — all
> playground capability programs) is decoupled: it gates legacy _deletion
> breadth_, not the flip itself.

1. **Preconditions (the #3153 census classes, in place of #2856):**
   - #3156 substring/charCodeAt family — **done** (2026-07-12).
   - #3167 string relational operators — lowerable + selector mirror.
   - #3168 unary `+`/`-` ToNumber — lowerable + selector mirror.
   - TypedArray-view element store (census class 4): do NOT lower; add a
     **selector mirror** so bodies containing an element store to a
     TypedArray view reject pre-claim (small predicate in
     `src/ir/select.ts`/`capability.ts` mirroring the from-ast throw
     condition — the #2856-C2 documented residual). This is part of THIS
     issue's flip PR.
   - **Gate check**: `JS2WASM_IR_POSTCLAIM_LOG=<f>` over a full
     `tests/equivalence` run + `STRIDE=300 npx tsx scripts/ir-postclaim-meter.mts .`
     both report **zero** post-claim demotions.
2. **Flip**: default the IR-first path on in `src/codegen/index.ts` (keep
   `JS2WASM_IR_FIRST=0` as an escape hatch for one release); keep the demote-to-legacy
   fallback for _rejected_ functions unchanged.
3. **Measure**: full-corpus A/B on CI sharded test262 (host + standalone lanes) —
   net ≥ 0, no async/generator bucket regression. This changes which emitter produced
   every claimed function's bytes; it is NOT byte-inert — the merge_group standalone
   floor is the hard gate. (Standalone/WASI keep generators compile-twice —
   `computeIrFirstSkipSet` gate 2 — so the #3164/#3132 generator work is
   orthogonal to this flip.)
4. **Bank**: promote the zeroed rejection reasons into `STRICT_IR_REASONS`
   (`src/codegen/index.ts`) per the #2855 ratchet so regressions become hard errors.

**Payoff**: clears gate G1 → unlocks the ~60.0K legacy-only fn-lines in
`plan/log/3090-phase0-legacy-delete-list.md` (Phase 3a deletion).

## Acceptance criteria

- IR-first is the default compile mode; overlay path behind the escape-hatch env only.
- test262 net ≥ 0 on merge_group; ir-fallback baseline unchanged or lower.
- `plan/log/3090-phase0-legacy-delete-list.md` G1 marked cleared (unblocks Phase 3a).

## Implementation notes (2026-07-11, fable-shrink)

- Gate line (`src/codegen/index.ts` ~:2100): `!explicitlyDisabledEnv(JS2WASM_IR_FIRST)`
  — default ON under `experimentalIR`; only explicit `0`/`false` disables
  (one-release escape hatch). `disableIrFirst` (#2973 eval/new-Function
  sub-compiles) unchanged.
- **New gate 7** (`irFirstBodyHasNullish`, `src/codegen/ir-first-gate.ts`):
  functions containing `??`/`??=` stay compile-twice. `lowerNullish` covers
  only reference-shaped operand pairs; without the gate the flip promoted the
  documented metered `??` residual demote (#2135) to a skipped-slot hard
  compile error (caught by `tests/issue-2135.test.ts` pre-PR). Retire the
  gate when `lowerNullish` covers all operand shapes.
- Off-arm test/sweep stubs switched from unset/`""` to explicit `"0"`
  (issue-2138/2951/2945/2972, `scripts/ir-first-sweep.mts`).
- Coordinated with fable-irflip: buckets = body-shape-rejected 15 (never
  claimed → out of the A/B population), post-claim demotions 0; no file
  conflict (they work in `src/ir/*`).
- STRICT_IR_REASONS banking (plan step 4) deliberately deferred to a
  follow-up PR so the flip's A/B stays clean.
- The `test262-sharded.yml` `ir_first` dispatch input is now vestigial
  (its `'1'` equals the default); repurpose to `'0'` later if a legacy-lane
  measurement is ever needed.

## CI A/B divergence (banked 2026-07-11, fable-shrink) — WHY THIS IS BLOCKED

The naive flip (default-on gate + gate-7 `??`) produced a **large systemic
equivalence divergence** in CI (PR #2891): 50+ `equivalence-gate` regressions
across ~14 unrelated feature files + `cross-backend-parity` failures. **Set
back to `blocked`; PR #2891 left as DRAFT** (banked branch, not landed).

### Root cause (single, structural)

`computeIrFirstSkipSet` skips functions in `plan.safeSelection.funcs`, which
comes from the **static selector** (`planIrCompilation`). The selector does
**NOT trial-lower** — the real `from-ast` lowering runs later
(post-`compileDeclarations`). So the selector **claims functions the IR
builder cannot actually lower**. Under the overlay a builder `throw` is
caught and the **pre-emitted legacy body** is used (a metered demote). Under
IR-first the legacy body was **skipped** (placeholder `unreachable`), so the
same `throw` becomes a **hard `[IR-FIRST skipped-slot, #2138]` compile
error**.

Concrete (from `cross-backend-parity`):
`ir/from-ast: method call .charCodeAt(...) on string not in slice 4 [IR-FIRST skipped-slot]`
(also `.indexOf`, `.flat`, …).

### Divergence surface (all builder-throw sites the selector doesn't mirror)

string-methods (charAt/charCodeAt/indexOf/lastIndexOf/padStart/padEnd/repeat/
replace/replaceAll/split/substring/slice/trim/trimStart/trimEnd), string
relational `<`/`>`/`<=`/`>=`, unary `+` coercion, `Symbol.toPrimitive`,
template-literal number coercion, ternary-with-string-result,
toString/valueOf, try-catch-finally shapes, non-numeric sort. **Gate 7
(`??`) was one instance of this whole class.**

### Why per-shape gate patching is the wrong fix

Denylisting each unlowerable shape (the gate-4/5/6/7 pattern) does not scale:
the surface is broad, lives as `throw` sites in `from-ast.ts`, and any missed
case ships a **divergent** flip.

### Two proper fixes (next window)

- **(A) Selector precision** — mirror every `from-ast` throw condition into
  `capability.ts` / `select.ts` so `safeSelection` == true buildability. This
  is the **#2855 / #2949** track (align claim with builder). Preferred:
  it also shrinks the fallback buckets.
- **(B) Pipeline reorder** — trial-lower via `from-ast` FIRST, skip legacy
  only for functions that lowered clean (compile-once for proven successes).
  Cleanest correctness guarantee, but a real ordering change to
  `generateModule`.

### Same-day middle path (evaluated, deferred)

Replace the skip **denylist** with a conservative **allowlist** gate — skip
only functions whose body is provably in a small lowerable set (numeric
arithmetic/compare, control flow, local calls, returns; **no** method calls /
string ops / coercion). Safe-by-construction _iff_ the allowlist is a strict
subset of buildable; lands a reduced (pure-function-only) flip that still
clears G1 for that population. Risk: a single mis-classified construct
re-introduces divergence, and it can't be fully validated without a CI A/B
round-trip. Not taken under the closing-window constraint.

### Resume instructions

1. Branch `issue-3143-ir-first-default-flip` (banked, DRAFT PR #2891) has the
   default-on gate + gate-7 + loc-budget allowance + doc/test updates —
   re-usable once the skip set is buildability-accurate.
2. Land fix (A) or (B) first (own issue/slice), THEN re-open #2891, re-merge
   `origin/main`, run the full CI A/B. Merge only when `equivalence-gate` and
   `cross-backend-parity` are green.
3. On landing: flip `status: done`, mark G1 cleared in
   `plan/log/3090-phase0-legacy-delete-list.md` (already staged there — revert
   that edit if the flip is materially reworked).

## Resume + resolution (2026-07-12, sendev-3143flip) — UNBLOCKED

The banked "broad divergence surface" (string methods, relational, unary `+`,
`Symbol.toPrimitive`, template coercion, ternary-string, toString/valueOf,
try-catch, sort) is **no longer the blocker**: intervening main advances
applied fix (A) incrementally — #3156 (substring/charCodeAt family lowering),
#3167 (string relational lowering), plus selector-precision that now REJECTS
the remaining shapes pre-claim (rejected ⇒ never in `safeSelection` ⇒ never
skipped ⇒ graceful legacy, never a skipped-slot hard error).

### The meter was a FALSE GREEN (root cause the prior attempts kept hitting)

The #3153 meter reads `CompileResult.irPostClaimErrors`, but a skipped-slot
**hard error** lands in `CompileResult.errors` (severity `error`, message
`[IR-FIRST skipped-slot, #2138]`) — NOT in `irPostClaimErrors`. Proven: the
class-4 file pre-fix returned `errors=2, irPostClaimErrors=0`. So "meter
STRIDE=300 = zero" did NOT prove flip-readiness; it was blind to the exact
failure population. **The authoritative flip-readiness gate is a `result.errors`
scan for `[IR-FIRST skipped-slot`** across the corpus (see `.tmp/skipslot-fast.mts`;
consider folding this into the #3153 meter as a follow-up).

### Residual firing-class inventory (current main + this branch)

`result.errors` skipped-slot scan over FULL examples/playground (103 files, the
dense divergence source per #3153) + test262 STRIDE=120 (~360): after the fixes
below, **zero** skipped-slot hard errors. The only classes that fired:

1. **TypedArray-view element store** (`view[i] = v`) — native-messaging
   `putAscii`/`putUint`. → **gate 8** (`irFirstBodyStoresTypedArrayView`).
2. **TypedArray-view construction** (`new <TypedArrayCtor>(n)`, from-ast
   "unknown class") — folded into **gate 8** (store OR construct; view element
   READS still lower, not gated). Defense-in-depth: didn't fire in the sampled
   corpus but is a real selector-claimable from-ast throw.
3. **`__box_number` / `__extern_is_undefined` unknown funcref** — fibMemo
   (Map + number boxing). from-ast emits these as named funcref calls relying
   on legacy's `addUnionImports`/`ensureLateImport` **side effect** (documented
   dual-compile assumption, from-ast.ts:3345); IR-first skips legacy → import
   unregistered → `ir/integration` throws. → **general fix**: extend
   `preregisterDynamicSupport` (`src/ir/integration.ts`) to register the
   `addUnionImports` family + `__extern_is_undefined` when the built IR
   references them by name, then `flushLateImportShifts` so the funcIdx shift +
   defined-body fix-up applies BEFORE Phase-3 baking (a pending batch desynced a
   sibling IR function's funcIdx — "out of local range"). Idempotent,
   pre-emission, kills the class not the instance.

NOT flip regressions: 4 test262 dstr class-method files THROW "Cannot read
properties of undefined (reading 'flags')" — a pre-existing TypeScript-checker
crash (`getMembersOfSymbol`), reproduces with `JS2WASM_IR_FIRST=0`. Out of scope.

### Validation

- `tests/issue-3143.test.ts` (21 tests): gate-8 predicate (store + construct
  branches), e2e no-hard-error + correct-bytes + `JS2WASM_IR_FIRST=0` parity,
  and the fibMemo `__box_number`/`__extern_is_undefined` regression + VALID
  binary guard. tsc clean; `check:ir-fallbacks` OK (body-shape-rejected
  unchanged at 14, no post-claim increase); 2138/2951/2972 (40 tests) green.
- Broad-impact ⇒ the full-CI/merge_group (equivalence + test262 + standalone
  floor + cross-backend-parity shards) is the ultimate gate — the same gates
  that caught the banked regression. Merged-report delta MUST be
  net-non-negative, zero conformance regression.

## CI result (2026-07-12, sendev-3143flip) — DENYLIST GATING IS NOT VIABLE

First full CI run of the gated flip:

- **cross-backend-parity GREEN, all 8 equivalence-SHARDS GREEN, quality GREEN,
  cheap-gate GREEN** — the banked "50+ equivalence regressions" HEADLINE
  divergence is genuinely resolved (by #3156/#3167 + selector rejects + the
  class-4/box_number fixes here). Gates 9/10 (param mutation, unlowered array
  method) cleared cross-backend-parity's 3 adversarial cases.
- **equivalence-GATE FAILS: 138 NEW regressions.** The shards are non-failing
  (record partials like test262); the _gate_ compares partials to baseline. The
  138 are skipped-slot hard errors in the `tests/equivalence/*.test.ts` INLINE
  programs — the authoritative #3153 dense corpus, which the dir-walking
  `.tmp/skipslot-fast.mts` scanner NEVER scanned (it walks
  examples/playground/test262 dirs; the equivalence sources are template
  literals inside the test files). Extracted + scanned them
  (`.tmp/equiv-scan.mts`): **~67 raw / ~22 real distinct from-ast throw classes,
  125+ skipped-slot hard errors**, covering CORE operations:
  - "Phase 1 requires matching operand types" (type-mismatched arith/compare)
  - most String methods unlowered: split/replace/replaceAll/padStart/padEnd/
    repeat/trimStart/trimEnd/lastIndexOf; number .toString/.valueOf
  - class member resolution ("class C has no method/field/static X")
  - call & constructor ARITY (default/optional params)
  - property assignment on ref (obj.prop=, arr.length=), .call/.apply on
    closures, `new Date` (unknown class), template/unary/bool coercion,
    array-literal widening, + a hard CRASH (tostring-valueof: "Cannot read
    properties of undefined").

**Conclusion:** the divergence surface is broad and systemic (the banked
diagnosis was right). Per-shape DENYLIST gating cannot close 22+ core-operation
classes (impractical, and self-defeating — gated kinds block their own handler
deletion; any missed shape = a regression). The gate/fix work banked here
(class-4, union-import pre-registration, gates 9/10) is correct and valuable but
is NOT sufficient for the flip.

**Recommended pivot — ALLOWLIST skip.** Change `computeIrFirstSkipSet` from a
denylist (skip claimed − gated) to an ALLOWLIST (skip ONLY functions whose
entire body is a proven-lowerable subset: matching-type numeric arith, control
flow, correct-arity local calls, returns; NO method calls / class / closures /
coercion / mismatched types). Safe-by-construction (a missed allowlist entry
keeps a function compile-twice = safe; vs a missed denylist entry = hard error).
Clears G1 (IR-first IS the default mode) with a conservative compile-once
subset; the −60k deletion then unlocks INCREMENTALLY as the allowlist widens via
real lowering (#2855/#2856) — matching CLAUDE.md's gated G1–G4 deletion model.
The banked "same-day middle path", now validatable locally against
equivalence-gate.

## ALLOWLIST implemented + validated (2026-07-12, sendev-3143flip) — approved (A)

`computeIrFirstSkipSet` now skips legacy ONLY for functions that pass
`irFirstBodyIsProvenLowerable` (a positive AST walk) AND whose signature is
f64-params + (f64|void)-return (via `overrideMap`, no default/optional/rest/
destructuring params). The proven-lowerable subset is number-only with a
strict NUMBER vs BOOLEAN context split (comparisons only in if/while/do/for/`?:`
conditions and `&&`/`||`/`!` operands; no boolean literals/values; local `let`
mutation OK, param mutation not; exact-arity calls to other claimed funcs). The
denylist gate predicates (`irFirstBody*`) remain exported + unit-tested but are
no longer wired into the skip decision (the allowlist subsumes them).

Two allowlist-precision iterations: v1 conflated numeric/boolean and leaked
`0 === false` ("matching operand types") + `&&`-of-numbers ("requires bool
operands") at the math tests; v2's context split + f64-only signature fixed both.

Validation:

- `.tmp/equiv-scan.mts` over the FULL equivalence inline corpus (209 files, 1267
  sources): compiled 1267, threw 0, **skipped-slot-hard 0**.
- Full `tests/equivalence` vitest suite: **ZERO `[IR-FIRST skipped-slot]`
  failures**. Remaining equiv failures are PRE-EXISTING and flip-independent:
  TS type-error negative tests, and one legacy nested-function-in-loop
  closure-capture value bug (`arguments-nested-and-loops` "for-loop with
  function declaration in body", 30 vs 33) — reproduces with
  `experimentalIR:false` (pure legacy, `irCompiledFuncs=[]`), i.e. fails on main
  too; the diff touches none of the legacy closure path. Baseline drift, not a
  #3143 regression.
- tsc clean; `check:ir-fallbacks` OK; loc-budget OK (index.ts net-shrank —
  denylist gates removed); biome clean.

Tradeoff (as approved): the initial compile-once subset is pure-numeric
functions only, so the immediate legacy deletion is small; it WIDENS as the IR
lowers more kinds (#2855/#2856). The flip clears G1 (IR-first is the default
MODE) safely, which is the load-bearing outcome.

**Meter caveat (durable):** the #3153 meter reads `irPostClaimErrors`, but
skipped-slot HARD errors land in `CompileResult.errors` — the meter is a FALSE
GREEN for flip-readiness. The authoritative gate is a `result.errors` scan for
`[IR-FIRST skipped-slot` over the EQUIVALENCE inline corpus (not a dir walk).
Fold both into the #3153 meter as a follow-up.

**Meter caveat (durable):** the #3153 meter reads `irPostClaimErrors`, but
skipped-slot HARD errors land in `CompileResult.errors` — the meter is a FALSE
GREEN for flip-readiness. The authoritative gate is a `result.errors` scan for
`[IR-FIRST skipped-slot` over the EQUIVALENCE inline corpus (not a dir walk).
Fold both into the #3153 meter as a follow-up.

## CI GREEN (2026-07-12, sendev-3143flip) — PR #2891 @ 3b7d4a25f3

All PR-level required checks PASS: **equivalence-gate** (138 regressions → 1 →
0; the gradual-typing regression fixed by the signature-parity fixpoint),
**quality** (dead-export green after deleting the 7 unwired predicates),
**cross-backend-parity**, **equivalence-shards 1–8**, cheap-gate / smoke /
linear-tests / check-for-test262-regressions / changes. test262 host+standalone
shards + merge-shard-reports + standalone-floor `skipping` on the PR — they run
on **merge_group** only (post-enqueue).

Behavior-preserving proof: the 8-file ON-vs-OFF A/B was IDENTICAL (22==22
failures, all pre-existing — fail with `experimentalIR:false` too). The
allowlist skips only functions whose IR body ships identically to the overlay,
so the flip changes compile-time work, not output → the test262 merged-report
delta should be net-zero by construction.

**Follow-ups (post-merge):**

1. Widen the allowlist beyond f64-numeric (proven strings/vecs/JS-host
   generators → restore #2951/#2972 compile-once) via the #2855/#2856
   capability track; each widening unlocks more Phase-3a legacy deletion.
2. The −60k deletion is INCREMENTAL, not one flip: a legacy handler is
   deletable only once NO compile-twice function uses it (requires the allowlist
   to own that node kind). Scope deletion slices as the allowlist widens.
3. Fold the `result.errors` skipped-slot scan over the equivalence inline corpus
   into the #3153 meter (retire the false-green `irPostClaimErrors` channel).
