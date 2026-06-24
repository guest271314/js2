---
id: 2138
title: "IR-first compile-once inversion: selector decides before compileDeclarations (flag-gated investigation)"
status: blocked
blocked_by: [2167]
pipeline_unblocked: 1927
spec: ready
sprint: 66
created: 2026-06-12
updated: 2026-06-24
priority: high
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: compiler
language_feature: compiler-internals
goal: maintainability
related: [1530, 1916, 1927, 2135]
origin: "2026-06-12 sprint-62 architecture analysis (pipeline workstream N2)"
---

# #2138 — every IR-claimed function is compiled twice by design

## Problem

Legacy compiles ALL bodies (`src/codegen/index.ts:1174`), then the IR
overlay re-compiles claimed ones and overwrites (`:1308`). Wasted compile
time — and the always-available legacy body is *the mechanism* that makes
silent fallback possible (#1530's root enabler). "Phase out the fallback"
has no destination until the pipeline can skip legacy for claimed
functions.

## Approach

Behind `JS2WASM_IR_FIRST=1`: run `planIrCompilation` before
`compileDeclarations` and skip legacy bodies for claimed functions whose
whole call-graph closure is claimed. Measure test262 delta + compile-time
delta on a full run. File divergences found.

## Acceptance criteria

- Flag exists; default behavior unchanged (byte-identical output without
  the flag).
- One measured test262 + compile-time run recorded in this issue.
- Divergences filed as issues.

## Notes

Fable-routed investigation — the findings shape #1530/#1916-impl
sequencing for sprints 63+. This is the structural endgame the
STRICT_IR_REASONS ratchet feeds into.

## Implementation Plan

> Spec'd against `origin/main @ 8effc04c0` (2026-06-23) — the commit that
> landed #1927's `runPipeline` (PR #1958). Line numbers below are from that
> commit; **re-`grep` the function names before editing** (`generateModule`,
> `generateMultiModule`, `compileDeclarations`, `compileIrPathFunctions`).

### Root cause (confirmed against current main)

The legacy front-end compiles **every** top-level function body, then the IR
overlay re-compiles the claimed ones and *overwrites the just-emitted legacy
body*. The overwrite is literal:

- `generateModule` (`src/codegen/index.ts:1032`) runs the third pass
  `compileDeclarations(ctx, ast.sourceFile)` (`:1333`) — this emits a full
  Wasm body into `ctx.mod.functions[localIdx]` for **every** function.
- Then, guarded by `if (options?.experimentalIR)` (`:1354`), it runs
  `planIrCompilation` + `compileIrPathFunctions` (`:1494`).
- `compileIrPathFunctions` (`src/ir/integration.ts:108`) lowers each claimed
  function AST→IR→Wasm and at `integration.ts:718` does
  `ctx.mod.functions[localIdx] = { …, body: tcoBody, … }` — **discarding** the
  legacy body that `compileDeclarations` already produced for that slot.

So every IR-claimed function is compiled twice by design: once by legacy
(thrown away), once by IR (kept). That wasted legacy compile is also the
*mechanism* that makes silent fallback free (#1530's root enabler) — because a
working legacy body always exists, an IR throw can be demoted to a warning with
no destination cost. "Phase out the fallback" has no endgame until the pipeline
can **skip legacy for fully-claimed functions**.

`generateMultiModule` (`src/codegen/index.ts:5305`) compiles all bodies
(`:5448-5451`) and has **no** `experimentalIR` overlay block at all — the multi
path never runs IR. #1927 deliberately routes `experimentalIR` through
`buildCodegenOptions` to `generateMultiModule` as a **no-op consumer** (the
`// generateMultiModule ignores the IR fields today, that is the #2138 seam`
comment at `compiler.ts:594-596`). This issue owns wiring that seam live for
`generateModule` first; multi-module is a follow-on slice.

### What "compile-once inversion" means

Today the order is **compile-all-legacy → overwrite-claimed-with-IR**. The
inversion is **plan-IR-first → compile only the un-claimed via legacy → compile
the claimed via IR once**. Concretely, behind `JS2WASM_IR_FIRST=1`:

1. Run `planIrCompilation` (+ the `overrideMap`/`safeSelection` resolution that
   currently sits *after* `compileDeclarations`) **before** the body pass.
2. Compute the **fully-claimed closure**: a function is skippable by legacy iff
   it AND its whole call-graph closure are in `safeSelection.funcs` (the
   selector already closes the claim set under local call edges — see
   `select.ts:364` "Step 2: call-graph closure"). A function with any
   legacy-compiled callee must NOT be skipped (its `call $idx` would dangle).
3. Have `compileDeclarations` **skip emitting a body** for skippable functions
   (still pre-allocate the funcIdx/typeIdx slot — see below), then run the IR
   overlay to fill exactly those slots once.
4. Flag OFF ⇒ byte-identical to today (acceptance criterion).

This is investigation-flavored: the first deliverable is the flag + a measured
test262 + compile-time run, NOT a finished retirement of legacy. The slices
below are ordered so the structural risk is isolated and each lands green.

### The load-bearing subtlety — slot pre-allocation vs body emission

`compileDeclarations` does **two** things per function that must be teased
apart: (a) it **pre-allocates** the funcIdx/typeIdx slot and records it in
`ctx.funcMap` (the IR overlay relies on this — `integration.ts:672`
`ctx.funcMap.get(name)` and `:677` `localIdx = funcIdx - ctx.numImportFuncs`
expect the slot to already exist), and (b) it **emits the body** into that slot.
The inversion must keep (a) for every function (so funcIdx assignment and
therefore the whole module's index layout is **identical** flag-on vs flag-off)
and only skip (b) for fully-claimed functions. Emitting an empty placeholder
body (e.g. a single `unreachable`) into the skipped slots is the safe shape:
the IR overlay overwrites it exactly as it overwrites a full legacy body today,
so the `ctx.mod.functions[localIdx] = {…}` patch site needs **no** change.

**Why a placeholder, not "remove the slot":** removing/reordering function slots
would renumber every downstream funcIdx and desync `call $idx` ops, the
late-import shifter, and `declaredFuncRefs` — the exact index-fragility class
#1916 exists to kill. Keep the slot, swap the body. This keeps the inversion a
*body-emission* change, never an *index-layout* change. Verify with the
byte-identical gate (flag-off) and an index-stability assertion (flag-on, see
tests).

### Decomposition into independently-landable dev slices

Each slice is a separate PR, green on its own, ordered by risk.

#### Slice 1 — hoist IR planning above `compileDeclarations` (refactor, no behavior change)

- **Scope:** move the `planIrCompilation` + `buildTypeMap` + `buildIrClassShapes`
  + `overrideMap`/`safeSelection` construction block (`index.ts:1355-1493`) so it
  runs **before** `compileDeclarations(ctx, ast.sourceFile)` (`:1333`). The
  actual `compileIrPathFunctions` call (`:1494`) stays AFTER `compileDeclarations`
  (it still needs the final funcIdx/typeIdx that `compileDeclarations` assigns).
  Net effect: the *plan* (which functions are claimed) is known before the body
  pass; the *overlay* still runs after. No legacy skipping yet.
- **Files:** `src/codegen/index.ts` only.
- **Risk:** LOW. Pure reordering of a side-effect-light planning block. The one
  hazard: `buildIrClassShapes(ctx, …)` reads `ctx.classSet`/`ctx.structFields`/
  `ctx.funcMap` populated by `collectDeclarations`/class collection — confirm
  those still run before the hoisted block (they do: `collectDeclarations` is at
  `:1320`, well before `compileDeclarations` at `:1333`). Does NOT touch
  value-rep / standalone lanes. **Byte-identical** output expected (flag or no
  flag) — assert via `check:ir-fallbacks` (no demotions) + a corpus byte-diff.
- **Acceptance probe:** `pnpm run check:ir-fallbacks` shows zero delta;
  equivalence suite green. Compile a 2-function recursive-`fib` example and
  diff the `.wat` before/after — must be identical.

#### Slice 2 — the `JS2WASM_IR_FIRST` flag + fully-claimed-closure skip (the keystone)

- **Scope:** add the env flag (read once, e.g.
  `const irFirst = process.env.JS2WASM_IR_FIRST === "1"`). When set AND
  `options.experimentalIR`: compute the `skippable` set = functions whose own
  name AND every local callee (transitively) are in `safeSelection.funcs`
  (reuse the selector's call-graph closure result; do NOT re-derive it — expose
  the closure set from `planIrCompilation` if it isn't already on the
  `IrSelection` return). Thread `skippable` into `compileDeclarations` so it
  emits a placeholder body (`[{ op: "unreachable" }]`) for those functions
  instead of compiling them. The IR overlay then fills exactly those slots (no
  change to `integration.ts:718`).
- **Files:** `src/codegen/index.ts` (flag + skippable computation + thread),
  `src/codegen/declarations.ts` (accept a `skipBodies?: ReadonlySet<string>`
  param on `compileDeclarations`; at the top-level FunctionDeclaration
  body-emission site, emit the placeholder when `skipBodies?.has(name)`),
  possibly `src/ir/select.ts` (export the closure set if not already available).
- **Risk:** **HIGH — this is the structural keystone.** It changes which bodies
  legacy emits. Two specific traps:
  1. **`new.target` coarse gate** (`index.ts:1490`): when `ctx.usesNewTarget`,
     `safeSelection` is cleared to empty AFTER planning. The `skippable` set
     MUST be computed from the SAME post-gate `safeSelection`, never the raw
     selection — otherwise a function gets its legacy body skipped but is then
     NOT IR-compiled, leaving a `unreachable` placeholder live. Compute
     `skippable` strictly downstream of every `safeSelection` mutation.
  2. **post-claim resolve/build fallback** (`index.ts:1445`,
     `integration.ts:726`): a function the selector claimed can still fall back
     to legacy at overrideMap-resolve time or at IR-build time (caught, demoted
     to warning). If legacy already skipped its body, that fallback now lands on
     an `unreachable` placeholder — a hard runtime trap, not a graceful demote.
     **Resolution:** only mark a function `skippable` after it survived
     overrideMap resolution (`overrideMap.has(name)`). Because IR-*build*
     failures are only known *after* `compileIrPathFunctions` runs (which is
     after `compileDeclarations`), gate the skip conservatively: under
     `JS2WASM_IR_FIRST`, if `compileIrPathFunctions`'s `report.errors` names a
     skipped function, that is now a **hard error** (the placeholder is live).
     This is acceptable for a flag-gated investigation — the flag's job is to
     surface exactly these divergences as filable issues (acceptance criterion
     3). Document it: under the flag, a post-claim IR fallback on a skipped
     function fails the compile loudly instead of silently demoting.
  - **Touches the standalone/value-rep lane only indirectly** (it changes which
    path emits a body, not the bodies themselves) — but because a skipped-then-
    failed function traps, this MUST be validated on the **full `merge_group`
    test262 run**, never a scoped sweep (broad-impact rule, see
    `project_broad_impact_validate_full_ci`). Flag-off path is byte-identical
    and safe; the risk is entirely in the flag-on measurement.
- **Acceptance probe:** (1) flag-OFF: full equivalence + `check:ir-fallbacks`
  zero delta + corpus byte-diff identical (proves default unchanged). (2)
  flag-ON: a small all-IR-claimable program (e.g. recursive numeric `fib` +
  typed caller) compiles, runs correct, and `compileDeclarations` emitted a
  placeholder for the claimed funcs (assert via an instrumentation counter or a
  `.wat` inspection that the body came from IR). (3) flag-ON on a program with a
  partially-claimed closure: the un-claimed function keeps its legacy body
  (assert it is NOT a placeholder).

#### Slice 3 — measurement run + divergence filing (closes the issue's acceptance criteria)

- **Scope:** one full test262 + compile-time run with `JS2WASM_IR_FIRST=1`
  vs the baseline (flag off), recorded in this issue. File every divergence
  (test262 regression OR a skipped-function-trap) as its own issue. This is the
  deliverable that satisfies acceptance criteria 2 and 3.
- **Files:** none (data + issue files). Run via the standard
  `pnpm run test:262` worktree runner with the env flag set; capture the
  compile-time delta from the runner's timing output.
- **Risk:** NONE (measurement only). Heavy CPU — run when the box is idle or in
  CI, not alongside the dev pool.
- **Acceptance probe:** the test262 pass delta + compile-time delta are written
  into a `## Measurement (JS2WASM_IR_FIRST)` section here; each divergence has a
  filed issue id.

#### Slice 4 (follow-on, OPTIONAL this sprint) — extend the seam to `generateMultiModule`

- **Scope:** give `generateMultiModule` the same `experimentalIR` overlay block
  that `generateModule` has (it has none today — `index.ts:5448-5451`). Only
  attempt after Slice 2 proves the single-module inversion. This is the larger
  follow-on and may spill to a later sprint.
- **Files:** `src/codegen/index.ts` (`generateMultiModule`).
- **Risk:** MEDIUM — multi-file call-graph closure spans files; the selector's
  closure must be computed across `multiAst.sourceFiles`. Defer unless Slice 2
  lands early.
- **Acceptance probe:** a 2-file program with an IR-claimable function imported
  across files compiles and runs; full test262 net-zero with the multi IR
  overlay OFF by default.

### Dependency order across the IR cluster

`#1927` (the single pipeline driver) is **already landed** (PR #1958) — it is
the technical prerequisite for everything below and it left the
`generateMultiModule` IR seam as a deliberate no-op for this issue to wire.

- **#2138 (this issue) enables / unblocks:**
  - **#2135 (single IR capability predicate)** — the inversion makes the
    selector's claim decision *load-bearing for correctness* (a wrong claim now
    traps a skipped function instead of silently demoting). That sharply raises
    the value of unifying `select.ts`'s `isPhase1Expr` with `from-ast.ts`'s
    throw sites so selector and builder cannot disagree. #2138's flag-on traps
    are exactly the `select`↔`from-ast` drift #2135 fixes. **Sequence #2135
    right after #2138 Slice 2** — they are mutually reinforcing; #2138's
    measurement (Slice 3) feeds #2135's acceptance metric.
  - **#1916 (symbolic function references)** — independent in *files*
    (`emit/binary.ts`, `late-imports.ts`) but the inversion's placeholder-slot
    discipline depends on funcIdx layout staying stable; #1916's FuncHandle
    indirection makes that stability structural rather than convention. #1916
    can land before OR after #2138; doing #1916 first *reduces* #2138's
    index-fragility risk. No file conflict (different files).
- **#2138 needs (soft):** nothing hard-blocking beyond #1927 (landed). It reads
  `planIrCompilation`/`safeSelection` (`select.ts`) and the overlay
  (`integration.ts`) as they are today.
- **#2134 (IR effect model)** and **#1930 (TypeOracle)** are **parallel, not
  dependent** — #2134 governs intra-function instruction scheduling, #1930
  governs the checker→codegen type boundary; neither blocks nor is blocked by
  the compile-once inversion. They can proceed independently once unblocked.

**Recommended cluster order:** #1916 (or in parallel) → **#2138 Slices 1-2** →
#2135 → #2138 Slice 3/4. #2134 and #1930 run in parallel on their own tracks.

### Edge cases to preserve (regression traps)

- **Flag OFF must be byte-identical.** The hoist (Slice 1) and the skip logic
  (Slice 2) both gate on `JS2WASM_IR_FIRST`; with it unset, not one emitted byte
  changes. This is acceptance criterion 1 and the only unconditional guarantee.
- **funcIdx layout invariant.** Slot pre-allocation happens for *every*
  function regardless of skip; only the body differs. Never remove or reorder a
  slot. An index-stability test (compile the same source flag-on vs flag-off and
  assert `ctx.mod.functions.map(f => f.name)` is identical) guards this.
- **`new.target` clears `safeSelection`** — compute `skippable` strictly after
  that clear (Slice 2 trap 1).
- **Post-claim fallback on a skipped function** traps under the flag — this is
  intended *investigation* behavior (surface divergences), not a silent demote;
  fail loud and file it (Slice 2 trap 2).
- **Class members** go through the `classMember` parity guard
  (`integration.ts:704`) and a separate slot pre-allocation in `class-bodies.ts`
  — Slice 2's `skippable` set should cover **top-level FunctionDeclarations
  only** for the first cut (class-method body-skip is a strictly later
  refinement; leave class methods on the always-legacy-then-overwrite path).
- **TCO parity** — `applyIrTailCalls` (`integration.ts:717`) runs on the IR body
  before the patch; unaffected by the inversion (the patch site is unchanged).

### Test / regression plan

1. **Flag-off byte-identity** (`tests/issue-2138.test.ts`): compile a small
   corpus with the flag unset and diff `.wat` against the pre-change baseline.
   Must be identical (assert the flag-reading branch is dead when the env var is
   absent).
2. **funcIdx layout invariant**: same source, flag-on vs flag-off, assert
   `ctx.mod.functions` name order identical.
3. **Flag-on all-claimed**: recursive numeric `fib` with a typed caller —
   compiles, runs correct, the claimed bodies are IR-emitted (placeholder
   skipped by legacy).
4. **Flag-on partial closure**: a claimed function calling an un-claimable one —
   the un-claimable keeps its legacy body; no trap.
5. **Flag-on post-claim-fallback trap** (negative): a function the selector
   claims but that fails IR build — under the flag, the compile fails loudly
   (asserts the "fail loud, don't trap silently" contract).
6. **Full `merge_group` test262** with the flag OFF must be net-zero (this is a
   refactor when the flag is off); the flag-ON run is Slice 3's measurement, not
   a gate.

### Suggested commit / PR sequence

1. `refactor(#2138): hoist IR planning above compileDeclarations (no behavior change)` — Slice 1
2. `feat(#2138): JS2WASM_IR_FIRST flag — skip legacy bodies for fully-claimed closure` — Slice 2
3. `chore(#2138): record IR-first test262 + compile-time measurement, file divergences` — Slice 3 (data only)
4. (optional) `feat(#2138): extend IR overlay to generateMultiModule` — Slice 4

Slices 1 and 2 are the structural work; keep them separate PRs so the
low-risk hoist lands and de-risks the keystone diff. Slice 2 MUST validate on
the full `merge_group` run, not a scoped sweep.

### Status / blocker note (2026-06-23, architect)

This issue's frontmatter blocker is **#2167 (Fable model disabled)**, NOT
#1927. #1927 (the *technical* prerequisite) has now **landed** (PR #1958), so
the technical path is clear and this spec is dev-ready. But #2167 is still
`in-progress` (Fable unavailable) and gated this issue on `reasoning_effort:
max`. Per #2167's own resolution policy, this issue stays parked on the Fable
gate for *implementation dispatch*; the spec is written now so it is
ready-to-dispatch the moment #2167 closes. The frontmatter therefore keeps
`status: blocked` / `blocked_by: [2167]` but records `pipeline_unblocked: 1927`
to mark that the technical prerequisite is satisfied.
