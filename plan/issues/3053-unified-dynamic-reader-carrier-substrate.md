---
id: 3053
title: "Unified dynamic-reader carrier substrate — one __dyn_member_get primitive under #3037 CS3 (identity) AND #2949 S5.4 (IR claim-rate)"
status: in-progress
assignee: ttraenkler/opus-u0-carrier
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
related: [3037, 2949, 3027, 2719, 2734, 2175, 2580, 2896, 2186, 2947, 2855]
depends_on: [3037, 2949]
origin: "2026-07-05 — two independent investigations (opus-3037-cs1c CS3 readiness; opus-s5-4 S5.4 verdict) converged on the SAME root cause: the $Object dynamic reader returns a bare externref, tag-5-boxed downstream, losing BOTH object identity (#3037) AND typed-carrier information (#2949). This spec designs the ONE substrate that unblocks both, and gives the honest floor-safety verdict for the -299/-788 minefield."
---

# #3053 — unified dynamic-reader carrier substrate

**This is a substrate / strategy spec, not a single PR.** It designs a single
runtime primitive — a locals-free, carrier-uniform `__dyn_member_get(recv,key)`
that returns a proper tag-6 carrier for object payloads (strings stay tag-5) —
and shows how ONE helper serves BOTH remaining sprint levers:

1. **#3037 CS3** — the ~1,552-test object-identity keystone (#3027 driver). The
   CS1a→CS1b operand-scoped carrier hit its coverage ceiling (it fixes only
   DIRECT `any===any` operands). Every remaining gap is a reader/producer result
   carried as externref INTO an `any` slot (local / arg / return), dominantly the
   `assert.sameValue` harness comparator (any params, tag-5). The CS1b(iii)
   re-probe pinned the residual as the **UNIVERSAL-reader carrier = CS3 / V2-S3b**
   — the −299 minefield.
2. **#2949 S5.4/S5.P** — the IR claim-rate lever. opus-s5-4 traced S5.4 to a
   MISSING primitive: a locals-free, carrier-uniform `__dyn_member_get(recv,key)
   → carrier` that handles named + indexed reads without touching the caller's
   `fctx`/locals. With property-access blocked, S5.P's reachable flip set is
   near-empty (the reduce-style `obj[idx]===cur && obj[idx-1]===prev`
   conjunction needs property-access).

