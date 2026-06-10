---
id: 1919
title: "standalone invalid-Wasm residual bucket after #1623/#1666/#1677: async-gen i64 ABI, __obj_find externref key, __str_flatten, arguments arity (~1,135 tests)"
status: ready
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: critical
feasibility: hard
reasoning_effort: max
model: fable
task_type: bugfix
area: codegen, emit
language_feature: async-generators, classes, private-names, strings
goal: standalone-mode
related: [1623, 1666, 1677, 1776, 1807, 1916]
test262_bucket: standalone-invalid-wasm
test262_count: 1135
es_edition: multi
origin: "2026-06-10 standalone-vs-host baseline diff: 1,330 non-Temporal gap rows are WebAssembly.instantiate validation failures; 195 are owned by #1916 (Array generics); this issue tracks the remaining ~1,135, split by signature."
---

# #1919 — standalone invalid-Wasm residual bucket (split by signature)

## Problem

After the #1623/#1666/#1677 type-boundary fixes, the 2026-06-10 standalone
baseline still contains ~1,135 gap tests (host-pass) whose standalone binary
**fails Wasm validation** at instantiate time. Every one of these violates the
#1888 dual-mode invariant (refuse loudly, never emit invalid Wasm). Split by
validator signature (function × first mismatch):

| Count | Signature | Representative test | Suspected area |
| ---: | --- | --- | --- |
| ~230 | `"f"` / `"fn"` `call[0] expected type i64, found extern.convert_any of type (ref extern)` and variants | `language/statements/async-generator/dstr/obj-ptrn-prop-ary-trailing-comma.js` | async-generator resume ABI: some callee takes an **i64** param (state/brand slot?) but the standalone path passes an externref. NB: i64 here may be the BigInt-brand ValType decision surface (see #1349/#1644 i64-bigint-brand gate) |
| ~150 | `"f"`/`"C_method"`/`"C___priv_method"` `if[0] expected type i32, found call of type externref` | `language/statements/async-generator/dstr/dflt-ary-ptrn-rest-id.js` | a boolean-position call returns externref where the host path returns i32 (truthiness helper not branded for standalone) |
| 146 | `"__obj_find" i32.and[0] expected type i32, found call of type externref` | `language/statements/class/elements/after-same-line-static-method-rs-static-async-generator-method-privatename-identifier.js` | the `$Object` hash-probe helper is instantiated with a **non-i32 key hash**: private-name/symbol keys reach `__obj_find` as externref. Confirmed by local probe on main @ 936d1ac51 |
| ~165 | `"__str_flatten" call[0] expected (ref null N), found i32.const` + null-deref flavor | `language/statements/class/elements/set-access-of-missing-private-setter.js`, `language/statements/while/S12.6.2_A4_T4.js` | string-rope flatten helper compiled with mismatched string-rep (nativeStrings i16-array vs extern string) — same family as #1677 Signature A but for the rope arg |
| 93 | `"test" not enough arguments on the stack for call (need N, got M)` | `language/eval-code/direct/async-gen-meth-fn-body-cntns-arguments-lex-bind-declare-arguments-and-assign.js` | `arguments` object materialization in async-gen methods emits a call whose arity doesn't match the standalone helper signature |
| ~120 | `throw[0]` type mismatches in `C_method`/`C___priv_method`/`__anon_0_method` | class-elements private methods | exception-tag payload type differs between host/standalone lowering |
| ~230 | long tail (`local.set`, `call[1]`, `__closure_*`, `inner`, …) | | per-signature triage needed |

(Counts from the standalone-vs-host gap diff; signatures normalized over
function name + mismatch instruction.)

## Why this is the right next split

This bucket is pure compiler bugs — no spec work, no new runtime features.
Each signature is mechanical to reproduce (the JSONL rows carry exact function
names and offsets) and most cluster on the async-generator + class-private
paths that recently gained standalone lowering (#1665/#1326). Fixing the top
three signatures alone recovers ~530 tests.

## Suggested approach

1. Like #1909 did for RegExp: take each signature row above and either fix it
   in one slice or spawn a child issue with the WAT diff. Suggested order:
   `__obj_find` (single helper, 146 tests) → async-gen `i64` ABI (~230) →
   `__str_flatten` (~165) → truthiness `if[0]` (~150) → arguments arity (93).
2. For each: compile the representative test with `--target standalone`, dump
   WAT around the cited offset, identify the producer, fix the standalone arm
   or add a loud refusal.
3. Add a regression gate: any `invalid Wasm binary` row in the standalone
   lane should be triaged as a P1 compiler bug class, distinct from
   `Codegen error:` refusals (see #1853 hard-error stability bucket).

## Acceptance criteria

- `__obj_find` validates with private-name/symbol keys (146 rows → 0).
- Async-generator destructuring tests instantiate (i64/`if[0]` signatures → 0).
- Standalone baseline `invalid Wasm binary` total drops below 300, with the
  remainder mapped to child issues by signature.
- No new host-mode regressions; equivalence tests green.
