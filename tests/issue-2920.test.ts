// #2920 — the STRICT compile-SUCCEEDED arm of the negative-test verdict (the
// follow-up to #2912, which deliberately left this arm lenient).
//
// When a negative parse/early/resolution test COMPILES with NO diagnostic, the
// compiler did not detect the expected early error. The historical policy
// scored a conformance PASS whenever the produced Wasm merely failed to
// instantiate/link (an INCIDENTAL pass, the #2898 fragility) — ~439 host-lane
// false passes. The strict verdict is always FAIL: an incidental link failure
// is not spec-conformant early-error detection.
//
// These tests pin the shared helper used by ALL THREE runners
// (scripts/test262-worker.mjs, tests/test262-shared.ts fixture path,
// tests/test262-vitest.test.ts) so the strict verdict stays byte-identical.
import { describe, it, expect } from "vitest";
import { negativeCompileSucceededVerdict } from "../scripts/negative-verdict.mjs";

describe("#2920 negativeCompileSucceededVerdict (strict compile-SUCCEEDED arm)", () => {
  it("always returns fail — a compile with no diagnostic is a missed early error", () => {
    // The whole test262 parse/early/resolution negative population is SyntaxError.
    expect(negativeCompileSucceededVerdict("SyntaxError", "parse").status).toBe("fail");
    expect(negativeCompileSucceededVerdict("SyntaxError", "early").status).toBe("fail");
    expect(negativeCompileSucceededVerdict("SyntaxError", "resolution").status).toBe("fail");
  });

  it("never returns pass — the incidental-instantiate-failure pass is removed", () => {
    // The old lenient arm returned "pass" when the produced Wasm failed to
    // instantiate/link. There is no input for which the strict arm passes.
    for (const type of ["SyntaxError", "ReferenceError", "TypeError", undefined]) {
      for (const phase of ["parse", "early", "resolution", undefined]) {
        expect(negativeCompileSucceededVerdict(type as string | undefined, phase as string | undefined).status).toBe(
          "fail",
        );
      }
    }
  });

  it("produces an honest, diagnostic error message naming the undetected error", () => {
    expect(negativeCompileSucceededVerdict("SyntaxError", "parse").error).toBe(
      "expected parse SyntaxError but compiled with no diagnostic (early error not detected)",
    );
    // phase omitted (the worker path has only the expected type)
    expect(negativeCompileSucceededVerdict("SyntaxError", undefined).error).toBe(
      "expected SyntaxError but compiled with no diagnostic (early error not detected)",
    );
    // both absent — still a fail with a sane message
    expect(negativeCompileSucceededVerdict(undefined, undefined).error).toBe(
      "expected early error but compiled with no diagnostic (early error not detected)",
    );
  });
});
