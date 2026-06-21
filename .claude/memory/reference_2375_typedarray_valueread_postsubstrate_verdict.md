---
name: reference_2375_typedarray_valueread_postsubstrate_verdict
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#2375 re-grounded against main 218375d60 (post #2026 classes-as-first-class-values, 2026-06-19).

**#2026 DID clear the pre-existing instantiate-trap** — the masked `wasm exception during module init` (from `[Float64Array,…]` host-import reflection in `testTypedArray.js` module scope) is gone; the harness now compiles+runs. But wiring the full TypedArray + ArrayBuffer/SharedArrayBuffer/DataView `$NativeProto` value-read glue (member-CSV + makeGlue, exactly like the #2374/#2377 wrapper-proto brands) and diffing base-vs-patched on 400 standalone tests gives **CE→pass: 0, regressions: 0, CE→fail: ~129**. It only converts an honest `compile_error` into a runtime `fail`.

Why: 118/155 CE-base files reach the proto via `Object.getPrototypeOf(Int8Array)` (the harness `TypedArray` var) — a **dynamic runtime** path the static `Int8Array.prototype` value-read glue does not satisfy. Even the 37 static-view-only files never reach pass — they invoke members (`.at()`, `byteLength`/`byteOffset` getters) or do `verifyProperty(TypedArray.prototype,…)` descriptor reflection.

**Do NOT ship the value-read-only glue here** (net-zero/negative — CE is more honest than fail). The glue is correct/tsc-green but staged-only. The real remaining slice (architect/runtime-scale): (1) native member-body closures for `%TypedArray%.prototype.<method>` over the live view receiver, (2) dynamic `Object.getPrototypeOf(<builtin ctor>)` → working `%TypedArray%` proto. The value-read scaffold folds in once those land. Routed to architect; issue stays `blocked`/`needs_role: architect`.

Note: runner `extractWasmExceptionMessage` (test262-runner.ts ~L2837) throws "Cannot convert object to primitive value" when `String(payload)` hits a thrown wasm-exception object with a throwing ToPrimitive — that surfaces as a probe "THROW", but the real outcome is `fail`. Diff per-file on CE-transition, not aggregate status counts (the THROW reclassification is order/run dependent). See [[reference_standalone_harvest_rootcausemap_mislabeled]].
