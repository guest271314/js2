---
id: 3037
title: "Object-identity canonicalization substrate for standalone dynamic reads (foundation under #3027 / V2-S3b reader-arm)"
status: ready
sprint: current
created: 2026-07-05
updated: 2026-07-05
priority: high
feasibility: hard
reasoning_effort: max
task_type: analysis
area: standalone
language_feature: compiler-internals
goal: standalone-mode
related: [2719, 2734, 2175, 2984, 3027, 2860, 2585, 2040, 1888, 2141]
depends_on: [2175]
origin: "2026-07-05 — V2-S3b (reader-arm MOP) died on the standalone floor proving object-identity canonicalization is the real gate under the ~1,552-test #3027 keystone; the operand-site tag-6 fix is unsound (−299 via assert.sameValue)"
---

# #3037 — object-identity canonicalization substrate (standalone)

**This is a substrate / strategy spec, not a single PR.** It decides WHERE the
compiler canonicalizes object identity so that the same logical object always
yields one `ref.eq`-identical GC ref, which is the foundation the #3027 keystone
(the ~1,552-test `$Object`-dynamic-reader residual) and the #2175 V2-S3b/S3c
reader-arm sit on top of. It composes with — and does not fork — the landed
S3a reconciliation arm (#2175, `__any_strict_eq`) and the #2963 singleton /
per-brand-global anchors.

Verified against `upstream/main @ 27bfb9417` (V2-S3a landed). Line/symbol
anchors are from that HEAD; re-grep if drifted.

---

## The measured problem (traced, not narrative)

In standalone mode a JS object reaches `===` through the `$AnyValue` boxing
layer under **two representations of the same reference**:

- **tag-6** (`refval`, field 3): the raw GC ref, via `boxToAny`'s kind-`ref`
  arm → `__any_box_ref` (`value-tags.ts:228`). This is what a *syntactic* read
  (`RegExp.prototype.exec`, a struct field, a directly-held value) produces.
- **tag-5** (`externval`, field 4): the SAME ref externref-wrapped, via
  `boxToAny`'s kind-`externref` arm → `__any_box_string` (`value-tags.ts:213`).
  This is what a *dynamic* read produces: `__extern_get` returns
  `extern.convert_any(e.value)` (`object-runtime.ts:1138`), an externref, which
  the consumer boxes with the blanket tag-5 arm — the descriptor `.value`, an
  array/vec element, any dynamic member read.

`__any_strict_eq` (`any-helpers.ts:2233`) has three relevant regions:

1. **top `ref.eq` on the two boxes** (`:2242`) — same $AnyValue struct → 1.
   Only fires when both operands are the *identical box*.
2. **cross-tag arm** (`tagA != tagB`, `:2291-2355`) — the **landed V2-S3a
   reconciliation**: recover each operand's payload (refval if non-null, else
   `any.convert_extern(externval)`) to a common `eqref` and `ref.eq`. This
   fixes **tag-6 × tag-5** (mixed) object identity. Standalone/wasi-gated.
3. **same-tag tag-5 arm** (`:2418-2436`, `tag5ValueEqThen` /
   `tag5StringEqThen`) — GUARDED string-CONTENT compare (`ref.test $AnyString`
   on both; `0` for non-strings).

**The residual that killed V2-S3b:** two objects read through the **same**
dynamic reader are BOTH boxed tag-5 → they hit region (3), the same-tag tag-5
arm, whose guard fails for objects → **returns 0** for genuinely-identical
objects. Concretely (all standalone, verified in the V2-S2/S3a logs):

