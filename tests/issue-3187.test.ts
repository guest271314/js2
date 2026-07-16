import { describe, it, expect } from "vitest";
import { classifyError } from "./test262-runner.js";
import { ORACLE_VERSION } from "./test262-oracle-version.js";

// #3187 — error_category classifier split.
//
// classifyError previously binned "… is not a function" (a missing builtin /
// unimplemented runtime feature) and "No dependency provided for …" (the
// compiler's own dependency-injection diagnostic) as `wasm_compile`, inflating
// the genuine invalid-Wasm bucket ~3.4× (~448 → ~87 default-lane records). This
// pins the split into three honest buckets and the narrowed wasm_compile.
//
// This is a verdict-classification change, so ORACLE_VERSION was bumped (>= 3).
describe("#3187 error_category classifier split", () => {
  it("keeps GENUINE invalid-Wasm as wasm_compile", () => {
    expect(
      classifyError(
        'invalid Wasm binary (WebAssembly.instantiate(): Compiling function #47:"isSameValue" failed: call[0] expected type i32, found local.get of type externref @+123)',
      ),
    ).toBe("wasm_compile");
    expect(classifyError("WebAssembly.instantiate(): Compiling function #3 failed")).toBe("wasm_compile");
  });

  it("bins '… is not a function' as missing_builtin, not wasm_compile", () => {
    for (const msg of [
      "safeBroadcast is not a function",
      "safeBroadcastAsync is not a function",
      "transferToImmutable is not a function",
      "sumPrecise is not a function",
      "then is not a function",
      "object is not a function",
      "undefined is not a function",
    ]) {
      expect(classifyError(msg), msg).toBe("missing_builtin");
    }
  });

  it("bins 'No dependency provided …' as missing_dependency, not wasm_compile", () => {
    for (const msg of [
      'No dependency provided for extern class "BigInt"',
      'No dependency provided for extern class "FinalizationRegistry"',
      "No dependency provided for imported function env::__extern_get",
    ]) {
      expect(classifyError(msg), msg).toBe("missing_dependency");
    }
  });

  it("bins 'no test export' as harness_shape, not wasm_compile", () => {
    expect(classifyError("no test export")).toBe("harness_shape");
  });

  it("does not steal a genuine wasm_compile that also quotes source text", () => {
    // An instantiate error that quotes a helper name must stay wasm_compile even
    // though the ordering places missing_builtin/missing_dependency later.
    expect(classifyError('Compiling function #12:"isConstructor" failed: type mismatch')).toBe("wasm_compile");
  });

  it("bumped ORACLE_VERSION (classification logic changed)", () => {
    expect(ORACLE_VERSION).toBeGreaterThanOrEqual(3);
  });
});

// #3285 — wrapper return-code protocol beats the trap regexes. The tightened
// assert_throws shim embeds the ORIGINAL test source line in "returned N"
// failure messages; quoted text like "out of bounds" / "unreachable" was
// hitting the trap patterns and mis-binning honest assertion fails as
// uncatchable traps — false-positive-tripping the allowance-immune #3189
// trap-growth ratchet (live instance: Temporal/Duration/subtract/
// result-out-of-range-1 counted as a NEW oob on the #3104 measurement run).
// A genuine trap aborts the module and can never produce a "returned N"
// message, so the protocol prefix is authoritative.
describe("#3285 — 'returned N' protocol classified before trap patterns", () => {
  it("bins a returned-N message quoting 'out of bounds' as assertion_fail, not oob", () => {
    expect(
      classifyError(
        "returned 2 — assert #1 at L28: assert.throws(RangeError, () => { d.subtract(d.negated()); }, `…is out of bounds: ${d}`);",
      ),
    ).toBe("assertion_fail");
  });

  it("bins a returned-N message quoting 'unreachable' as assertion_fail, not unreachable", () => {
    expect(classifyError("returned 3 — assert #2 at L10: assert(x !== 'unreachable code path');")).toBe(
      "assertion_fail",
    );
  });

  it("bins returned -1 (exception caught by wrapper) as exception_in_test even with trap words", () => {
    expect(classifyError("returned -1 — assert #1 at L5: assert.throws(TypeError, () => oob.access());")).toBe(
      "exception_in_test",
    );
  });

  it("still bins a GENUINE trap message as a trap (no returned-N prefix)", () => {
    expect(classifyError("RuntimeError: memory access out of bounds")).toBe("oob");
    expect(classifyError("RuntimeError: unreachable")).toBe("unreachable");
  });
});
