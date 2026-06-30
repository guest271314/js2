---
id: 2868
title: "Standalone: invalid Wasm binary emitted (correctness) — __uri_encode/__uri_decode, __str_flatten, and common user-body shapes"
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
related: [2860]
umbrella: 2860
---

# Standalone: invalid Wasm binary emitted

## Problem

In `--target standalone`, some modules compile to a binary the engine rejects:

```
invalid Wasm binary (WebAssembly.instantiate(): Compiling function #N:"<fn>" ...)
```

This is a **correctness** bug — the worst class, since the module is structurally
broken, not merely missing a feature.

### Impact (measured 2026-06-30) — 523 standalone-only failures (all CE)

By the rejected function name:

| function | tests | note |
| -------- | ----- | ---- |
| `test` (harness/user) | 199 | a common emitted body shape |
| `inner` | 81 | nested function shape |
| `__uri_decode` | 46 | native decodeURI/decodeURIComponent impl |
| `fn` | 42 | |
| `__uri_encode` | 18 | native encodeURI/encodeURIComponent impl |
| `__str_flatten` | 10 | native string flatten |
| `C_setPrivateReference` | 10 | private-field accessor |
| `gen` / `__closure_*` / `__cb_*` | ~40 | |

The `__uri_encode`/`__uri_decode` (64 combined) and `__str_flatten` carriers are
concrete native helpers emitting invalid bytes — the most isolated sub-bugs.

## Root cause (to confirm during triage)

Standalone-only invalid binaries usually mean a stack-balance / type-mismatch in
a `ctx.standalone`-gated emission path, or a late-import funcIdx shift that
wasn't propagated (cf. the `addUnionImports` index-shift hazards in CLAUDE.md and
`reference_1461`/`reference_2191`/`reference_2193`). The two named native
helpers (`__uri_*`, `__str_flatten`) are self-contained — disassemble one failing
module with `binaryen`/`wasm-objdump` to get the exact validation error
(stack-height, type, or bad funcref).

## Implementation Plan

This is **triage-then-fix**, not a single known edit. Procedure:

1. **Reproduce minimally** — pick one test per named function (e.g.
   `test/built-ins/decodeURI/**` for `__uri_decode`,
   `test/built-ins/String/prototype/split/**` for `__str_flatten`). Compile with
   `--target standalone`, dump the WAT, and read the validator's exact complaint
   (write probes under `.tmp/`).
2. **`__uri_encode`/`__uri_decode`** (64): inspect the native helper emission
   (grep `__uri_encode`/`__uri_decode` in `src/codegen/`); fix the
   stack/type/funcidx defect. Likely a single shared bug across both.
3. **`__str_flatten`** (10): same approach — overlaps the null-deref string
   cluster (umbrella #2860 note).
4. **`test`/`inner`/`fn` body shapes** (322): these are user/harness bodies, so
   the defect is a general codegen construct mis-emitted under standalone.
   Cluster the offending source constructs (look for a shared syntactic feature
   across the failing files) and fix the emitter. Use the validator error to
   localize (e.g. "type mismatch in ... expected externref got anyref" →
   a missing `extern.convert_any`/`any.convert_extern` on a standalone path).

Split into sub-tasks if the `__uri_*`/`__str_flatten` fixes are independent from
the body-shape fix (they likely are — file a follow-on for the residual after
the named helpers are fixed).

## Test plan

Standalone CE → pass:
- `test/built-ins/{decodeURI,decodeURIComponent,encodeURI,encodeURIComponent}/**`
- `test/built-ins/String/prototype/split/**` (RegExp-arg `__str_flatten`)
- the `reduceRight`/`substring`/`func-decl-forbidden-ext` examples listed in the
  triage.

Validate by re-compiling each repro to a valid module, then full `merge_group` +
standalone high-water. Pure correctness win — no host-mode path touched.
