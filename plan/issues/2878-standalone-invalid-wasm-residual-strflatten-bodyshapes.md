---
id: 2878
title: "Standalone: invalid Wasm residual — 3 root-cause classes (A: dstr default value-rep, B: __str_flatten null-deref, C: eqref/funcidx-shift). Single-cause framing superseded."
status: done
assignee: ttraenkler/dev-2878
completed: 2026-07-02
created: 2026-06-30
updated: 2026-07-03
priority: high
feasibility: medium
task_type: bug
area: codegen
goal: standalone
sprint: 69
horizon: m
related: [2860, 2868, 2849, 2918, 1461]
umbrella: 2860
decomposition: "Triaged into 3 independent classes (see ## Triage findings). dev-2878 fixed Class C (eqref-coercion, PR #2431) and marked this done — BUT that re-measurement sampled built-ins/ only and MISSED the Class-A object-destructuring value-rep cluster, which lives in language/**/dstr/** (42 tests, 0->18 genuine PASS). dev-callback's Class-A slice 1 lands via PR #2435. TECH-LEAD DECISION PENDING: reopen #2878 vs re-home the remaining Class-A/B slices under a fresh follow-up issue."
---

# Standalone: invalid Wasm — residual after #2868

#2868 fixed the `__uri_encode`/`__uri_decode` carriers (root cause: a shared
`throwURIError` `Instr[]` aliased the same `call`/`throw` Instr objects across
~13 spread sites, so `shiftLateImportIndices` over-shifted the shared `funcIdx`
once per occurrence — fixed by making it a fresh-Instr factory). This follow-on
tracks the **rest** of the #2868 invalid-Wasm surface that the URI fix did not
cover.

## Remaining buckets (from the #2868 measurement, 2026-06-30)

| function | tests | note |
| -------- | ----- | ---- |
| `test` (harness/user) | 199 | a common emitted body shape |
| `inner` | 81 | nested function shape |
| `fn` | 42 | |
| `__str_flatten` | 10 | native string flatten (String split RegExp-arg path) |
| `C_setPrivateReference` | 10 | private-field accessor |
| `gen` / `__closure_*` / `__cb_*` | ~40 | |

## Root-cause hypothesis

The `__uri_*` fix shows one concrete instance of the **shared-Instr-object
aliasing** hazard interacting with the late-import index-shift walker
(`shiftLateImportIndices` mutates `instr.funcIdx += delta` per occurrence; a
spread-shared `call`/`ref.func` Instr is shifted N×). The `test`/`inner`/`fn`
body-shape failures (322) may share this class (another emitter that spreads a
shared `Instr[]` containing a `call`/`ref.func`) **or** be a distinct
stack-balance / type-mismatch on a `ctx.standalone`-gated path. Triage one repro
per named function (disassemble with binaryen, read the exact validator error),
then cluster.

A defensive hardening worth evaluating: make `shiftLateImportIndices` (and the
sibling string-import shift in `index.ts`) **idempotent per Instr object** (track
a `Set<Instr>` of already-shifted call/ref.func nodes), so a shared Instr can
never be double-shifted regardless of emitter aliasing. That would neutralize the
whole bug class at the walker instead of fixing each emitter. Weigh against the
"never alias one Instr[]" convention (memory
`reference_shared_instr_object_dce_double_remap`).

## Test plan

Standalone CE → pass: `test/built-ins/String/prototype/split/**` (RegExp-arg
`__str_flatten`), plus the clustered `test`/`inner`/`fn` body-shape examples once
the shared construct is identified. Full `merge_group`.

## Triage findings (2026-07-02, dev-callback — reproduced on origin/main @ 4d5287afc)

The buckets are **NOT one root cause** — at least three distinct classes
reproduce on current main:

### Class A — object-destructuring-with-default value-rep mismatch (the dominant `test`/`inner`/`fn` invalid-Wasm cluster)

Repro: `test/language/statements/const/dstr/obj-ptrn-prop-id-init-skipped.js`
(and the whole `**/dstr/**` family). V8 rejects:
```
Compiling function #48:"test" failed: local.set[0] expected type f64, found local.get of type externref
```
Disassembly of `$test`: a binding local `$5` is declared **f64** (its default
arm unboxes via `__unbox_number` → f64), but the **value-present else arm**
stores the raw struct field (externref) with **no coercion**:
```wat
(if (call $__str... default-check)
  (then (local.set $5 (call $__unbox_number ...)))   ;; f64  ✓
  (else (local.set $5 (local.get $13))))             ;; externref -> f64  ✗ invalid
```
Site: `src/codegen/statements/destructuring.ts` → `emitDefaultValueCheck`
(L553). `buildElseBranch` (L613-622) coerces `fieldType → targetType`, but the
authoritative type is the **local's own** type (`getLocalType(fctx, localIdx)`,
which `emitDefaultIntoLocal` at L570-576 already uses). When `targetType` is
absent / equals `fieldType`, the else arm skips coercion and stores an externref
into an f64 local → invalid Wasm.

