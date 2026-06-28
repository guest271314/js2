---
id: 2787
title: "Differential-test corpus failures — 2 malformed_wasm + 13 mismatch + 6 runtime_error"
status: ready
sprint: Backlog
created: 2026-06-28
updated: 2026-06-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: conformance
language_feature: compiler-internals
goal: trustworthiness
related: [389, 2143, 1941]
origin: "2026-06-28 — diff-test red on main (job 83903650345, surfaced in #2252 merge_group); reply to loopdive/js2#389"
---

# #2787 — Differential-test corpus failures (umbrella tracking)

## Problem

The `diff-test` ("Differential test", `scripts/diff-test.ts`, corpus
`tests/differential/corpus`, 104 programs) is a **non-required** gate that
compares js2wasm output against the V8 reference engine (Node-host lane:
in-process `compile()` → `WebAssembly.validate` → instantiate → compare
stdout). It is currently **red on main**.

The redness was surfaced in **#2252's `merge_group`** — a pure dependency
**version bump** with no codegen change — so these failures are
**pre-existing**, not release-caused. In that run the corpus actually
**net-improved** (baseline 69/104 → current 83/104 match, 15 improvements);
the delta gate failed on a **single new regression**
(`array/01-basic.js: match → malformed_wasm`). This umbrella issue catalogs
the full failing set so it can be triaged down over time.

Source of truth for the list below: CI job **83903650345**
(`gh run view --job 83903650345 -R loopdive/js2 --log`). The default lane and
the `-O3` optimize lane show the **same** 21 failures, so none is
wasm-opt-specific.

## Failure buckets (21 failing programs of 104)

### Bucket A — `malformed_wasm` (2) — INVALID output, highest severity

The compiler reports `success` but `WebAssembly.validate` **rejects** the
binary — a genuine codegen correctness bug (the module won't load on a strict
engine at all). **Tracked separately and at higher priority in #2788**
(`area: codegen`, `sprint: current`, `priority: high`) with reproduced
validator errors.

- `array/01-basic.js` — **new regression** this run (`match → malformed_wasm`);
  `__module_init` type mismatch: `call[0] expected type f64, found if of type externref`
- `closures/10-mutual.js` — already malformed on the baseline;
  `__module_init` type mismatch: `call[0] expected type externref, found call of type i32`

### Bucket B — `mismatch` (13) — VALID wasm, wrong output (conformance divergence)

The binary validates and runs but produces output that differs from V8:

- `array/12-from-of.js`
- `builtins/01-json-stringify.js`
- `builtins/04-symbol.js`
- `builtins/07-promise-basic.js`
- `builtins/08-promise-chain.js`
- `builtins/09-async-await.js`
- `classes/10-toString-impl.js`
- `closures/07-arrow-this.js`
- `closures/09-callback.js`
- `control/12-for-in-object.js`
- `object/02-spread.js`
- `object/06-delete.js`
- `object/12-assign.js`

### Bucket C — `runtime_error` (6) — VALID wasm, traps/throws at instantiate

The binary validates but throws during instantiation/execution:

- `array/11-flat-flatMap.js`
- `builtins/03-map-set.js`
- `builtins/12-arraybuffer.js`
- `builtins/14-spread-args.js`
- `builtins/15-tag-template.js`
- `closures/08-method-chain.js`

## Severity ordering

1. **Bucket A (malformed_wasm)** — real invalid-module codegen bugs. Higher
   severity than a wrong-output mismatch because the module is not even
   well-formed. Owned by **#2788**.
2. **Buckets B + C** — conformance divergences on valid wasm. Lower severity
   (the module is well-formed); these are feature-completeness gaps in
   Promise/async, Map/Set, Symbol, spread, JSON.stringify, delete, for-in,
   arrow-`this`, tagged templates, ArrayBuffer, etc. Several likely already
   have feature-specific issues.

## Acceptance criteria

- Bucket A driven to zero via #2788 (so the diff-test delta gate goes green
  again w.r.t. the `array/01-basic.js` regression).
- Buckets B/C triaged: each mapped to an existing feature issue or a new
  per-feature follow-up; the corpus baseline reflects intended state.

## Notes

- Relation to **#2143**: that issue added the `WebAssembly.validate` lane to
  the default pipeline so malformed_wasm is _caught_; this issue is about
  _fixing_ the programs it surfaces.
- Relation to **#1941**: the optimize lane / corpus work.
- Relation to **loopdive/js2#389**: the external reporter's `--target wasi`
  output is **valid WasmGC** (verified — the `-0x9` `wasm-validate` error is
  an old-wabt limitation, not a js2wasm bug); that is unrelated to these
  diff-test codegen failures, which are on the default WasmGC + JS-host path.
