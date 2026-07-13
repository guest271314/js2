---
id: 3232
title: "standalone: static private ACCESSOR setter emits invalid Wasm (C_setPrivateReference — call[0] ref-type mismatch) — 10 compile_error→pass"
status: done
sprint: 71
assignee: ttraenkler/opus-privref
created: 2026-07-13
updated: 2026-07-13
completed: 2026-07-13
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, standalone
language_feature: classes, private-names, accessors
goal: standalone-mode
related: [1591, 1365, 1364, 2101a]
loc-budget-allow:
  - src/codegen/expressions/assignment.ts
origin: "2026-07-13 opus-gapmap standalone measure-first: wasm_compile cluster in the host-passes/standalone-fails set. Documented for a fresh full-budget agent (prior author at budget)."
---

# #3232 — static private accessor setter → invalid Wasm on standalone

## Measured impact (verified via runner, 2026-07-13)

**+10 `compile_error` → `pass`** (higher value than a leaky de-leak — these tests
do NOT run today). **Standalone-only ⇒ gc-neutral by construction** (the gc/host
lane compiles + passes all 10; only the standalone/`nativeStrings` lane emits
invalid Wasm). The fix must be standalone-gated so the gc lane stays
byte-identical.

The 10 files (all HOSTPASS on gc, all `compile_error` on standalone):

```
language/statements/class/elements/private-accessor-name/static-private-escape-sequence-u2118.js
                                                          static-private-escape-sequence-u6F.js
                                                          static-private-escape-sequence-ZWJ.js
                                                          static-private-escape-sequence-ZWNJ.js
                                                          static-private-name-common.js
                                                          static-private-name-dollar.js
                                                          static-private-name-u2118.js
                                                          static-private-name-underscore.js
                                                          static-private-name-ZWJ.js
                                                          static-private-name-ZWNJ.js
```

Reproduce the count:
```bash
ls test262/test/language/statements/class/elements/private-accessor-name/static-private-*.js
# then run each with runTest262File(path, "language/statements", 20000, "standalone")
# → all 10 return status "compile_error".
```

## Symptom (exact, from the runner on all 10)

```
WebAssembly.instantiate(): Compiling function #45:"C_setPrivateReference" failed:
call[0] expected type (ref …)   ← a ref-type mismatch at a call inside the
                                    STATIC-private SETTER call path
```

The failing function is the test's `static setPrivateReference(value) { this.#name = value; }`
— i.e. a **static private SETTER invocation** (`this.#name = value` where `#name`
is a `static set` accessor). The getter side (`C_getPrivateReference`) does NOT
fail — only the setter callsite.

## Scoping already done (don't redo)

- **NOT unicode/escape-specific.** The failing set includes plain-ASCII names
  (`-name-common`, `-name-dollar`, `-name-underscore`), so the trigger is the
  **static-private-setter code path itself**, not the private-name escape
  handling. (The escape-sequence variants fail for the same reason, incidentally.)
- **The isolated repro compiles CLEAN on BOTH lanes** — this is THE key clue:

  ```ts
  let stringSet = "";
  class C {
    static get #p() { return "get string"; }
    static set #p(param: string) { stringSet = param; }
    static getPrivateReference(): string { return this.#p; }
    static setPrivateReference(value: string): void { this.#p = value; }
  }
  ```
  This compiles + validates standalone with no error. Also clean with `any`-typed
  `stringSet`/params, and with the literal `#℘` char. So the bug needs the
  **test262 harness context** to reproduce — the differentiator is the VALUE TYPE
  at the setter callsite as the wrapper produces it (the wrapped test passes a
  bare string literal / `any` through `assert.sameValue` flow), NOT the class
  shape in isolation.

## Root-cause plan (do this FIRST — pull the failing WAT)

1. **Get the failing WAT from the WRAPPED compile.** The isolated repro won't
   show it. Use the runner's own wrapper:
   - `wrapTest(source, meta, target)` is EXPORTED from `tests/test262-runner.ts`
     (~line 2373); `runTest262File` calls it at ~line 3863 then `compile(wrappedSource, { target: … , … })` at ~line 3905.
   - Write a `.tmp` probe (or a `tests/probe-*.test.ts`, gitignored) that reads
     one failing file, calls `wrapTest(src, meta, /*standalone target*/)`, then
     `compile(wrapped, { target: "wasi" /* or the standalone target the runner
     uses */, … })`, and writes `result.wat` / `result.binary` to `.tmp/`. Inspect
     the `C_setPrivateReference` function body and find the `call` whose argument
     ref-type ≠ the callee's expected param type.
   - The runner passes `target` into `wrapTest` and `compile` — mirror exactly
     what `runTest262File(..., "standalone")` does (grep the `target` plumbing
     around line 3863–3905; standalone lane forces `nativeStrings: true`).

