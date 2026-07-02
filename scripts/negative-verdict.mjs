// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2912 — shared negative-test verdict logic.
//
// Used by BOTH runners so the parse/early/resolution negative-test gate is
// IDENTICAL across them and across gc/standalone targets:
//   • scripts/test262-worker.mjs        (authoritative CI worker; driven by
//                                         tests/test262-shared.ts via the pool)
//   • tests/test262-vitest.test.ts      (two-phase cached runner)
//
// Background (the defect this fixes):
//   A negative test with `phase: parse | early | resolution` is a conformance
//   pass only when the compiler rejected the program for the RIGHT reason. The
//   historical gate was DEAD code — `status: hasEarlyError ? "pass" : "pass"`
//   (both arms "pass") — so ANY compile error scored a pass and `negative.type`
//   was never verified. `ES_EARLY_ERRORS` + `hasEarlyError` only LOOKED like a
//   gate.
//
// What this makes real (compile-FAILED arm):
//   pass only when the raised compile error is consistent with the test's
//   expected `negative.type`. Empirically (full-corpus scan, 2026-07-01) EVERY
//   parse/early/resolution negative in test262 has `type: SyntaxError`, and
//   every compile-time rejection our compiler emits for these inputs is a
//   static/syntax rejection — so those still score pass (0 verdict change),
//   while the change (a) deletes the dead ternary, (b) verifies negative.type,
//   and (c) FAILS a future wrong-type negative (e.g. a parse-phase
//   ReferenceError/TypeError test we reject with an unrelated diagnostic).
//
// Deliberately NOT tightened here (see #2912 follow-up): the compile-SUCCEEDED
// arm, where the compiler emitted NO error and the test "passes" only because
// the produced Wasm fails to instantiate/link (the #2898 incidental-pass
// fragility). Strictly requiring a compile-time diagnostic there flips ~439
// host-lane tests pass->fail — a real correctness improvement, but an
// intentional-drop that needs a coordinated re-baseline (PO/lead sign-off; the
// regression gate has no in-PR intentional-drop flag). That arm stays an
// explicitly-documented lenient fallback for now.

/**
 * TS diagnostic codes that correspond to ES early errors (SyntaxError-class).
 * Retained for documentation / future per-type refinement; the SyntaxError arm
 * below does not need them because a raised compile error on a parse/early
 * negative is already a static rejection.
 */
export const ES_EARLY_ERROR_CODES = new Set([1102, 1103, 1210, 1213, 1214, 1359, 1360, 2300, 18050]);

/**
 * Did a COMPILE-TIME rejection match the test's expected `negative.type`?
 *
 * @param {string|undefined} expectedType e.g. "SyntaxError" | "ReferenceError" | "TypeError"
 * @param {number[]} [errorCodes] numeric diagnostic codes on the raised errors
 * @param {string} [message] concatenated raised-error messages (for type-name evidence)
 * @returns {boolean} true iff the rejection is consistent with expectedType
 */
export function negativeCompileErrorMatches(expectedType, errorCodes = [], message = "") {
  // Unknown / unspecified expected type: we cannot verify — stay lenient
  // (a raised compile error is still a rejection). Never a regression.
  if (!expectedType) return true;

  // A parse/early/resolution rejection is a STATIC rejection == SyntaxError-class.
  // Every parse/early/resolution negative in test262 is `type: SyntaxError`, so
  // this is the hot path: any raised compile error is a syntax/static rejection.
  if (expectedType === "SyntaxError") return true;

  // Non-SyntaxError parse/early negatives are absent from today's corpus. When
  // they appear, require the diagnostic to EVIDENCE the expected type; a
  // rejection for an unrelated reason must NOT score a conformance pass.
  const codes = Array.isArray(errorCodes) ? errorCodes : [];
  if (message && new RegExp(`\\b${expectedType}\\b`, "i").test(message)) return true;
  // An explicit ES early-error code is SyntaxError-class; it only satisfies a
  // SyntaxError expectation (handled above), not Reference/TypeError.
  void codes;
  return false;
}

/**
 * STRICT verdict for the compile-SUCCEEDED arm of a negative
 * parse/early/resolution test (#2920 — the follow-up that tightens the arm
 * #2912 deliberately left lenient).
 *
 * The compiler emitted NO diagnostic, so it did NOT detect the expected early
 * error. The historical policy scored a conformance PASS whenever the produced
 * Wasm merely failed to instantiate/link — an INCIDENTAL pass (the #2898
 * fragility). A full-corpus audit (2026-07-01) found ~439 host-lane negatives
 * passing ONLY this way (`await`/`yield` as a binding identifier, escaped
 * keywords, duplicate module exports, unresolved imports) — real
 * early-error-detection GAPS, not conformance passes. Strict verdict: this is
 * always a FAIL. Whether the produced Wasm subsequently instantiates or links
 * is irrelevant — an incidental link failure is not spec-conformant
 * early-error detection.
 *
 * This is an intentional conformance-verdict tightening (a ~439 host-lane
 * pass->fail drop), NOT a code regression — it lands with a coordinated
 * baseline refresh (see plan/issues/2920). Applies identically across the host
 * (`gc`) and `standalone` targets and across all three runners
 * (scripts/test262-worker.mjs, tests/test262-shared.ts fixture path,
 * tests/test262-vitest.test.ts) so the gate stays byte-identical.
 *
 * @param {string|undefined} expectedType e.g. "SyntaxError"
 * @param {string|undefined} phase        e.g. "parse" | "early" | "resolution"
 * @returns {{status: "fail", error: string}}
 */
export function negativeCompileSucceededVerdict(expectedType, phase) {
  const what = `${phase ? `${phase} ` : ""}${expectedType || "early error"}`;
  return {
    status: "fail",
    error: `expected ${what} but compiled with no diagnostic (early error not detected)`,
  };
}
