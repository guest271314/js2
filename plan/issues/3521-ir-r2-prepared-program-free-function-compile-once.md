---
id: 3521
title: "IR-only R2: prepare-before-emit free-function ownership"
status: blocked
sprint: current
created: 2026-07-21
updated: 2026-07-21
priority: critical
horizon: xl
complexity: XL
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen, compiler
language_feature: compiler-internals
es_edition: n/a
goal: ir-full-coverage
lane: ir-retirement-r2
model: gpt-5.6-sol
parent: 3518
depends_on: [3520]
required_by: [3522, 3523, 3525, 3526]
related: [2138, 2855, 3143, 3203, 3518, 3519]
origin: "#3518 R2 — invert single-source free functions from compile/patch to prepare/emit"
files:
  - src/ir/program.ts
  - src/ir/prepare.ts
  - src/ir/integration.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/lower.ts
  - src/ir/backend/legality.ts
  - src/codegen/context/types.ts
  - src/codegen/context/create-context.ts
  - src/codegen/declarations.ts
  - src/codegen/index.ts
  - src/index.ts
  - src/compiler.ts
  - tests/issue-3521-prepared-ir-program.test.ts
---

# #3521 — IR-only R2: prepare-before-emit free-function ownership

## Objective

Introduce `PreparedIrProgram` and invert the default single-source top-level
free-function pipeline so every in-scope function is classified before any
function body emitter runs:

```text
source + ProgramAbiMap
        |
        v
prepare all free-function components
        |
        +-- Prepared    -> emit IR body exactly once
        `-- Unsupported -> emit direct body exactly once (temporary hybrid)

