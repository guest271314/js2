---
id: 2944
title: "Substrate: poisoned $Object values escape into struct-typed slots — externref-typed escape discipline for hash-consumer vars"
status: done
completed: 2026-07-02
assignee: ttraenkler/dev-2937f
created: 2026-07-02
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: dynamic-object-property-type-inference
goal: acorn-dogfood
related: [2849, 2937, 2584, 2372, 2432, 2896, 1712]
depends_on: []
blocks: [2849, 2937]
---

# #2944 — externref-typed escape discipline for poisoned `$Object` (hash-consumer) vars

> **DONE 2026-07-02 — implemented TYPE-KEYED, not per-escape-site (same PR as
> the #2849 re-land / #2937).** Key insight that collapsed the XL scope: the
> struct type a poisoned var mis-binds to comes from the checker's **evolved
> JS-mode `ts.Type`**, and the return type, class-field type, params, aliases
> and receivers all resolve through the **same type object identity**. So one
> set — `ctx.objectHashConsumerTypes` (recorded at the poison decision in
> `collectEmptyObjectWidening`; guards: host-only / not-`any` / props>0) —
> checked in the three resolution funnels (`resolveWasmType`,
> `ensureStructForType`, `resolveStructName`) delivers the return/field/param/
> alias escape discipline enumerated below without chasing individual escape
> sites. The "colliding `__anon` struct" is simply never registered for a
> poisoned type, so nothing can bind to it. Acceptance, measured: host gate
> re-dropped + all 4 `it.fails` arms flipped back to plain `it` and passing;
> dogfood corpus 21/23 equal±quirks (≥13 required), 0 REAL divergences;
> standalone byte-identical (sha256); mechanism details + known residual in
> the #2937 issue file (`## Fix (the re-land)`).

**[SENIOR-DEV ONLY] — substrate slice.** This is the proper home for BOTH #2849
(dynamic-object static-write shadows sidecar, host mode) and #2937 (the acorn
uniform null-deref that the #2849 host fix caused). A scoped resolver change
cannot satisfy both; a value-representation slice is required.

## The conflict (why a scoped fix is impossible)

The `#2584`/`#2372`/`#2849` **poison** (`ctx.objectHashConsumerVars`,
`markObjectHashConsumers` in `declarations.ts`) keeps a `{}` var that has BOTH
dynamic-key access (`o[k]=`, `k in o`, `for (k in o)`, `Object.keys/…`) AND
static-named access on the `$Object` **sidecar** — it suppresses widening into a
closed WasmGC struct so writes + reads share one representation.

**The gap (root-caused for #2937, instrumented):** the poison is honored **ONLY
at the widening DECISION**. `objectHashConsumerVars` is consulted nowhere in the
read/write codegen. So:

1. The poison keeps the _value_ a `$Object`, but the read/write paths still
   resolve the receiver via `resolveStructName(TS-type)`, which can bind the
   poisoned var to a colliding `__anon` struct registered under the SAME TS
   object type by a _different_ (non-poisoned) same-shaped var. Instrumented on
   acorn: `options.ecmaVersion` → `resolveStructName` returns `__anon_4`
   (idx 46, an `ecmaVersion`-bearing struct) while `poisoned=true` and
   `widenedVarStruct=undefined` → `struct.get` on a `$Object` value → null.
2. Worse, the poisoned `$Object` value **ESCAPES the identifier**: `getOptions`
   RETURNS `options`, the caller stores it in the struct-typed `this.options`
   field, then reads `this.options.ecmaVersion` via that struct binding — a
   **non-identifier** access. A receiver-identifier bail (attempted in #2937,
   commit on branch `issue-2937-acorn-host-poison`) fixes parser SETUP but only
   1/23 corpus inputs, because the escaped value is read through struct-typed
   slots the bail cannot reach.

Measured proof (#2937): host poison ON + identifier bail → 22/23 acorn corpus
inputs still throw; pure revert (poison OFF in host) → all 23 parse but #2849
reopens. The two constraints (**#2849 fixed AND compiled-acorn parses**) cannot
both hold with a scoped resolver change — the poison's "keep as `$Object`" only
half-propagates.

## Required fix (the substrate slice)

Propagate the "this value is a `$Object` (poisoned), not a struct" decision
through every place a poisoned value **escapes** the declaring identifier, so
downstream reads use the dynamic host/`$Object` path instead of `struct.get`:

- **Return type**: a function that returns a poisoned var must have its inferred
  return type lowered to externref/`$Object`, not the colliding anon struct.
- **Field assignment**: `this.f = <poisoned>` (and any `x.f = <poisoned>`) must
  type field `f` as externref so `x.f.prop` reads via `__extern_get`.
- **Param passing / aliasing**: passing a poisoned var as an argument, or
  `const y = <poisoned>`, must carry the externref typing to the callee/alias.

Equivalent alternative (broader, more work): unify the `$Object`/struct read
path so ANY read of a _possibly_-`$Object` value uses the dynamic host path —
this is the value-rep substrate direction (#2896 family). Either way the read
site must stop binding a poisoned/escaped value to a struct type it isn't.

Then RE-EXTEND the poison to host (re-drop the `ctx.standalone` gate that #2937
restored) — with escapes handled, host acorn stays green AND #2849's host bug
stays fixed.

## Acceptance

- Re-drop the host gate in `collectEmptyObjectWidening` AND land the escape
  discipline together: compiled-acorn dogfood corpus back to ≥ the 2026-06-30
  baseline (≥13 equal±quirks) in host mode.
- `tests/issue-2849.test.ts`: the 4 host arms currently marked `it.fails`
  (3 guard variants + DEAD_BRANCH) flip back to plain `it` and pass
  (host `2022 → 13`, unreached-write reads `2022`).
- Standalone codegen byte-identical (its poison is unchanged throughout).
- 0 test262 regressions; full `merge_group` + standalone floor.

## Seed material

- **The escape mechanism, instrumented firing site, and measured
  revert-vs-bail comparison** are captured in the "The conflict" section above
  (root-caused during #2937). The #2937 issue file has the symptom, the
  bisect to PR #2432, and the fixed-by-revert banner.
- **#2849 design** (the poison, `objectHashConsumerVars`, the sidecar-wins
  strategy (b) and why (a)/(c) were rejected): the #2849 issue file's
  "Corrected Root Cause & Design" section.
- WIP receiver-identifier bail (the incomplete first half — a foundation, NOT a
  fix): earlier commit on branch `issue-2937-acorn-host-poison` history
  (superseded by the revert; recover from git if useful).
- Instrumentation recipe: `DBG_THROW_SITES` env hooks in `typeErrorThrowInstrs`
  / `resolveStructNameForExpr` / `markObjectHashConsumers` (see #2937 analysis).

## Residual fixed (TS-mode 0-props escape) — 2026-07-02, sr-escape

The landed fix's population guard (`vt.getProperties().length > 0`) admitted
only the JS-mode EVOLVED type, on the assumption that the TS-mode (non-evolved)
empty `{}` type "already resolves to externref". **Measured false**: the
signature pre-pass `ensureStructForType(returnType)` on a function that RETURNS
the poisoned var registers the SAME 0-props ts.Type as an **empty anon struct**
("empty objects get an empty struct" in `ensureStructForType`), so the
local/return/field slots type `(ref null $__anon_N)`, the `{}` host `$Object`
fails the decl-init cast, and the var is null from the first instruction. Probe
(unannotated acorn `Parser`/`getOptions` shape, `fileName: t.ts`): threw
`TypeError … Cannot access property on null or undefined` on main WITH the
landed fix; the #2937 reduced shapes (E1/E2/E3) missed this because their
`: any` annotations pre-lowered every slot to externref.

**Why the guard couldn't just be dropped**: the type of a `: {}` ANNOTATION is
an interned ts.Type **shared** by every var so annotated (measured: two
annotated vars → one instance), so poisoning it would demote unrelated vars.
But the **widened literal type** of an unannotated `var o = {}` is a fresh
per-var instance whose `symbol.declarations[0]` IS the var's own initializer
literal (measured; the shared annotation type fails this check — `symbol` has
no such declaration). The residual fix admits the 0-props type **only when
`vt.symbol?.declarations?.[0] === decl.initializer`** — per-var by
construction, zero shared-identity risk. Same identity domain the widening
registration (`anonTypeMap.set(varType, …)`) already relies on.

Validation: escape probe host `test(2022)` → 13 (return + `this.options` field

- method read); alias-binding arm; `tests/issue-2944.test.ts` added (fails on
  pre-residual main); acorn corpus re-verified 21 equal±quirks / 0 REAL / 2
  pre-existing throws; standalone sha256 byte-identical (set stays host-only);
  equivalence: the 56 local failures reproduce IDENTICALLY (same per-file counts)
  on pristine main — pre-existing env, zero delta.

### Design-premise validation (prior art for #2856 / extern-in-IR)

Both the landed fix and this residual empirically validate the substrate
premise: **representation must follow the VALUE, keyed by the ts.Type instance
the checker threads through every slot** (decl, reads, inferred return, field,
alias — one shared instance, measured). One decision recorded once + consulted
at the three type-resolution chokepoints fixed ALL escape shapes at once — no
per-site bails. This maps 1:1 onto the IR value model direction (June audit D1,
#2856 extern-in-IR): when IR owns slot typing, `objectHashConsumerTypes`
becomes an IR-side `extern` value-kind decision at exactly one point, and the
three legacy chokepoint consults are the migration seam. Cite as prior art in
the #2856 spec work.
