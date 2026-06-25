---
id: 2660
title: "Whole-program escape/dynamic-use gate for reconstructing `new F()` instances as `$Object` (value-rep infra)"
status: ready
assignee: ""
sprint: Backlog
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
