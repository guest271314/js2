---
id: 1864
title: "JS→WASM should compile on par with TS→WASM (untyped JS loses type info → degraded/broken codegen)"
status: backlog
sprint: Backlog
created: 2026-06-04
updated: 2026-06-04
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: js-input
goal: correctness
related: [1866, 389]
---
# #1864 — JS→WASM parity with TS→WASM

**Source:** GitHub issue #389 (guest271314): "for js2wasm to pass muster the
JavaScript to WASM compilation has to work on par with the TypeScript to WASM
compilation — by any means necessary." (He's been trying `ts-migrate` to convert
JS→TS as a workaround.)

## Problem

js2wasm leans on TypeScript type annotations for codegen decisions. Plain JS
input loses that information, so the same logic compiles worse — or wrong — than
its `.ts` form. Observed symptoms:

- **Broken host imports** — a JS host emits an undefined `env::__extern_get`
  import under `--target wasi` (see #1866), because an untyped value falls back
  to a JS-host path instead of a typed standalone lowering.
- **Silent miscodegen** — transpiling our own `nm_js2wasm.ts` to JS with
  `esbuild` (which strips JSDoc) blanked the integer interpolation in a stderr
  line (`number` params defaulted to a non-numeric type). Preserving JSDoc
  `@param {number}` via `ts.transpileModule(..., {removeComments:false})` fixed
  it — i.e. js2wasm *does* read JSDoc types, but bare JS without them degrades.

So today "JS support" effectively requires JSDoc types or a TS source; arbitrary
JS does not reach TS-level output.

## Why it matters

Many users (and guest's reference hosts) author plain `.js`. If JS is a
second-class input, the standalone story is incomplete. The
`examples/native-messaging/compare-memory.mjs` `.js` variant demonstrates the
JSDoc-preserving path works; the gap is bare/untyped JS.

## Possible directions

- Stronger type inference for untyped JS (flow/usage-based) so numeric locals
  and typed-array params don't fall back to host/externref paths.
- First-class JSDoc type ingestion (document it; ensure all `@param`/`@returns`
  forms are honored) as the supported "typed JS" path.
- A built-in JS→TS normalization step (the role `ts-migrate` would play), so JS
  input is typed before codegen — "by any means necessary."
- At minimum: never emit an unsatisfiable `env::*` import for standalone JS;
  fail with a clear diagnostic pointing at the untyped construct (overlaps #1866).

## Acceptance criteria

- A representative plain-JS program (e.g. the native-messaging host as `.js`)
  compiles to standalone WASI that imports only `wasi_snapshot_preview1` and
  behaves identically to its `.ts` form.
- Documented, tested "typed JS via JSDoc" path; tracked parity gaps for bare JS.
