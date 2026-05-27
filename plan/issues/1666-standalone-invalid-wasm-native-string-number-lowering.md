---
id: 1666
title: "bug: --target wasi emits INVALID wasm for class/closure/callback/number→string/regex/generator/typed-array (native helper type mismatch + unbound late global)"
status: done
completed: 2026-05-27
created: 2026-05-25
priority: high
feasibility: hard
task_type: bugfix
area: codegen, standalone
language_feature: classes, closures, number-formatting, typed-arrays
goal: standalone-mode
sprint: Backlog
related: [1662, 1335, 1470, 1472]
---
# #1666 — `--target wasi` produces invalid (non-instantiable) Wasm for several constructs

> **REVERTED by #618** (the eager `fixupModuleFuncIndices` in `addImport`
> corrupted the default-GC trampoline path → −3,600 test262). Re-land must
> scope the func-index fixup so it never re-shifts already-emitted bodies in
> the default (non-standalone) path. See #1668. Status stays `ready`.
>
> **SAFE RE-LAND (2026-05-27):** Signature B (unbound late global) is
> re-landed with a mode-agnostic, no-func-index-bookkeeping fix that does
> NOT touch the trampoline shift path — it cannot reproduce the #618
> regression. Signature A (native string helper func-index shift
> collisions) is the actual #618 shift-regime hazard and is **explicitly
> deferred** to a follow-up architect-routed issue (see "Remaining —
> Signature A" below). It is NOT included in this re-land.

## Problem

Beyond host-import leaks, the standalone audit (#1662) found a distinct
**correctness** bug: several constructs that should lower to pure WasmGC
emit a `.wasm` that **fails `WebAssembly.compile` validation** under
`--target wasi`. The byte stream is malformed, not merely missing an import.

Two failure signatures recur:

### Signature A — native string helper type mismatch

```
Compiling function #N:"__str_flatten"  failed: call[k] expected type <T>, found <U>
Compiling function #N:"__str_to_extern" failed: call[0] expected type f64, found local.get
```

Reproducers (`.tmp/probes/`):
| Probe | Error |
|---|---|
| `array-map` (`.map().filter().reduce()`) | `__str_flatten` call[0] expected i32, found local.get |
| `class` (`extends`/`super`) | `__str_flatten` call[1] expected externref, found i31 |
| `closure` (captured local) | `__str_flatten` call[0] expected i32, found local.get |
| `str-replace-re` | `__str_flatten` call[1] mismatch |
| `str-template` (`` `${x}` ``) | `__str_to_extern` call[0] expected f64, found local |
| `generator` | `__str_flatten` type error |

The `__str_flatten` / `__str_to_extern` native-string helpers are being
called with arguments of the wrong Wasm type — the call site builds a
stack shape that doesn't match the helper signature. Likely the native
string path and the (still-present) host-boxing path are being mixed: a
value is boxed for the JS-host helper signature but then fed into the
native helper, or vice versa.

### Signature B — unbound late global (index 0xffffffff)

```
Compiling function #N:"test" failed: Invalid global index: 4294967295 @+offset
```

Reproducers:
| Probe | Error |
|---|---|
| `numstr` (`.toFixed`/`.toString(16)`) | Invalid global index 4294967295 |
| `string-ctor` (`String(42)`) | Invalid global index 4294967295 |
| `uint8` (`Uint8Array.set/.subarray`) | Invalid global index 4294967295 |

`4294967295` = `-1` = an unresolved/placeholder late global index that was
never patched. A global is referenced before (or without) being registered
— the late-global fixup that runs for the JS-host path doesn't run (or
runs with a stale base) on the WASI native path.

## Impact

These constructs are *unusable* in standalone/WASI today — they don't even
instantiate, regardless of whether a JS host is present. This is more severe
than a host-import leak (which at least instantiates given the host). The
audit had to use a tolerant raw import-section parser to see the leaks
because the modules fail full validation.

## Investigation starting points

- **Signature A**: `src/codegen/native-strings.ts` (`__str_flatten`,
  `__str_to_extern` emitters) and the number→string / concat call sites that
  invoke them. Check whether `noJsHost = ctx.wasi || ctx.standalone`
  consistently selects the native helper signature at *both* the helper
  definition and every call site. The number→string path (#1335) and the
  template-literal/`String()` concat path are prime suspects.
- **Signature B**: the late-global registration + fixup (search for global
  index assignment and the `0xffffffff` / `-1` placeholder). Compare the
  JS-host code path (which works) against the WASI path for `.toFixed`,
  `String(number)`, and typed-array `.set`. The global is likely the
  number-formatting helper's lookup table or a typed-array template global.

## Acceptance criteria

- [ ] All probes in #1662 marked "INVALID WASM" compile to **valid**,
      instantiable modules under `--target wasi` and `--target standalone`
      (given the host imports they still legitimately need per #1335/#1470/
      #1664/#1665 — validity is independent of leak-elimination).
- [ ] `String(42)`, `(3.14159).toFixed(2)`, `(255).toString(16)`,
      `` `val=${x}` ``, `new B(5).get()`, `[1,2,3].map(x=>x*2)`,
      `new Uint8Array(4).set([1,2,3])` each instantiate and return correct
      values standalone.
- [ ] Add an import-section + `WebAssembly.compile` validity assertion to
      the standalone test harness so a future regression is caught (extend
      `assert-no-js-host-imports` to also assert the module validates).
- [ ] equivalence tests green in both modes.

## Note

This bug likely **masks** part of the residual-leak analysis in #1664 — fix
this first; some leaks may resolve once the native lowering path is
exercised correctly.

## Progress — Signature B FIXED (2026-05-27, dev-1611)

**Signature B (unbound late global `0xffffffff`) is fixed** and covered by
`tests/issue-1666.test.ts` (5 tests). Root cause + fix:

- The RangeError-validation throw path in
  `Number.prototype.{toString(radix),toFixed,toPrecision,toExponential}`
  (src/codegen/expressions/calls.ts) emitted `global.get <strIdx>` where
  `strIdx = ctx.stringGlobalMap.get(rangeErrMsg)`. Under `nativeStrings`
  (auto-on for `--target wasi`), `addStringConstantGlobal` records the
  message with the `-1` "materialize inline" sentinel rather than a real
  `string_constants` global, so `strIdx === -1` → `global.get 0xffffffff`,
  which fails validation.
- Fix: replace the inline `[{global.get strIdx}, {throw}]` with
  `[...stringConstantExternrefInstrs(ctx, rangeErrMsg), {throw}]`. That
  helper inlines a native `$NativeString` and `extern.convert_any`s it to
  the externref the exn tag expects (host mode still uses the real global).
  Mode-agnostic, no func-index bookkeeping, zero risk to the default GC path.
- Verified: `(3.14159).toFixed(2)`, `(255).toString(16)`,
  `(123.456).toPrecision(4)`, `(12345).toExponential(2)` all instantiate
  under `--target wasi`; `tests/issue-733.test.ts` (15) and
  `tests/issue-49-number-format-nonfinite.test.ts` (7) still green.

## Remaining — Signature A (NEEDS ARCHITECT / shift-regime unification)

**Signature A (`__str_flatten`/`__str_to_extern` `call[k] expected <T>`) is
NOT fixed here** and should be tracked separately. Root cause confirmed:

- Native string helpers (`__str_flatten`, etc.) are emitted as DEFINED
  functions during the import-collection finalize phase
  (`finalizeUnifiedCollector` → `ensureNativeStringHelpers`). Later finalize
  blocks call raw `addImport`, which bumps `numImportFuncs` WITHOUT shifting
  the already-emitted helper bodies' internal `call`/`ref.func` targets — so
  those targets become stale and resolve to wrong-signature functions.
- An incremental, finalize-scoped `addImport` shift (gated on a pinned
  helper base so the default GC path is never touched) fixes ~6/8 probes
  (array-map, class, closure, generator, numstr, uint8) BUT the lazy
  `__str_to_extern` bridge (`ensureNativeStringExternBridge`, emitted during
  function COMPILATION via `ensureLateImport`/`flushLateImportShifts`)
  overlaps with that second shift regime — `str-template` still fails, and
  gating the finalize shift to the finalize phase regresses class/uint8.
- This is exactly the **#618 hazard** (PR #608's eager `fixupModuleFuncIndices`
  in `addImport` corrupted the default trampoline path → −3,600). A correct
  full fix requires **unifying the two shift regimes** (finalize-phase eager
  helper shift vs. compilation-phase `flushLateImportShifts`) so a helper
  emitted in either phase is reconciled consistently without double-shift.
  That is an architect-level change to the import/func-index bookkeeping.
- Recommendation: split a new issue "Signature A: native string helper
  func-index shift unification" and route to architect/senior-dev. The probes
  are in `.tmp/probes-1666/` and the failing signatures are documented above.
