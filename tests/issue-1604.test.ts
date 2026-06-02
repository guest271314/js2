import { describe, it, expect } from "vitest";
import { wrapTest } from "./test262-runner.js";

/**
 * #1604 — String case-conversion tests (toUpperCase/toLowerCase/toLocale*)
 * failed because the `wrapTest` harness unconditionally rewrote every
 * `__expected.index` / `__expected.input` *read* into the extracted variables
 * `__expected_index` / `__expected_input`. Those variables are only declared
 * when the source *assigns* `__expected.index = N` (the RegExp-exec result
 * pattern). The case tests only read `.index`/`.input` (both `undefined` on a
 * plain string) and never assign them, so the rewrite left a reference to an
 * undeclared variable, producing `__expected_index is not defined`.
 *
 * The transform must only rewrite the reads when the corresponding declaration
 * was actually extracted; otherwise the property read stays intact (→ undefined).
 */
describe("#1604 wrapTest __expected.index/.input read rewrite", () => {
  it("leaves __expected.index/.input as property reads when no assignment is present", () => {
    const source = `
var __upperCase = "".toUpperCase();
var __expected = "";
if (__upperCase.index !== __expected.index) {
  throw new Test262Error('#2');
}
if (__upperCase.input !== __expected.input) {
  throw new Test262Error('#3');
}
`;
    const { source: wrapped } = wrapTest(source);
    // No declaration extracted, so the reads must remain property accesses.
    expect(wrapped).not.toContain("__expected_index");
    expect(wrapped).not.toContain("__expected_input");
    expect(wrapped).toContain("__expected.index");
    expect(wrapped).toContain("__expected.input");
  });

  it("still extracts __expected.index/.input into vars when assigned (RegExp exec pattern)", () => {
    const source = `
var __executed = /str/.exec("astr");
var __expected = ["str"];
__expected.index = 1;
__expected.input = "astr";
if (__executed.index !== __expected.index) {
  throw new Test262Error('#1');
}
if (__executed.input !== __expected.input) {
  throw new Test262Error('#2');
}
`;
    const { source: wrapped } = wrapTest(source);
    // Declaration extracted → reads rewritten to the extracted vars.
    expect(wrapped).toContain("var __expected_index");
    expect(wrapped).toContain("var __expected_input");
    // The original `__expected.index` *reads* (not the assignment) are gone.
    expect(wrapped).toContain("__expected_index");
    expect(wrapped).toContain("__expected_input");
  });
});
