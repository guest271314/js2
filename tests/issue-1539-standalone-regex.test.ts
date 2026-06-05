// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1539 Phase 2a — pure-WasmGC standalone RegExp engine, `.test` slice.
 *
 * Each case compiles a `RegExp.prototype.test` call under `--target standalone`
 * (pure WasmGC, no JS host), instantiates with an EMPTY import object (proving
 * genuine standalone — no `env.RegExp_new`), runs it, and asserts the boolean
 * result matches the native JS `RegExp.prototype.test`. This is the dual-run
 * equivalence gate the architect required for Phase 2a.
 *
 * The matcher itself (parse → bytecode → VM) is unit-tested in pure TS by
 * tests/regex-bytecode.test.ts; this file validates the Wasm codegen + the
 * standalone routing end-to-end.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile + run `/<pattern>/<flags>.test("<input>")` under --target standalone.
 *
 * The input is embedded as a string literal in the module (standalone exports
 * take/return WasmGC NativeStrings, not JS strings, so we cannot marshal a JS
 * string across the boundary — the matcher runs entirely in-Wasm on a literal,
 * and we read back the boolean as an i32). Mirrors tests/issue-1321-standalone.
 */
async function standaloneTest(pattern: string, flags: string, input: string): Promise<boolean> {
  const inLit = JSON.stringify(input); // safe JS/TS string literal
  const src = `export function run(): boolean { return /${pattern}/${flags}.test(${inLit}); }`;
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  // No JS-host RegExp import should be emitted.
  const mod = await WebAssembly.compile(r.binary);
  const hostRegex = WebAssembly.Module.imports(mod).filter((i) => /RegExp/.test(i.name));
  expect(hostRegex, "no RegExp_new host import in standalone").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const run = (instance.exports as { run(): number }).run;
  return run() !== 0;
}

function nativeTest(pattern: string, flags: string, input: string): boolean {
  return new RegExp(pattern, flags).test(input);
}

// `p` holds the literal regex source (single backslashes in JS string form,
// e.g. "\\d+" === the regex source `\d+`). The same `p` drives both the
// standalone-compiled `/p/` and the native `new RegExp(p)` reference.
const CASES: Array<{ p: string; f: string; inputs: string[] }> = [
  { p: "abc", f: "", inputs: ["abc", "xabcy", "ab", "ABC"] },
  { p: "a.c", f: "", inputs: ["abc", "a c", "ac", "a\nc"] },
  { p: "a+", f: "", inputs: ["", "a", "baaab"] },
  { p: "a*b", f: "", inputs: ["b", "aaab", "xb", "c"] },
  { p: "colou?r", f: "", inputs: ["color", "colour", "coluor"] },
  { p: "[abc]", f: "", inputs: ["a", "d", "xby"] },
  { p: "[^abc]", f: "", inputs: ["a", "d", "abc"] },
  { p: "[a-z]+", f: "", inputs: ["hello", "HELLO", "12abc"] },
  { p: "[0-9]{2,4}", f: "", inputs: ["1", "12", "12345"] },
  { p: "\\d+", f: "", inputs: ["abc123", "no digits"] },
  { p: "\\w+", f: "", inputs: ["foo_bar9", "!!!"] },
  { p: "cat|dog", f: "", inputs: ["i have a dog", "fish", "cat"] },
  { p: "^abc", f: "", inputs: ["abc", "xabc"] },
  { p: "abc$", f: "", inputs: ["abc", "abcx"] },
  { p: "^abc$", f: "", inputs: ["abc", "abcd"] },
  { p: "(ab)+", f: "", inputs: ["ababab", "ba"] },
  { p: "(?:ab)+c", f: "", inputs: ["ababc", "c"] },
  { p: "abc", f: "i", inputs: ["ABC", "AbC", "xyz"] },
  { p: "[a-c]+", f: "i", inputs: ["ABC", "aBcD", "xyz"] },
  // #1539 Phase 2c — dotAll `s`: `.` matches line terminators too.
  { p: "a.c", f: "s", inputs: ["a\nc", "a\rc", "abc"] },
  { p: "a.*z", f: "s", inputs: ["a\nbz", "az", "abc"] },
  // #1539 Phase 2c — multiline `m`: `^`/`$` match at line boundaries.
  { p: "^abc", f: "m", inputs: ["x\nabc", "abc", "xabc"] },
  { p: "abc$", f: "m", inputs: ["abc\ny", "abc", "abcx"] },
  { p: "^abc$", f: "m", inputs: ["x\nabc\ny", "abc", "xabc"] },
  // Non-multiline `^`/`$` unaffected by interior newlines.
  { p: "^abc", f: "", inputs: ["x\nabc", "abc"] },
  // Combined `m` + `s`.
  { p: "^a.b$", f: "ms", inputs: ["a\nb", "x\na\nb\ny", "ab"] },
];

