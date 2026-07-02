---
id: 2938
title: "Standalone: native SYNC-generator resume substrate — widen native generator lowering to eliminate __create_generator / __gen_* host imports"
status: in-progress
assignee: ttraenkler/sr-funcidx
created: 2026-07-01
priority: high
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: xl
related: [2936, 2906, 2413, 2864, 2171, 2170, 2571, 2581, 2203]
umbrella: 2860
---

> Formerly #2920 (id ceded to PR #2424), then #2933 (id ceded to PR #2442's
> `2933-standalone-namespace-static-value-read.md` — that PR was CLEAN and ahead
> in the merge race, so this pre-emptively re-id'd to #2938 to avoid a
> merge_group dup-id-gate failure + auto-park churn). The funcIdx-shift
> prerequisite is #2936 (PR #2444, merged).

## ✅ RELAX LANDED (2026-07-02, branch issue-2933-noyield-relax, stacked on #2936)

The two no-yield bails are relaxed (lockstep: `buildNativeGeneratorPlan`
suspendCount + `isNativeGeneratorCandidate` terminal yield-require), unblocked
by #2936's late-import shift-regime fix (see
`plan/issues/2936-resume-lazy-emit-funcidx-shift.md` for the corrected root
cause — the shift never fired during the resume emit; it was a raw-import +
deferred-batch regime mix in `ensureLateImport`). Two new corpus-found bails
added, both gate-consistent (in `isNativeGeneratorCandidate` /
`buildNativeGeneratorPlan`, the single source of truth):

- **Whole-param default on a binding pattern** (`*method({} = undefined)`) —
  the resume prelude has no defaulted-raw-arg arm; mis-typed the state struct
  (`struct.new[k] expected i32, found externref`).
- **Duplicate-name / computed-name generator METHODS** (`*id(){}` +
  `static *id(){}`, `*[sym]()`) — the class collection pass keys on
  `${className}_${methodName}` and skips the duplicate, so the second member
  emits against the first's `NativeGeneratorInfo` (mismatched
  `synthesizedThis` → "local index out of range", fn-name-gen-method.js).

**Validation (542-file no-yield corpus, deterministic sample):**

- Host-free (no `__gen_*`/`__create_generator`/`__get_caught_exception`
  imports): **4 → 58 files** (+54; ×4 sampling ⇒ ~216 of the 2163-file
  candidate population, consistent with the ~250–350 estimate on the 1780).
- **0 per-file status flips** vs main baseline (368 pass both sides).
- **10 invalid modules, ALL pre-existing on pristine main without the relax**
  (verified per-lane; unrelated standalone bugs — dstr-default struct.new
  arity, forbidden-ext/b2 externref coercion, closure local.set typing).
  **0 relax-attributable invalids.**
- gc/host byte-inert (120 sha256 A/B vs origin/main generators-native.ts).
- Generator equivalence suites + tests/issue-2930.test.ts green.

## Handoff to #2936 (funcIdx-shift fix — the unblocker) [historical]

#2920 is BLOCKED on #2936 (late-import funcIdx-shift for lazily-emitted resume
functions). This issue's no-yield yield (~250–350 host-free tests) unlocks the
moment #2936 lands. Everything the successor needs:

- **The two held-off bails** (search `#2920` in `src/codegen/generators-native.ts`):
  1. `buildNativeGeneratorPlan` — `if (suspendCount === 0) return null;` (the
     comment above it names the blocker). Relax to allow zero-suspend once #2936
     is fixed.
  2. `isNativeGeneratorCandidate` — the terminal
     `return plan !== null && plan.states.some(... "yield" ...)`. Relax to
     `return plan !== null;` in lockstep with #1 (both must flip together — a
     mismatch is an undefined-funcidx invalid module).
- **Repro files** (compile through the test262 runner's standalone path — the bug
  only fires at full-harness scale, never in isolation):
  - `test262/test/language/statements/generators/dstr/obj-ptrn-empty.js`
    (destructure-triggered late import).
  - `test262/test/language/statements/generators/scope-paramsbody-var-close.js`
    (escaping-closure-triggered — proves it is NOT destructuring-specific).
  - Error signature: `__str_flatten call[1] expected externref, found i32`.
- **Verification for the relax PR**: 0 invalid modules on a 500+ file no-yield
  sample (`.tmp/2920/noyield_files.txt` derivation is in the corrected-measurement
  section) + the byte-inert sha256 check for gc/host and standalone with-yield.
- **Base commit**: `492fe0c58` on branch
  `issue-2920-standalone-native-sync-generator-resume` carries the correct
  zero-suspend lowering + destructure hardening; only the two bails gate it off.

# Standalone native SYNC-generator resume substrate

## 🚧 SLICE-1 BUILD STATUS (2026-07-02) — no-yield BLOCKED on a funcIdx-shift bug

**On the branch now (safe, byte-inert on real test262):**

