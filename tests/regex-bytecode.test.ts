// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1539 Phase 2a — pure-TS regex pipeline tests.
 *
 * Validates parse → compile → reference VM against the native JS RegExp engine
 * for the Phase-2a subset. The reference VM (`vm.ts`) is the spec the Wasm
 * interpreter mirrors, so getting this right de-risks the codegen.
 */
import { describe, expect, it } from "vitest";
import { parseFlags, RegexUnsupportedError } from "../src/codegen/regex/bytecode.js";
import { compilePattern } from "../src/codegen/regex/compile.js";
import { parsePattern } from "../src/codegen/regex/parse.js";
import { search } from "../src/codegen/regex/vm.js";

/** Run our pipeline and return [start,end] of the first match (g0), or null. */
function ourMatch(pattern: string, flags: string, input: string): [number, number] | null {
  const flagBits = parseFlags(flags);
  const c = compilePattern(pattern, flagBits);
  const m = search(c.prog, c.classTable, c.nGroups, input, 0, false);
  if (!m) return null;
  return [m[0]!, m[1]!];
}

/** Native reference. */
function nativeMatch(pattern: string, flags: string, input: string): [number, number] | null {
  const re = new RegExp(pattern, flags);
  const m = re.exec(input);
  if (!m) return null;
  return [m.index, m.index + m[0].length];
}

const CORPUS: Array<{ p: string; f: string; inputs: string[] }> = [
  { p: "abc", f: "", inputs: ["abc", "xabcy", "ab", "", "ABC"] },
  { p: "a.c", f: "", inputs: ["abc", "a c", "ac", "a\nc"] },
  { p: "a*", f: "", inputs: ["", "aaa", "baaa", "xyz"] },
  { p: "a+", f: "", inputs: ["", "a", "aaab", "baaa"] },
  { p: "a?b", f: "", inputs: ["b", "ab", "aab", "xb"] },
  { p: "[abc]", f: "", inputs: ["a", "d", "xby", ""] },
  { p: "[^abc]", f: "", inputs: ["a", "d", "abcd"] },
  { p: "[a-z]+", f: "", inputs: ["hello", "Hello", "123abc", ""] },
  { p: "[0-9]{2,4}", f: "", inputs: ["1", "12", "12345", "999"] },
  { p: "\\d+", f: "", inputs: ["abc123", "12.34", "no digits"] },
  { p: "\\w+", f: "", inputs: ["foo_bar9", " spaces ", "!!!"] },
  { p: "\\s+", f: "", inputs: ["a b", "a\tb", "ab"] },
  { p: "cat|dog|bird", f: "", inputs: ["i have a dog", "a bird", "cat", "fish"] },
  { p: "^abc", f: "", inputs: ["abc", "xabc", "abcx"] },
  { p: "abc$", f: "", inputs: ["abc", "abcx", "xabc"] },
  { p: "^abc$", f: "", inputs: ["abc", "abcd", "xabc"] },
  { p: "(ab)+", f: "", inputs: ["ababab", "ab", "ba", "abab c"] },
  { p: "(?:ab)+c", f: "", inputs: ["ababc", "abc", "c", "abx"] },
  { p: "a{3}", f: "", inputs: ["aaa", "aa", "aaaa", ""] },
  { p: "a{2,}", f: "", inputs: ["a", "aa", "aaaaa"] },
  { p: "colou?r", f: "", inputs: ["color", "colour", "coluor"] },
  { p: "abc", f: "i", inputs: ["ABC", "AbC", "abc", "xyz"] },
  { p: "[a-c]+", f: "i", inputs: ["ABC", "aBcD", "xyz"] },
  { p: "a.*z", f: "", inputs: ["az", "abcz", "a z", "abc"] },
  { p: "a.*?z", f: "", inputs: ["azaz", "abcz"] },
  { p: "\\.", f: "", inputs: ["a.b", "axb"] },
  { p: "[.]", f: "", inputs: ["a.b", "axb"] },
  // #1539 Phase 2c — dotAll `s`: `.` matches line terminators too.
  { p: "a.c", f: "s", inputs: ["a\nc", "a\rc", "abc", "a c"] },
  { p: "a.*z", f: "s", inputs: ["a\nbz", "ab\ncz", "az"] },
  { p: ".", f: "s", inputs: ["\n", "\r", "x", ""] },
  { p: ".", f: "", inputs: ["\n", "\r", "x"] },
  // #1539 Phase 2c — multiline `m`: `^`/`$` match at line boundaries.
  { p: "^b", f: "m", inputs: ["a\nb", "b\na", "ab", "a\r\nb"] },
  { p: "a$", f: "m", inputs: ["a\nb", "b\na", "ba", "a\r\nb"] },
  { p: "^abc$", f: "m", inputs: ["x\nabc\ny", "abc", "xabc", "abcx"] },
  { p: "^$", f: "m", inputs: ["a\n\nb", "ab", "\n"] },
  // Non-multiline `^`/`$` are unaffected by interior newlines.
  { p: "^b", f: "", inputs: ["a\nb", "b\na"] },
  { p: "a$", f: "", inputs: ["a\nb", "b\na"] },
  // Combined `m` + `s`.
  { p: "^a.b$", f: "ms", inputs: ["a\nb", "x\na\nb\ny", "a b"] },
];

describe("#1539 regex bytecode pipeline vs native RegExp", () => {
  for (const { p, f, inputs } of CORPUS) {
    for (const input of inputs) {
      it(`/${p}/${f} on ${JSON.stringify(input)}`, () => {
        expect(ourMatch(p, f, input)).toEqual(nativeMatch(p, f, input));
      });
    }
  }
});

describe("#1539 capture groups", () => {
  it("records group spans", () => {
    const c = compilePattern("(a)(b)c", 0);
    const m = search(c.prog, c.classTable, c.nGroups, "xabcy", 0, false);
    expect(m).not.toBeNull();
    // g0=[1,4] g1=[1,2] g2=[2,3]
    expect([m![0], m![1]]).toEqual([1, 4]);
    expect([m![2], m![3]]).toEqual([1, 2]);
    expect([m![4], m![5]]).toEqual([2, 3]);
  });

  it("named groups map to indices", () => {
    const parsed = parsePattern("(?<year>\\d{4})");
    expect(parsed.numCaptures).toBe(1);
    expect(parsed.groupNames.get("year")).toBe(1);
  });
});

describe("#1539 narrowed refusals (Phase 2a)", () => {
  const refused = [
    "\\1", // backref
    "\\k<x>", // named backref
    "(?=ab)", // lookahead
    "(?!ab)", // neg lookahead
    "(?<=ab)", // lookbehind
    "\\p{L}", // unicode property
    "\\bword", // word boundary
  ];
  for (const p of refused) {
    it(`refuses ${JSON.stringify(p)}`, () => {
      expect(() => compilePattern(p, 0)).toThrow(RegexUnsupportedError);
    });
  }
});

describe("#1539 flag parsing", () => {
  it("parses gi", () => {
    expect(parseFlags("gi")).toBe(1 | 2);
  });
  it("rejects duplicate", () => {
    expect(() => parseFlags("gg")).toThrow(RegexUnsupportedError);
  });
  it("rejects unknown", () => {
    expect(() => parseFlags("z")).toThrow(RegexUnsupportedError);
  });
});
