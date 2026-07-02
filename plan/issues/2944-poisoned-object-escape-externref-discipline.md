---
id: 2944
title: "Substrate: poisoned $Object values escape into struct-typed slots — externref-typed escape discipline for hash-consumer vars"
status: done
completed: 2026-07-02
assignee: ttraenkler/sr-escape
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

## Design (2026-07-02, sr-escape) — TYPE-keyed poison at the type-resolution chokepoint

### Measured root cause (sharper than the seed's framing)

Minimal repro (host, poison re-enabled, **no type annotations** — the reduced
E1/E2/E3 shapes in #2937 all passed because their `: any` annotations already
lowered every slot to externref; acorn is unannotated JS, so its types are
INFERRED object types, and that is the load-bearing difference):

```ts
// @ts-nocheck
var defaults = { ecmaVersion: 5, sourceType: "script" };
function getOptions(opts) {
  var options = {};
  for (var opt in defaults) {
    options[opt] = opts && opt in opts ? opts[opt] : defaults[opt];
  }
  if (options.ecmaVersion === "latest") {
    options.ecmaVersion = 1e8;
  } else if (options.ecmaVersion == null) {
    options.ecmaVersion = 11;
  } else if (options.ecmaVersion >= 2015) {
    options.ecmaVersion -= 2009;
  }
  return options;
}
class Parser {
  constructor(opts) {
    this.options = getOptions(opts);
  }
  read() {
    return this.options.ecmaVersion;
  }
}
export function test(ev) {
  return new Parser({ ecmaVersion: ev, sourceType: "module" }).read();
}
```

