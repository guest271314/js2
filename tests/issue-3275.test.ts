// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3275 — smoke test for the ensureNativeStringHelpers slice-1 decomposition.
 *
 * The `String.prototype` method-helper tail was lifted verbatim out of the
 * `ensureNativeStringHelpers` god-function into three sibling modules
 * (`native-strings-{search,transform,rewrite}.ts`). Byte-identity across the
 * playground corpus is proved by `scripts/prove-emit-identity.mjs`; this test is
 * the required #2093 runtime gate — it compiles each extracted family under
 * `--target standalone` (pure Wasm, NO JS host) and checks the emitted helpers
 * actually execute correctly. Each case instantiates with an EMPTY import object,
 * proving no host-import leak.
 */
async function instantiate(source: string) {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const envLeaks = r.imports.filter((i) => i.module === "env" || i.module.startsWith("wasm:js-string"));
  expect(
    envLeaks.map((i) => `${i.module}::${i.name}`),
    "JS-host imports leaked",
  ).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, (...args: number[]) => number>;
}

describe("#3275 native-strings-search (search & trim) — standalone", () => {
  it("indexOf / lastIndexOf / includes / startsWith / endsWith", async () => {
    const ex = await instantiate(`
      export function idx(): number { return "abcabc".indexOf("bc"); }
      export function idxFrom(): number { return "abcabc".indexOf("bc", 2); }
      export function idxMiss(): number { return "abcabc".indexOf("z"); }
      export function last(): number { return "abcabc".lastIndexOf("bc"); }
      export function inc(): number { return "hello world".includes("o w") ? 1 : 0; }
      export function starts(): number { return "foobar".startsWith("foo") ? 1 : 0; }
      export function ends(): number { return "foobar".endsWith("bar") ? 1 : 0; }
    `);
    expect(ex.idx!()).toBe(1);
    expect(ex.idxFrom!()).toBe(4);
    expect(ex.idxMiss!()).toBe(-1);
    expect(ex.last!()).toBe(4);
    expect(ex.inc!()).toBe(1);
    expect(ex.starts!()).toBe(1);
    expect(ex.ends!()).toBe(1);
  });

  it("trim / trimStart / trimEnd strip whitespace", async () => {
    const ex = await instantiate(`
      export function trimLen(): number { return "  hi  ".trim().length; }
      export function startLen(): number { return "  hi  ".trimStart().length; }
      export function endLen(): number { return "  hi  ".trimEnd().length; }
      export function trimFirst(): number { return "  hi  ".trim().charCodeAt(0); }
    `);
    expect(ex.trimLen!()).toBe(2);
    expect(ex.startLen!()).toBe(4); // "hi  "
    expect(ex.endLen!()).toBe(4); //   "  hi"
    expect(ex.trimFirst!()).toBe(104); // "h"
  });
});

describe("#3275 native-strings-transform (length & case) — standalone", () => {
  it("repeat / padStart / padEnd", async () => {
    const ex = await instantiate(`
      export function rep(): number { return "ab".repeat(3).length; }
      export function padS(): number { return "5".padStart(3, "0").charCodeAt(0); }
      export function padSLen(): number { return "5".padStart(3, "0").length; }
      export function padE(): number { return "5".padEnd(3, "x").charCodeAt(2); }
    `);
    expect(ex.rep!()).toBe(6); // "ababab"
    expect(ex.padS!()).toBe(48); // "0"
    expect(ex.padSLen!()).toBe(3); // "005"
    expect(ex.padE!()).toBe(120); // "5xx" → 'x'
  });

  it("toLowerCase / toUpperCase", async () => {
    const ex = await instantiate(`
      export function lo(): number { return "ABC".toLowerCase().charCodeAt(0); }
      export function up(): number { return "abc".toUpperCase().charCodeAt(2); }
    `);
    expect(ex.lo!()).toBe(97); // "a"
    expect(ex.up!()).toBe(67); // "C"
  });
});

describe("#3275 native-strings-rewrite (replace / split / construct) — standalone", () => {
  it("replace / replaceAll", async () => {
    const ex = await instantiate(`
      export function rep1(): number { return "a-b-c".replace("-", "+").charCodeAt(1); }
      export function repAllLen(): number { return "a-b-c".replaceAll("-", "++").length; }
    `);
    expect(ex.rep1!()).toBe(43); // "a+b-c" → '+'
    expect(ex.repAllLen!()).toBe(7); // "a++b++c"
  });

  it("split yields the right piece count and content", async () => {
    const ex = await instantiate(`
      export function parts(): number { return "a,b,c,d".split(",").length; }
      export function piece(): number { return "a,bb,c".split(",")[1].charCodeAt(0); }
    `);
    expect(ex.parts!()).toBe(4);
    expect(ex.piece!()).toBe(98); // "bb" → 'b'
  });

  it("String.fromCharCode / fromCodePoint", async () => {
    const ex = await instantiate(`
      export function fcc(): number { return String.fromCharCode(65).charCodeAt(0); }
      export function fcp(): number { return String.fromCodePoint(97).charCodeAt(0); }
    `);
    expect(ex.fcc!()).toBe(65); // "A"
    expect(ex.fcp!()).toBe(97); // "a"
  });
});
