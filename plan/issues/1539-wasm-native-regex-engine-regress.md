---
id: 1539
title: "Standalone Wasm RegExp engine via regress (Phase 2 of #1474)"
status: ready
created: 2026-05-20
updated: 2026-05-24
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime
language_feature: regular expressions
goal: standalone-wasm
sprint: 55
depends_on: [1474]
related: [1474, 682, 1535]
---
# #1539 — Standalone Wasm RegExp engine via regress (Phase 2 of #1474)

## Decision

**Use `regress` (Rust crate) as the standalone regex engine. Close out #682 (libregexp).**

Rationale for rejecting QuickJS libregexp:
- `LRE_FLAG_INDICES` is explicitly marked `"Unused by libregexp, just recorded"` in `libregexp.h` — the `d` flag is silently accepted but `match.indices` is never populated. Silent wrong behavior, not a compile error.
- The "ES2023 compliant" claim in #682 is self-asserted; `regress` is tested against the test262 RegExp suite.
- `regress` is actively maintained (ridiculousfish), used in Boa and Hermes, with verified spec coverage.

**Scope**: `regress` is used **only in standalone mode** (`ctx.standalone === true`). JS-host mode continues using the existing `RegExp_new` host import — no change there.

## Problem

`#1474` Phase 1 landed refuse-and-document: standalone builds with regex fail at compile time. Phase 2 (this issue) replaces those refusals with real regex execution via `regress`.

In standalone mode today:
- `/\d+/.test(s)` → compile error (Phase 1 gate in `typeof-delete.ts`)
- `new RegExp(p, f)` → compile error (Phase 1 gate in `new-super.ts`)
- `s.match(re)`, `s.replace(re, f)`, `s.split(re)` → compile error (Phase 1 gate in `string-ops.ts`)

After this issue: all of the above work by routing through the regress side module.

## Library

