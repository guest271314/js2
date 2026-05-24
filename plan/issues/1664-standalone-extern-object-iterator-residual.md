---
id: 1664
title: "host-indep: residual __extern_* / __register_* / __iterator* / __array_* leaks after #1472"
status: ready
created: 2026-05-25
priority: medium
feasibility: hard
task_type: bugfix
area: codegen, standalone
language_feature: objects, classes, typed-arrays, iterators
goal: standalone-mode
sprint: Backlog
related: [1662, 1472, 1473]
---
# #1664 — Residual generic-object / iterator host imports under `--target wasi`

## Problem

#1472 ("eliminate JS host object/property ops for standalone") is marked
**done**, but several common constructs still leak the generic
externref-dispatch helpers it was supposed to retire. The allowlist entries
for `__extern_`, `__register_`, `__iterator`, `__array_` (lines 207–249 of
`src/codegen/host-import-allowlist.ts`) all cite #1472 — they are now
residual gaps after a partial landing.

Observed leaks (`--target wasi`, raw import section):

| Probe | Leaking imports |
|---|---|
| `class B extends A { … super.get() }` | `__register_prototype`, `__register_class_object` |
| `new Uint8Array(4).set([1,2,3]).subarray(1)` | `__extern_get`, `__extern_length`, `__array_from_iter` |
| `re.exec(s)` result indexing | `__extern_get` |
| `Map`/`Set` (standalone) | also pulls `__get_undefined` |

Note: most of these probes ALSO emit invalid Wasm (see #1666) — the leak and
the validation failure share a root cause in the native-string/late-global
lowering path. Fix #1666 first; the residual imports here may partly resolve
once the native lowering path is exercised correctly, but the
`__register_*` prototype side-table and `__array_from_iter` typed-array
bridge are genuine missing Wasm-native pieces.

## Standalone alternative

- **`__register_prototype` / `__register_class_object`** — these maintain a
  host-side side-table linking WasmGC structs to JS prototypes for
  `instanceof` and method dispatch. In standalone mode `instanceof` over
  user classes can be resolved with a compile-time class-id field on the
  struct + a `ref.test`/id-compare chain; no host registry needed (#1472
  spec describes the vtable approach).
- **`__extern_get` / `__extern_length`** — generic property/index/length on
  an externref. For typed arrays the element/length access is a pure WasmGC
  `array.get`/`array.len` once the value is known to be a `$TypedArray`
  struct rather than an opaque externref; the leak means the value escaped
  to externref. Audit why the typed-array `.set`/`.subarray` path boxes to
  externref under WASI.
- **`__array_from_iter`** — `Array.from(iterable)` / spread-of-iterable.
  Standalone path: a WasmGC loop calling the iterator protocol helpers
  (which themselves must be native — see #1665) and pushing into a WasmGC
  array.
- **`__get_undefined`** — the `undefined` sentinel; in standalone this is a
  module-level global `(global $__undefined (ref null any))` initialised
  once, not a host call.

## Acceptance criteria

- [ ] `class B extends A`, `Uint8Array.set/.subarray`, and `Map`/`Set`
      probes emit zero `__register_*` / `__extern_*` / `__array_from_iter`
      / `__get_undefined` imports under `--target wasi` and
      `--target standalone`.
- [ ] `new B(5).get()` (super call) returns the correct value standalone.
- [ ] Remove the now-clean allowlist prefixes (or narrow them) and ratchet
      the budget down.
- [ ] equivalence tests green in both modes.

## Files

- `src/codegen/object-ops.ts`, `src/codegen/property-access.ts` —
  externref-dispatch sites.
- `src/codegen/registry/*` — prototype/class registry.
- `src/codegen/typed-arrays*` — typed-array `.set`/`.subarray` lowering.
- `src/codegen/host-import-allowlist.ts` — remove/narrow entries.

## Dependency

Resolve **#1666** (invalid-wasm cluster) first — several of these probes
fail WASM validation, masking whether the leak is intrinsic or a fallout of
the broken lowering path.
