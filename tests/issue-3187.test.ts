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
