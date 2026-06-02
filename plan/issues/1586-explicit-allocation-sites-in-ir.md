---
id: 1586
title: "IR preparation: explicit allocation sites with stable identity and metadata hooks"
status: done
created: 2026-05-23
updated: 2026-05-24
completed: 2026-05-24
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: compiler
language_feature: compiler-internals
goal: platform
sprint: 55
required_by: [747, 1585, 1587, 1588]
es_edition: n/a
---
# #1586 — IR preparation: explicit allocation sites with stable identity and metadata hooks

Foundational IR refactor that makes every value-creation site in the
intermediate representation a first-class, identifiable, annotatable node.
This is the prerequisite for any future static analysis that needs to reason
about allocations — escape analysis, lifetime analysis, ownership tracking
(#1587), and the dual-target IR architecture (#1585).

The issue is intentionally narrow: it does not perform any new analysis. It
prepares the IR so that subsequent analyses *can* be added without
re-plumbing every pass.

## Goal

After this issue:

1. Every operation that brings a new value into existence is an explicit
   `AllocSite` node (or carries an `AllocSite` annotation), addressable by
   subsequent passes.
2. Each `AllocSite` has a stable identifier that survives IR transformations
   — inlining, constant folding, dead-code elimination must either preserve
   the ID, transfer it to a fused node, or explicitly mark it as deleted.
3. A documented metadata API allows passes to attach typed annotations to
   `AllocSite` nodes (e.g. `escapes: true`, `lifetime: function-local`,
   `encoding: utf8-guaranteed`) without modifying the IR core.
4. No behavioral changes. The existing test suite (unit, equivalence,
   test262, differential) passes unchanged before and after.

## Why this is a prerequisite

Several pending compiler enhancements depend on the IR being able to answer
"where was this value allocated, and what do we know about it?" reliably
across passes:

- **Ownership and access semantics analysis (#1587)** — needs allocation
  sites as analysis anchor points.
- **Dual-target IR architecture (#1585)** — the long-term ability to target
  linear memory requires lifetime annotations on allocation sites.
- **String encoding tracking (#1588)** — tags strings at their origin
  (allocation site) and propagates through.
- **Escape analysis for closure-capture optimization** — currently implicit;
  becomes explicit and reusable.

Each of these can be implemented independently *if* the IR provides stable,
annotatable allocation sites. Without it, each analysis has to recover the
information itself, and the results do not compose.

## Current state (to be confirmed during implementation plan)

The current IR mixes explicit and implicit allocation:

- **Explicit**: object literals, array literals, function declarations,
  class instantiations, explicit `new`-expressions. These already have
  dedicated IR nodes.
- **Implicit**: string concatenation result objects, intermediate values
  from spread/rest, arguments objects, template-literal cooked/raw arrays,
  return values from built-ins that allocate.
- **Black-box**: allocations performed inside built-in implementations are
  not visible to the IR and remain so under this issue.

The "implicit" category is where the cleanup happens. The audit step of the
implementation plan must enumerate every such case.

## Design

### `AllocSite` node shape

```ts
interface AllocSite {
  id: AllocSiteId;          // stable across passes
  kind: AllocKind;           // 'object' | 'array' | 'string' | 'closure' | …
  type: IRType;              // what is being allocated
  origin: SourceLocation;    // for diagnostics and source maps
  metadata: AllocMetadata;   // open map for analysis annotations
}
```

`AllocSiteId` is a numeric ID assigned at IR construction. Passes that
fuse or replace nodes must update the IR's allocation-site registry to
reflect provenance:

```ts
interface AllocSiteRegistry {
  resolve(id: AllocSiteId): AllocSite | null;
  alias(from: AllocSiteId, to: AllocSiteId): void;  // for fusion
  retire(id: AllocSiteId): void;                     // for deletion
}
```

### Metadata API

Annotations are typed by namespace + key, written and read through the
registry:

```ts
registry.annotate(id, 'ownership', { kind: 'owned' });
registry.read(id, 'ownership'); // → { kind: 'owned' } | undefined
```

Namespace prevents collision between analyses; each analysis owns its own
namespace and may not write to others.

### Pass discipline

Three rules every pass must follow after this issue lands:

1. **Preserve IDs through value-preserving transformations.** If a pass
   rewrites `x = new Foo()` to `x = inlined-foo-body`, the resulting value
   must carry the original `AllocSite` ID.
2. **Alias IDs through fusion.** If two allocations are fused (e.g. by
   common subexpression elimination), the registry records the alias.
3. **Retire IDs on deletion.** If a pass proves an allocation dead and
   removes it, the registry is informed so downstream passes do not see
   stale references.

Verification: a debug-mode invariant checker walks the IR after each pass
and asserts that every value with an allocation provenance resolves
through the registry to a live or retired entry.

## Scope

1. Audit the existing IR for implicit allocations. Produce a list in the
   implementation plan; convert each to an explicit `AllocSite` node or
   annotation.
2. Implement the `AllocSiteRegistry` with the API above.
3. Update every existing IR pass to follow the three pass-discipline rules.
   This is the bulk of the work — each pass must be reviewed and patched
   if it currently loses provenance.
4. Add the debug-mode invariant checker. Make it a CI gate at least in
   `pnpm typecheck` or a dedicated check.
5. Document the API and discipline in a new ADR. The ADR should
   cross-reference #1587, #1588, and #1585 as known consumers.
6. No new analyses in this issue. The hooks are added; the analyses come
   in follow-up issues.

## Non-goals

- Performing any new analysis (ownership, lifetime, escape, encoding) —
  those are #1587, #1588, and future issues.
- Changing the IR's external semantics. All test suites must pass
  unchanged.
- Reaching into built-in implementations to expose their internal
  allocations. Built-ins remain black boxes at the IR level; if a future
  analysis needs visibility inside a built-in, that built-in is rewritten
  to expose its allocations or a separate mechanism is added.
- Tracking allocation sites in the bytecode interpreter (#1584). The
  interpreter is a separate concern; the registry is for the AOT IR.
  Future work can extend it.

## Relationship to other issues

- **#1587** (ownership and access semantics analysis) — hard dependency on
  this issue. The analysis pass reads from and writes to `AllocSite`
  metadata.
- **#1588** (string encoding tracking) — hard dependency on this issue.
  Encoding annotations live on string `AllocSite` nodes.
- **#1585** (dual-target IR architecture) — long-term consumer. The
  defensive-design checklist in #1585 point 3 ("Allocation sites
  identified explicitly") is satisfied by this issue.
- **#1584** (Wasm-GC-native bytecode interpreter) — orthogonal. Does not
  block this issue, does not depend on it.

## Acceptance criteria

- [ ] Implementation plan enumerates every implicit allocation in the
      current IR with an audit table (source location, kind, planned
      conversion to explicit `AllocSite`).
- [ ] `AllocSiteRegistry` implemented under `src/ir/alloc-registry.ts`
      (or equivalent).
- [ ] All existing IR passes patched to preserve, alias, or retire IDs
      per the three pass-discipline rules.
- [ ] Debug-mode invariant checker added and runs in CI.
- [ ] ADR-XXX (`docs/adr/`) documents the API, discipline, and known
      consumers.
- [ ] All existing test suites (`npm test`, `pnpm run test:262`,
      `pnpm run test:diff`) pass with no new failures and no behavioral
      changes vs. baseline.
- [ ] No new failing test262 cases. No new differential-testing
      mismatches.

## Risks

- **Audit incompleteness.** An implicit allocation missed in the audit
  remains invisible to downstream analyses. Mitigation: invariant checker
  is conservative — if a value appears without provenance, it is flagged.
  Forces audit gaps to surface during CI rather than later.
- **Performance regression from registry overhead.** The registry is
  consulted on every IR transformation. Mitigation: implement as a flat
  array indexed by ID, not a hash map; benchmark on a representative
  test262 subset before merging.
- **Pass-discipline drift over time.** Future passes may forget to update
  the registry. Mitigation: the invariant checker catches violations in
  CI; ADR documents the rules clearly.
- **Scope creep into analysis work.** Tempting to add "just one simple
  analysis" while doing the plumbing. Mitigation: explicit non-goal; any
  analysis is a separate issue.

## Notes

- This issue is **infrastructure**, not feature work. It produces no
  user-visible behavior change. Its value is enabling subsequent issues to
  be smaller and more focused.
- The pattern (registry + per-pass discipline) is the same one LLVM uses
  for its `Value` provenance and MLIR uses for its op-attribute system.
  Worth referencing in the ADR.
- The work can plausibly run in parallel with built-in expansion work,
  since the audit and registry implementation touch the IR core and IR
  passes, not the built-in library.
- A natural sprint shape: week 1 audit + ADR draft, weeks 2–3 registry
  implementation + pass patching, week 4 invariant checker + CI
  integration + ADR finalization.

## Implementation Plan

> Authored after reading `src/ir/{types,nodes,builder,verify,integration}.ts`
> and `src/ir/passes/{constant-fold,dead-code,inline-small,monomorphize}.ts`
> against `origin/main` @ `e114fe378`. Line numbers are anchors as of that
> commit — re-grep before editing.

### Root cause / current state (confirmed)

The IR (`src/ir/`) is a typed SSA representation. Three facts shape this design:

1. **`IrValueId` is NOT a stable allocation identity.** `IrValueId`
   (`nodes.ts:355`) is a per-function, branded SSA index minted by
   `IrValueIdAllocator` (`nodes.ts:362`). Two passes *renumber* it:
   - `inlineSmall` (`passes/inline-small.ts:112`) remaps every callee value id
     into a fresh caller-scope range (`nextValueId = caller.valueCount`,
     `calleeRename` map at `:175`).
   - `monomorphize` clones whole functions, re-running the builder.
   So an allocation's `IrValueId` does **not** survive inlining or
   specialization. The stable identity must be a **separate, module-global
   id** that travels *on the instruction*, independent of `IrValueId`.

2. **Allocation sites are already explicit as instr *kinds*** — there is no
   "implicit allocation" hiding in arithmetic. Every value-creating op is a
   distinct `IrInstr` variant (audit table below). What's missing is (a) a
   stable cross-pass id on each, and (b) a metadata channel. The issue's
   "implicit" framing predates the IR's current shape; the real work is
   *threading identity + metadata through existing alloc instrs and the
   passes that rewrite them*, not inventing new nodes.

3. **`IrInstrBase` already carries an optional `site: IrSiteId`**
   (`nodes.ts:401-408`, line/column only). The allocation-site id and
   metadata hook attach to the same base interface, so *every* instr variant
   inherits them with zero per-variant edits. Lowering and the verifier
   already tolerate `site` being absent, so an optional `alloc` field is
   non-breaking.

There is no allocation registry, no metadata map, and no invariant checker
today. `verifyIrFunction` (`verify.ts:30`) is per-function and structural
(SSA dominance, type agreement) — the natural host for the new checker.

### Audit table — value-creating IR instrs (the "allocation sites")

Every instr below brings a fresh heap value into existence and must receive an
`AllocSiteId`. Source is `src/ir/nodes.ts`. "WasmGC op" is what `lower.ts`
emits.

| `kind` | nodes.ts | AllocKind | WasmGC lowering | Notes |
|--------|----------|-----------|-----------------|-------|
| `object.new` | 755 | `object` | `struct.new $obj_<shape>` | object literal |
| `closure.new` | 806 | `closure` | `struct.new $closure_*` | captures escape analysis (#747) anchor |
| `refcell.new` | 860 | `refcell` | `struct.new $refcell` | mutable-capture box |
| `class.new` | 916 | `object` | `call $<Class>_new` (alloc inside) | ctor allocates; site is the call, body is black-box |
| `extern.new` | 1380 | `extern` | `call $<Class>_new` | opaque externref handle |
| `extern.regex` | 1450 | `extern` | `call RegExp_new` | RegExp literal |
| `string.const` | 703 | `string` | `array.new_fixed` + `struct.new $NativeString` (native) / interned | #1588 encoding anchor |
| `string.concat` | 714 | `string` | `String_concat` / `array.new_*` | #1588 anchor; **intermediate** value |
| `box` | 656 | `box` | `__box_number` / struct.new | f64→externref boxing |
| `iter.new` | 1183 | `iterator` | iterator object alloc | for-of protocol |
| `gen.epilogue` | (≈1314) | `generator` | `__create_generator(buffer)` | Generator object |
| `gen.push` | (≈1168) | — | buffer append, no fresh alloc | NOT an alloc site (mutates buffer) |
| array-literal path | via `vec`/`object.new` | `array` | `array.new_fixed` | confirm: arrays currently route through `object.new`/legacy; if a dedicated `array.new` IR instr is absent, mark arrays as **black-box (legacy path)** and note in ADR |

**Black-box (explicitly out of scope, per Non-goals):** allocations inside
`<Class>_new`, `RegExp_new`, `String_concat`, `__create_generator`, and any
built-in body. The IR sees the *call*, tags the *call's result* as the alloc
site, and does not descend into the callee.

The audit is **closed by construction**: the verifier (below) flags any
SSA value whose defining instr is in the alloc-kind set but lacks an
`AllocSiteId`. New alloc instr kinds added later trip the same check.

### Design — three pieces

#### 1. `AllocSiteId` + the `alloc` field on `IrInstrBase`

`src/ir/nodes.ts`:

```ts
/** Module-global, stable across inlining/monomorphize. Distinct from IrValueId. */
export type AllocSiteId = number & { readonly __brand: "AllocSiteId" };
export function asAllocSiteId(n: number): AllocSiteId { return n as AllocSiteId; }

export type AllocKind =
  | "object" | "array" | "string" | "closure"
  | "refcell" | "box" | "extern" | "iterator" | "generator";
```

Extend `IrInstrBase` (`nodes.ts:401`) — **one edit, inherited by all variants**:

```ts
export interface IrInstrBase {
  readonly result: IrValueId | null;
  readonly resultType: IrType | null;
  readonly site?: IrSiteId;
  /** Present iff this instr is a value-creating (allocation) site. */
  readonly alloc?: AllocSiteId;   // NEW
}
```

Rationale for putting the id on the instr (not on the `IrValueId`): instrs are
the thing passes clone/rewrite, and they carry it through naturally as a plain
data field; an id keyed on `IrValueId` would be invalidated by every renumber.

#### 2. `AllocSiteRegistry` — module-global, flat-array backed

New file `src/ir/alloc-registry.ts`. **Flat array indexed by id, not a Map**
(per the Risks section — registry is consulted on every transform):

```ts
export interface AllocSite {
  readonly id: AllocSiteId;
  readonly kind: AllocKind;
  readonly type: IrType;
  readonly origin?: IrSiteId;          // reuse the instr's site (line/col)
  // metadata is stored out-of-band in the registry, keyed by id+namespace
}

type Provenance =
  | { state: "live"; site: AllocSite }
  | { state: "aliased"; to: AllocSiteId }   // fusion: this id folded into `to`
  | { state: "retired" };                    // proven dead + removed

export class AllocSiteRegistry {
  private readonly sites: Provenance[] = [];   // index === AllocSiteId
  // metadata[id] = Map<namespace, unknown>
  private readonly meta: (Map<string, unknown> | undefined)[] = [];

  fresh(kind: AllocKind, type: IrType, origin?: IrSiteId): AllocSiteId {
    const id = asAllocSiteId(this.sites.length);
    this.sites.push({ state: "live", site: { id, kind, type, origin } });
    return id;
  }

  /** Resolve through alias chains to the canonical live site, or null if retired/unknown. */
  resolve(id: AllocSiteId): AllocSite | null {
    let cur = this.sites[id as number];
    const seen = new Set<number>();              // cycle guard
    while (cur && cur.state === "aliased") {
      if (seen.has(cur.to as number)) return null;
      seen.add(cur.to as number);
      cur = this.sites[cur.to as number];
    }
    return cur && cur.state === "live" ? cur.site : null;
  }

  alias(from: AllocSiteId, to: AllocSiteId): void { /* set sites[from] = {aliased,to}; merge meta into `to` */ }
  retire(id: AllocSiteId): void { /* set sites[id] = {retired} */ }
  isKnown(id: AllocSiteId): boolean { /* index in range */ }

  // --- metadata API (namespaced; each analysis owns one namespace) ---
  annotate<T>(id: AllocSiteId, ns: string, value: T): void { /* resolve canonical id, write meta[id].set(ns,value) */ }
  read<T>(id: AllocSiteId, ns: string): T | undefined { /* resolve canonical id, meta[id]?.get(ns) */ }
}
```

Reserved namespaces (documented in the ADR, enforced by convention only in
this issue): `"ownership"` (#1587), `"encoding"` (#1588), `"lifetime"` (#1585),
`"escape"` (closure-capture follow-up). `annotate` resolves alias chains so a
write after fusion lands on the canonical site.

**Where the registry lives:** one registry per `IrModule` compile. Thread it
through `integration.ts` — created once in the function that drives the build
(near where `built: BuiltFn[]` is assembled, before `runHygienePasses`), then
passed into each pass invocation. Do **not** make it a per-function singleton
(inlining merges functions; ids must be module-stable).

#### 3. Builder wiring — mint ids at construction

`src/ir/builder.ts`. The builder is per-function but takes the shared registry
by constructor injection:

```ts
constructor(
  private readonly name: string,
  private readonly resultTypes: readonly IrType[],
  private readonly exported = false,
  private readonly allocRegistry?: AllocSiteRegistry,   // NEW, optional for test builders
) {}
```

Add a private helper and call it from every alloc-emitting method:

```ts
private allocId(kind: AllocKind, type: IrType, site?: IrSiteId): AllocSiteId | undefined {
  return this.allocRegistry?.fresh(kind, type, site);
}
```

Patch each alloc emitter to set the `alloc` field. Example for
`emitObjectNew` (`builder.ts:298`):

```ts
const alloc = this.allocId("object", resultType, /* site */);
this.pushInstr({ kind: "object.new", shape, values: [...values], result, resultType, alloc });
```

Same one-line addition in: `emitClosureNew` (:356), `emitRefCellNew`,
`emitClassNew`, `emitExternNew`, `emitRegExpLiteral` (:651),
`emitStringConst` (:257), `emitStringConcat` (:265), `emitBox`,
`emitIterNew`, `emitGenEpilogue`. (Grep the audit table kinds; each has one
`pushInstr` call.) Leave non-alloc emitters untouched — they simply never set
`alloc`, and the verifier expects exactly that.

### Pass discipline — the three rules, per pass

Each pass that rewrites instrs must keep registry provenance honest.

**`passes/inline-small.ts` (rule 1: preserve).** When the callee instr is
re-emitted into the caller with a renamed `result` (`:175`, the
`calleeRename` loop / `rewriteOperands` at `:326`), **copy the `alloc` field
verbatim** — do NOT mint a new id. `rewriteOperands` already preserves
`result`; extend it (or the clone helper) to preserve `alloc`. The same
allocation now lives at a new `IrValueId` but the SAME `AllocSiteId` — exactly
the invariant #1587/#747 need. *Inlining the same callee twice* duplicates the
allocation statically; for that case mint a fresh id per inlined copy via
`registry.fresh(...)` seeded from `registry.resolve(originalId)`'s kind/type
(an inlined copy is a genuinely distinct runtime allocation). Document this
"clone forks the id" decision in the ADR.

**`passes/constant-fold.ts` (rule 3: retire).** When CF replaces an instr with
`{ kind: "const", ... }` (`:119`, `:133`) and the original instr had an
`alloc` field, call `registry.retire(originalAlloc)` — a folded-away string
const, e.g., no longer allocates. The replacement `const` carries no `alloc`.

**`passes/dead-code.ts` (rule 3: retire).** `shouldKeep` filters dead instrs
(`:71`, `:260`). Before dropping an instr with an `alloc` field, call
`registry.retire(instr.alloc)`. This is the dominant retire path (DCE removes
the most allocs).

**`passes/monomorphize.ts` (rule 1: preserve / fork).** Cloning a function for
a specialization re-runs construction. Treat each clone like inlining: a
specialized copy is a distinct allocation set, so **fork fresh ids** (kind/type
copied from the source site). Preserve within a single clone.

**`passes/simplify-cfg.ts`.** Moves/merges blocks but does not create or
destroy alloc instrs — no registry interaction needed. Add a one-line comment
asserting this so future edits don't silently violate it.

CSE / fusion (rule 2: alias) has **no current pass** — there is no CSE in the
pipeline today. Implement `alias()` in the registry so the hook exists for a
future CSE pass, document it in the ADR, but do not add a CSE pass here.

### Invariant checker

Add `verifyAllocProvenance(func, registry)` to `src/ir/verify.ts` (or a sibling
`verify-alloc.ts` re-exported from `index.ts`). Walk every block/instr:

1. If `instr.kind` is in the alloc-kind set (audit table) **and** the function
   is not on the legacy/black-box path → assert `instr.alloc !== undefined`
   and `registry.resolve(instr.alloc) !== null` (live, not retired — a live
   instr must not reference a retired id).
2. If `instr.alloc !== undefined` → assert `registry.isKnown(instr.alloc)`
   (no dangling ids) and that `resolve(...).kind` matches the instr's expected
   `AllocKind`.
3. Gate the whole walk behind a debug flag (env `IR_VERIFY_ALLOC=1` or the
   existing IR debug switch) so it's free in production but **on in CI**.

Hook it in `integration.ts` at the existing verify call sites:
`runHygienePasses` boundaries — after `:328` (post-hygiene), `:356`
(post-inline), `:408` (post-mono). Add the alloc check alongside the existing
`verifyIrFunction(...)` calls so a pass that loses provenance fails CI at the
same gate that already catches malformed SSA.

CI integration: add `IR_VERIFY_ALLOC=1` to the `quality` job env in
`ci.yml` (the job that runs `pnpm typecheck` + IR unit tests), and to the IR
unit-test command. No new workflow — reuse `quality`.

### Migration path (incremental, non-breaking at every step)

1. **Land types only** — `AllocSiteId`, `AllocKind`, the optional `alloc`
   field, and `AllocSiteRegistry`. No emitter sets it yet; no behavior change.
   Ship + verify green.
2. **Wire the builder** — inject the registry, set `alloc` on every audit-table
   emitter. Registry is populated but unused by passes. Verify green.
3. **Patch passes** one at a time (DCE → CF → inline → mono), each with the
   retire/preserve/fork rule. After each, run the checker locally.
4. **Turn on the checker in CI** (`IR_VERIFY_ALLOC=1`) only after all passes
   are patched — otherwise step 3's intermediate states trip it.
5. **ADR + cross-references** last, once the API is final.

Because `alloc` is optional and lowering ignores it, the binary output is
**byte-identical** before and after every step — this is the key safety
property and the basis for the acceptance criterion "no behavioral changes."

### ADR

New `docs/adr/0013-ir-allocation-sites.md` (next number after `0012`).
Cover: the `IrValueId`-vs-`AllocSiteId` distinction and *why* identity lives on
the instr, the registry's flat-array design + alias/retire/resolve semantics,
the three pass-discipline rules with the "clone forks the id" decision, the
namespace ownership table, and the LLVM `Value`-provenance / MLIR op-attribute
prior art. Cross-reference #1587 (ownership, `"ownership"` ns), #1588
(encoding, `"encoding"` ns), #1585 (lifetime, `"lifetime"` ns). Add a row to
`docs/adr/README.md`.

### Files touched (summary)

| File | Change |
|------|--------|
| `src/ir/nodes.ts` | `AllocSiteId`, `AllocKind`, `asAllocSiteId`; `alloc?` on `IrInstrBase` |
| `src/ir/alloc-registry.ts` | **new** — `AllocSiteRegistry`, `AllocSite`, metadata API |
| `src/ir/index.ts` | re-export `alloc-registry.js` |
| `src/ir/builder.ts` | registry ctor param, `allocId` helper, set `alloc` on ~11 emitters |
| `src/ir/passes/dead-code.ts` | retire on drop |
| `src/ir/passes/constant-fold.ts` | retire on fold-away |
| `src/ir/passes/inline-small.ts` | preserve within clone / fork across clones |
| `src/ir/passes/monomorphize.ts` | fork ids per specialization |
| `src/ir/passes/simplify-cfg.ts` | comment-only assertion (no-op) |
| `src/ir/verify.ts` (or `verify-alloc.ts`) | `verifyAllocProvenance` |
| `src/ir/integration.ts` | create + thread registry; call checker at verify boundaries |
| `.github/workflows/ci.yml` | `IR_VERIFY_ALLOC=1` in `quality` |
| `docs/adr/0013-ir-allocation-sites.md` + `README.md` | ADR |

### Test plan

- **Unit (`tests/ir/`)**: new `alloc-registry.test.ts` — fresh→resolve,
  alias chain resolution + cycle guard, retire→resolve-null, annotate/read
  per-namespace, alias merges metadata onto canonical. New
  `alloc-provenance.test.ts` — build a function with an `object.new`, run DCE
  on a dead copy → asserts `retire` called and checker passes; inline a callee
  twice → asserts two distinct live ids; const-fold a `string.concat` of two
  consts → original alloc retired.
- **Checker-as-gate**: a deliberately-broken pass fixture (drops an alloc instr
  *without* retiring) → `verifyAllocProvenance` must throw. Proves the gate
  catches discipline drift (Risk: pass-discipline drift).
- **No-regression (the load-bearing criterion)**: `npm test` (equivalence) and
  the full `pnpm run test:262` must show **byte-identical** emitted Wasm and
  identical pass/fail counts vs. the `e114fe378` baseline. Because `alloc` is
  inert at lowering, any diff signals a bug. Run `pnpm run test:diff` for the
  differential check.
- **Perf**: micro-benchmark the registry on a representative test262 subset
  (the Risks section calls for this) — flat-array `fresh`/`resolve` should be
  O(1); confirm no measurable compile-time regression before merge.

### Risks / notes for the dev

- **Do not key identity on `IrValueId`** — it is renumbered by inline + mono.
  This is the single most important constraint; the whole point of the issue
  fails if violated.
- **Inlining/mono fork, not preserve, across copies** — a statically duplicated
  allocation is a distinct runtime allocation. Preserve only *within* one
  clone. Get this wrong and #747 escape analysis will conflate two allocations.
- **Optional `alloc` keeps it non-breaking** — existing IR unit tests construct
  instrs without it; lowering ignores it; verify tolerates its absence except
  on the gated alloc-provenance path. Keep it optional permanently for
  test-builder ergonomics.
- **Arrays**: confirm during impl whether a dedicated array-literal IR instr
  exists or arrays route through `object.new`/legacy. If legacy, mark arrays
  black-box in the ADR and add the `array.new` IR instr in a follow-up — do
  not expand scope here.