describe("#1539 standalone RegExp.test — no JS host, matches native", () => {
  for (const { p, f, inputs } of CASES) {
    for (const input of inputs) {
      it(`/${p}/${f} on ${JSON.stringify(input)}`, async () => {
        const expected = nativeTest(p, f, input);
        expect(await standaloneTest(p, f, input)).toBe(expected);
      });
    }
  }
});

// #1539 Phase 2b — `String.prototype.search(/re/)`: returns the match index or
// -1, routed through the same pure-WasmGC matcher. The subject is embedded as a
// string literal and the RegExp is the call argument; we read back the f64
// index as a number and compare to native `String.prototype.search`.
async function standaloneSearch(pattern: string, flags: string, input: string): Promise<number> {
  const inLit = JSON.stringify(input);
  const src = `export function run(): number { return ${inLit}.search(/${pattern}/${flags}); }`;
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const hostRegex = WebAssembly.Module.imports(mod).filter((i) => /RegExp/.test(i.name));
  expect(hostRegex, "no RegExp_new host import in standalone").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const run = (instance.exports as { run(): number }).run;
  return run();
}

describe("#1539 standalone String.prototype.search — no JS host, matches native", () => {
  // Reuse the .test corpus: search returns the index of the first match, or -1.
  for (const { p, f, inputs } of CASES) {
    for (const input of inputs) {
      it(`"${input}".search(/${p}/${f})`, async () => {
        const expected = input.search(new RegExp(p, f));
        expect(await standaloneSearch(p, f, input)).toBe(expected);
      });
    }
  }

  it("var-bound RegExp argument (const re = /…/)", async () => {
    const src = `export function run(): number { const re = /\\d+/; return "ab12cd".search(re); }`;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(2);
  });

  it("new RegExp(...) argument", async () => {
    const src = `export function run(): number { return "xxbx".search(new RegExp("b")); }`;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(2);
  });
});

describe("#1539 standalone narrowed refusals (Phase 2a)", () => {
  async function expectRefused(src: string): Promise<void> {
    const r = await compile(src, { target: "standalone" });
    expect(r.success, `expected refusal for:\n${src}`).toBe(false);
    expect(r.errors.some((e) => /#1539|#1474/.test(e.message))).toBe(true);
  }

  it("refuses dynamic new RegExp(var)", async () => {
    await expectRefused(`export function f(p: string): boolean { return new RegExp(p).test("x"); }`);
  });
  it("refuses backreference", async () => {
    // Single backslash in the emitted source: regex literal /(a)\1/.
    await expectRefused(`export function f(s: string): boolean { return /(a)\\1/.test(s); }`);
  });
  it("refuses lookahead", async () => {
    await expectRefused(`export function f(s: string): boolean { return /a(?=b)/.test(s); }`);
  });
  // #1539 Phase 2c landed the `m` (multiline) and `s` (dotAll) flags — they are
  // no longer refused (see the dual-run CASES above). The `u`/`v` (code-point)
  // and `d` (indices) flags remain deferred to Phase 2d.
  it("refuses unicode flag (u, Phase 2d)", async () => {
    await expectRefused(`export function f(s: string): boolean { return /^a/u.test(s); }`);
  });
  it("refuses indices flag (d, Phase 2d)", async () => {
    await expectRefused(`export function f(s: string): boolean { return /^a/d.test(s); }`);
  });
});
