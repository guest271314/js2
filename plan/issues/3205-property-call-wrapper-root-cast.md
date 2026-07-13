---
id: 3205
title: "Property/element callable dispatch: order-independent wrapper-root cast + covariant funcref dispatch (retire the #2967 slice-2a latent hazard)"
status: done
completed: 2026-07-13
assignee: ttraenkler/opus-closures
created: 2026-07-13
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
goal: async-model
parent: 2967
related: [2967, 2873, 1131, 2174]
origin: "#2967 slice-2a park fix (PR #2873) — 'Follow-up candidates filed in-issue (not blocking): the property-call closure dispatch (calls-closures.ts) still casts to the declared wrapper — same latent order-dependence, no corpus hit'"
loc-budget-allow:
  - src/codegen/expressions/calls-closures.ts
---

# #3205 — Property/element callable dispatch: order-independent wrapper-root cast

## Problem (the latent hazard the #2873 fix flagged but did not close)

When `#2967` slice-2a fixed the funcref-wrapper-struct RTT order-dependence for
the **callable-param** dispatch (`calls.ts`, root-wrapper cast via
`getFuncRefWrapperRootTypeIdx`), it explicitly flagged the SAME latent hole in
the **property-call / element-access** dispatch
(`src/codegen/expressions/calls-closures.ts` ~682/874): those sites still cast
the field/element callee to its **declared** wrapper and fetch the funcref via a
**single** declared funcref cast.

Every no-capture closure wrapper struct is a layout-identical
`(struct (field funcref))`, but `getOrCreateFuncRefWrapperTypes` chains each
later signature `sub final` under the module's FIRST wrapper (the chain root).
WasmGC isorecursive canonicalization keys on (fields, supertype, finality), so
the siblings do NOT canonicalize. A closure whose **actual** signature differs
from the field's **declared** signature — a covariant return
(`() => number`/`() => string` stored in a `() => void` field) or an activated
async closure (its result rewritten to externref/Promise) — is allocated under a
DIFFERENT sibling wrapper. The declared-wrapper cast then nulls (or the single
declared funcref cast nulls), and `call_ref` traps on the null funcref
("dereferencing a null pointer").

**This is a real miscompilation, not a theoretical one.** Reproductions (all
trap on pristine `main`; WAT-verified the wrapper-struct/funcref mismatch):

```ts
// (1) covariant return through a property call
class Runner { fn: () => void; constructor(f: () => void){ this.fn = f; }
  run(): void { this.fn(); } }
let n = 0;
function bumpNum(): number { n++; return 7; }   // () => f64 wrapper
new Runner(bumpNum).run();                       // main: null-deref trap; expect n=1

// (2) async closure stored on a field
new Runner(async () => { n++; }).run();          // main: null-deref trap

// (3) covariant element-access call
const arr: Array<() => void> = [bumpNum];
arr[0]();                                         // main: null-deref trap
```

