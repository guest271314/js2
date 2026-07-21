---
id: 3520
title: "IR-only R1: source-qualified unit identity and whole-program ABI map"
status: in-progress
assignee: ttraenkler/codex-r1
claimed_by: codex-r1
claimed_at: 2026-07-21T20:23:19Z
branch: symphony/3520-r1-identity-abi
sprint: current
created: 2026-07-21
updated: 2026-07-21
priority: critical
horizon: l
complexity: L
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen, compiler
language_feature: compiler-internals
es_edition: n/a
goal: ir-full-coverage
lane: ir-retirement-r1
model: gpt-5.6-sol
parent: 3518
depends_on: [3519]
required_by: [3521, 3525]
related: [1983, 2138, 2930, 3142, 3143, 3518, 3529]
origin: "#3518 R1 — replace display-name identity before preparation ownership changes"
files:
  - src/ir/identity.ts
  - src/ir/program-abi.ts
  - src/ir/index.ts
  - src/ir/nodes.ts
  - src/ir/outcomes.ts
  - src/ir/builder.ts
  - src/ir/ast-lowering-plans.ts
  - src/ir/from-ast.ts
  - src/ir/imported-functions.ts
  - src/ir/module-bindings.ts
  - src/ir/promise-delay-lowering.ts
  - src/ir/propagate.ts
  - src/ir/type-evidence.ts
  - src/ir/select.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/verify.ts
  - src/ir/verify-alloc.ts
  - src/ir/analysis/encoding.ts
  - src/ir/analysis/escape.ts
  - src/ir/analysis/linear-memory-plan.ts
  - src/ir/analysis/ownership.ts
  - src/ir/analysis/stack-alloc.ts
  - src/ir/analysis/string-evidence.ts
  - src/ir/backend/contract.ts
  - src/ir/backend/legality.ts
  - src/ir/backend/linear-integration.ts
  - src/ir/backend/porffor/assembler.ts
  - src/ir/backend/porffor/compat.ts
  - src/ir/backend/porffor/integration.ts
  - src/ir/backend/porffor/sink.ts
  - src/ir/backend/porffor/type-converter.ts
  - src/ir/passes/dead-code.ts
  - src/ir/passes/inline-small.ts
  - src/ir/passes/monomorphize.ts
  - src/ir/passes/simplify-cfg.ts
  - src/ir/passes/tagged-union-types.ts
  - src/ir/passes/tagged-unions.ts
  - src/codegen/class-member-keys.ts
  - src/codegen/context/types.ts
  - src/codegen/context/create-context.ts
  - src/codegen/ir-first-gate.ts
  - src/codegen/ir-overlay-finalize.ts
  - src/codegen/index.ts
  - src/codegen/stdlib-selfhost.ts
  - tests/issue-3520-ir-unit-identity.test.ts
---

# #3520 — IR-only R1: source-qualified identity and whole-program ABI map

## Objective

Give every source and synthetic compiler unit a structural, source-qualified
identity and build one deterministic `ProgramAbiMap` before changing which
front-end emits bodies.

This is an identity/ABI landing, not an ownership flip. The same units still
take the same direct, compile-twice, or IR-overlay route as before. R1 removes
the name-collision and late-slot-allocation assumptions that would otherwise
make R2's prepare-before-emit inversion unsound.

## Current evidence

The current middle-end calls a display string an identity:

- `src/ir/nodes.ts:36-52` defines `IrFuncRef`, `IrGlobalRef`, and `IrTypeRef`
  with only `{ kind, name }`; the comments explicitly bind those names to the
  legacy context maps.
- `src/ir/nodes.ts:2591-2605` makes `IrModule` only a flat function array;
  imports, globals, types, exports, classes, and synthetic units are not a
  program-owned contract.
- `src/ir/from-ast.ts:561-570` chooses `options.funcName ?? fn.name.text`, and
  `calleeTypes` / `classShapes` / `moduleBindings` are flat string maps
  (`:444-470`, `:503-517`).
- `src/ir/integration.ts:150-220` keys propagated signatures and local calls by
  function name. Its post-pass table at `:685-710` also joins functions by
  name.
