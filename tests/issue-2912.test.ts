// #2912 — the negative-test verdict must be a REAL error-type gate, not the
// historical dead `status: hasEarlyError ? "pass" : "pass"` (both arms "pass").
//
// These tests pin the shared gate helper used by BOTH runners
// (scripts/test262-worker.mjs and tests/test262-vitest.test.ts) so the two arms
// genuinely differ and `negative.type` is verified.
import { describe, it, expect } from "vitest";
import { negativeCompileErrorMatches } from "../scripts/negative-verdict.mjs";

describe("#2912 negativeCompileErrorMatches (real error-type gate)", () => {
  it("passes a SyntaxError negative on any raised compile error (static rejection)", () => {
    // The entire test262 parse/early/resolution negative population is SyntaxError,
    // and every compile-time rejection our compiler emits for these is a static
    // rejection — so this is the hot path and must score pass.
    expect(negativeCompileErrorMatches("SyntaxError", [1005], "';' expected.")).toBe(true);
    expect(negativeCompileErrorMatches("SyntaxError", [], "for-in requires a variable declaration")).toBe(true);
    expect(negativeCompileErrorMatches("SyntaxError", [6188], "Numeric separators are not allowed here.")).toBe(true);
    // no code, no message signal — still a static rejection for a SyntaxError test
    expect(negativeCompileErrorMatches("SyntaxError", [], "")).toBe(true);
  });

  it("is NOT the dead gate: a wrong-type rejection does not score pass", () => {
    // A future parse-phase ReferenceError/TypeError negative rejected with an
    // UNRELATED diagnostic must fail (the old code returned "pass" either way).
    expect(negativeCompileErrorMatches("ReferenceError", [1005], "';' expected.")).toBe(false);
    expect(negativeCompileErrorMatches("TypeError", [], "Unsupported feature X")).toBe(false);
  });

  it("verifies negative.type: passes a non-SyntaxError when the diagnostic evidences it", () => {
    expect(negativeCompileErrorMatches("ReferenceError", [], "ReferenceError: x is not defined")).toBe(true);
    expect(negativeCompileErrorMatches("TypeError", [], "TypeError: bad assignment")).toBe(true);
    // word-boundary: `\bTypeError\b` must not match mid-word ("TypeErrorish")
    expect(negativeCompileErrorMatches("TypeError", [], "a TypeErrorish thing")).toBe(false);
    expect(negativeCompileErrorMatches("ReferenceError", [], "a DereferenceErrorish")).toBe(false);
  });

  it("stays lenient when the expected type is unknown (never a false regression)", () => {
    expect(negativeCompileErrorMatches(undefined, [1005], "';' expected.")).toBe(true);
    expect(negativeCompileErrorMatches("", [], "")).toBe(true);
  });
});