- Destructuring generator params (object + typed-array, with-yield) — native
  lowering via a state-0-guarded resume-prelude destructure. Correct on synthetic
  cases; **flips ~0 real test262** (the dstr corpus is no-yield, see below) and is
  **byte-inert on the real corpus** (with-yield object-pattern generators all bail
  to host for other reasons — 0 native flips, 0 invalid on the 70-file with-yield
  corpus). Kept as the prerequisite it is.
- `ctx.currentFunc = resumeFctx` wrapping + a default-initializer bail on the
  destructure emit (correctness hardening).

**No-yield generator support is PREPARED but HELD OFF** (the two bails —
`buildNativeGeneratorPlan` suspendCount and the candidate yield-require — are
reverted to reject no-yield). Zero-suspend lowering itself is **correct**
(ident/obj param, return-value, 2nd-next→`{done:true}`, throw-in-body all valid +
js-host-matching, 0 wrong-value failures on a 500-file corpus sample). It flips
**~14% of no-yield generators host-free** (71–78/500 → ~250–350 of the 1780).

**BLOCKER — late-import funcIdx-shift at harness scale.** With no-yield enabled,
~1.4% of no-yield generators (7/500) produce an **invalid module**:
`__str_flatten call[1] expected externref, found i32` — an already-emitted runtime
string helper (func #6/#7) desyncs because a late/union import fired _during the
lazily-emitted resume function's body/param emit_ and shifted function indices
without repointing that helper's `call`. This is the **reference_1461 /
reference_2193 / #2918 `shiftAsyncSideChannelFuncIdxs` class** of bug, NOT specific
to destructuring: it reproduces on `obj-ptrn-empty.js` (destructure-triggered) AND
`scope-paramsbody-var-close.js` (escaping-closure-triggered), i.e. any no-yield
body/param that triggers a late import at scale. Only reproduces with the full
test262 harness (a small module never fires the shifting import), so it is a
merge_group-class regression that scoped checks miss. `ctx.currentFunc` wrapping +
default-init/dstr gating each removed a subset but not the root cause.

**Next step:** a focused funcIdx-shift fix — ensure the lazily-emitted resume
function's late imports repoint ALL already-emitted bodies (runtime helpers
included), likely by registering the resume path's imports up-front or applying
the #2918 side-channel-shift pattern. Once green on a 500+ file no-yield sample
with **0 invalid**, relax the two bails and the ~250–350-test yield unlocks.
Escalated to tech lead for scheduling.

## ⚠️ CORRECTED MEASUREMENT (2026-07-02) — the corpus is NO-YIELD generators

The original import-set measurement below (1396 dstr-param / 1851 flippable) was
**methodologically wrong**: it counted files whose imports ⊆ gen-suite, which
conflates _"a generator exists and `.next()` is called"_ (leaks
`__create_generator`/`__gen_next`) with _"the generator actually yields."_

**Grounded re-measurement** (compiled real corpus files through the runner's
standalone path, `.tmp/2920/corpus-verify.mjs`):

- Of the 1851 fully-flippable files, only **~70 contain a `yield` in code**
  (65 emit `__gen_push_*` = a runtime-yielded value). **1780 are NO-YIELD
  generators** — the test262 `dstr-binding` templates
  (`*method({x:y}){ assert(bindings); }` then `.next()`), which test **parameter
  binding**, not iteration.
- The native machine **requires a yield** (`generators-native.ts:806`
  `suspendCount===0 → return null`, and `:987`). So every no-yield generator
  bails to the host eager-buffer path — that is what 1780 of the 1851 leak on.
- **The destructuring-param slice (committed) flips ~0 corpus tests** (verified
  0/70 on the with-yield files: the few with-yield dstr tests use _untyped_
  array patterns, which the slice correctly bails; the rest are no-yield).
  It IS correct + byte-inert (gc/host sha256-identical; non-dstr generators
  byte-unchanged) and flips ~10-20 _synthetic_ with-yield object-param cases —
  a valid prerequisite, but ~0 real test262 on its own.

**The real opportunity = native NO-YIELD generators (the 1780).** A naive relax
of the two no-yield bails produces **invalid Wasm** (`__gen_resume_f`:
local.set expected i32, found externref) — the resume-function state typing
assumes ≥1 yield. So no-yield support is a genuine L/XL slice: give the resume
function a zero-suspend lowering (state 0 runs body to completion → `done`
result), fix the i32/externref result typing, and verify `.next()`/`.return()`
dispatch on a done-from-start generator. The committed dstr-param work is the
prerequisite (no-yield dstr-binding tests need BOTH) and stays on the branch.

_Status: reported to tech lead; awaiting direction on re-scope (A: build no-yield
generators on this branch keeping dstr-params; vs B: hold)._ The dstr-param
commit is safe on origin regardless.

## Problem / goal