- `src/ir/passes/inline-small.ts:88-102` and
  `src/ir/passes/monomorphize.ts:99-126` build `byName` maps. A duplicate
  display name silently overwrites the earlier entry before either pass.
- `src/codegen/index.ts:4970-5046` copies import aliases between the flat
  `funcMap`, `closureMap`, and `moduleGlobals` namespaces. The multi-source
  overlay must separately collect name collisions at `:5274-5284` because the
  IR itself cannot represent distinct same-named declarations.
- `src/codegen/class-bodies.ts:1078-1118` registers instance and static methods
  from the same `${className}_${methodName}` display name. The existing
  collision guard deliberately suppresses a second placeholder; getters and
  setters need separate spelling conventions at `:1197-1283`.
- `src/ir/integration.ts:921-970` finds `__module_init` by display name and
  patches class/module slots allocated by legacy compilation. That adapter is
  temporary and cannot be the identity model for an IR-only program.

These are not hypothetical multi-source-only hazards. Two files may both
declare `main`; two nested classes may both be named `C`; one class may have
static and instance `m`; and `get x` / `set x` are separate executable units
even though users see one property name.

## Identity contract

Add one canonical identity vocabulary, with a single encoder/comparator:

- `IrSourceId` is independent of the process cwd and absolute checkout path.
  It combines a normalized program-relative source key with the source's
  deterministic compiler order. The entry file and synthesized/lib sources
  have explicit kinds; no `Map` insertion accident defines order.
- `IrUnitId` identifies an executable source unit by source, lexical owner
  chain, unit kind, and declaration ordinal. Kinds cover top-level functions,
  class constructors/methods/accessors, object methods, nested declarations,
  closures, module init, and synthetic support units.
- `IrClassId` identifies a class declaration/expression by source, lexical
  owner, and declaration ordinal. The class's spelling is only `displayName`.
- `IrBindingId` (or an equivalently closed union) identifies function, global,
  import, type, export, and synthetic/runtime bindings. A callable reference
  distinguishes a source `IrUnitId` from an intrinsic/import/support binding;
  no ad-hoc magic string enters the identity domain.
- Synthesized identities derive from `{parentId, role, ordinal}`. Lifted
  closures and monomorphized clones never derive uniqueness from a generated
  display name or a type string alone.

Identity values must be immutable and serializable for diagnostics/tests. A
human-readable label is stored separately and may remain byte-compatible with
current telemetry. Equality, maps, call graphs, passes, and ABI resolution may
never use that label.

The inventory exposes two explicit populations rather than conflating nested
support artifacts with terminal source outcomes:

- `allUnits` is exhaustive over source, nested, lifted, and synthetic support
  units. Every record has a `terminalOwnerId` and, where applicable, a
  `lexicalOwnerId`.
- `terminalUnits` is the exact one-to-one population consumed by the R0 outcome
  ledger. Its count must equal terminal outcomes, while every additional
  `allUnits` record must resolve to one terminal owner.

An equality check between `allUnits.length` and the R0 outcome count is invalid:
R0 deliberately attributes lifted/support preparation failures to their source
owner. R1 makes that relationship structural instead of manufacturing extra
terminal rows.

## `ProgramAbiMap` contract

Build one whole-program inventory in deterministic source order. The map owns:

1. Every source and synthetic unit, class, and binding identity.
2. Callable signatures, global storage, imported callable/global signatures,
   Wasm type intents, exports, class layouts, and support-unit relationships.
3. Stable source order and dependency order, including explicit parent/child
   links for lifted closures and constructor support units.
4. The eventual concrete Wasm handle for each identity. Allocation happens
   once; a second allocation, an unplanned binding, or two identities sharing a
   non-alias slot is an R0 `Invariant`.
5. Explicit aliases. An import alias, inherited member, or export alias points
   to a canonical binding ID; it is not implemented by copying a display-name
   map entry.

R1 supplies a narrow `LegacyAbiAdapter` (name may follow repository
conventions) so existing direct code can resolve its old `funcMap`,
`moduleGlobals`, `structMap`, and export slots from `ProgramAbiMap`. The
adapter is the only string-keyed compatibility boundary. It must:

- generate collision-free internal Wasm names from IDs while preserving the
  old spelling when it is unambiguous;
