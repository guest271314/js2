---
id: 2660
title: "Whole-program escape/dynamic-use gate for reconstructing `new F()` instances as `$Object` (value-rep infra)"
status: in-progress
assignee: ttraenkler/sd-s3a
sprint: 66
created: 2026-06-25
priority: medium
feasibility: hard
reasoning_effort: max
task_type: infra
area: codegen, value-rep, analysis
language_feature: constructor functions, prototype chain, dynamic property access
goal: test262-conformance
related: [2580, 1888, 1712, 1100, 2009, 747]
---

# #2660 — Whole-program escape/dynamic-use gate for `new F()` instance reconstruction (value-rep infra)

## Why this issue exists

This is the **infrastructure blocker** that three independent max-reasoning
sessions (#2580 Stage A, Stage B, B-fnctor) all converged on. It is filed
SEPARATELY from #2580 because it is **general value-rep infrastructure**, not the
B-fnctor symptom — it gates any future "represent a statically-typed WasmGC value
as a dynamic `$Object` when it is consumed dynamically" reconstruction, of which
B-fnctor (`new F()` instances participating in the `$Object.$proto` walk) is the
first consumer.

**This is a SPEC deliverable. No implementation should be attempted until this
plan is reviewed.** The B-fnctor build (#2580 last lap) waits on this infra.

## Problem statement (the precise blocker)

A `new F()` instance is lowered to a bespoke closed WasmGC struct
`$__fnctor_<Name>` (`src/codegen/expressions/new-super.ts:998-1007`). It is NOT an
`$Object` and has no `$proto` field, so:

- Its element/property reads do **not** route through `__extern_get` /
  `__extern_get_idx` / the `$Object.$proto` walk. Verified per-process on current
  main: in `some/15.4.4.17-7-c-i-15` (`Con.prototype=proto; child=new Con();
  some.call(child, cb)`), `__extern_get_idx` is **never called** for `child[1]` —
  the generic-method array-like read path doesn't recognize the fnctor struct.
- So inherited-prototype reads on `new F()` instances (the ~51-file `.prototype=`
  cluster, #2580 B-fnctor) cannot resolve.

The ONLY correct fix (architect decision ii-a, #2580) is to make the instance
participate in the **one** `$Object.$proto` walk — i.e. **reconstruct the
instance as an `$Object`** (or an `$Object`-participating shape) when it is
consumed dynamically.

**The hazard (the #1888-floor eject):** a `new F(){ this.x = 3 }` instance with a
typed own-field consumer reads `c.x` via `ref.test $__fnctor_F → struct.get
$__fnctor_F <fieldIdx>` (the hot path — verified in the WAT). Reconstructing the
instance as an `$Object` **unconditionally** would move every such typed own-field
read onto `__extern_get`/`__extern_set`, regressing the hot path and ejecting the
standalone floor (#2097) — the documented #1888-class stop-the-line failure. So
the reconstruction MUST be gated to fire ONLY when it cannot regress a typed
own-field read.

## Implementation Plan (architect spec)

### 1. The gate predicate — precise enough to implement

Reconstruct a `new F()` allocation site as an `$Object`-participating instance
**iff BOTH hold** (conjunction — either alone is unsafe):

- **(A) Dynamically consumed** — at least one read/write of the instance (or a
  value flow-reachable alias of it) goes through a *dynamic* access site:
  `__extern_get` / `__extern_set` / `__extern_get_idx` / `__extern_has_idx` /
  generic-method `.call`/`.apply` array-like dispatch / `Object.*` reflection.
  Equivalently: the instance's static type at some use is `any`/`unknown`, OR it
  is passed to a parameter/return typed `any`, OR it is the receiver of an
  unresolved (non-`struct.get`) member access.
- **(B) No typed own-field consumer** — NO use of the instance (or an alias)
  resolves to a typed `struct.get $__fnctor_F <fieldIdx>` / `struct.set` on the
  bespoke fnctor struct. I.e. the instance is never read through its concrete
  static class type. (This is the hot-path-protection clause — it is what makes
  reconstruction floor-safe.)

**Conservative default = do NOT reconstruct.** A site that the analysis cannot
prove satisfies (A)∧(B) keeps the current bespoke-struct lowering (status quo,
zero regression). Reconstruction is an *opt-in* that only fires on proven-safe
sites — so an imprecise/incomplete analysis loses rows but never ejects the floor.
This is the critical inversion: the gate's failure mode must be "miss a B-fnctor
row," never "regress a typed `new F()`."

A site satisfying (A) but NOT (B) (consumed BOTH dynamically and via a typed
field) is the genuinely-hard mixed case — **out of scope for v1; keep status quo
(typed struct) and let the dynamic read miss.** v1 targets the pure-dynamic
instances (A∧B), which is exactly the test262 B-fnctor cluster (the instances
there have no typed field reads — they're read only via generic-method `.call`).

### 2. Where/when it runs, and relation to the existing IR escape analysis

- **Placement:** a **whole-program** pre-pass over the AST/IR, BEFORE
  `compileNewExpression` decides the instance lowering in
  `new-super.ts`. It must be whole-program because aliasing (B) requires seeing
  every use of the instance across function boundaries (the instance can be
  returned, stored in a field, passed as an arg). A per-function pass cannot
  prove (B).
- **Relation to `ir/integration.ts` `analyzeEscape` (#747):** that is a
  *different* analysis — it classifies *closure/allocation escape* for
  scalar-replacement/stack-allocation (does an alloc outlive its frame), gated by
  `JS2WASM_IR_ESCAPE`, currently inert. It is NOT a dynamic-use classifier. This
  gate (#2660) asks a different question ("is this instance read through a dynamic
  vs a typed-field site"). They MAY share the alias/ownership oracle
  (`analyzeOwnership`'s alloc-site registry) — recommend building #2660 on top of
  that oracle rather than a fresh aliasing engine — but the *classification* is
  new. Document them as siblings, not the same pass.
- **Output:** a `Set<allocSiteId>` of `new F()` sites approved for reconstruction,
  consulted by `compileNewExpression`.

### 3. The `$Object` reconstruction path + interaction with `$__fnctor_<Name>` / `_fnctorProtoLookup`

For an approved site:

- Allocate the instance via `__new_plain_object` (a real `$Object`) instead of
  `struct.new $__fnctor_<Name>` (`new-super.ts:1092`). The ctor body's
  `this.x = …` writes become `__extern_set($Object, "x", …)` (they already have a
  dynamic-write lowering for `any`-typed `this`).
- Seed the instance's `$proto` from F's prototype. **This is where #1712's
  `_fnctorProtoLookup` machinery converges with the `$Object.$proto` walk:** the
  per-fnctor prototype must live in ONE readable location. Two sub-options for the
  architect to pick during the build:
  - **(3a)** Keep the host `_fnctorProtoLookup` path (instance→ctor→vivified
    `.prototype` sidecar) AND additionally write the instance's `$Object.$proto`
    to F.prototype-as-`$Object` at construction, so the existing `$Object` walk
    resolves inherited reads natively (host AND standalone). This requires
    `F.prototype = x` to land in a readable `$Object` location — today the whole
    reassignment lands on the `$6` closure trampoline struct, which `ref.test
    $Object` misses (#2580 Stage-B finding, `runtime.ts` closure-isn't-`$Object`).
    So (3a) ALSO needs a readable per-fnctor prototype `$Object` global keyed off
    the *closure global* (not the unreadable closure struct slot).
  - **(3b)** Standalone-native: synthesize a per-fnctor prototype `$Object` global
    (seeded from `F.prototype = …` writes, keyed by fnctor name →
    `ctx.fnctorPrototypeObject`), and set `instance.$proto` to it at construction.
    No host dependency.
  Recommend **(3b)** as the canonical path (dual-mode parity, the
  architecture-principles requirement) with (3a)'s host sidecar as the JS-host
  fast path. Either way: ONE link location (`$Object.$proto`), ONE walk — the
  invariant #2580 Stage A established.
- The indexed-read fnctor fallback (`_fnctorProtoLookup` wired into
  `__extern_get_idx`/`__extern_has_idx`) is then unnecessary for reconstructed
  instances (they ARE `$Object`s and walk natively) — but harmless to keep for
  the host non-reconstructed path. (Note: B-fnctor's attempt to wire ONLY that
  fallback banked 0 rows precisely because the instance never reaches those
  helpers — reconstruction is what routes it there.)

### 4. #1888-floor SAFETY argument (the crux)

Gated reconstruction CANNOT eject typed own-field reads because:

1. The gate's clause (B) **excludes** any site with a typed `struct.get
   $__fnctor_F` consumer. A reconstructed site provably has zero typed-field
   reads, so moving its reads to `__extern_get` changes nothing on the hot path
   (there were no hot-path reads to move).
2. The default is status-quo (no reconstruction), and reconstruction is opt-in on
   proven (A)∧(B) sites only. An incomplete/imprecise analysis therefore
   **under**-approximates the reconstruct set → loses B-fnctor rows but never
   touches a typed `new F()`. The failure mode is bounded to "0 rows," never
   "negative."
3. The bespoke `$__fnctor_<Name>` struct type, its inheritance ancestors
   (`new-super.ts:602/747`), and the ctor result type (`:1019`) are LEFT
   UNCHANGED for non-reconstructed sites — no closed-struct shape change, so the
   iso-recursive canonicalization hazard (#1100/#2009) is not re-entered.
4. **Validation gate:** the build MUST validate through the full merge_group
   standalone floor (#2097) + the test262 net-regression gate, NEVER a scoped
   sweep, with stop-the-line on ANY eject (broad-impact value-rep). A single
   `new F(){this.x}` typed-field regression in the floor = the gate's clause (B)
   has a hole; fix the analysis, do not weaken (B).

### 5. Slice breakdown + broader applicability

**Slices (each its own PR, full-floor-validated):**
- **S1 — the analysis (inert).** Whole-program (A)∧(B) classifier producing the
  approved-site set, behind a default-OFF flag, byte-identical Wasm (no lowering
  change yet). Mirror #747's inert-first rollout. Unit-test the predicate on the
  B-fnctor cluster shapes + a `new F(){this.x}`-typed control (must NOT be
  approved).
- **S2 — per-fnctor prototype `$Object`** (3b): `F.prototype = …` lands in a
  readable per-fnctor `$Object` global. Independently testable
  (`Object.create(F.prototype)` resolves) and useful on its own.
- **S3 — reconstruction lowering.** `compileNewExpression` consults the approved
  set; approved sites allocate as `$Object` + seed `$proto` from S2. Flip the flag
  ON. THIS is the floor-risk slice — full merge_group, stop-the-line.
- **S4 — B-fnctor cluster lands** as a consequence (the ~51 `.prototype=` files +
  the generic-method-on-`new F()` rows); measure per-process.

**Broader applicability (flag):** the (A)∧(B) dynamic-use gate is reusable for
ANY "statically-typed WasmGC value reconstructed as `$Object` on dynamic use"
work — e.g. the sparse-array `$Vec`→`$Object` reconstruction (#2001 tail), the
acorn dogfood dynamic-struct-read identity (#1712/#2582 family), and the M1/core
uniform-externref consumer paths. Building the gate as a general
`approvedForDynamicReconstruction(allocSiteId)` oracle (not a fnctor-specific
predicate) pays off across the value-rep lane. Recommend the architect generalize
the oracle interface in S1 even though B-fnctor is the first consumer.

## Acceptance (of the eventual build, not this spec)

- B-fnctor cluster (`some/every/.../15.4.4.*-c-i-*` `.prototype=` subset) flips to
  pass, measured per-process / one-fresh-process-per-file.
- ZERO regression in `new F(){this.x}` typed own-field reads + the standalone
  floor (#2097) across the FULL merge_group gate.
- The gate defaults safe (no reconstruction) on any site it cannot prove (A)∧(B).

## Provenance

Distilled from the #2580 M3 sessions (Stage A `2110d9a4`-era spec, Stage B
`2026-06-24` finding, B-fnctor `2026-06-25` verify-first) — see #2580 for the WAT
bisections and per-process evidence. Three independent max-reasoning sessions
reached option ii-a + this missing whole-program gate, so the blocker is real, not
session-specific.

---

# Implementation log

## S1 — inert (A∧B) escape/dynamic-use gate (LANDED, PR `9bf333da9870`)

`src/codegen/fnctor-escape-gate.ts` (`analyzeFnctorEscapeGate` →
`ctx.fnctorEscapeGate`), wired inert at `index.ts`. Per-`new F()` classification
`reconstruct` / `keep-typed` / `keep-static`, conservative-closed (unknown ⇒
keep). Stored, not yet consumed. Verified correct via `JS2WASM_LOG_FNCTOR_GATE=1`:
zero-own-field-dynamic → `reconstruct`; `function C(){this.x=3}` typed-field →
`keep-typed`; no-dynamic-use → `keep-static`; generic `.call` receiver →
`reconstruct`. (This is the #2580 B-f0 scaffold; the duplicated #2580 architect
spec was reconciled — see the #2580 cross-ref.)

## S2 — per-fnctor prototype `$Object` (standalone) — LANDED (this PR, 2026-06-26, sd-protoextend, max-reasoning)

> Verify-first, binaryen-decoded WAT + per-process probes on current main. The
> #2660 spec §3.1/(3b) ("synthesize a per-fnctor prototype `$Object` global,
> seeded from `F.prototype = …` writes, keyed by fnctor name →
> `ctx.fnctorPrototypeObject`") is implemented. REUSES the one `$Object.$proto`
> walk — no parallel `[[Prototype]]` mechanism.

### Root cause (re-grounded, standalone)

A user fnctor `F` is lowered to a closure trampoline struct (`$6`,
`struct.new $6 (ref.func $__fn_tramp_F_cached)`), **NOT** an `$Object`. WAT-decoded:
`F.prototype` reads as `__extern_get($closure, "prototype")` and writes as
`__extern_set($closure, …)`; both `ref.test $Object`-MISS → the write is dropped,
the read returns null. So `Object.create(F.prototype).foo` returned **0** (vs the
named-`$Object`-var control which returns 7 — the existing `$proto` walk is
correct, only F's prototype wasn't a readable `$Object`).

A **second, separate gap**: a TOP-LEVEL `F.prototype = …` statement is dropped
before any codegen — `declarations.ts`'s module-init collection only keeps an
assignment whose **root identifier is a module global**, and a fnctor `F` (a
function declaration) is NOT a module global, so the statement never reaches
`compilePropertyAssignment`. (Verified: `compileAssignment` is never called for a
top-level `Con.prototype = {…}` — only for the in-function form.)

### The fix (standalone-gated; host byte-identical)

`ctx.fnctorPrototypeObject: Map<fnctorName, globalIdx>` (a `mut externref` module
global per fnctor, holding a native `$Object`), in `src/codegen/expressions/fnctor-prototype.ts`:

- **READ `F.prototype`** (property-access.ts, early in `compilePropertyAccess`):
  `tryEmitFnctorPrototypeRead` lazy-inits an empty `$Object` (`__new_plain_object`)
  into the global on first access, then `global.get`. Returns externref.
- **WRITE `F.prototype = rhs`** (assignment.ts, top of `compilePropertyAssignment`):
  `tryCompileFnctorPrototypeAssign` builds `rhs` as a native `$Object` (plain
  object literal, the #2580 Stage-A `compileProtoArg` precedent) or coerces it to
  externref, then `global.set`.
- **WRITE `F.prototype.p = v`** rides the READ interception — the inner
  `F.prototype` read returns the global `$Object`, the existing
  `__extern_set_strict` fallback writes `p` onto it. No extra code.
- **Top-level statement keep-in-init** (declarations.ts module-init collection):
  `isFnctorPrototypeAssignTarget` keeps a top-level `F.prototype = …` /
  `F.prototype.p = …` in `__module_init` (mirrors the `Array.prototype` CPR
  keep-in-init), so it reaches the interception. Fixes the second gap.

`resolveFnctorSymbol` (exported from S1's `fnctor-escape-gate.ts`) is the SINGLE
fnctor-recognition predicate — it unwraps `( )`/`as`/`!` and matches only an
identifier resolving to a user `FunctionDeclaration`/`FunctionExpression`/
`var F = function` with a body. Classes (class fast path in property-access),
builtins (`Array.prototype`), arrows, and method receivers are all excluded.

### Hot-path / non-regression (C1)

Every site gates on `ctx.standalone`; host/GC mode never enters the new arms →
**byte-identical** (confirmed: the class `.prototype` fast path, named-var
`Object.create(p)`, typed array `.length`, and the whole host suite are
untouched). Module globals are append-only/index-stable, so minting one mid-compile
carries no late-import funcidx-shift hazard (#2043). The closed `$__fnctor_<Name>`
struct shape is NOT changed (no #1100/#2009 canonicalization re-entry).

### Standalone-floor EJECT (PR #2087 v1) + the RECONSTRUCT-GATE fix

The first S2 push (interception fired for **every** user fnctor's `.prototype`)
ejected the merge_group standalone floor (#2097): **49 standalone pass→fail
regressions, net −40** (tolerance −15). The global net-regression gate PASSED
(net +1) because the host lane masked it — the standalone floor is the only gate
that catches a standalone-specific drop. Two clusters, both an unscoped
interception clobbering a WORKING prototype path (bisected per-process):

- **5 `Array/prototype/{concat,filter,map,slice,splice}/create-proxy.js`** — the
  READ interception. `var Ctor = function(){}` is used as a `Symbol.species`
  constructor; `Object.getPrototypeOf(result)` must equal the runtime's
  `Ctor.prototype`, but the interception returned a DIFFERENT object (the empty
  per-fnctor global) → identity assertion failed.
- **44 `Iterator/prototype/*` + `Iterator/*`** — the keep-in-init. `sta.js` has
  `Test262Error.prototype.toString = function(){}`; keep-in-init made that
  previously-dropped top-level statement EXECUTE, perturbing module-init for the
  iterator-helper harness ("[object Object] is not iterable").

**Root cause:** S2 fired for fnctors that already have a working prototype path
(species `Ctor` never `new`'d in source; `Test262Error` is `keep-typed`). **Fix —
the RECONSTRUCT-GATE:** `resolveUserFnctorName` now additionally requires the
fnctor be in the S1 escape-gate `approvedNames` set (≥1 `reconstruct`-classified
`new F()` site) — exactly the constructors S3 reconstructs and whose prototype
needs to be a readable `$Object`. A `keep-typed` / `keep-static` / never-`new`'d
function keeps its existing prototype behaviour. The narrowing is a strict subset
of the prior firing (the 49 regressed files were ALL non-reconstruct, so
reconstruct-firing caused none of them), so it cannot introduce new regressions.
**Verified: all 49 previously-regressed files now pass (49/0) per-process**;
`approvedNames` is computed at index.ts:1076 (before collectDeclarations + codegen,
so it is always set for the read/write/keep-init gates). S2's unit tests now arm
`Con` as a reconstruct fnctor (`new Con()` + a dynamic instance read).

### Validation

New `tests/issue-2660-s2-fnctor-prototype-object.test.ts` (11 standalone cases:
whole-reassign, bare-identifier cluster shape, per-prop accumulate, indexed key,
function-expression fnctor, in-function write, own-shadows-inherited, + class /
named-var / array-`.length` regression guards) — green. tsc + prettier + biome
clean. Sibling standalone #2580 suites (m3-protochain / m3-protoextend / m3-bacc)
+ the S2 suite: **36/36 green**. `prototype-chain.test.ts` (6/5) and
`classes.test.ts` (7 fail) are **pre-existing host-harness artifacts — identical
on pristine origin/main** (A/B-verified; `buildImports` omits host runtime
imports), NOT this change.

Broad-impact value-rep → the authoritative gate is the **merge_group standalone
floor (#2097) + the test262 net-regression gate** (never a scoped sweep). Files:
`src/codegen/expressions/fnctor-prototype.ts` (new), `src/codegen/fnctor-escape-gate.ts`
(export `resolveFnctorSymbol`), `src/codegen/context/{types,create-context}.ts`,
`src/codegen/property-access.ts`, `src/codegen/expressions/assignment.ts`,
`src/codegen/declarations.ts`, `tests/issue-2660-s2-fnctor-prototype-object.test.ts`.

### Next (S3) — the floor-risk reconstruct

S3 wires `compileNewFunctionDeclaration`/`compileNewExpression` to consult
`ctx.fnctorEscapeGate.approved`: an approved `new F()` allocates an `$Object`
(own props via `__extern_set`) and seeds `instance.$proto` from
`fnctorPrototypeObject[F]` (S2's readable global). THIS is the #1888-floor
eject-risk slice — stop-the-line + escalate on ANY floor movement. Issue stays
`in-progress`.

## S3 — GROUNDING + IMPLEMENTATION PLAN + CARRY decision (2026-06-26, sd-protoextend, max-reasoning)

> Verify-first grounded against current `main` (S2 landed, `351c1803`). **Decision:
> CARRY S3 as a deliberate next slice** (per the lead's explicit offer) — it is the
> broad `new F()`-instance representation change the issue always sized at ~3–5
> days, NOT a one-pass safe slice, and rushing a representation change onto the
> #1888-floor lane right after S2 demonstrated the floor's sensitivity (49-row
> host-masked drop) is the documented eject hazard. S2 (the substrate: per-fnctor
> prototype `$Object` + the `approvedNames`/`approved` gate) is banked and clean;
> S3 builds on it with a precise plan below. NO S3 code landed.

### The dispatch + interception point (verified)

`compileNewFunctionDeclaration` (`new-super.ts:925`) is the single dispatch for
`new F()` on a user fnctor; it has the `NewExpression` node `expr`, so the gate
check is `ctx.fnctorEscapeGate?.approved.has(expr)` (node identity — exactly what
S1 keys on). `compileFnctorNew` builds the `$__fnctor_<Name>` struct + ctor and at
the call site (`:1209`) emits `call <ctor>` returning `{ kind: "ref", typeIdx:
structTypeIdx }` (`:1210`; ctor result type set at `:1040`).

### THE CRUX (why it is not a one-pass slice): the return-type / binding-type ripple

Reconstructing an approved `new F()` as an `$Object` changes the call-site result
from `(ref $__fnctor_F)` to **externref**. But the cluster's binding is NOT
`any`-typed: `var child = new Con()` types `child` as the **Con instance type →
`(ref $__fnctor_F)`** (TS infers the nominal instance type; only an explicit
`const c: any` widens it). So an approved instance's binding local is a
struct-ref, and a bare allocation swap would `local.set` an externref into a
struct-ref local → invalid Wasm / type mismatch. **S3 must therefore RE-TYPE the
binding local (and any param/return/field the instance flows into) to externref**,
not just change the allocation. The S1 gate guarantees no typed `struct.get`
own-field READ, but it does NOT guarantee the binding's static *type* is `any` —
so the re-typing is the load-bearing, broad-radius part. (A narrower gate that
ALSO requires an `any`-typed binding would be one-pass-safe but banks ~0 cluster
rows, because the cluster uses untyped `var child`.)

### Staged plan (each its own merge_group-floor-validated PR; stop-the-line)

- **S3a — empty-body approved fnctors, `any`-binding only (the canary, ~0–few
  rows, LOW risk).** Gate: `approved.has(expr)` AND the fnctor struct has 0 fields
  AND the binding is `any`/`unknown`-typed (or inline `new F().x`). Emit
  `__new_plain_object()` + seed `$proto` = `global.get(fnctorPrototypeObject[F])`
  (snapshot at construction — spec-correct: `new F()` captures `F.prototype` at
  construction; reuse `getOrMintFnctorProtoGlobal` from S2) + return externref. No
  ctor body to run (empty). No binding re-typing (already `any`). This is the
  zero-risk proof the allocation+`$proto`-seed path is sound; it does NOT bank the
  cluster (cluster bindings aren't `any`). Validates the mechanism on the floor.
- **S3b — binding re-typing for approved struct-typed instances (the cluster, the
  HIGH-risk core).** When `new F()` is approved, re-type the binding local /
  param / return that the instance flows into from `(ref $__fnctor_F)` to
  externref, so the reconstructed `$Object` flows through the dynamic-read +
  generic-method paths. This is the broad value-rep change; it needs a
  flow/binding-retype pass and full-floor validation with a fix-iterate budget
  (S2 took one). Hold behind S3a's floor result.
- **S3c — own-field approved fnctors (`this.x=` consumed only dynamically).**
  Reconstruct must run the ctor body with `this` bound to the `$Object` (each
  `this.x=` → `__extern_set(instance,"x",v)`). Most cluster fnctors are empty-body
  (CORRECTION 1), so this is a tail, not the bulk.
- **S3d / S4 — the generic-method cluster lands** as a consequence once
  reconstructed instances participate in the `$Object.$proto` walk + the indexed
  read path (`forEach.call(child,cb)` visits inherited indices). Residual needs the
  #983d method-dispatch body (track separately).

### Risk register (carry-forward)

- **Hot-path byte-identity (C1):** non-approved `new F()` (every typed/keep-static
  instance) keeps the bespoke struct + ctor verbatim — the reconstruct branch is
  the only change and fires only on `approved` (S1-conservative). Standalone-gated.
- **Floor sensitivity:** S2's eject (an over-broad READ interception, host-masked
  from the global gate) proves the #2097 standalone floor is the only gate that
  catches a standalone-specific drop — S3 MUST validate through the merge_group
  floor, stop-the-line + escalate on ANY floor movement, never a scoped sweep,
  never re-enqueue.
- **`$proto` snapshot ordering:** seed from `global.get(fnctorPrototypeObject[F])`
  at the `new F()` site (construction-time snapshot) — the cluster runs
  `F.prototype = proto` before `new F()`, so the global is populated; a later
  `F.prototype = …` reassignment correctly does NOT retro-change existing
  instances (spec §9.1.13).
- **Binding re-typing blast radius (S3b):** this is the part that can ripple into
  unrelated typed-instance handling if the retype is mis-scoped — the reason S3b is
  staged behind the S3a canary and budgeted a fix-iterate cycle.

### Files to touch (S3a first)

`src/codegen/expressions/new-super.ts` — `compileNewFunctionDeclaration` (`:925`,
add the `approved` + empty-body + any-binding gate) → a new
`compileFnctorNewAsObject` helper (allocate `$Object`, seed `$proto`, return
externref); reuse `getOrMintFnctorProtoGlobal` (export it from
`src/codegen/expressions/fnctor-prototype.ts`). New
`tests/issue-2660-s3-fnctor-reconstruct.test.ts` (standalone: `function Con(){};
Con.prototype={foo:7}; const c:any=new Con(); c.foo === 7`). Issue stays
`in-progress`; S2 banked, S3 carried.

## S3a — LANDED (the value-rep CANARY, 2026-06-26, sd-s3a, max-reasoning)

> Verify-first grounded against current `main` (S1+S2 landed, `6c5049b1`).
> Decoded the dispatch, the escape-gate result shape, the variable-binding
> local-typing path, and the late-import shift mechanism on current main before
> writing a line. **Verdict: S3a IS a clean one-pass low-risk slice** — the
> alloc + `$proto`-seed primitive already exists (`__object_create`), is a
> DEFINED function in standalone (no funcidx-shift hazard), and a real-local-type
> safety check makes the floor regression structurally impossible. No re-grounding
> surprises; no broad ripple entered.

### The fix (standalone-gated; host/WASI byte-identical)

`compileNewFunctionDeclaration` (`new-super.ts`) gates at the cache-MISS entry on
`ctx.standalone ∧ fnctorEscapeGate.approved.has(expr) ∧ empty-body ∧ no-args ∧
result-consumed-as-externref`, then calls the new `compileFnctorNewAsObject` →
`emitFnctorProtoGet(F)` (S2's lazy `$Object` global, now `export`ed) +
`__object_create(proto)` (ES §20.1.2.2: fresh `$Object` with `$proto` seeded in
ONE call) → returns externref. ONE `$Object.$proto` walk, ONE prototype identity;
no parallel `[[Prototype]]` mechanism. The bespoke `$__fnctor_<Name>` struct, its
ctor, and the cache are LEFT UNTOUCHED for every non-reconstructed site (no
#1100/#2009 canonicalization re-entry).

### The load-bearing safety check (why the floor can't move)

The cluster's binding is the nominal `(ref $__fnctor_F)` instance type, so a bare
alloc-swap (return externref) would `local.set` externref into a struct-ref local
→ invalid Wasm / `ref.cast` trap. S3a sidesteps that ripple (S3b's job) by reading
the **REAL allocated local type** (`getLocalType(fctx, localMap.get(name))`, not
the TS annotation — verified the `noLib` checker conflates `any` and inferred
`Con`) and reconstructing ONLY when that slot is already externref (the
`any`/`unknown` case) or the use is an inline `new F().x`/`[i]` receiver. Every
other shape (struct-typed local, module-global, call-arg, return) falls through to
status quo. The failure mode is bounded to a 0-row MISS, never a typed-field
regression — confirmed: `function C(){this.x=3}; const c=new C(); c.x` stays the
`struct.get` hot path (returns 3), and `const c = new Con()` (nominal struct
binding) safely declines (returns 0, no trap).

### Cache-order safe-miss (documented, not a bug)

The gate sits at the cache-miss entry. If a NON-approved sibling `new F()`
compiled first, it populated `funcConstructorMap[F]`; a later approved site then
hits that cache in `compileNewExpression` and keeps status quo WITHOUT reaching
the gate — a safe MISS (the struct ref coerces cleanly into the approved site's
externref binding), never a trap. S3b's binding-retype removes the miss.

### Validation

New `tests/issue-2660-s3-fnctor-reconstruct.test.ts` (11 standalone cases: canary
`c.foo`=7, bare-identifier reassign, inline `new Con().foo`, per-prop multi-key,
indexed proto key, function-expression fnctor, two-approved-sites, + 3 regression
guards: typed own-field stays struct/3, struct-binding declines/no-trap,
no-`F.prototype` empty proto) — **11/11 green**; S2 suite **10/10 green**. tsc +
`prettier --check` + `biome lint --diagnostic-level=error` clean. The
prototype-chain / classes / inheritance / #1888 vitest "failures" are
**pre-existing host-harness artifacts — A/B-verified BYTE-IDENTICAL on pristine
`origin/main`** (host-import LinkErrors / `string_constants` / `any+any`
arithmetic — none involve `new F()`), NOT this change. Host/WASI never enter the
reconstruct arm (gated on `ctx.standalone`) → byte-identical.

Broad-impact value-rep → the authoritative gate is the **merge_group standalone
floor (#2097) + test262 net-regression gate** (never a scoped sweep);
stop-the-line on ANY floor movement. Files: `src/codegen/expressions/new-super.ts`
(gate + `fnctorNewResultConsumedAsExternref` + `compileFnctorNewAsObject`),
`src/codegen/expressions/fnctor-prototype.ts` (export `emitFnctorProtoGet`),
`tests/issue-2660-s3-fnctor-reconstruct.test.ts`.

### Next (S3b) — the HIGH-risk binding-retype core

S3b re-types the binding local / param / return that an approved struct-typed
`new F()` instance flows into (from `(ref $__fnctor_F)` to externref), so the
reconstructed `$Object` flows through the dynamic-read + generic-method paths and
the test262 cluster lands. Held behind S3a's floor result; budget a fix-iterate
cycle (S2 took one). Issue stays `in-progress`.

## HANDOFF (2026-06-26, sd-2674c) — acorn #1712 endgame needs this keystone; validated READ-half component ready

The acorn dogfood (#1712) endgame converges on THIS issue. After #2085 fixed the
9th-wall hang, `parse()` returns Programs for empty/numeric statements but the
remaining walls are all ONE family: an **`any`/`unknown`-typed receiver that at
runtime IS a known WasmGC struct**, where the dynamic read path
(`__extern_get` → host proxy / sidecar) diverges in representation from the
struct-slot write (`#2664`/`#2659` `emitAlternateStructSetDispatch`). Identity
breaks (`this.type === types$1.X` → false) and read/write desync (numeric-field
loops).

### Bounded-vs-escape-analysis verdict (cheap TS-checker probe — conclusive)
`.tmp/checker-probe.mjs` (mirrors the compiler's `createProgram`+allowJs) shows
the compiler's checker types the local receivers as **`any`**:
- `var node = this.startNode(...)` → **any** (43/43 samples)
- `scope.flags` where `scope = this.currentVarScope()` → receiver **any**;
  `currentVarScope()` / `enterScope()` return types → **any**
- `this` in the lifted parser methods → the polymorphic `this`-type (no struct)

So receiver-resolution splits in two:
- **`this` receiver = BOUNDED** — recoverable SYNTACTICALLY from the
  `Class.prototype.m = function(){}` (or aliased `var pp = Class.prototype; pp.m
  = …`) assignment. No flow needed. **Already implemented + validated** (below).
- **local receivers (`node`, `scope`) = NEEDS #2660** — they are bound from
  METHOD-CALL RETURNS (`this.startNode()`, `this.currentVarScope()`) the checker
  leaves `any` (the callees are aliased-prototype methods — same root). Recovering
  `Node`/`Scope` requires inter-procedural return-type + field-element-type
  inference (follow callee `return new Node()` / `return this.scopeStack[i]`
  chains). That is the whole-program flow THIS issue builds.

### Per-wall map (all the same family)
| wall | receiver | resolution |
|---|---|---|
| #2681 `this.type` (parseExprAtom switch `unexpected()`) | `this` | BOUNDED — FIXED + validated (read-half below) |
| #2694 `Scope.flags` (11th wall, tight loop) | `this.currentVarScope()` (local) | needs #2660 flow |
| #2687 `node.expression` null | `node = this.startNode()` (local) | needs #2660 flow |
| #2686 binary-expr throw | parseExprOp token compares / node builds | almost certainly same family → needs #2660 |

### Validated READ-half component to REUSE (don't rebuild)
Branch `issue-2681-acorn-lifted-method-this` @ `c83216fe2` (WIP, NOT PR'd —
preserved for folding in). It is the symmetric READ counterpart to #2664's
`emitAlternateStructSetDispatch` WRITE half:
- `FunctionContext.thisStructName` (context/types.ts) — the struct a lifted
  method's `this` resolves to.
- `resolveLiftedMethodThisStruct` (closures.ts) — the SYNTACTIC prototype-alias
  resolver (set on `liftedFctx`).
- `tryEmitThisStructMemberRead` (property-access.ts) — guarded
  `emitExternrefToStructGet` (`ref.test $struct → struct.get → __extern_get`
  fallback) for `this.<field>`.
Validated: on compiled acorn, `parse("x")` `__host_eq` dropped **30k → 163** — the
parseExprAtom switch now matches and the #2681 `unexpected()` throw is gone.

### How the unified substrate should generalize it
Keep this exact symmetric read+write+**compound** dispatch; only generalize the
RECEIVER-RESOLUTION step from "syntactic `this`" to "any receiver whose struct
type #2660's flow proves". I.e. `thisStructName` becomes a general
`receiverStructName(expr)` backed by the #2660 escape/flow result; the
read/write/compound emitters are unchanged.

### CRITICAL hazard — symmetry is mandatory
A READ-only slot fix WITHOUT the matching write+compound caused a **35.9M-iter
`__extern_get`/box/unbox loop** in `parse("x")` (read=slot, `this.field++`
write-back=sidecar → desync). The substrate MUST cover **read + write + compound**
(`recv.field++`, `recv.field op= v`) consistently, or numeric-field loops appear.

### Probes banked (`.tmp/`, single-compile worker+SAB; ~290s/acorn-compile)
`checker-probe.mjs` (the verdict gate, no Wasm compile), `keyhist2.mjs`
(`__extern_get` key histogram — named the Scope.flags wall), `this-bind-repro.mjs`
(small-scale fix verification), `structwalk.mjs`, `diff-probe.mjs` +
`tests/dogfood/probe-driver.mjs`.