In standalone mode, `function*` sync generators that fall outside the native
candidate subset lower to the **host-import** eager-buffer path
(`env::__create_generator`, `__gen_next`, `__gen_create_buffer`,
`__gen_yield_star`, `__gen_set_return`, `__gen_result_*`, `__gen_push_*`,
`__gen_return`, `__gen_throw`), plus the trampoline's `__get_caught_exception`.
Widen the **already-existing** native generator resume machine
(`src/codegen/generators-native.ts`) so those shapes lower host-free.

**Scope: SYNC generators only.** Async generators (`__create_async_generator`,
4065 tests) are explicitly OUT of scope.

## MEASUREMENT (done — run 28491700781 standalone merged jsonl)

Corpus extraction from `test262-standalone-results-merged.jsonl` (status==pass,
imports touching the sync-gen suite):

- **7379** tests touch the sync-gen host suite; **4831** of them pass.
- **NO test** has `imports ⊆ gen-suite` alone — **every** gen test also
  co-leaks `env::__get_caught_exception`. That import is emitted by the native
  generator **trampoline's own catch** (the `try { block { loop { if-chain } } }
catch $exn` dispatch), NOT by user code — it disappears when the generator
  lowers natively. So the honest "fully host-free" corpus is
  `imports ⊆ gen-suite ∪ {__get_caught_exception}`.
- **Honest full-build yield: 1851 PASS tests** flip fully host-free
  (1878 with the looser "no Promise/async co-leak" definition; the delta is a
  handful of tests that also leak `__array_from_iter` / `__get_generator*_prototype`).
- Of the 1851: **1610 are "simple"** (only `__gen_next`/result imports — no
  `yield*`/`.throw`/`.return`/`set_return`); **241 advanced**.

### Dominant root cause (empirically confirmed on current main)

A **mature** native generator machine already exists in `generators-native.ts`
(N-state resume; already handles straight-line `yield`, `let x = yield`,
`try/finally` no-catch, `if`/`else`, `while`/`do`/`for` loops, bare blocks,
numeric `yield*` delegation, and f64 / native-string / boxed-any-externref yield
carriers). The dominant REMAINING bail is the **candidate-gate parameter check**:

```ts
// src/codegen/generators-native.ts:955-957  (isNativeGeneratorCandidate)
for (const param of decl.parameters) {
  if (param.dotDotDotToken || !ts.isIdentifier(param.name)) return false;
}
```

So **destructuring / rest parameters** (`function*([a,b]){}`, `*m({x}){}`,
`function*(...rest){}`) reject → host eager-buffer fallback (or a hard CE #680 in
strict `target:standalone`). Confirmed via probes (`.tmp/2920/probe.mjs`):
plain-param generator → NATIVE (no imports); `[a,b]` / `{a,b}` / `...xs` → CE
#680 (top-level) or `__gen_*` host leak (class/object method).

### Slice-1 target = native destructuring + rest generator params

- **1396 PASS tests** flip host-free (ALL simple next/yield-only; 1082 are
  class/object-method generators, 314 function generators). This is 75% of the
  full-build yield in one bounded slice.
- Remaining **455 non-dstr flippable** tests bail for OTHER reasons (later
  slices — triage the residual candidate-gate / plan-builder bails).

## Architecture notes for the build

- The native generator state struct + factory is built in
  `registerNativeGenerator` (generators-native.ts:1144) from `decl.parameters`,
  currently assuming identifier params (one struct slot per param). Destructuring
  params must: store the **raw incoming param value** (the iterable/object) in a
  frame slot, then run the destructuring **binding** in the entry-state (state 0)
  prelude to produce the bound locals — reusing the existing `compileStatement`
  destructuring-binding machinery that regular functions already use. Bound
  names live across yields become spills (the plan builder's `addSpill` path,
  typed via `spillDecls` — generators-native.ts:314-320). Rest params bind a vec.
- Two consumers share the candidate gate and MUST stay in agreement:
  `registerNativeGenerator` AND `sourceNeedsGeneratorHostImports` (else a
  `funcIdx: undefined` invalid module). Widen the gate in ONE place.
- Class-method vs object-literal-method vs function/decl generators reach the
  factory via different emit sites (class-bodies.ts #2571, literals.ts #2581,
  nested-declarations.ts). Object-literal methods with default/optional params
  already bail (argc trampoline gap, line 966-970) — keep that.

## DISCIPLINE (graveyard-class — MUST hold)

- **Carrier-gated + byte-inert**: the native path is already gated on
  `noJsHostTarget(ctx)` (= `ctx.standalone || ctx.wasi`), so gc/host never reach
  it. Verify gc/host output stays **byte-identical** with sha256 before/after.
- **funcIdx / type-index shift**: register any new struct/vec types late + once
  (memory: project_type_index_shift_and_deadelim); watch late-import funcIdx
  shifts (shiftAsyncSideChannelFuncIdxs / #2918 pattern).
- **Corpus-verify** on the measured 1396-test dstr corpus (a scoped compile
  sweep counting host-import elimination), not just a handful.
- **Slice it**: dstr-array-param first if needed, then obj-pattern, then rest —
  a measurably-flipping partial beats a stranded full build.