- `gOPD(p,"exec").value === gOPD(p,"exec").value` → **0** (both reads tag-5).
- `const o:any={z:1}; f(o); /* two reader reads of o */` → **0**.
- The 20-test `Array.indexOf` object-element cluster (#2734) was this class in
  the search helper; the general `===` surface is still exposed.

### Why the obvious patches are ALL unsound (the floor minefield)

Region (3) — the tag-5 same-tag arm — is the single most floor-regression-prone
site in the compiler, because **tag-5 is triple-overloaded**: its `externval`
holds genuine strings, `$BoxedNumber` carriers, AND non-string GC
objects/closures (`any-helpers.ts:1566-1570`). Two independent attempts to give
it object-identity are recorded as hard floor regressions:

- Adding a `#2585` object-identity `ref.eq` arm (and a `#2040` numeric arm) to
  the tag-5 same-tag classifier regressed **−162** (ejected from the standalone
  highwater floor): it flips tag-5 boxed-VALUE equality that the
  destructuring / generator-iterator lowering implicitly relies on
  (`any-helpers.ts:1574-1587`).
- Flipping the generic `boxToAny` externref arm (`value-tags.ts:187-213`) to
  honest classification (`honestAnyBoxing`) regressed **−788 / −794**: the
  test262 harness comparator `assert.sameValue` / `isSameValue` routes ALL
  `any` operands through the externref ABI and depends on main's tag-5
  box-the-externref behaviour (`value-tags.ts:206-212`).
- Boxing operands to tag-6 **at the `===` operand-site** (V2-S3b's attempt)
  regressed **−299** deterministically: forcing internalize-then-`ref.eq` at
  the comparison breaks exactly the harness-comparator tag-5 identity above.

**The lesson (the thesis of this spec):** identity CANNOT be patched at the
equality operand-site, and the tag-5 same-tag arm CANNOT be taught object
identity. Identity must be canonicalized **where values are read/produced**, so
that a GC object never reaches `===` boxed tag-5 in the first place — objects
box **tag-6** (identity in `refval`), tag-5 stays **strings-only**, and the
already-correct tag-6 same-tag `ref.eq` arm (`any-helpers.ts:2404-2416`) does
the work with **zero** new equality-site risk.

### Grounding fact the strategy rests on

In pure standalone there are **no host externrefs** — every externref is
`extern.convert_any` of a GC ref (native strings are `$AnyString` GC arrays,
not `wasm:js-string`). Therefore `any.convert_extern ∘ extern.convert_any` is
the identity on GC refs (WasmGC internalize/externalize is bijective for
GC-origin externrefs). So a stored `e.value` GC ref read back through the
reader and re-internalized IS `ref.eq`-identical to the original — **the ONLY
way identity is lost is a production site that (a) mints a FRESH GC allocation
for the same logical object, or (b) boxes the ref tag-5 so `===` lands in the
overloaded same-tag arm.** Both are production-site defects, not equality-site
defects. (In host mode, host externrefs are genuinely non-`eq` and the host
`isSameValue` owns identity — every arm here is `ctx.standalone`-gated and host
stays byte-identical.)

---

## Implementation Plan (strategy decision + slices)

### Options considered

#### Option A — canonical-ref INTERN table (identity map)

A module structure mapping "logical object key" → the one canonical GC ref, so
every read of the same logical object returns it.

- **Where/keyed on what:** an intern table only helps objects that have an
  *external* identity key BEFORE you hold the canonical ref (chicken/egg: a
  plain user object simply IS its GC ref — there is no prior key to intern on).
  It is well-defined only for **synthesized / reflective** objects that are
  materialized on demand: builtin protos (key = brand), builtin method/getter
  values (key = `(brand, member)`), ctor carriers (key = name), well-known
  symbol carriers (key = id).
- **Memory cost:** for the synthesized classes it is O(distinct reflective
  objects the program touches) — small, and it is **already implemented** as
  per-key module globals: `__native_proto_<brand>` (#2175 S1), the #2963
  `pushBuiltinFnSingletonValueInstrs` per-`(brand,member)` global, the #3006
  ctor carriers, `ensureSymbolCarrier`. A *general* user-object intern map would
  be a per-allocation hash table (large, and pointless — see below).
- **Soundness on the #2661 flipped cases:** fixes `getPrototypeOf` (returns the
  per-brand global) and synthesized-value identity. Does **nothing** for
  aliased user-object array elements or a plain user object round-tripped
  through `__extern_get` — those have no synthesized key.
- **Verdict:** A is the correct MODEL for synthesized objects and is largely
  DONE. It is not, and should not become, a general user-object substrate.

#### Option B — externref-identity-preserving equality (keep operands externref through ===)

- **Why it looks attractive:** the tag-5 path "already preserves" host identity
  in host mode; keep `===` at the externref layer and never unbox.
- **Why it is unsound / insufficient:** WasmGC has **no `ref.eq` on
  externref** — to compare two externrefs you must `any.convert_extern` them,
  which is precisely the operand-site internalization that regressed −299, and
  for genuine host externrefs internalize yields non-`eq` refs (unreliable
  identity). It also does not touch `getPrototypeOf` / reflective visibility at
  all (those are production, not equality). B collapses into either the
  forbidden operand-site tag-6 approach or a no-op.
- **Verdict:** REJECTED. This is the class the task forbids.

#### Option C — canonicalize at the production / box site (RECOMMENDED)

Guarantee that every logical object has exactly ONE canonical GC ref and that
every read path yields THAT ref boxed **tag-6** (never a fresh allocation,
never tag-5). Then S3a's landed machinery (tag-6 same-tag `ref.eq`, plus the
cross-tag reconciliation for any transitional mixed pair) answers identity
with **no equality-site change**.

- **Soundness on ALL #2661 flipped cases:** each reduces to "same logical
  object ⇒ same canonical GC ref, boxed tag-6":
  - `gOPD(p,"m").value` vs `p.m`: both resolve to the ONE stored `e.value` /
    #2963 singleton, boxed tag-6 → `ref.eq` true.
  - `arr[0]` vs `arr[1]` aliasing one object: the array stores ONE ref; both
    reads return it boxed tag-6 → true (S3a already flips this for the mixed
    case; C removes the tag-5 same-tag exposure entirely).
  - `getPrototypeOf`: returns the per-brand `$NativeProto` global (Option-A
    anchor) → true.
- **Standalone floor risk:** the risk is *localized to the enumerated
  production sites* and is byte-inert everywhere else. The generic `boxToAny`
  externref arm (the −788 chokepoint) and the tag-5 same-tag arm (the −162
  chokepoint) are **NOT touched** — that is the whole point.
- **Blast radius:** the dynamic-read consumer sites (standalone) + the reader
  natives; host/gc lanes and every non-reflective program are byte-identical.
- **Enables V2-S3c + the guard-flip:** once objects the reader produces are
  tag-6-canonical, the V2-S3b `$NativeProto`/closed-shape reader arms can land
  WITHOUT any `===` change (the exact thing that killed the last attempt), and
  V2-S3c's instance-chain arm + the STRICT-IR guard-flip stack on top.

**Recommendation: Option C**, implemented as scoped production-site
representation canonicalization, resting on S3a for the transitional window and
folding Option A's memoization only for synthesized anchors. Reject B. Never
touch the tag-5 same-tag arm or the generic externref boxing arm.

### The invariant this substrate establishes (state it, gate on it)

> **INV-1 (representation canonicalization):** in `ctx.standalone`, a GC object
> value flowing into an `any` slot via a dynamic reader or descriptor synthesis
> is boxed **tag-6** (`refval`); tag-5 (`externval`) is reserved for genuine
> `$AnyString` strings (+ the legacy `$BoxedNumber` carrier). Equivalently:
> `typeof x === "object"/"function"` values never reach `===` boxed tag-5.

> **INV-2 (allocation canonicalization):** a production site never mints a fresh
> GC allocation for a logical object that already has a canonical ref (stored
> `e.value`, #2963 singleton, per-brand proto global, ctor carrier). Reads
> thread the stored/anchored ref; they never re-wrap into a new struct.

INV-1 makes `===` land in the tag-6 arm (safe); INV-2 makes the tag-6 arm's
`ref.eq` actually true. Both are production-side; neither touches `===`.

### Sub-slice decomposition (each byte-inert-off-path; each merge_group floor-gated)

> **Every slice MUST validate on the full `merge_group` + `check-standalone-highwater.mjs`**, never a scoped sweep — this is THE floor-regression minefield (documented −162 / −299 / −788 / −794 / −7228 incidents). Each slice is `ctx.standalone`-gated and must keep `scripts/prove-emit-identity.mjs` (the 39-hash corpus) IDENTICAL for host/gc and for any module that never pulls the dynamic reader.

- **CS0 (S) — characterization + invariant lock (byte-inert).** No codegen
  change. Add a standalone characterization suite that pins the residual and
  the invariant as a table: (a) `gOPD(p,"exec").value === gOPD(p,"exec").value`
  → currently `.toBe(0)` (the boundary that later slices flip to `1`);
  (b) two dynamic reads of one aliased user object → `.toBe(0)`;
  (c) anti-vacuity negatives that must STAY 0 (`{x:1} === {x:1}`, distinct
  strings, `exec !== test`); (d) a "reader value tag" probe asserting an
  object read dynamically is NOT `typeof "string"` (proves it should be tag-6).
  This slice makes the flip auditable and prevents a coincidental-pass
  (builtin-proto surfaces hide coincidental passes — use inject/contrast).

- **CS1 (M) — production-site honest object boxing at the dynamic-reader
  consumers.** THE keystone substrate slice. Enumerate every standalone site
  that takes a dynamic-reader externref result (`__extern_get`, vec/array
  element read, descriptor `.value`/`.get` synthesis) and boxes it to `any`,
  and route it through a **scoped honest classify** — `$AnyString` → tag-5,
  else eq-castable GC → tag-6 — instead of the blanket `__any_box_string`. The
  honest classifier ALREADY exists as `__any_from_extern`'s `honest` arm
  (`any-helpers.ts:427-469`, `$AnyString`→tag-5, other eq→tag-6); reuse it —
  do **not** mint a second classifier. **Hard constraint:** touch ONLY the
  enumerated dynamic-read consumers; do **NOT** flip the generic `boxToAny`
  externref arm (`value-tags.ts:187-213`, the −788 chokepoint) and do **NOT**
  add anything to the tag-5 same-tag arm (the −162 chokepoint).
  - *Files:* the dynamic member-read lowerings in `property-access.ts` /
    `element-access` that box an `__extern_get` result to `any`; the #2885
    gOPD descriptor synthesis in `calls.ts` (store the raw ref, box tag-6);
    the vec/array element→any read path. Grep for `__any_box_string` /
    `__any_box_extern` reached from a reader result under `ctx.standalone`.
  - *Gate:* CS0's boundary (a),(b) flip `0 → 1`; a string read dynamically
    still concatenates (`const o:any={s:"ab"}; o.s + o.s === "abab"`, tag-5
    intact); anti-vacuity negatives stay 0; `typeof (dynamically-read object)`
    unchanged. Full merge_group floor + prove-emit-identity green.
  - *Floor-risk: HIGH* (adjacent to the harness-comparator chokepoint). The
    scoping to enumerated sites is the safety boundary — a reviewer MUST
    confirm the generic externref arm and the tag-5 same-tag arm are untouched
    (diff-audit gate).

- **CS2 (S) — synthesized-anchor audit + lock (Option A completion).** Confirm
  every synthesized reflective object is memoized to ONE canonical ref and add
  swap-guarded identity tests where missing: protos (`__native_proto_<brand>`),
  method/getter values (#2963 singleton — done V2-S2), ctor carriers (#3006),
  well-known symbol carriers. Fill any gap where a synthesis path still mints
  fresh (INV-2). Mostly audit + regression-lock; no new mechanism.
  - *Gate:* `RegExp.prototype === RegExp.prototype`;
    `X.prototype.m === gOPD(X.prototype,"m").value`;
    `getPrototypeOf(Int8Array.prototype) === %TypedArray%.prototype` (once the
    chain fields are filled — may defer the last to V2-S3b). Swap-guards prove
    discrimination.

- **CS3 (L) — V2-S3b reader-arm MOP, RE-ENABLED on top of CS1.** This is the
  #2175 v2 C3 reader arm (`$NativeProto`/`$Object`/closed-shape step-3/4 arms
  across the 7 reader natives) that died last attempt. It lands here as a
  **consumer** of the substrate: because CS1 guarantees any object the reader
  produces is tag-6-canonical, the reader arm needs **zero** `===` change (the
  exact thing that caused −299). The reader arm's raw-anyref `$PropEntry.value`
  carrier (v2 D4) + CS1's honest boxing together make
  `const p:any = RegExp.prototype; p.exec === RegExp.prototype.exec` hold at the
  runtime layer. Keep on its own CI evidence (the v2 spec's "do not fold S3+S5"
  rule stands). *This slice is #2175 V2-S3b; #3037 is its precondition, not its
  replacement.* Owned by the #2175 wave; listed here to make the dependency
  explicit.

**Order:** CS0 → CS1 → CS2 (CS2 parallel-able with CS1) → CS3 (= V2-S3b).
CS1 is the substrate keystone; V2-S3b/S3c and the STRICT-IR guard-flip stack on
CS1. Do not attempt CS3 before CS1 lands — that reproduces the #2661 death.

### Edge cases

- **Native strings must NOT mis-box tag-6.** The honest classifier tests
  `ref.test $AnyString` FIRST (`any-helpers.ts:430-443`); a string read
  dynamically stays tag-5. CS1 must reuse that ordered classifier, never a bare
  `ref.test $eq`.
- **`$BoxedNumber` carriers** parked in tag-5 externval (`any-helpers.ts:1567`)
  must stay tag-5 (numeric-class arm + `__any_to_f64` recovery depend on it) —
  the honest classifier's `$AnyString`-first / eq-second order already excludes
  `$BoxedNumber` from the tag-6 arm only if `$BoxedNumber` is not `eq`-castable;
  verify `$BoxedNumber`'s heap type is not an `eq` subtype that would wrongly
  take the tag-6 arm, else add an explicit `$BoxedNumber`→tag-5 pre-test.
  **(Open — must be checked in CS1 review; a mis-tag here re-breaks numeric
  `===`.)**
- **Host mode / gc lane byte-identity.** Every arm `ctx.standalone`-gated;
  host `isSameValue` (#1888) and the host externref proxy identity untouched.
- **Frozen / `Object.create(null)` objects** keep current semantics — CS1 only
  changes the TAG of the boxed result, not the reader's lookup.
- **Transitional mixed pairs** (one operand tag-6 from CS1, one still tag-5
  from an un-migrated site) are covered by S3a's cross-tag reconciliation arm —
  so partial CS1 coverage never regresses, it only under-fixes. This is why CS1
  can land incrementally per consumer site if needed.

### What this spec explicitly does NOT do

- Does NOT patch identity at the `===` operand-site (proven unsound, −299).
- Does NOT add an object-identity arm to the tag-5 same-tag classifier (−162).
- Does NOT flip the generic `boxToAny` externref arm / `honestAnyBoxing`
  globally (−788/−794).
- Does NOT build a general user-object intern map (pointless — user objects are
  their GC ref; only synthesized objects need Option-A memoization, already
  done).
- Does NOT change host mode; no new host imports.
- Does NOT implement the reader-arm MOP itself (that is #2175 V2-S3b / CS3,
  which this substrate unblocks).

### Risks & honest assessment

1. **CS1 is genuinely hard and floor-risky.** It sits one arm away from the two
   worst floor-regression chokepoints in the codebase. The mitigation is strict
   scoping (enumerated consumers only) + a mandatory diff-audit that the generic
   and same-tag arms are untouched + full merge_group evidence. Estimate: L in
   care even though M in code size.
2. **`$BoxedNumber` eq-castability** (edge case above) is the single most likely
   silent regression — it must be settled with a `ref.test` probe on current
   main BEFORE writing CS1, not assumed.
3. **Enumeration completeness.** If a dynamic-read consumer is missed, that path
   stays tag-5 and under-fixes (safe via S3a, not a regression) — but the #3027
   number won't fully move until all consumers migrate. Expect CS1 to iterate
   per consumer family (property read, element read, descriptor synthesis).
4. **The bijection assumption** (no host externrefs in standalone) is load-
   bearing. If any host-string-mode externref leaks into a `ctx.standalone`
   read, the honest classifier could mis-tag. The `$AnyString`-first ordering
   plus standalone gating contains this, but CS1 review must confirm no
   host-string leak path reaches the migrated consumers.

**Bottom line:** the object-identity foundation under #3027 is a
**production-site representation-canonicalization** problem (Option C), not an
equality problem. The landed S3a arm already handles the mixed-tag window; the
missing piece is CS1 — making dynamic-reader object values box tag-6 at the
enumerated production sites so they never enter the overloaded tag-5 same-tag
arm. Once CS1 lands, the V2-S3b reader-arm re-lands with no `===` change and the
#3027 keystone + guard-flip stack on top. The hardness is concentrated in CS1's
floor-adjacency, managed by strict scoping and merge_group-only validation.