- reject an ambiguous reverse lookup instead of choosing first/last wins;
- record intentional aliases separately from accidental collisions; and
- expose the old display labels for telemetry without making them keys.

## Bounded landing sequence

### Commit 1 — identities and exhaustive inventory

- Add the identity types, canonical encoder/comparator, and source-order
  builder.
- Inventory single- and multi-source ASTs without changing selection or body
  routing.
- Cover class declarations/expressions, static/instance/accessor distinctions,
  nested scopes, object methods, lifted functions, module init, and known
  synthetic support roles. Unsupported syntax is still inventoried.
- Cross-check the R0 outcome ledger: every terminal row maps to exactly one
  `terminalUnits` identity, every `allUnits` record resolves through
  `terminalOwnerId`, and legacy labels/histograms remain unchanged.

### Commit 2 — key source planning and analyses by identity

- Replace source-unit string keys in `propagate.ts`, `type-evidence.ts`,
  `select.ts`, `ast-lowering-plans.ts`, imported/module-binding plans,
  promise-delay ownership, IR-first call-graph closure, class-member keys, and
  self-host selection with structural IDs.
- Key recursion/SCC, escape/ownership, string-evidence, and linear-memory-plan
  source ownership by identity. Property names, intrinsic names, and layout
  field names remain labels and must not be mechanically converted.
- Keep existing selection results, preparation order, and diagnostics stable;
  this commit changes lookup identity only.

### Commit 3 — key IR references, passes, and backends by identity

- Replace name-keyed local-call/type maps in `from-ast.ts`, `integration.ts`,
  lowering, verification, overlay finalization, and backend contracts with
  IDs.
- Put an `IrUnitId` on every `IrFunction`; make direct calls carry a typed
  callable binding ID. Keep `name` only as a display/debug field.
- Key inlining, recursion/SCC analysis, monomorphization, and clone edit tables
  by identity. A clone receives a derived ID; its display name may retain the
  current format.
- Make WasmGC, linear integration, and the Porffor adapter consume the same
  binding identity. Backend-local scratch labels and concrete export strings
  remain explicit labels below the ABI boundary.
- Keep runtime/helper string references behind a typed intrinsic/import binding
  variant until R6; do not invent source IDs for runtime providers.

### Commit 4 — ABI map and legacy-slot adapter

- Plan/import/intern every ABI entry once, then feed current declaration and
  integration code through the compatibility adapter.
- Replace collision scanners and name-based patch lookup where an ID is
  available. Keep the existing routing order and legacy body emitters.
- Preserve current public export names. Internal name changes are permitted
  only for a real collision and require runtime evidence.
- Emit diagnostic tables sorted by canonical source/unit order, never JS `Map`
  accident or filesystem walk order.

## File ownership and locks

The implementing agent owns the files listed in frontmatter for the duration
of R1. The expanded lock is deliberate: a repository audit found source-unit
string keys in AST lowering plans, imported/module binding plans,
promise-delay ownership, IR-first call graphs, analysis passes, overlay
finalization, and the Porffor adapter in addition to the initially named core
files. Lock `src/ir/nodes.ts`, every typed-reference consumer, the listed
passes/backends, and `src/codegen/index.ts` as one identity change. Do not split
those files across parallel developers.

New identity/ABI modules are preferred over growing `codegen/index.ts`.
Changes in codegen context are adapter plumbing only. R1 may thread identity
through backend-linear/Porffor contracts, but it must not change backend
ownership or lowering behavior; whole-program multi consumption belongs to R5
and shared backend conversion belongs to R8.

## Anti-vacuity tests

`tests/issue-3520-ir-unit-identity.test.ts` must prove all of the following:

1. Two source files with identical top-level function/class/global display
   names receive distinct IDs and ABI entries in deterministic source order.
2. Two same-named classes in different lexical scopes, and two anonymous class
   expressions, do not share `IrClassId`, field layout, constructor, or member
   entries.
3. `static m`, instance `m`, `get x`, `set x`, a private/computed member, and a
   top-level spelling that resembles the legacy synthetic key all inventory as
   distinct units. Supported units resolve to distinct slots; unsupported
   members still receive distinct terminal identities.
