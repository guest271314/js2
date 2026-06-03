---
id: 1662
title: "audit: standalone (--target wasi) host-import leaks per construct + remaining-gap map"
status: done
created: 2026-05-25
updated: 2026-05-25
completed: 2026-05-25
priority: high
feasibility: easy
task_type: research
area: codegen, standalone
language_feature: host-imports
goal: standalone-mode
sprint: Backlog
related: [1535, 1471, 1472, 1473, 1474, 1103, 1335, 1470, 1599, 682, 1598, 1387, 1781]
---
# #1662 — Standalone (`--target wasi`) host-import audit

## Problem

The dual-mode principle (CLAUDE.md) says every feature should have a
Wasm-native path that needs no JS runtime. #1535 produced a _source-level_
inventory of host imports; this issue is the _empirical_ counterpart — for a
representative feature matrix, compile each construct with `--target wasi`
and record which **non-`wasi_snapshot_preview1`** imports actually leak into
the emitted `.wasm`.

`wasi_snapshot_preview1.*` (fd_write, proc_exit, random_get, …) is the WASI
ABI and is **expected** — not a leak. Only `env.*` (and any
`wasm:js-string` / `string_constants`) count as JS-host leaks.

## Method

36 minimal probes in `.tmp/probes/*.ts`, each
`npx tsx src/cli.ts <probe>.ts --target wasi -o <out> --no-dts`, then the
module's import section parsed (tolerant raw parser used so leaks are
visible even for modules that fail full WASM validation — see the
"invalid-wasm" cluster below). Cross-checked against `--target standalone`
and the strict-mode allowlist (`src/codegen/host-import-allowlist.ts`).

## Findings table (construct → leak under `--target wasi`)

| Construct                                                       | Result under `--target wasi` | Leaking `env.*` imports                                                                                                                                             | Owner            |
| --------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| number arithmetic (`*`,`/`,`%`)                                 | CLEAN                        | —                                                                                                                                                                   | —                |
| string literals + concat + `+`                                  | CLEAN                        | —                                                                                                                                                                   | —                |
| `String.prototype` `.length`/`.slice`/`.indexOf`/`.toUpperCase` | CLEAN                        | —                                                                                                                                                                   | —                |
| `String.prototype.split(",")`                                   | CLEAN                        | —                                                                                                                                                                   | —                |
| `String.fromCharCode`                                           | CLEAN                        | —                                                                                                                                                                   | #1598 (landed)   |
| `Uint8Array` `.set`/`.subarray`                                 | **INVALID WASM** + leaks     | `__extern_get`, `__extern_length`, `__array_from_iter`                                                                                                              | #1664 / #1666    |
| `Float64Array`/`Int32Array`                                     | CLEAN                        | —                                                                                                                                                                   | —                |
| `ArrayBuffer` + `DataView` get/set                              | CLEAN                        | —                                                                                                                                                                   | —                |
| plain array `.push` + `.length`                                 | CLEAN                        | —                                                                                                                                                                   | —                |
| array `.map`/`.filter`/`.reduce`                                | **INVALID WASM** + leaks     | `__make_callback`, `__call_1_f64`, `__call_2_f64`                                                                                                                   | #1470 / #1666    |
| array `for-of` iteration                                        | CLEAN                        | —                                                                                                                                                                   | —                |
| object literal + property get/set                               | CLEAN                        | —                                                                                                                                                                   | —                |
| object spread `{...o, b:2}`                                     | CLEAN                        | —                                                                                                                                                                   | —                |
| class + method + `extends`/`super`                              | **INVALID WASM** + leaks     | `__register_prototype`, `__register_class_object`                                                                                                                   | #1664 / #1666    |
| closure capturing local                                         | **INVALID WASM** + leaks     | `__make_callback`                                                                                                                                                   | #1470 / #1666    |
| `JSON.stringify` (object)                                       | **CE (gated)**               | (gate rejects `env.eval`/`isNaN`/`isFinite`/`global_JSON`)                                                                                                          | #1599 Phase 2    |
| `JSON.parse`                                                    | **CE (gated)**               | (same)                                                                                                                                                              | #1599 Phase 2    |
| `Math.*` (sqrt/floor/max/sin)                                   | CLEAN                        | —                                                                                                                                                                   | —                |
| `parseInt`/`parseFloat`/`Number()`                              | leaks                        | `parseInt`, `parseFloat`                                                                                                                                            | **#1663 (new)**  |
| `(x).toFixed`/`(n).toString(16)`                                | **INVALID WASM** + leaks     | `number_toString`, `number_toString_radix`, `number_toFixed`                                                                                                        | #1335 / #1666    |
| `String(42)`/`String(true)`                                     | **INVALID WASM** + leaks     | `number_toString`                                                                                                                                                   | #1335 / #1666    |
| template literal `` `${x}` `` (number interp)                   | **INVALID WASM** + leaks     | `number_toString`                                                                                                                                                   | #1335 / #1666    |
| `/re/.test(s)`                                                  | **INVALID WASM** + leaks     | `RegExp_new`, `RegExp_test`                                                                                                                                         | #682 / #1474     |
| `/re/.exec(s)`                                                  | **INVALID WASM** + leaks     | `RegExp_new`, `RegExp_exec`, `__extern_get`                                                                                                                         | #682 / #1474     |
| `s.replace(/x/g,…)`                                             | **INVALID WASM** + leaks     | `RegExp_new`, `string_replace`                                                                                                                                      | #682 / #1474     |
| `Map` (`new`/`set`/`get`/`size`)                                | leaks                        | `Map_new`, `Map_set`, `Map_get`, `Map_get_size`                                                                                                                     | #1103            |
| `Set` (`new`/`add`/`size`)                                      | leaks                        | `Set_new`, `Set_add`, `Set_get_size`                                                                                                                                | #1103            |
| `try { throw new Error } catch`                                 | CLEAN                        | —                                                                                                                                                                   | #1473 (landed)   |
| null-deref TypeError try/catch                                  | CLEAN                        | —                                                                                                                                                                   | #1473 (landed)   |
| `function*` generator + for-of                                  | **INVALID WASM** + leaks     | `__gen_create_buffer`, `__gen_push_f64`, `__gen_push_i32`, `__create_generator`, `__create_async_generator`, `__gen_throw`, `__get_caught_exception`, `__iterator*` | **#1665 (new)**  |
| `a[Symbol.iterator]()`                                          | CE (TS type)                 | —                                                                                                                                                                   | (probe artefact) |
| `async function` (declared)                                     | CLEAN                        | —                                                                                                                                                                   | —                |
| `Promise.resolve`                                               | CLEAN                        | —                                                                                                                                                                   | —                |
| `new Date(0).getFullYear()`                                     | CLEAN                        | —                                                                                                                                                                   | —                |
| `BigInt` (`10n+20n`)                                            | CLEAN                        | —                                                                                                                                                                   | —                |
| `Symbol("x")` identity                                          | CLEAN                        | —                                                                                                                                                                   | —                |

