// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1959 — native RegExp VM empty-iteration progress guard (§22.2.2.3.1
 * RepeatMatcher). A nullable quantifier body (`(?:a?)*`, `(a*)*`, …) used to
 * loop pushing backtrack frames until the 1,000,000-step cap, which was then
 * reported as "no match" — a silent wrong answer plus a multi-second perf
 * cliff at every scan position. The compiler now emits a PROGRESS opcode that
 * fails any iteration consuming nothing, so the loop exits per spec.
 *
 * Validation is on the pure-WasmGC standalone backend (the affected VM). We
 * compare against Node's `RegExp` via `String.prototype.search` (returns the
 * match index, or -1). The TS reference VM is covered in regex-bytecode.test.ts.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function search(pattern: string, input: string): Promise<number> {
  const src = `export function run(): number { return ${JSON.stringify(input)}.search(/${pattern}/); }`;
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { run(): number }).run();
}

describe("#1959 native RegExp empty-iteration progress guard", () => {
  // The exact repros from the issue file — nullable quantifier bodies.
  const nullableCases: Array<[string, string]> = [
    ["(?:a?)*", "b"], // empty match at 0 — was a 3s "no match"
    ["(?:a?)*", "aab"], // consumes "aa" then exits
    ["(a?)*x", "bbb"], // no match, must be fast (no cap burn)
    ["(a*)*", "aaa"], // nested nullable stars
    ["(a*)*", ""], // empty input
    ["(?:)*", "abc"], // empty body star
    ["(a*)+", ""], // nullable plus on empty input
    ["(a*)+", "aaab"], // nullable plus consuming
    ["(?:x*)*y", "xxxy"], // nullable inner consumed by outer
  ];

  for (const [pattern, input] of nullableCases) {
    it(`/${pattern}/ on ${JSON.stringify(input)} matches native`, async () => {
      const expected = input.search(new RegExp(pattern));
      expect(await search(pattern, input)).toBe(expected);
    });
  }

  it("pathological pattern no longer burns the step cap (fast no-match)", async () => {
    const src = `export function run(): boolean { return /(a?)*x/.test("bbbbbbbbbbbbbbbbbbbb"); }`;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const t0 = Date.now();
    // boolean export marshals as i32 (0/1), not a JS boolean.
    const ret = (instance.exports as { run(): number }).run();
    const dt = Date.now() - t0;
    expect(ret).toBe(0);
    expect(dt).toBeLessThan(500); // was multiple seconds before the guard
  });

  // Non-nullable quantifiers (no scratch slot allocated) must be unaffected.
  const controlCases: Array<[string, string]> = [
    ["a*", "aaab"],
    ["a+", "aaab"],
    ["a+b", "xxb"],
    ["(ab)+", "ababab"],
    ["[0-9]+", "ab123"],
  ];

  for (const [pattern, input] of controlCases) {
    it(`control /${pattern}/ on ${JSON.stringify(input)} unregressed`, async () => {
      const expected = input.search(new RegExp(pattern));
      expect(await search(pattern, input)).toBe(expected);
    });
  }
});