4. A lifted closure in each of two same-named parents and two monomorphization
   clones cannot alias in inline/mono maps. Reversing unrelated `Map` insertion
   order does not change canonical IDs or output ordering.
5. Imported/default/renamed aliases and inherited members resolve as explicit
   aliases to one canonical binding, while an accidental collision raises the
   stable ABI invariant.
6. The R0 ledger has exactly one outcome per `terminalUnits` record; nested and
   support records remain present in `allUnits`, resolve to a terminal owner,
   and do not change legacy display labels/histograms.

Run the collision tests alongside `tests/issue-1983-funcmap-collision.test.ts`,
`tests/issue-2138-multi-module-ir-overlay.test.ts`,
`tests/ir/inline-small.test.ts`, `tests/ir/phase3c.test.ts`, and the
multi-file equivalence suite.

## Acceptance criteria

- [ ] `IrSourceId`, `IrUnitId`, `IrClassId`, and typed binding identities are
      the only keys for program-level IR semantics; display names are labels.
- [ ] Same display names across files/classes/lexical scopes and
      static-vs-instance/get-vs-set members cannot collide or overwrite an IR,
      pass, ABI, or concrete slot entry.
- [ ] One deterministic `ProgramAbiMap` inventories signatures, globals,
      imports, types, exports, aliases, classes, and synthetic support units in
      source order before R2 uses it for ownership.
- [ ] Inline, recursion, propagation, monomorphization, integration, and clone
      identity are keyed structurally; there is no `byName` last-wins behavior
      for source units.
- [ ] The legacy adapter is the only name-keyed compatibility boundary and
      rejects ambiguous reverse lookup.
- [ ] Selection, Prepared/Unsupported outcomes, direct-vs-IR routing, and body
      emission counts are unchanged in R1.
- [ ] Non-collision fixtures are emitted byte-for-byte identically across gc,
      standalone, and WASI. Collision fixtures match JavaScript runtime
      behavior and retain public export names.
- [ ] Existing fallback/adoption and R0 telemetry counts/labels retain parity;
      the new IDs add information but do not reclassify outcomes.

## Risks and mitigations

- **Public-name churn:** structural IDs could leak into exports or diagnostics.
  Keep display/export names as explicit ABI labels and byte-compare every
  non-collision fixture.
- **Nondeterministic IDs:** filesystem or `Map` insertion order could change
  binaries and baselines. Derive IDs from normalized source identity, lexical
  position, unit kind, and deterministic clone ordinals.
- **Adapter ambiguity:** a reverse name lookup can silently choose the wrong
  legacy slot. Require a unique structural owner and raise a stable Invariant
  on zero or multiple matches.
- **Late index shifts:** lazy imports/globals can invalidate numeric slots.
  Keep symbolic ABI handles until the one planned finalization boundary and
  test late-import pressure.
- **Wide pass blast radius:** identity touches builders, passes, and codegen.
  Land the bounded commits with old/new telemetry parity after each step and
  keep routing unchanged throughout R1.

## Out of scope

- Creating `PreparedIrProgram` or moving preparation before body emission
  (#3521).
- Skipping any additional direct body, changing fallback policy, or removing
  `experimentalIR` / IR-first switches.
- Compile-once class/closure ownership (#3522), module init (#3523), or
  whole-program multi-source ownership (R5).
- Rewiring runtime families (R6), async policy (R7), linear consumption (R8),
  or deleting direct handlers (#3090/R10).

## Required completion evidence

```bash
pnpm exec vitest run tests/issue-3520-ir-unit-identity.test.ts tests/issue-1983-funcmap-collision.test.ts tests/issue-2138-multi-module-ir-overlay.test.ts tests/ir/inline-small.test.ts tests/ir/phase3c.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
pnpm run check:ir-only -- --policy=hybrid
pnpm run check:ir-fallbacks -- --verbose
pnpm run typecheck
pnpm run lint
pnpm run format:check
node scripts/equivalence-gate.mjs
pnpm exec vitest run tests/cross-backend-diff.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

The PR report must include the source/unit/class/binding denominators, a
collision matrix, deterministic-order proof, old-vs-new telemetry diff, and
the byte-identity result for the non-collision corpus. A passing runtime sample
without distinct ABI IDs/slots is vacuous and does not close R1.
