---
id: 1666
title: "bug: --target wasi emits INVALID wasm for class/closure/callback/number→string/regex/generator/typed-array (native helper type mismatch + unbound late global)"
status: done
created: 2026-05-25
completed: 2026-05-25
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

## Resolution (2026-05-25)

Both signatures were distinct **index-shift** bugs, plus one knock-on
**string-materialization** bug. Root-caused and fixed:

### Root cause A — func-index drift in already-emitted helper bodies

`finalizeUnifiedCollector` (declarations.ts) emits the native-string helpers
(`__str_copy_tree`, `__str_flatten`, …) into `ctx.mod.functions`, then later in
the *same* pass adds late func imports (`__make_callback`, `number_toString*`,
`__call_*`, …) via `addImport`. `addImport` bumped `ctx.numImportFuncs` and the
`funcMap`, but — unlike `addStringConstantGlobal`, which has called
`fixupModuleGlobalIndices` for *globals* since #1174 — it never patched the
`call` indices already baked into the emitted helper bodies. So `__str_flatten`'s
`call $__str_copy_tree` (originally `call 0`) kept pointing at index 0, which the
later import insertion had reassigned to `__make_callback`. wasmtime/V8 then
rejected the module with `call[k] expected type <T>, found <U>` *inside the
helper*, not at the user call site.

**Fix**: an eager func-index fixup in `addImport` (`registry/imports.ts`,
`fixupModuleFuncIndices`) — symmetric with the global fixup. It shifts every
`call`/`return_call`/`ref.func` ≥ threshold across all live bodies
(mod.functions, currentFunc, funcStack, parentBodiesStack, liveBodies,
pendingInitBody, global inits), plus `funcMap`, exports, table elements,
declaredFuncRefs, and `startFuncIdx`. The four self-shifting batch adders
(`addUnionImports`, `addStringImports` in index.ts) bump a re-entrancy guard
(`ctx.suppressFuncIndexFixup`) so they keep doing their single batched shift
without double-shifting; `addArrayIteratorImports` / `addGeneratorImports`
previously did **no** shift at all (a latent sibling of this bug) and are now
fixed for free by the eager path.

### Root cause B — unbound late global (`global.get -1`)

Under nativeStrings (auto-on for wasi/standalone) a string constant carries the
`-1` sentinel in `stringGlobalMap` (no `string_constants` global exists). Many
dynamic-dispatch sites used the shape
`addStringConstantGlobal(v); const i = stringGlobalMap.get(v); if (i !==
undefined) global.get i`. Because `-1 !== undefined`, the guard emitted
`global.get -1` → `Invalid global index: 4294967295`. Sites: the `toString`/
`toFixed`/`toPrecision`/`toExponential` RangeError throw payloads
(`expressions/calls.ts`), the extern method-name / builtin-name / `__extern_get`
property-key pushes (`calls.ts` + `property-access.ts`).

**Fix**: materialize the constant inline via `stringConstantExternrefInstrs`
(which already handles both string backends) at every such site; added a local
`pushStringConstantExternref` helper in calls.ts.

### Knock-on — template literal number substitution

`compileNativeTemplateExpression` round-tripped a non-string span through the
JS-host extern bridge (`__str_to_extern`/`__str_from_extern`, backed by
`__str_to_mem`/`__str_from_mem` host imports the strict wasi gate drops). Under
nativeStrings, `number_toString` already returns a boxed NativeString-as-
externref, so the span is now brought back to a string ref with a pure
`any.convert_extern` + guarded `ref.cast` (the same pattern `String(n)` uses) —
no host bridge.

### Outcome (which became valid vs which refuse vs which still leak)

| Construct | Before | After |
|---|---|---|
| closure (captured local) | INVALID | **valid + fully standalone** (0 env imports, runs under wasmtime → 10) |
| class extends/super | INVALID | **valid + fully standalone** (0 env imports, → 5) |
| array .map/.filter/.reduce | INVALID | **valid + fully standalone** (0 env imports, → 12) |
| template `` `val=${x}` `` | INVALID | **valid** (leaks `number_toString` — #1335) |
| `(255).toString(16)` / `.toFixed` | INVALID | **valid** (leaks `number_toString*` — #1335) |
| `String(42)` | (already valid) | valid (leaks `number_toString` — #1335) |
| `Uint8Array.set` | INVALID | **valid** (leaks `__extern_get` — #1664) |

The audit's "INVALID WASM + leaks" entries were misleading: the leak counts came
from a *tolerant* import-section parser reading a malformed module. Once valid,
classes/closures/array-methods carry **zero** env imports. The remaining leaks
(`number_toString*`, `__extern_get`) are genuine feature gaps owned by #1335 /
#1664; this issue delivers **validity**, which is independent of
leak-elimination per the original acceptance note.

### Verification

- New regression suite `tests/issue-1666-standalone-valid-wasm.test.ts`:
  asserts `WebAssembly.compile` validity for every construct under both
  `--target wasi` and `--target standalone`; instantiates the three
  zero-host-import constructs with an empty import object and checks return
  values (10 / 5 / 12); plus a gc-mode regression guard.
- Confirmed end-to-end under real `wasmtime -W gc=y,function-references=y,
  tail-call=y,exceptions=y --invoke test`: closure→10, arrmap→12, cls→5.
- Targeted equivalence sweep (~250 tests across strings/classes/closures/
  arrays/templates/typed-arrays/map-set/standalone/wasi-stdout): no new
  failures; the handful of red tests (json-stringify boolean-coercion quirk,
  iife-tagged-templates, optional-direct-closure-call, object-literal
  getters/setters) fail identically on `origin/main` — pre-existing, unrelated.
- `tsc --noEmit` clean; biome lint introduces no new diagnostics.

### Files

- `src/codegen/registry/imports.ts` — eager func-index fixup in `addImport` +
  `fixupModuleFuncIndices`.
- `src/codegen/context/types.ts` — `suppressFuncIndexFixup` re-entrancy guard.
- `src/codegen/index.ts` — guard the two self-shifting batch import adders.
- `src/codegen/expressions/calls.ts` — RangeError throw payloads +
  dynamic-name pushes via `stringConstantExternrefInstrs` /
  `pushStringConstantExternref`.
- `src/codegen/property-access.ts` — `__extern_get` property-key pushes via
  `stringConstantExternrefInstrs`.
- `src/codegen/string-ops.ts` — template number substitution avoids the host
  extern bridge under nativeStrings.