- Crate: [`regress`](https://github.com/ridiculousfish/regress) (Apache-2.0 / MIT)
- Build: `cargo build --release --target wasm32-unknown-unknown --no-default-features --features utf16` + `wasm-opt -Os`
- Expected binary: ~250 KB (no Unicode property tables), ~400 KB (with full `\p{}` support). Pre-build and commit to `vendor/regress.wasm`; rebuild only when `vendor/regress-version.txt` changes.
- UTF-16 feature flag matches `--nativeStrings` representation — no re-encoding needed for that path.

## Design

No new CLI flag. Routing is purely on `ctx.standalone`:

```
ctx.standalone = false  →  existing JS host import (RegExp_new) — unchanged
ctx.standalone = true   →  regress side module
```

The Phase 1 `reportError` guards in `typeof-delete.ts`, `new-super.ts`, `string-ops.ts` are **replaced** by the regress codegen path.

## Implementation Plan

### Entry points

| File | Change |
|------|--------|
| `src/codegen/typeof-delete.ts` | Remove Phase 1 `reportError` in `compileRegExpLiteral`; when `ctx.standalone`, emit `regress_compile(pattern, flags)` instead of `RegExp_new` |
| `src/codegen/expressions/new-super.ts` | Same for `new RegExp(p, f)` |
| `src/codegen/string-ops.ts` | Replace Phase 1 error gates for `match`/`matchAll`/`search`/`replace`/`replaceAll`/`split` with regress-backed calls when `ctx.standalone` |
| `src/codegen/regex-link.ts` (new) | Side-module linker: embed `vendor/regress.wasm`, use Binaryen `wasmMerge` to link it into the output when `ctx.standalone`. Registers the regress import namespace. Only runs once per module (`ctx.regressLinked` guard). |
| `src/codegen/index.ts` | Add `ctx.regressLinked: boolean`; set on first regex site emitted in standalone mode. |
| `vendor/regress.wasm` | Pre-built artifact (committed). |
| `vendor/regress-version.txt` | Pin: crate version + feature flags. |
| `scripts/build-regress-wasm.sh` | Rebuild script (dev only; CI uses committed artifact). |

### ABI

Strings pass as `(ptr, len)` UTF-16 code-unit pairs into a shared linear memory slab:

```wat
(import "regress" "compile"     (func (param i32 i32 i32) (result i32)))
;; pattern_ptr, pattern_len, flags_bitfield -> re_handle (0 = compile error)

(import "regress" "exec"        (func (param i32 i32 i32 i32) (result i32)))
;; re_handle, str_ptr, str_len, start_idx -> match_handle (0 = no match)

(import "regress" "group"       (func (param i32 i32) (result i64)))
;; match_handle, group_idx -> start<<32|end  (-1,-1 = unmatched group)

(import "regress" "group_count" (func (param i32) (result i32)))
;; match_handle -> capture group count

(import "regress" "free"        (func (param i32)))
;; free re_handle

(import "regress" "free_match"  (func (param i32)))
;; free match_handle
```

### WasmGC types

```wat
(type $RegExp (sub (struct
  (field $tag        i32)                   ;; REGEXP_TAG
  (field $handle     (mut i32))             ;; regress re_handle
  (field $source     (ref $StringArr))      ;; pattern string
  (field $flags      i32)                   ;; bitfield: g=1 i=2 m=4 s=8 u=16 y=32 d=64 v=128
  (field $lastIndex  (mut f64))
)))

(type $MatchArray (struct
  (field $matched    (ref $StringArr))      ;; full match string
  (field $groups     (ref $vec_StringArr))  ;; capture groups (null = unmatched)
  (field $index      i32)                   ;; match start in input
  (field $input      (ref $StringArr))      ;; original input
  (field $indices    (ref extern))          ;; start/end pairs; populated only when d flag set
)))
```

### Edge cases

- **`d` flag (`match.indices`)** — regress returns group start/end positions via `group()`; populate `$indices` when `flags & 64`. This is the disqualifying gap for libregexp.
- **Empty match + `g` flag** — advance `lastIndex` by 1 after empty match; follow spec §22.2.7.2 step 8.c.
- **`y` sticky + non-zero `lastIndex`** — pass `lastIndex` as `start_idx`; discard match if `match.start !== lastIndex`.
- **`RegExp.prototype[Symbol.match/replace/split/search]`** — follow spec branching on `g`/`y` flags. Replace the `__extern_method_call` dispatch in `src/runtime.ts:4678-4744` with regress exec when `ctx.standalone`.
- **`RegExp.prototype.flags`** getter — recompute string from `$flags` bitfield.
- **`lastIndex` mutation** — `g` and `y` flags mutate `lastIndex` after each exec; write back via `struct.set $RegExp $lastIndex`.
- **GC / resource cleanup** — no WasmGC finalizers; call `regress.free(handle)` eagerly using the existing dispose-pattern in the runtime.
- **String encoding** — For `--nativeStrings` (`array i16`, already UTF-16): `array.copy` to slab. For externref strings: use `__extern_string_to_utf16` (already exists) then copy.
- **Named capture groups** — parse `(?<name>...)` at compile time, store name→index table in `$RegExp`; expose via `match.groups` object.

### Build script (`scripts/build-regress-wasm.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail
VERSION=$(cat vendor/regress-version.txt)
cargo build --release --target wasm32-unknown-unknown \
  --no-default-features --features utf16 \
  --manifest-path scripts/regress-build/Cargo.toml
wasm-opt -Os \
  scripts/regress-build/target/wasm32-unknown-unknown/release/regress_shim.wasm \
  -o vendor/regress.wasm
```

Rust toolchain only needed to rebuild the artifact. CI uses the committed `vendor/regress.wasm`.

### Test262 paths

- `test/built-ins/RegExp/*` (~1,400 tests, run under `--target standalone`)
- `test/built-ins/String/prototype/{match,replace,replaceAll,search,split}/*`
- `test/language/literals/regexp/*` (~50 tests)

Acceptance: ≥80% pass when compiled with `--target standalone`.
`match.indices` (`d` flag) tests must pass — this was libregexp's disqualifying gap.

### Dependencies

- **#1474** Phase 1 must be merged (already landed); this issue replaces its `reportError` gates.
- #682 closed out — no further work on libregexp.

### Risks

- **Rust toolchain** — mitigated by committing prebuilt artifact; CI never runs `cargo`.
- **Binary size** — ~250–400 KB added to every standalone module. Acceptable for `--target standalone`; irrelevant for JS-host builds.
- **regress ABI stability** — pin version in `vendor/regress-version.txt`; review on upgrade.