Invariant at any stage -> fail; never retry through direct codegen
```

R2 is deliberately limited to top-level `FunctionDeclaration` units in the
ordinary single-source pipeline. It establishes the ownership mechanism that
later slices extend. It does not absorb class/member/closure inventory,
module-init execution, multi-source/M0, runtime-family migration, async, or the
linear backend.

## Current evidence

The current “IR-first” path is still a conditional overlay:

- `src/codegen/index.ts:1568-1591` documents that `planIrOverlay` was extracted
  so the same mutation-bearing planner can run before or after direct body
  compilation. Type and class-shape state may depend on body-emitter effects.
- `src/codegen/index.ts:1671-1708` describes `computeIrFirstSkipSet` as a narrow
  positive allowlist. A selected function outside that numeric/boolean subset
  still compiles direct and is later patched.
- `src/codegen/index.ts:3068-3100` plans a skip set, calls
  `compileDeclarations`, and installs `unreachable` placeholders for the
  allowed subset.
- `src/codegen/index.ts:3107-3144` then builds, optimizes, lowers, and patches IR
  after `compileDeclarations`. Host callback, Date, and Promise support is
  finalized only after legacy declaration/body side effects.
- `src/codegen/declarations.ts:2251-2277` decides at body-emission time whether
  to compile direct or write a placeholder, keyed by a string name.
- `src/ir/integration.ts:168-247` mixes selection, IR build, allocation
  registry setup, and concrete Wasm registry mutation. At `:589-714` it runs
  middle-end passes; at `:748-773` it allocates new Wasm slots; and at
  `:918-1004` it lowers and patches already-created functions.
- The measured allowlist ceiling is only **441/1,568 (28.1%)**. Widening that
  allowlist cannot make the remaining 71.9% compile once.

Therefore “selected” and even “IR-emitted” are not ownership proofs. R2 makes
`Prepared` a pre-emission fact and removes the allowlist from free-function
ownership.

## `PreparedIrProgram` contract

Add a program object whose construction completes before the first in-scope
body instruction is emitted. Exact names may follow repository conventions,
but the contract is fixed:

- `abi: ProgramAbiMap` — the R1 identity/slot plan.
- `units` — one terminal R0 outcome for every inventoried in-scope unit.
- `preparedUnits` — verified, post-pass typed IR keyed by `IrUnitId`, with
  source location, final signature, export intent, and backend-legality proof.
- `directUnits` — temporary hybrid `Unsupported` units with their stable code;
  this is a routing plan, not an untyped catch/retry path.
- `supportIntents` — the complete set of imports, globals, types, literals,
  helpers, closure/callback support, runtime entry intents, and exports that a
  Prepared body may reference.
- `components` — local call-graph components and their frozen ownership. If a
  cross-unit ABI/call edge cannot be proven safe, the entire component becomes
  typed `Unsupported` before emission rather than partially emitting and
  discovering the mismatch later.

`Prepared` means AST→IR build, verification, hygiene, inline/mono transforms,
symbolic resolution validation, support-intent collection, target legality,
and final ABI/signature checks succeeded. Backend body emission is a consumer,
not another capability probe.

## Prepare/emit split

Refactor `compileIrPathFunctions` into explicit phases:

1. **Inventory and plan.** Consume R0 outcomes and R1 identities/ABI. Run the
   selector for every top-level free function even if tracking/logging is off.
2. **Build all candidate IR.** Build every selected local-call component into
   an `IrModule`; do not allocate or patch concrete function bodies.
3. **Optimize and verify.** Run current hygiene, inline, monomorphization,
   allocation provenance, and target-legality checks. Any failure before the
   Prepared boundary becomes the typed outcome required by R0.
4. **Materialize support intents.** Inventory every symbolic ref and helper
   request and resolve it through `ProgramAbiMap` before body emission. Lazy
   creation of an unplanned import/type/global/helper after this seal is an
   `Invariant`, not a reason to retry direct codegen.
5. **Freeze ownership.** Every in-scope component is now exactly one of
   Prepared, Unsupported, or Invariant. No later code can mutate that choice.
6. **Emit once.** Direct compilation receives only the Unsupported ID set and
   emits each once. IR emission receives only Prepared units and emits each
   once into its planned slot. No `unreachable` placeholder is a shipping
   ownership mechanism.

The temporary `JS2WASM_IR_FIRST=0` / `disableIrFirst` compatibility policy may
still force a unit to the typed legacy policy until R9, but it may not create a
compile-twice unit: it must classify that unit before body emission and direct
compile it once. R9 deletes the options and this forced-legacy outcome.

## Exact emission accounting

Extend the R0 unit ledger with counters keyed by `IrUnitId`:

- `prepareAttempts`
- `directBodyEmissions`
- `irBodyEmissions`
- `legacyBodyEmitted` and `irBodyEmitted` compatibility booleans derived from
  those counters

For every R2 free function:

| Outcome                 | Direct emits | IR emits | Compile succeeds |
| ----------------------- | -----------: | -------: | ---------------- |
| Prepared                |            0 |        1 | yes              |
| Unsupported (hybrid)    |            1 |        0 | yes              |
| Invariant               |            0 |        0 | no               |
| Post-Prepared invariant |            0 | 0 or 1\* | no               |

`\*` A backend may have begun writing only to an isolated transaction/buffer;
the module must not publish it. It may never direct-compile the unit. Counters
record the attempted emission and fatal outcome without claiming success.

The sum of Prepared + Unsupported + Invariant must equal the inventory
denominator, and no successful unit may have `direct + IR != 1`.

## Bounded landing sequence

### Commit 1 — split preparation from emission, no routing change

- Introduce `PreparedIrProgram` and pure/intermediate build/pass/verify APIs.
- Collect and seal support intents; make emission consume a prepared value.
- Preserve the existing routing while tests prove build/emit separation and
  byte/runtime parity.

### Commit 2 — freeze single-source free-function ownership

- Replace `computeIrFirstSkipSet` for R2 free functions with terminal outcomes.
- Pass ID sets, not names, into direct compilation.
- Direct-compile Unsupported functions once; emit Prepared functions once.
- Turn every failure after Prepared into a typed fatal Invariant with no legacy
  catch/retry.

### Commit 3 — remove free-function patch/placeholder compatibility

- Stop allocating free-function body slots as a side effect of legacy body
  compilation. Use `ProgramAbiMap` slots directly.
- Delete the free-function `unreachable` placeholder/patch branch and derive
  transitional `irFirstSkipped` / `irCompiledFuncs` telemetry from exact
  counters.
- Retain class/module overlay code untouched for #3522/#3523.

## File ownership and locks

Lock `src/codegen/index.ts`, `src/codegen/declarations.ts`,
`src/ir/integration.ts`, `src/ir/prepare.ts`, and `src/ir/program.ts` to one R2
developer. The split crosses the ownership boundary and cannot be safely
implemented as independent edits to those files.

Changes to `class-bodies.ts`, module-init body construction, multi-source
`generateMultiModule`, `src/codegen-linear/`, runtime/builtin providers, or
async frame code are out of scope. If preparation exposes one of those as a
required follow-up, record a typed Unsupported outcome and update its assigned
R3–R8 issue instead of absorbing it.

## Anti-vacuity tests

`tests/issue-3521-prepared-ir-program.test.ts` must include:

1. A numeric allowlist function and an IR-supported function outside the old
   allowlist both become Prepared and each record exactly `direct=0, IR=1`.
   This proves the result is not merely the old skip set under a new name.
2. A selector-rejected free function becomes typed Unsupported and records
   exactly `direct=1, IR=0`; there is no IR attempt or second direct compile.
3. A local-call component with one unsafe ABI edge is classified before
   emission. No member has an emitted body when the component outcome is still
   undecided.
4. Injected build/verify/backend-legality failures before Prepared yield the
   correct typed outcome. An injected failure after Prepared is a fatal
   Invariant and direct emission stays zero.
5. An unplanned symbolic import/global/type/helper requested after the support
   seal is fatal. A planned host callback, Date snapshot, Promise delay, string
   literal, lifted closure, and monomorphized clone all resolve without lazy
   fallback.
6. `JS2WASM_IR_FIRST=0` / `disableIrFirst` (while still supported) can select
   the temporary direct policy but never cause `direct=1, IR=1`.
7. Inventory, outcome, and emission denominators reconcile; duplicate/missing
   counters and a shipping placeholder fail the test.

Run these with `tests/issue-3143.test.ts`, `tests/issue-3203.test.ts`,
`tests/issue-3214-imported-hof.test.ts`, the inline/mono pass suites, and the
full equivalence/cross-backend gates.

## Acceptance criteria

- [ ] `PreparedIrProgram` is complete and immutable before any R2
      free-function body emission starts.
- [ ] Preparation includes final typed IR, verification/passes, target legality,
      ABI validation, and every support intent; emission performs no new
      capability decision.
- [ ] Component ownership is frozen before body emission. Each free function
      has exactly one terminal outcome and at most one successful body emitter.
- [ ] Prepared free functions never invoke `compileFunctionBody`, never receive
      a legacy placeholder, and record `direct=0, IR=1` regardless of whether
      they belonged to the old numeric allowlist.
- [ ] Unsupported free functions direct-compile exactly once in temporary
      hybrid mode. Invariants fail without direct retry.
- [ ] Any failure after Prepared is fatal and cannot demote, patch back, or ship
      a partial/unreachable body.
- [ ] Transitional fallback/adoption/R0 telemetry is derived from the exact
      ledger and retains label/count parity where policy did not intentionally
      change.
- [ ] Existing runtime behavior, public ABI, equivalence, cross-backend,
      standalone/WASI validity, and full merge-group Test262 are
      net-non-negative.

## Risks and mitigations

- **Preparation side effects:** a failed unit could leave imports, helpers, or
  slots behind. Build in an isolated transaction and publish only a terminal
  Prepared component.
- **Mixed-component ABI drift:** direct callers and Prepared callees may
  disagree on signatures. Freeze ownership by call/ABI component and validate
  every edge against `ProgramAbiMap` before any body emission.
- **Late support discovery:** strings, callbacks, lifted units, or runtime
  helpers may be requested during lowering. Inventory typed support intents
  during preparation and make a post-seal request an Invariant.
- **Lost inlining behavior:** the second legacy phase currently populates an
  inlinable registry. Run optimization over the complete Prepared program and
  retain explicit performance/equivalence evidence without a discovery pass.
- **Coarse fallback hiding progress:** component-atomic Unsupported may direct-
  emit more bodies initially. Report both root cause and affected component;
  never split ownership merely to improve the headline count.

## Out of scope

- Class declarations/members, constructors, class expressions, object methods,
  or nested closure ownership (#3522).
- Module-init preparation, static field/block execution, TDZ/start semantics,
  or removal of the two direct init passes (#3523).
- `generateMultiModule` whole-program ownership (R5), new runtime semantic
  intrinsics (R6), async ownership (R7), or shared linear consumption (R8).
- Removing public/env escape hatches (R9) or deleting direct handlers
  (#3090/R10).

## Required completion evidence

```bash
pnpm exec vitest run tests/issue-3521-prepared-ir-program.test.ts tests/issue-3143.test.ts tests/issue-3203.test.ts tests/issue-3214-imported-hof.test.ts tests/ir/inline-small.test.ts tests/ir/phase3c.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
pnpm run check:ir-only -- --policy=hybrid
pnpm run check:ir-only -- --policy=ir-only --json
pnpm run check:ir-fallbacks -- --verbose
pnpm run typecheck
pnpm run lint
pnpm run format:check
node scripts/equivalence-gate.mjs
pnpm exec vitest run tests/cross-backend-diff.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

The PR report must include inventory and outcome denominators, a per-unit
direct/IR emission table, the old-allowlist vs Prepared delta, all post-Prepared
failure injections, and proof that no in-scope placeholder or compile-twice
unit shipped. “IR emitted” without `directBodyEmissions: 0` is not acceptance.