- poison OFF (main today): `test(2022)` → `0` (the #2849 shadow bug, via the class shape)
- poison ON (#2432 state): `test(2022)` → throws `TypeError … at 17:19` (`this.options` reads null)

WAT + ts.Type-identity probes pin the chain:

1. `checker.getTypeAtLocation` returns **one shared ts.Type instance** (call it
   `T2`) for the `options` declaration, every `options.…` receiver, AND
   `getOptions`'s inferred return type. (Distinct `{}` vars get distinct
   instances — no cross-var sharing in the probe.)
2. The function-signature pre-pass calls **`ensureStructForType(ctx,
unwrappedRetType)` (`declarations.ts:2971`)** on `getOptions`'s return type =
   `T2`. `ensureStructForType` registers **"empty objects get an empty struct"**
   → `anonTypeMap.set(T2, $__anon_0)`. The poison suppressed the _widening_
   registration of T2, but this TYPE-keyed registrar doesn't consult the poison.
3. `collectDeclarations` then types the `options` local via `resolveWasmType(T2)`
   → anonTypeMap hit → `(ref null $__anon_0)`. The `{}` initializer compiles to
   a HOST `$Object` (externref); the decl-init coercion emits
   `any.convert_extern` + `ref.test $__anon_0` → host object is not a wasm
   struct → **`options` local is NULL from the first instruction**.
4. All for-in `options[opt]=` writes `__extern_set(null, …)` silently no-op;
   `return options` returns null; `this.options` field (externref — acorn class
   fields type as `any`) stores null; `read()`'s null-guard throws. In full
   acorn the same chain nukes parser setup on every input (#2937), and other
   registrars (closure param `ensureStructForType`, literal registration,
   destructuring) can bind the same type the same way — this is why the
   receiver-identifier bail (#2937 WIP) could never win: the DECLARED SLOT
   types, not the read sites, are what poison must reach.

So: the poison is **var-name-keyed and consulted only at the widening
decision**, while representation actually flows from **ts.Type-keyed**
machinery (`ensureStructForType` / `anonTypeMap` / `resolveWasmType` /
`resolveStructName`). Any type-keyed registrar re-binds every slot (local,
return, param, field) and every read of the poisoned value back to a struct.

### The fix — poison the TYPE, not (just) the var

Record the poisoned var's ts.Type instance(s) in a new context set and consult
it at the three type-resolution chokepoints everything else derives from:

- `ctx.objectHashConsumerTypes: Set<ts.Type>` (context/types.ts +
  create-context.ts).
- **Populate** in `collectEmptyObjectWidening` (declarations.ts): when a var is
  poisoned, add `checker.getTypeAtLocation(decl.name)` and
  `getTypeAtLocation(decl.initializer)` — skipping `any`-flagged types (the
  `any` singleton is shared by all any-typed vars, same guard as the existing
  anonTypeMap skip). **Host-gated (`!ctx.standalone`)** so standalone bytes are
  untouched (standalone has the same latent escape, but that is a separate
  byte-affecting slice; its poison behavior is unchanged here).
- **Consult** in:
  1. `ensureStructForType` (index.ts) — early return. Kills the empty-struct /
     shaped-struct registration from return-type/param/closure/destructuring
     pre-passes.
  2. `resolveWasmType` (index.ts, top of the Object-flags branch) — return
     `externref`. Every slot the value flows into (local, return, param, field,
     alias) lowers to externref, matching the `$Object` host value.
  3. `resolveStructName` (property-access.ts) — return `undefined`. Every
     member read/write on an expression of that type routes through the dynamic
     host path (`__extern_get`/`__extern_set` + the #2655 multi-struct
     dispatch), which handles both host `$Object`s and genuine structs.
- **Re-drop the host gate** on the `markObjectHashConsumers` loop (restore
  #2432's behavior) in the same PR — with the type discipline in place the
  escape that killed acorn is closed.

Why this shape: it is exactly the existing precedent — `#1287` (.d.ts types),
`#2542` (index-signature dictionaries), `#2724` (mixed accessor literals) all
"skip registration → type lowers to externref everywhere → `$Object` dynamic
path services it". The poison becomes one more citizen of that discipline, and
the decision lives at the type-resolution chokepoint rather than being patched
at N read sites. (North-star note: this is representation-decision
centralisation — when the IR value model (#2856 D1) takes over slot typing, the
poisoned-type set maps 1:1 onto an IR-side `extern` value-kind decision; the
chokepoint consult means the IR migration replaces ONE lookup, not N scattered
bails.)

Escape coverage follows automatically: assignments/aliases (`const y = o` —
y's slot types via resolveWasmType(T2) → externref), returns (signature
pre-pass consults ensureStructForType/resolveWasmType), params + closure params
(closures.ts calls ensureStructForType(tsParamType) → skipped → externref),
struct fields typed from the RHS/declared type (index.ts:12663 propType →
externref), array elements (vec elem type resolution → externref elem key).
A shared-type demotion (two vars sharing one annotated ts.Type, one poisoned)
demotes both to `$Object` — conservative but CONSISTENT (both representations
agree), and unannotated `{}` vars (the acorn class) have per-var types.

### Validation gates (acceptance)

- probe above: poison-on host → 13; acorn corpus ≥ 2026-06-30 baseline
  (≥13 equal±quirks, 0 `compiled-parse-threw` beyond the 2 known);
- `tests/issue-2849.test.ts`: 4 `it.fails` host arms flip back to plain `it`;
- standalone: byte-identical (sha256 over the #2849 test corpus + a standalone
  compile of the probe);
- equivalence tests green; full `merge_group` (broad-impact rule) for the 137
  recovered + no regressions.

## Test Results (2026-07-02, implementation branch)

- **Escape probe** (acorn `Parser`/`getOptions` shape, unannotated): host
  `test(2022)` → **13** (was: throw with poison-on, `0` with poison-off).
- **Acorn corpus** (`tests/dogfood/acorn-corpus.mjs`, full 23 inputs):
  **21 equal±quirks / 0 REAL / 2 threw** (`corpus/regex.js`, `real/acorn.mjs`
  self-stress — the same 2 pre-existing throws as the #2462 revert state; above
  the 2026-06-30 baseline of 13 equal). Poison ACTIVE in host throughout.
- **`tests/issue-2849.test.ts`**: all 11 pass with the 4 former `it.fails` host
  arms flipped to plain `it` (2022 → 13 on all guard variants + dead-branch
  2022 read-back).
- **`tests/issue-2944.test.ts`** (new): return+field escape (13), default arm
  (5), alias escape (13), standalone purity — all pass.
- **Standalone byte-diff**: sha256 identical main↔branch for ALL 6 corpus
  sources under `--target standalone` (poison + codegen untouched). Host bytes
  change ONLY for poisoned-with-guard shapes (the fix); `static-only` and
  `no-guard` host compiles byte-identical.
- **Sequencing vs #2462**: the revert (PR #2462) MERGED first (project-lead
  directive — acorn un-broken at the accepted interim cost of the #2432 host
  wins, ~137 tests). This PR is the RE-ENABLEMENT: it re-drops the
  `ctx.standalone` gate WITH the ts.Type-keyed escape discipline, so the host
  wins recover as positive deltas in the `merge_group` and acorn stays green.

### Design-premise validation (prior art for #2856 / extern-in-IR)

The fix empirically validates the substrate premise: **representation must
follow the VALUE, and the correct key is the ts.Type instance the checker
threads through every slot** (decl, reads, inferred return, field, alias — one
shared instance, measured). A single decision recorded once and consulted at
the type-resolution chokepoints fixed ALL escape shapes at once — no per-site
bails, no read-path patches. This maps 1:1 onto the IR value model direction
(June audit D1, #2856 extern-in-IR): when IR owns slot typing, the
`objectHashConsumerTypes` set becomes an IR-side `extern` value-kind decision
at exactly one point, and the three legacy chokepoint consults are the
migration seam to replace. Cite this as prior art in the #2856 spec work.
