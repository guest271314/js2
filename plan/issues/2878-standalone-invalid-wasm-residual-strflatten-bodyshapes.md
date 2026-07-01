---
id: 2878
title: "Standalone: invalid Wasm residual — __str_flatten + user-body shapes (test/inner/fn) after #2868 URI-carrier fix"
status: ready
created: 2026-06-30
updated: 2026-06-30
priority: high
feasibility: medium
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: m
related: [2860, 2868]
umbrella: 2860
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

### Class B — `__str_flatten` runtime null-deref (String.split/replace with RegExp arg)

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