Verified against `upstream/main @ fa2e137e6` (V2-S3a landed; #3037 CS1a/CS1b/
CS1b(ii)/CS1b(iii) landed; #2580 M-series dyn-read + #2896 landed). Line/symbol
anchors are from that HEAD; re-grep if drifted.

---

## The convergence (why one spec serves two frontiers)

Both investigations independently bottomed out at the SAME instruction. Traced,
not narrative:

- `__extern_get` (`object-runtime.ts:1015-1168`) returns
  `extern.convert_any(e.value)` (`:1138`) — a **bare externref** of the stored
  property value's GC ref.
- `emitDynGet` (`dyn-read.ts:224`) / `__dyn_get` (`dyn-read.ts:144`) wrap it but
  **preserve the bare-externref carrier** (`dyn-read.ts:143`: "The result is a
  UNIFORM externref").
- Downstream, that externref is boxed by the **generic `boxToAny` externref arm**
  (`value-tags.ts:187-213`) → `__any_box_string` → **tag-5**. For a genuine GC
  object this is the identity-losing lie: two reads of the same object are both
  tag-5, and `__any_strict_eq`'s same-tag tag-5 arm (`any-helpers.ts:2431+`) is a
  string-content compare that returns **0** for objects.

So:
- **#3037 loses IDENTITY** because the object arrives at `===` boxed tag-5.
- **#2949 loses the TYPED CARRIER** because the reader hands the IR a bare
  externref, not a tagged `$AnyValue` the IR lattice can thread; and the one
  leaf helper (`emitDynGet`) breaks the pure-`Instr[]` handle contract
  (`dyn-read.ts:305-306` allocs caller locals; `:297` late-import-shifts the
  caller body — the #2043/#2078 mid-emit funcidx hazard).

**The unified fix is a single self-contained primitive** whose call site is a
bare `call` and whose result is the identity-preserving, tag-honest carrier both
frontiers need. Its floor-safety hinges on ONE architectural decision that all
three prior deaths violated: **the externref↔carrier round-trip lives INSIDE the
helper, never in a shared seam** (`emitAnyEqOperands` −299, the generic
`boxToAny` externref arm −788/−794, or `__any_to_extern`'s tag-6 arm — the
consumer-breadth mine).

---

## Ground truth: the four seams this spec must NOT touch (and why)

| Seam | Site | Regression on touch | Why load-bearing |
| --- | --- | --- | --- |
| generic `boxToAny` externref arm | `value-tags.ts:187-213` → `__any_box_string` | **−788 / −794** (`honestAnyBoxing` global flip) | the `assert.sameValue`/`isSameValue` harness comparator marshals ALL `any` operands through this arm and depends on main's tag-5 box-the-externref behaviour |
| `emitAnyEqOperands` (the `===` operand seam) | `coercion-engine.ts:454-467` (`coerceType(externref→$AnyValue)`) | **−299** (V2-S3b operand-site tag-6) | the harness comparison *is* an `===` over any operands; forcing tag-6 here re-breaks the harness tag-5 identity |
| `__any_to_extern` tag-6 arm | `any-helpers.ts:814-827` (`extern.convert_any` of the WHOLE box) | breaks EVERY dynamic member read (CS1a finding) | a `$AnyValue`-typed any-object local, coerced to externref for a re-read, hands `__extern_get` the wrapped box → `ref.test $Object` fails → null/0 |
| tag-5 same-tag arm | `any-helpers.ts:2431+` (`tag5*EqThen`) | **−162** (adding an object-identity `ref.eq` arm) | tag-5 is triple-overloaded (strings + `$BoxedNumber` + non-string GC); destructuring / generator-iterator lowering rely on its boxed-VALUE equality |

**The design rule that follows:** the new primitive must produce and consume its
carrier so that a migrated value NEVER traverses any of these four seams in a way
that changes their emitted bytes. Achieved by (a) doing the unwrap/rebox inside
the helper, and (b) leaning on the **landed S3a cross-tag arm**
(`any-helpers.ts:2302-2368`, standalone-gated) so any transitional tag-6×tag-5
pair of the same object still `ref.eq`s to 1 — partial migration **never
regresses, only under-fixes**.

---

## The unified primitive

```
;; standalone / gc carrier = (ref null $AnyValue); host carrier = externref
__dyn_member_get(recv: <carrier>, key: <carrier>) -> <carrier>
```

### Standalone / gc body (self-contained round-trip — the whole point)

```
__dyn_member_get(recv: (ref null $AnyValue), key: (ref null $AnyValue))
    -> (ref null $AnyValue):
  recvExt = __carrier_recv_to_extern(recv)   ;; INTERNAL unwrap — NOT global __any_to_extern
  keyExt  = __any_to_extern(key)             ;; existing; key is string/number → decimal
  resExt  = __extern_get(recvExt, keyExt)    ;; existing reader (proto-walk, accessors, .length)
  return  __any_from_extern_honest(resExt)   ;; honest box → tag-6 object / tag-5 string / tag-3,4 num,bool
```

The critical, DIFFERENT-from-`__any_to_extern` piece is the **internal receiver
unwrap** `__carrier_recv_to_extern` — a NEW leaf helper (or inlined body) that,
unlike the global `__any_to_extern`, PEELS the tag-6 payload:

```
__carrier_recv_to_extern(v: (ref null $AnyValue)) -> externref:
  tag 6 → extern.convert_any(v.refval)     ;; the RAW $Object ref (field 3) — so __extern_get's ref.test $Object HITS
  tag 5 → v.externval                       ;; string externref (field 4)
  tag 3 → __box_number(v.f64)               ;; primitive receiver (rare: String/Number method)
  tag 4 → __box_boolean(v.i32)
  tag 2 → __box_number(f64.convert_i32_s(v.i32))
  tag 0/1 → ref.null.extern / undefined     ;; null/undefined receiver → __extern_get miss
```

This is exactly the tag-6 unwrap the global `__any_to_extern` **deliberately
does NOT do** (`any-helpers.ts:814-824` keeps tag-6 wrapped so an `any` boundary
round-trips through the generic classifier). Because the peel lives INSIDE the
substrate helper and its output feeds ONLY `__extern_get` (then is immediately
re-boxed honest), the global `__any_to_extern` seam — and every other consumer of
it — stays byte-identical. The round-trip is closed HONESTLY inside the helper
(`__any_from_extern_honest` re-tags the object tag-6), so re-reads compose:
`__dyn_member_get(__dyn_member_get(o,"a"),"z")` works without ever hitting the
`__any_to_extern` tag-6 breaker.

### `__any_from_extern_honest` is the settled classifier — reuse verbatim

The result boxing MUST use the FULL classifier `__any_from_extern_honest`
(`any-helpers.ts:378`, `{forceHonest:true}` → distinct-name sibling), NOT the
bare `fallbackStringAny` eq fragment. The ordering is the settled #3037 CS0/CS1b
probe (`any-helpers.ts:509-543`): `ref.test $AnyValue` passthrough →
`$BoxedNumber`→**tag-3** (`:510`) → `$BoxedBoolean`→**tag-4** (`:527`) → THEN
`fallbackStringAny` (`$AnyString`→**tag-5** `:444`, other-eq→**tag-6** `:460`).
The tag-3/tag-4 peel BEFORE the eq test is load-bearing: `__box_number_struct`
(`index.ts`) is a plain WasmGC struct → an `eq` subtype → a bare `ref.test (ref
eq)` would mis-route a boxed number to tag-6 and re-break numeric `===`. This
classifier is already on main (landed CS1b); `__dyn_member_get` reuses it — it
does NOT mint a second classifier.

### Host body (carrier = externref)

```
__dyn_member_get(recv: externref, key: externref) -> externref:
  return __extern_get(recv, key)   ;; host carrier IS externref; no box/unwrap
```

with the `.length` vec-dispatch / closure-arity / null-receiver arms currently in
`emitDynGet` (`dyn-read.ts:303-417`) moved INTO the helper's own frame (a defined
function allocates its OWN locals — the S5.4 blocker was that `emitDynGet`
allocated in the CALLER's `fctx`; here the call site is a bare `call`).

### Registration discipline (funcidx-shift-safe, locals-free at call site)

Registered up-front by a `preregisterDynamicSupport(ctx)` pass (idempotent, runs
BEFORE body compilation / funcidx settle — the same slot `ensureAnyHelpers` /
`ensureObjectRuntime` occupy), so the IR handle method stays a pure
`readonly Instr[]` `[call __dyn_member_get]` and the legacy call site is a bare
`call` with **zero** caller-frame locals and **zero** mid-emit late-import
shifting. This is what makes it BOTH a clean IR handle (S5.0–S5.3 body-only-shim
contract preserved) AND a clean legacy carrier.

---

## Micro-step ladder (each byte-inert-or-correct; each merge_group-floor-gated)

> **Every slice validates on the full `merge_group` +
> `check-standalone-highwater.mjs` + `scripts/prove-emit-identity.mjs` (the
> 39-hash corpus)** — never a scoped sweep. This is THE floor minefield
> (documented −162 / −299 / −788 / −794 / −7228). Each `ctx.standalone`-gated;
> host/gc off-path must stay byte-identical.

### U0 (M) — build the substrate helper (byte-inert, no call site)

Build `__dyn_member_get` + the internal `__carrier_recv_to_extern` unwrap +
absorb the `.length`/vec-index/closure/null-receiver dispatch + `ToPropertyKey`
into the helper body. Gate emission on a `ctx.usesDynMemberGet` latch that
**nothing sets in U0** (mirror `ensureDynReadHelpers`'s `ctx.usesDynRead` M0
gate, `dyn-read.ts:77`) + a `JS2WASM_FORCE_DYN_MEMBER_GET=1` self-test escape
(mirror `dyn-read.ts:76`). Registered via `preregisterDynamicSupport`.

- **Files:** `src/codegen/dyn-read.ts` (new `ensureDynMemberGet` + the two
  helper bodies, beside the existing `ensureDynReadHelpers`); wire
  `preregisterDynamicSupport` in the finalize/preregister pass in
  `object-runtime.ts` / `index.ts` next to `ensureObjectRuntime`.
- **Floor-risk: LOW.** An uncalled defined function is not import-pruned; the
  latch (not dead-elim) guarantees zero bytes for every module that never calls
  it. `prove-emit-identity` 39/39 IDENTICAL by construction.
- **Flip targets:** none yet (mechanism).
- **Anti-vacuity:** hand-built unit tests over `JS2WASM_FORCE_DYN_MEMBER_GET=1`
  asserting, on host AND standalone: (a) object read → tag-6, self-`===` via the
  carrier → 1, distinct → 0; (b) string read → tag-5, `typeof "string"`,
  content-eq; (c) number read → tag-3, `23===23.0`; (d) boolean → tag-4; (e) a
  **re-read** `__dyn_member_get(__dyn_member_get(o,"a"),"z")` returns the right
  value + tag (proves the internal unwrap round-trips — the CS1a `__any_to_extern`
  breaker is NOT re-triggered); (f) indexed `arr[0]` and dynamic-index
  `arr[i]`; (g) `.length` on array/string/closure matches `emitDynGet`. Contrast
  a deliberately-wrong tag to prove the assertions bite (no coincidental pass).

### U1 (M) — #2949 S5.4 consumer: route the IR member-read through the primitive

The thin-wiring S5.4 said was blocked, now unblocked. `IrDynamicLowering.
emitMemberGet()`/`emitElementGet()` → `[call __dyn_member_get]`;
`builder.emitDynMemberGet(recv,key) → dynamic`; the `from-ast`
`lowerPropertyAccess`/`lowerElementAccess` dynamic-receiver arm
(`from-ast.ts` ~L2200/L2579). Carrier in/out is the IR `dynamic` = `(ref null
$AnyValue)` gc/standalone, externref host — **no externref↔$AnyValue impedance at
the IR boundary** (the S5.4 carrier-impedance blocker, `2949` note 3, is
dissolved because the helper takes and returns the carrier directly).

- **Files:** `src/ir/lowering/handles.ts`, `integration.ts` (the
  `makeDynamicLowering` resolver — the pure `{body:[]}` shim now works because
  the op is a bare `call`), `builder.ts`, `from-ast.ts`.
- **Floor-risk: LOW–MED.** Byte-inert until S5.P opens the scan (the IR path is
  claim-gated); `prove-emit-identity` IDENTICAL. The only live change is that
  IR-claimed functions (a fixed, small set today) route member reads through the
  helper — validated by the `ir_first` lane (#2947).
- **Flip targets:** none yet (mechanism; the scan is still closed).
- **Anti-vacuity:** deferred to U2 per #2949 §4; unit tests execute
  `dyn.length`, `dyn[0]`, `dyn["k"]`, `dyn.p` over host + gc asserting value +
  tag preservation (the §S5.4 acceptance "value + tag preservation MUST be
  covered").

### U2 (L) — #2949 S5.P: open the IR scan for dynamic property-access (the claim-flip)

Relax `src/ir/select.ts` `dynamicUsesAreMoveOnly` (~L1178): accept a dyn receiver
in `isPropertyAccessExpression`/`isElementAccess` (result is dynamic → feeds
return / another dyn position), co-landed with the truthiness/eq/relational arms
per S5.P. **With property-access now available, the reduced-form-set caveat that
would have DEFERRED S5.P is lifted** — the reduce-style conjunction population
(`idx>0 && obj[idx]===cur && obj[idx-1]===prev`) becomes claimable.

- **Floor-risk: MED.** This is the real claim flip; measured per #2949 §4 (the
  ceiling + real-selector reachability probes, now on the FULL form set).
- **Flip targets (#2949):** `claimed` strictly increases; `param-/return-type-
  not-resolvable` drops by the claim increase and does NOT reappear as
  `body-shape-rejected`; `post-claim demotions == 0`. `check:ir-fallbacks`
  buckets `param-type-not-resolvable` / `return-type-not-resolvable` drop
  (`--update-on-decrease`).
- **Anti-vacuity:** #2949 §4 is MANDATORY — build S5.P only for a non-empty
  real-selector flip set. If the FULL-form-set probe is still empty, defer
  (documented), but the ceiling probe should now be non-empty precisely because
  property-access is the form the population needs.

### U3 (L) — #3037 CS3: the identity payoff (RIDES on U1/U2, not a separate legacy substrate)

**The honest architecture:** CS3's universal-identity flip is realized THROUGH
the IR carrier-uniformity of U1/U2, not through a bounded legacy patch. A function
the IR claims carries `any` locals/params/returns as `$AnyValue` uniformly, so
`x === y` inside it gets the **tag-6 same-tag `ref.eq` arm**
(`any-helpers.ts:2417-2430`) for free — with `emitAnyEqOperands` (−299) and the
generic arm (−788) UNTOUCHED (the operands arrive already `$AnyValue`, so
`emitAnyEqOperands`'s `isAnyValue` guard at `coercion-engine.ts:458/463` skips
the coercion seam entirely).

- **The CS3 KNOWN-GAP flip targets** (pinned at `0`, marked CS3-owned in
  `tests/issue-3037-cs1biii-descriptor-value-carrier.test.ts:179/191`):
  - `const v1: any = o.a; const v2: any = o.a; v1 === v2` → **flip to 1** when
    the enclosing function is IR-claimed (`any` locals carried `$AnyValue`,
    reads via `__dyn_member_get` tag-6, `===` via the tag-6 arm).
  - the descriptor `.value`-into-locals analogue → same.
- **The dominant CS3 gap — the `assert.sameValue` harness comparator** — flips
  IFF the IR claims the harness comparator (any params, `===` + `String()` +
  `typeof` + throw). If S5.P's forms cover the comparator body, CS3's ~1,552-test
  keystone moves as a SIDE EFFECT of the claim-rate work. **This is the
  convergence payoff: the same IR claim that raises #2949's number gives #3037
  its identity.**
- **Fallback if the IR does NOT claim the harness comparator** (U3b, scoped, MED):
  a harness-comparator-specific param-carrier migration — box object arguments as
  tag-6 `$AnyValue` at the CALL SITE and type `assert.sameValue`/`isSameValue`
  `any` params as `$AnyValue`, so the internal `===` sees tag-6 operands. This is
  a NARROW, single-callee carrier migration (NOT the global seam), safe via S3a
  for any un-migrated caller. Consumer-breadth inside the comparator (`String()`,
  `typeof`) is bounded and routes through existing `$AnyValue`-accepting helpers.
- **Floor-risk: LOW for the ride-on (U1/U2 already floor-gated); MED for U3b**
  (a real param-carrier ValType change on one callee family).
- **Flip targets:** the CS1b(iii) KNOWN-GAP rows; the #3037/#3027 identity
  cluster (~1,552 tests, the assert.sameValue-dominated tail).
- **Anti-vacuity:** the KNOWN-GAP test flips `0→1` under the claimed path AND a
  contrast test proves an UNCLAIMED function still under-fixes (0) rather than
  falsely passing; distinct-object anti-vacuity stays 0; string/number/boolean
  by-value invariants hold.

### U4 (L) — CS3 = V2-S3b reader-arm MOP, RE-ENABLED on the carrier (owned by the #2175 wave)

The `$NativeProto`/`$Object`/closed-shape step-3/4 reader arms across the 7
reader natives land as a CONSUMER of the substrate: because U1–U3 route reader
results through the tag-6-honest carrier, the reader arm needs **zero** `===`
change (the exact thing that killed the −299 attempt). Listed to make the
dependency explicit; owned by #2175 V2-S3b. Do not attempt before U1 lands.

**Order:** U0 → U1 → U2 (the #2949 claim-flip) → U3 (the #3037 identity ride-on,
+ U3b harness fallback if needed) → U4 (#2175 V2-S3b). U0 is the shared keystone;
BOTH frontiers stack on it.

---

## Which consumers break, and how each migrates (the consumer-breadth mine)

Making the reader return a `$AnyValue` carrier UNIVERSALLY (rather than a bare
externref) changes the read-result ValType → every consumer of a dyn read must
accept the new carrier. This is the mine that killed the naive "reader returns
tag-6 everywhere" approach (CS1a's finding: an `$AnyValue`-typed any-object local
breaks reads). The ladder defuses it by **NOT migrating all `any` locals** —
instead the carrier is uniform only WITHIN the boundary that already accepts it:

| Consumer of a dyn-read result | Legacy externref path (today) | Migrated `$AnyValue` path |
| --- | --- | --- |
| another dyn read (`o.a.z`) | externref → `__extern_get` | `__dyn_member_get` (unwraps tag-6 internally) — **self-composing** |
| `===` / `!==` | tag-5 (identity lost) | tag-6 same-tag arm (identity) — U3 |
| arithmetic (`+ - * /`) | `__any_to_f64` | `__any_to_f64` (unchanged; unboxes from box) |
| string concat (`+`) | `__any_add` | `__any_add` (tag-dispatched; unchanged) |
| `typeof` | tag-dispatched | tag-dispatched (unchanged) |
| method call (`o.m()`) | externref receiver | `__carrier_recv_to_extern` → externref (helper-internal) |
| host handoff | `__any_to_extern` (wraps) | `__any_to_extern` (unchanged — global seam untouched) |
| `Object.keys`/spread/`delete`/destructuring | externref | `__any_to_extern` → externref (unchanged) |

**The key safety property:** the ONLY consumer whose semantics CHANGE is `===`
(the intended fix, U3), and it changes only when BOTH operands are already
`$AnyValue` inside a carrier-uniform (IR-claimed) boundary. Every other consumer
either already accepts `$AnyValue` (arith/concat/typeof) or goes through the
helper-internal unwrap (reads/method-calls). The global `__any_to_extern` and the
generic `boxToAny` arm are **never** touched — that is why this path does not
re-detonate −788/−299.

**Why the migration is IR-scoped, not a legacy dataflow pass:** deciding WHICH
`any` locals to carry as `$AnyValue` (vs externref) is a whole-function dataflow
problem. Doing it in legacy would reimplement the IR's carrier lattice. The IR
(`#2949`) already tracks a value's `dynamic` carrier and threads it uniformly —
so the correct home for the carrier migration IS the IR claim (U1/U2). A bounded
legacy patch is offered ONLY for the single harness-comparator callee (U3b),
where the migration surface is one function, not the whole program.

---

## Edge cases

- **Native strings stay tag-5.** `__any_from_extern_honest` tests `ref.test
  $AnyString` FIRST (`any-helpers.ts:444`) — a string read stays tag-5, concat &
  content-`===` intact. NEVER a bare `ref.test $eq`.
- **`$BoxedNumber`/`$BoxedBoolean` carriers stay tag-3/tag-4.** The classifier
  peels them (`:510`/`:527`) BEFORE the eq test — settled by the CS0 probe
  (`__box_number_struct` is an `eq` subtype). Any carrier boxing MUST reuse the
  full classifier, never the eq fragment.
- **Accessor `.get` reads** (`__extern_get:1127-1131`) return a fresh computed
  value — NOT an identity-stable ref. `__dyn_member_get` boxes whatever the getter
  returns honest; identity of getter results is out of scope (spec-correct: a
  getter may return anything).
- **`null`/`undefined` receiver** → `__carrier_recv_to_extern` yields
  null/undefined extern → `__extern_get` miss → the singleton (S1 regime,
  `object-runtime.ts:1040`). No null-deref.
- **Typed-nominal-element vec** (`const a: any = [{z:1},{z:2}]`) — the
  `__extern_get_idx` #2186-class reader gap (CS1b(ii) known-limitation,
  `3037` §CS1b(ii)). `__dyn_member_get`'s indexed arm inherits it; out of scope
  here (does not occur in test262 pure-JS). File as a #2186 follow-up if the
  indexed-vec population needs it.
- **Host mode / gc lane byte-identity.** Every arm `ctx.standalone`/`ctx.wasi`
  gated; host `__extern_get` import path and `isSameValue` (#1888) untouched.
- **Transitional mixed pairs** (one operand migrated tag-6, one still tag-5) →
  S3a's cross-tag reconciliation arm (`any-helpers.ts:2302-2368`) → `ref.eq` → 1.
  Partial coverage never regresses.

## What this spec explicitly does NOT do

- Does NOT touch `emitAnyEqOperands` (−299), the generic `boxToAny` externref arm
  / `honestAnyBoxing` (−788/−794), the `__any_to_extern` tag-6 arm (the CS1a
  read-breaker), or the tag-5 same-tag arm (−162).
- Does NOT make the reader return tag-6 "universally" as a bare ValType flip —
  that IS the consumer-breadth mine; the carrier is uniform only within the
  IR-claimed (or single-callee U3b) boundary.
- Does NOT change host mode; no new host imports (`__dyn_member_get` host body is
  a thin `__extern_get` wrapper).
- Does NOT build a general user-object intern map (user objects ARE their GC ref;
  only synthesized objects need Option-A memoization, done in #3037 CS2).

---

## HONEST tractability verdict

**There IS a floor-safe, micro-stepped path — but the two frontiers do NOT get
equal, symmetric payoff from the same slice, and the CS3 identity flip is
DOWNSTREAM of the #2949 IR work, not parallel to it.** Precisely:

1. **U0 (the substrate helper) is unambiguously floor-safe and buildable.** It is
   byte-inert until called (latch-gated, like the #2580 M0 scaffold), does the
   externref↔carrier round-trip INSIDE itself, and touches none of the four
   forbidden seams. This is the clean shared keystone. **LOW risk.**

2. **#2949 S5.4/S5.P (U1/U2) gets a CLEAN, direct win.** U0 is exactly the
   locals-free, carrier-uniform, named+indexed primitive opus-s5-4 said S5.4 was
   blocked on. U1 is the thin wiring; U2 is the measured claim-flip (gated by
   #2949 §4 anti-vacuity). This unblocks the claim-rate lever with property-access
   in the form set. **LOW→MED risk, well-bounded.**

3. **#3037 CS3 (U3) is REAL but INDIRECT.** The universal-identity flip requires
   `any`-slot carriers to be `$AnyValue`-uniform — which is the consumer-breadth
   mine, tractable ONLY as the IR carrier work (U1/U2), NOT as a bounded legacy
   patch. So CS3's ~1,552-test keystone moves as a SIDE EFFECT of the IR claiming
   the identity-sensitive functions (dominantly the harness comparator). If the
   IR claims `assert.sameValue`, CS3 lands for free; if not, U3b is a scoped
   single-callee param-carrier fallback. **The honest caveat: the CS3 magnitude is
   CONTINGENT on the IR claim reaching the harness comparator** — a dependency on
   #2949's claim-rate growth, not a standalone guarantee.

4. **What would make CS3 tractable WITHOUT the IR:** a legacy whole-function
   `any`-carrier-selection pass (mark single-assignment `any` locals whose uses
   are all read-or-`===`, carry them `$AnyValue`, route reads through
   `__dyn_member_get`). This is a MED-L legacy analysis that DUPLICATES the IR
   lattice — **not recommended**; the IR is the right home. Documented as the
   alternative so the decision is explicit.

**Bottom line:** the substrate is NOT intractable — U0 is a clean, floor-safe,
byte-inert helper that both frontiers stack on, and it is the correct unblock for
BOTH the S5.4 blocker and the reader-arm MOP. The −299/−788 deaths are avoided by
keeping the round-trip inside the helper and leaning on S3a for partial coverage.
The one honest qualification is asymmetry: **#2949 gets a direct claim-flip; #3037
CS3 gets its identity flip as a downstream consequence of the IR carrier work
(U1/U2), realized fully only when the IR claims the harness comparator.** Build U0
first (it is pure upside, floor-safe, and unblocks the IR immediately); the CS3
magnitude then tracks the IR claim-rate. This is a "prerequisite-first" verdict:
U0 is the prerequisite; the CS3 keystone lands through the IR, not around it.

---

## Coordination / non-collision

- U0/U1 touch `src/codegen/dyn-read.ts` + `src/ir/**` — clear of #3037's
  `property-access.ts` operand-carrier work (CS1a/CS1b landed there) and clear of
  the #2949 S5.0–S5.3 mechanism slices. Confirmed by opus-s5-4's own collision
  note (`2949` §"Coordination with #3037 CS1b(ii)").
- U3/U3b touch the equality-consumer side and the harness call site — coordinate
  with the #2175 V2-S3b wave (U4) since both consume the carrier.
- The `__dyn_member_get` author should pair with the #2949 S5.4 owner
  (opus-s5-4's filed substrate dependency IS U0) and the #3037 CS3 owner.

---

## U0 — LANDED (byte-inert substrate helper)

**Author:** opus-u0-carrier. **Branch:** `issue-3053-u0-carrier-helper`.
**Risk realised: LOW** — byte-inert, zero emitted-byte change in every normal
compile (proven, see below).

### What shipped

- `src/codegen/dyn-read.ts` — new `ensureDynMemberGet(ctx)` registering, in
  gc/standalone (`ctx.standalone || ctx.wasi`):
  - `__carrier_recv_to_extern(v: (ref null $AnyValue)) -> externref` — the
    novel piece. It **PEELS** the carrier to the externref `__extern_get`
    needs: tag 6 → `extern.convert_any(v.refval)` (the RAW `$Object`, field 3,
    so `__extern_get`'s `ref.test $Object` HITS); tag 5 → `v.externval`
    (field 4); tag 3 → `__box_number(v.f64val)`; tag 4 →
    `__box_boolean(v.i32val)`; tag 2 → `__box_number(f64.convert_i32_s(...))`;
    tag 0/1/null → `ref.null.extern` (null/undefined receiver → miss). This is
    exactly the tag-6 unwrap the global `__any_to_extern` **deliberately does
    NOT do** (`any-helpers.ts:814-824` keeps tag-6 WRAPPED — the CS1a
    read-breaker). Because the peel lives INSIDE the helper and its output
    feeds ONLY `__extern_get`, the global `__any_to_extern` seam stays
    byte-identical.
  - `__dyn_member_get(recv, key) -> (ref null $AnyValue)` — the self-contained
    round-trip: `__carrier_recv_to_extern(recv)` → `__any_to_extern(key)` →
    `__extern_get` → `__any_from_extern_honest` (the settled #3037 CS1b
    classifier — tag-3/tag-4 peel BEFORE the eq test, then tag-5 string /
    tag-6 object; reused verbatim, NOT re-minted).
  - Host mode: `__dyn_member_get(recv,key) -> externref` = a thin
    `__extern_get(recv,key)` wrapper (carrier IS externref; no box/peel).
- Context latch `ctx.usesDynMemberGet` + idempotence latch
  `dynMemberGetHelpersEmitted` (`context/types.ts`, `create-context.ts`).
- `src/codegen/index.ts` — `ensureDynMemberGet(ctx)` wired at BOTH finalize
  points beside `ensureDynReadHelpers` (before dead-elim/freeze).

### Why floor-safe (the −162/−299/−788/−794 minefield, 3 prior deaths)

The helper touches NONE of the four forbidden seams: `emitAnyEqOperands`
(−299), the generic `boxToAny` externref arm / `honestAnyBoxing` (−788/−794),
`__any_to_extern`'s tag-6 wrap (CS1a read-breaker), the tag-5 same-tag arm
(−162). The externref↔carrier round-trip lives INSIDE the helper. **Verified
byte-inert:** `scripts/prove-emit-identity.mjs check` → **39/39 (file,target)
emits IDENTICAL** vs the pre-change base (`88f529d83`). Byte-inertness is
guaranteed by the `usesDynMemberGet` LATCH (nothing sets it in U0), not by
dead-elim — an uncalled DEFINED function is not import-pruned.

### funcidx-shift safety

Helpers are minted stable-handle (`mintDefinedFunc`); `eliminateDeadImports`
remaps live-import call immediates in all defined bodies (incl. finalize-minted)
and SKIPS stable handles — so the host body's baked `call __extern_get`
(a live import) is remapped, and standalone's stable-handle calls are immune.
No struct types registered at finalize (only `addFuncType`); the honest
classifier / `__any_to_extern` reuse struct types reserved during body comp.

### Self-test (anti-vacuity) — `JS2WASM_FORCE_DYN_MEMBER_GET=1`

`ensureDynMemberGet` under the FORCE escape also emits exported `__dmg_*`
drivers that build a receiver, call the helper, and return an i32 verdict
entirely in Wasm (a `(ref $AnyValue)` can't cross to JS). The drivers compare
via **direct carrier-field `ref.eq` / `f64.eq`** (not `__any_strict_eq`) so no
sealed coercion helper is invoked from `dyn-read.ts` — the #2108 coercion-drift
gate stays at 0. Covered by `tests/issue-3053-u0-dyn-member-get.test.ts` (12
assertions, all green):
- **standalone ($AnyValue carrier):** object read → **tag-6**; aliased reads ARE
  `===` (refval `ref.eq` → 1), distinct objects NOT (→ 0, assertions bite);
  string → **tag-5**, same stored ref via externval `ref.eq` → 1; number →
  **tag-3**, f64val `f64.eq` → 1; boolean → **tag-4**; RE-READ
  `dmg(dmg(o,"a"),"z")` → tag-3 value 7 (proves the internal peel round-trips —
  the `__any_to_extern` tag-6 breaker is NOT re-triggered).
- **gc/host (externref carrier):** the host object model is JS-side and box/
  marshal semantics are opaque, so the driver reports a marshalling-independent
  i32 — a present-key read through the host wrapper is a non-null externref (1),
  proving the host `__dyn_member_get` (thin `__extern_get` wrapper) is emitted,
  valid, and executes without trapping (deep host read semantics are
  `__extern_get`'s, tested elsewhere).

### U1 readiness — YES

U0 is exactly the locals-free, carrier-uniform, named-key primitive #2949 S5.4
was blocked on: the call site is a bare `call __dyn_member_get`, carrier in/out
is `(ref null $AnyValue)` (gc/standalone) / externref (host) with NO
externref↔$AnyValue impedance at the IR boundary. U1 wires
`IrDynamicLowering.emitMemberGet()`/`emitElementGet()` → `[call
__dyn_member_get]` and sets `ctx.usesDynMemberGet` at that call site (the latch
that makes this finalize pass emit the helper). The pure-`{body:[]}` IR shim
works because the op is a bare `call`. Deferred from U0 (scope): the host-mode
`.length`/vec-index/closure/null-receiver dispatch arms of `emitDynGet` — U0's
standalone body relies on native `__extern_get`, and the host body is the thin
`__extern_get` wrapper; the runtime-key-dispatched host `.length` arms are best
added in U1 against a real call site (they were not needed for the byte-inert
substrate and carry no floor risk deferred).