(CLEAN = zero non-wasi imports. "INVALID WASM" = the module also fails
`WebAssembly.compile` validation — a correctness bug, see #1666 — but the
import section still parses and shows the leak.)

## Interpretation

The host-import gate (`--no-host-imports`, implied by `--target wasi`) has
two failure modes:

1. **Allowlisted leak** — the import name matches a transitional entry in
   `host-import-allowlist.ts`, so the gate lets it through and the `.wasm`
   carries an unsatisfiable `env.*` import. Every leak above is allowlisted,
   each citing a tracking issue. These are the genuine remaining gaps.
2. **Hard CE** — JSON pulls `env.eval`/`env.global_JSON`, which are NOT on
   the allowlist, so the strict gate rejects them at compile time (the gate
   working as designed; #1599 Phase 2 owns the pure-Wasm codec).

A third, independent failure surfaced: many constructs that _should_ lower
to pure WasmGC (classes, closures, callback-based array methods, number→
string, regex, generators, typed-array `.set`) emit **invalid Wasm** under
`--target wasi` — the native string/number helpers (`__str_flatten`,
`__str_to_extern`) get a type-mismatched call, or a global index resolves to
`0xffffffff` (-1, an unbound late global). This is tracked separately as a
correctness bug in **#1666**.

## Genuine remaining gaps and their owners

| Bucket                             | Leaking imports                                                                 | Tracking issue                                                                      | Status              |
| ---------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------- |
| Map/Set/WeakMap/WeakSet            | `Map_*`,`Set_*`,`WeakMap_*`,`WeakSet_*`                                         | **#1103** (exists)                                                                  | ready — link        |
| Number→string formatting           | `number_toString*`,`number_toFixed`,`number_toPrecision`,`number_toExponential` | **#1335** (exists)                                                                  | ready — link        |
| RegExp engine                      | `RegExp_*`, regex-arg `string_*`                                                | **#682 / #1474**                                                                    | ready/done — link   |
| Closures / host callbacks          | `__make_*`,`__call_*`                                                           | **#1470**                                                                           | review — link       |
| JSON codec (Phase 2)               | (gated `eval`/`global_JSON`)                                                    | **#1599**                                                                           | done Phase 1 — link |
| `parseInt`/`parseFloat`/`Number()` | `parseInt`,`parseFloat`                                                         | **#1663 (new)** — #1471 was closed without covering these                           | new                 |
| Object/extern/iterator residual    | `__extern_*`,`__register_*`,`__iterator*`,`__array_*`,`__get_undefined`         | **#1664 (new)** — residual after #1472 closed                                       | new                 |
| Native generators                  | `__gen_*`,`__create_generator`,`__create_async_generator`                       | **#1665 (new)** — only owned by the #1376 IR telemetry gate, no native-engine issue | new                 |
| Invalid-wasm correctness bug       | (n/a — module fails validation)                                                 | **#1666 (new)**                                                                     | new                 |

## Expected / wont-fix (not filed)

- `eval`, `Function(string)`, Proxy, `with`, dynamic `import()` — wont-fix in
  standalone per CLAUDE.md skip filters. JSON's `env.eval` leak is an
  implementation detail of the host JSON shim, retired by #1599 Phase 2, not
  a reason to support eval.
- Full `Intl.*` / `localeCompare` collation — keep host-only (≥0.5 MB data),
  per #1535 recommendation.

## 2026-06-02 Standalone test262 coverage note

The `with` classification above is superseded for standalone test262 tracking:
the 2026-06-01 standalone test262 run showed 294 non-exclusive `WithStatement`
failures, and #1387 now owns the prove-or-demote lowering plan. The broader
lesson from this audit still stands, but #1781 is needed to retain the full
standalone JSONL and prove that every residual standalone test262 failure maps
to an issue file rather than only the manually copied high-volume clusters.