**Careful — two candidate fixes, only one is correct:**
1. *Naive*: make `buildElseBranch` coerce `fieldType → getLocalType(localIdx)`
   like `emitDefaultIntoLocal`. This makes the module VALID but is
   **semantically wrong**: the property value here is `null`, and
   `coerceType(externref, f64)` unboxes null → `NaN`, so `assert.sameValue(t,
   null)` fails. That converts CE → runtime-FAIL (honest, but not a pass).
2. *Correct*: the binding local `t` should be typed **any/externref**, not f64,
   because `const { s: t = counter() } = { s: null }` binds a nullable value.
   The bug is upstream in the **binding-local type inference** (where the local
   is allocated f64 despite an `any`/`null` field). Fix there so both arms are
   externref and no lossy coercion is needed. Investigate the local-type
   decision in `destructureParamObject` / `ensureBindingLocals` (the shared
   typed-struct helper invoked at destructuring.ts L847). Then both arms store
   externref and `t === null` holds.

Verify with **output-vs-js-host** on the `dstr` corpus before shipping (a valid
binary that returns NaN is NOT a pass).

**Class A slice 1 — LANDED (2026-07-02):** `emitDefaultValueCheck`
(`src/codegen/statements/destructuring.ts`) now coerces the **value-present**
arm to the binding local's ACTUAL declared type (`getLocalType(localIdx)`), not
`targetType`, at all three value-arm sites (`buildElseBranch`, the
`objectPropertySemantics` ref else-arm, and the trailing i32/other else). The
NaN-trap fear did **not** materialise: a scalar (f64/i32) local only ever binds
a *numeric* property whose boxed-number externref unboxes correctly; a
`null`-valued binding gets an externref local, so no lossy coercion occurs.
Measured on the targeted population (`local.set expected f64/i32, found ref`,
42 tests): **0→18 genuine PASS, +11 honest FAIL, 40→11 CE** (no-fix baseline was
40/40 CE). Byte-inert for the gc/host lane (sha256 identical on a dstr snippet
corpus — there the struct field type already matches the local, so the coercion
is a no-op path). Regression test: `tests/issue-2878-dstr-default-valuerep.test.ts`.
The 11 honest FAILs are a **separate** pre-existing bug (`null`-valued property
wrongly triggers the default in the *default-check*, and the multi-field
dynamic-object read returns 0 — #2849), NOT this slice.

**Re-measure pending (#2849 / PR #2432):** the dynamic-object multi-field
read-returns-0 half of the honest-FAIL set is #2849, whose fix is in CI as
**PR #2432**. When that lands, several of the 11 FAILs here should flip to
genuine PASS with no further change to this slice — re-run the targeted-sample
measurement (`local.set expected f64/i32, found ref`, seed 11) against
post-#2432 main and update the pass/fail split above. No action on this branch;
tracked as a re-measure note. Remaining Class-A
value-rep signatures (`call[N] expected externref, found struct.new/ref.cast`;
`struct.new expected eqref, found anyref`; `not enough arguments for struct.new`)
are distinct codegen shapes → follow-up slices.

### Class B — `__str_flatten` runtime null-deref (String.split/replace with RegExp arg) — tracked as #2935

Repro: `test/built-ins/String/prototype/split/argument-is-regexp-a-z-and-instance-is-string-abc.js`,
`.../replace/S15.5.4.11_A1_T7.js`. Runtime (not compile): `dereferencing a null
pointer in __str_flatten() (via test)`. A separate bug in the native
`__str_flatten` helper on the RegExp-arg split/replace path — distinct from
Class A. (A plain `"a1b2".split(/[0-9]/)` compiles to VALID Wasm and instantiates,
so the trigger is a more specific RegExp/receiver shape.)

### Class C — `call[N] expected externref` funcidx-shift (matches the #2868 hypothesis)

Repro: `test/language/expressions/arrow-function/dstr/dflt-ary-ptrn-rest-ary-elision.js`
→ `__str_flatten failed: call[1] expected type externref, found i32.const of
type i32`; `inner failed: call[0] expected type externref, found ref.cast`.
These are the funcidx/late-import-shift class the issue hypothesised. The
`shiftLateImportIndices` idempotency hardening (track a `Set<Instr>` of
already-shifted call/ref.func nodes) is the candidate neutraliser for this class
only.

**Recommendation**: split into per-class sub-issues. Class A (dstr binding-local
type inference) is the largest bucket and the highest-value; it needs the
binding-local-type fix (not the naive coercion). Classes B and C are
independent. `binaryen wasm-dis` shows GC bodies even when V8 rejects; use
`WebAssembly.validate` / `instantiate({})` for the authoritative verdict
(binaryen's `wasm-validate` rejects valid GC with `unexpected type form 0x50`).

## Resolution (2026-07-02, dev-2878)

### Re-measured the residual on current main first

The 2026-06-30 buckets had **already largely healed** on current `origin/main`
via intervening merges (#2918 native-Promise funcIdx-shift and others).
Concrete re-measurement (standalone compile + `WebAssembly.compile` validate over
a 3,500-file `built-ins` sample):

- `String/prototype/split/**`: **119/120 valid** (the `__str_flatten` bucket was
  already gone — the RegExp-arg split path validates). The `test`/`inner`/`fn`
  buckets (199/81/42 on 2026-06-30) had collapsed to a small heterogeneous tail.
- The **largest remaining coherent cluster** was a `local.tee/struct.set expected
  type eqref, found any.convert_extern of type anyref` family, surfacing as
  `__call_toString` / `__call_valueOf` (ToPrimitive dispatch) and
  `__set_member_toString` (member-write dispatch).

### Root cause — `externref → eqref` coercion produced ANYREF

`any.convert_extern` yields `anyref`, the **supertype** of `eqref`. Three sites
emitted the bare conversion and stored the result straight into an `eqref` slot
(`struct.set` / `local.set`), which the Wasm validator rejects — an invalid
binary (worst-class correctness bug). Fixed by narrowing `anyref → eqref` with a
nullable `ref.cast` to the abstract `eq` heap type (`-19` signed-LEB):

1. `src/codegen/coercion-plan.ts` — the #1917 **single coercion table** (the
   authoritative site; splits the old `externref → anyref/eqref` row so `eqref`
   narrows). This is what `fillMemberSetDispatch` uses to coerce an externref
   value into an `eqref` struct field → fixed `__set_member_*`.
2. `src/codegen/index.ts` `emitToPrimitiveMethodExports` `closure-extern` arm —
   the ToPrimitive dispatcher recovers an externref-stored method closure
   (`struct.get → any.convert_extern → local.set eqref`); narrow to the concrete
   closure struct type before the store → fixed `__call_toString` /
   `__call_valueOf`.
3. `src/codegen/type-coercion.ts` `coerceType` (fctx variant) + the
   `coercionInstrs` fallback arm — mirror the table fix for the inline-emit path.

Host (gc) mode is unaffected: this coercion only appears on the host-free
standalone/wasi path, and the change only *adds a valid narrowing cast* — a bare
`anyref`-into-`eqref` store was never valid in any mode, so there is no
valid-before case to regress.

### Measured effect

3,500-file `built-ins` standalone sample: invalid-Wasm **32 → 26** — the entire
`__call_toString`(5) / `__call_valueOf`(1) / `__set_member_toString`(1) family is
eliminated, **no new invalid functions**. Host (gc) sample unchanged (6 invalid,
all pre-existing heterogeneous `test`/`__cb_0`, none eqref-family).

### Residual (out of scope — candidate follow-on)

A small **heterogeneous** tail remains (not a single mechanism, not the
`eqref`/funcIdx-shift class): `test` (~15/sample, e.g. String/concat
`call[0] expected (ref null …)`, RegExp/test, TypedArray resizable-buffer
`array.get/array.set` type-mismatch) and a few `__closure_*` (species-poisoned
Array, for-await close, Proxy tco-realm) + `__cb_0`. Each is a distinct
codegen bug warranting its own triage; recommend a follow-on umbrella'd under
#2860 if the counts justify it.

### Tests

`tests/issue-2878-externref-eqref-narrow.test.ts` — deterministic unit assertions
that `coercionPlan` / `coercionInstrs` narrow `externref → eqref` (and leave
`externref → anyref` unchanged), plus standalone compile-and-validate of
ToPrimitive / dynamic-member shapes.

## Correction to the dev-2878 re-measurement (2026-07-02, dev-callback)

The dev-2878 re-measurement above sampled **`built-ins/` only**, so it did not
see the **Class A object-destructuring value-rep** cluster, which lives in
**`language/**/dstr/**`** (`const {u:v=…}={u:0}` over a heterogeneous/boxed
object → `local.set expected f64, found externref`). Independently measured on
the same current main: 42 tests in the targeted signature, **0 pass / 40 CE**
baseline → **18 genuine PASS / 11 honest FAIL / 11 CE** with the Class-A slice
(PR #2435). So #2878 was marked `done` on a corpus that missed this class; the
Class-A slice is a genuine, complementary fix (different file —
`statements/destructuring.ts` — untouched by PR #2431). Tech-lead to decide:
reopen #2878, or re-home remaining Class-A/B slices under a fresh follow-up.