The `main` "survival" of any such module was pure wrapper-CREATION ORDER (which
helper's wrapper became the chain root) — the exact order-dependence the #2873
callable-param fix removed, still live on the property/element path.

Why no corpus hit yet: the `website/playground/examples` corpus does not
exercise the callable-externref-field property-call branch at all (verified —
`prove-emit-identity` is byte-identical before/after this change), so the hazard
was latent. It surfaces in real programs (and test262 async-harness /
callback-in-field shapes) where a covariant or async closure is stored on an
object/class field or callable array and invoked through it.

## Fix (mirror the calls.ts #2873 root-wrapper dispatch)

In `compileCallablePropertyCall`'s externref branch AND
`compileCallableElementAccessCall` (`src/codegen/expressions/calls-closures.ts`):

1. **Build a funcref-type candidate set** (`buildClosureFuncCandidates`): the
   declared wrapper + speculative externref/void/f64/i32-return variants (the
   forward-referenced covariant/async closure may be wrapped only when a LATER
   `new`/store site compiles, so the value's real wrapper is not yet registered
   at the dispatch site) + a scan of `closureInfoByTypeIdx` for any already-
   registered same-arity closure whose funcref type differs.
2. **When exactly ONE candidate exists** (the only closure of this arity is the
   declared signature — the value can only be it or a capture subtype): emit the
   pre-existing single-candidate path VERBATIM (byte-identical; the
   declared-wrapper cast is safe).
3. **When >1 candidate exists**: cast the callee to the wrapper ROOT
   (`getFuncRefWrapperRootTypeIdx` — the guaranteed supertype of every wrapper),
   null-check self while the guarded-cast backup is still the raw value, save
   args to locals, fetch the funcref off the ROOT's field 0 (valid for a closure
   of ANY wrapper subtype), and dispatch on the funcref's exact type
   (`emitRootFuncrefDispatch`) — each arm re-casts self to that candidate's
   struct and coerces the return to the declared type; no funcref match → throw
   TypeError (never a null-deref trap). Async-return fields widen the dispatch
   result to externref so a stored async closure's Promise flows through intact
   (mirrors calls.ts #2174).

Return-coercion on the dead (non-matching) arms is import-free
(`drop`+`defaultValueInstrs` / pure numeric `coerceType`) so a never-executed
arm cannot pull a late import and shift indices under already-baked `ref.func`
operands (the #2174 hazard).

## Byte-identity

`prove-emit-identity` (`website/playground/examples`, gc+standalone+wasi, 39
records) is **IDENTICAL** before/after — the single-candidate path is byte-for-
byte the old code, and the corpus never reaches the multi-candidate branch. The
new helpers only emit when a genuine covariant/async candidate set exists.

## Measured yield (per-file `runTest262File`, branch vs pristine-main control)

Permanent repro: `tests/equivalence/issue-3205-property-call-wrapper-root.test.ts`
(5 cases — covariant number/string property-call, async-closure property-call,
element-access covariant call, matching-signature control).

Controls (all trap on `main`, WAT-verified wrapper mismatch):

| shape | main | branch |
| --- | --- | --- |
| covariant `()=>number` property-call (gc) | null-deref trap | PASS |
| covariant `()=>number` property-call (standalone) | null-deref trap | PASS |
| covariant `()=>string` property-call (gc) | null-deref trap | PASS |
| async-closure property-call (gc) | null-deref trap | PASS |
| covariant element-access `arr[i]()` (gc) | null-deref trap | PASS |
| matching-signature property-call (gc/std) | PASS | PASS (unchanged) |

No regressions: `illegal-cast-closures-585`, `class-method-calls`,
`optional-direct-closure-call` fail IDENTICALLY on main and branch (all
pre-existing).

test262 A/B (`runTest262File`, branch vs pristine-main), **2,386 files across
the affected suites** — `language/expressions/async-{arrow-,}function`,
`built-ins/Promise`, `language/statements/class/elements`, `built-ins/Array/from`:

- async+Promise (805 files): **113 pass both, 0 flips**;
- class/elements+Array.from (1,581 files): **1,281 pass both, 0 flips**.

**Zero regressions, zero improvements** on the sampled suites — the fix is inert
where the exact shape (covariant/async closure stored in a callable field,
called via property/element access) is not exercised, and the controls above
prove it fixes that shape where it IS exercised. So the yield is a genuine
latent-miscompilation-class removal with no conformance regression; the
merge_group full-corpus run is the backstop for any suite not sampled here.

Known residual (follow-up, NOT a regression — main also fails): covariant
`() => string` in STANDALONE mode returns a native-string REF (not externref),
which the externref/numeric alts don't cover, so it degrades from a null-deref
trap to a caught TypeError. A standalone ref-return alt (resolve the native
string/struct ref type) would close it; deferred.

## Acceptance criteria

- Property-call and element-access callable dispatch are order-independent for
  covariant/async closures (root-wrapper cast + funcref-type dispatch). ✓
- `prove-emit-identity` byte-identical on the playground corpus. ✓
- Reproductions fixed; zero regressions vs pristine main on the closure/async
  suites (merge_group full test262 is the backstop). ✓