2. **Identify the two mismatched types** at the `call[0]` site inside the setter
   path. Hypothesis (verify against the WAT): the static private SETTER accessor
   function is registered with a parameter ValType (e.g. `(ref $String)` under
   nativeStrings, or the branded static-field carrier type) that does NOT match
   the ValType the setter-invocation helper pushes for `value` (likely `externref`
   or a boxed `any`). The `this.#name = value` lowering for a STATIC private
   accessor routes through a private-setter dispatch helper; under nativeStrings
   the string/any rep differs from gc, so the arg coercion that the gc lane gets
   for free is missing/wrong on standalone → the emitted `call` arg type ≠ the
   accessor's declared param type.

3. **Fix at the setter callsite** (standalone-gated): coerce the pushed `value`
   to the accessor's declared parameter ValType before the `call` (the same
   coercion the gc lane already applies), so the `call[0]` types match. Ground the
   fix in the static-private-accessor lowering — grep for where `this.#name =`
   / private-setter dispatch is emitted (likely `src/codegen/property-access.ts`
   and/or the class-bodies private-accessor registration in
   `src/codegen/class-bodies.ts`; the `C_setPrivateReference`/`C_getPrivateReference`
   naming comes from the static-method compilation). Look for an asymmetry: the
   GETTER path works, the SETTER path is missing the arg coercion.

4. Keep it `ctx.standalone`/`nativeStrings`-gated → **gc byte-identical, NET≥0 by
   construction** (gc already passes all 10).

## Validation

- The 10 files above → `pass` on standalone via `runTest262File(..., "standalone")`.
- `prove-emit-identity`: gc/host lane byte-identical (the fix only fires on the
  standalone/nativeStrings arm).
- Add `tests/issue-3232-*.test.ts`: the harness-shaped repro (static private
  get+set accessor, `this.#x = v` in a static method, value read back) compiled
  `target: "wasi"`, asserting `WebAssembly.validate` + correct runtime value.
  NOTE: the isolated shape compiles clean today — the test must reproduce the
  HARNESS value-type flow (bare string-literal / `any` value into the setter),
  which is what the wrapped compile exercises. Derive the minimal triggering
  shape from step 1's WAT (whatever value-type the wrapper feeds the setter).

## Handoff note

Documented by opus-gapmap after landing #3228; stood down at budget before going
wide. Measurement is solid (10 files, single signature, standalone-only,
gc-neutral). The one open unknown is the exact minimal trigger — step 1 (pull the
wrapped WAT) resolves it. Bounded +10; flag the tech lead if root-cause opens
into an unbounded rep-substrate change (it should not — the getter path already
works, so it's a localized setter-arg-coercion asymmetry).

## Resolution (2026-07-13, opus-privref)

Root cause confirmed exactly as the plan hypothesised. In
`compilePropertyAssignment` (`src/codegen/expressions/assignment.ts`, the
private-accessor setter-dispatch branch ~line 3252) the **value** param was
coerced via `valTypeHint = setterParamTypes[1]`, but the **receiver** (param 0 =
self) was compiled with NO coercion. On the standalone/`nativeStrings` lane a
`this`-in-a-static-method receiver lowers to an `externref` static-class carrier,
so the emitted `call` pushed an `externref` where the accessor declares
`(ref $Class)` → `call[0] expected type (ref …), found … externref` (invalid
Wasm at `C_setPrivateReference`). The gc/host lane already coerces this receiver
via a pre-existing path, which is why gc passed all 10.

**Fix**: coerce the receiver to `setterParamTypes[0]` before compiling the value
(while it is the stack top), gated on `(ctx.standalone || ctx.wasi)` +
`recvResult.kind === "externref"` + a non-externref, non-matching self-param.
`coerceType` emits the same `any.convert_extern` + guarded `ref.cast` the getter
read path uses. Standalone/wasi-gated ⇒ **gc byte-identical** (verified: the
wrapped gc WAT is byte-for-byte unchanged, 3062 bytes).

**Validation**:
- All 10 `static-private-*` files → `pass` via
  `runTest262File(..., "standalone")` (was `compile_error`). **+10.**
- The entire `private-accessor-name/` dir passes on standalone; `private-methods/`
  CE count unchanged (5, pre-existing, unrelated) → no regression.
- gc/host lane byte-identical (wrapped WAT diff empty).
- `tests/issue-3232.test.ts` (3 cases: wasi valid-Wasm, standalone run-value,
  gc compile) — all green. Minimal trigger is the harness value-type flow
  (untyped `var stringSet;` + untyped accessor params); the fully-typed isolated
  shape compiles clean on both lanes even without the fix.
