// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3179 — standalone: for-in over an Array whose RUNTIME vec rep differs from
 * the statically-resolved vec type trapped `illegal cast`.
 *
 * Root cause: `emitArrayForIn` (statements/loops.ts) hard-`ref.cast`ed the
 * externref receiver to the vec type derived from the STATIC TS type — but the
 * allocation site picks the runtime rep independently (`new Array()` is
 * statically `any[]` → `__vec_externref`, while compileNewExpression's
 * usage-inference mints a `__vec_f64` for `arr[0] = 5`). The fix downcasts to
 * the shared `$__vec_base` supertype (#2186) instead — the loop only needs the
 * length (field 0) — guarded by `ref.test` (non-vec receiver → 0 iterations).
 *
 * Every case instantiates with an EMPTY import object (no JS host).
 */

async function compileStandalone(src: string) {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, () => number>;
}

describe("#3179 for-in over rep-divergent arrays (standalone)", () => {
  it("new Array() + indexed writes + for-in string-key element read (the issue repro)", async () => {
    const exports = await compileStandalone(`
      export function test(): number {
        var nullChars = new Array();
        nullChars[0] = '"a"';
        nullChars[1] = '"b"';
        let s = '';
        for (var index in nullChars) { s = s + nullChars[index]; }
        return s.length;
      }
    `);
    // '"a"' + '"b"' concatenated = 6 chars (previously: illegal-cast trap)
    expect(exports.test!()).toBe(6);
  });

  it("bare for-in over new Array() with elements (no element read) does not trap", async () => {
    const exports = await compileStandalone(`
      export function test(): number {
        var arr = new Array();
        arr[0] = 5; arr[1] = 6;
        let n = 0;
        for (var k in arr) { n = n + 1; }
        return n;
      }
    `);
    expect(exports.test!()).toBe(2);
  });

  it("for-in over a typed array literal still enumerates (no regression)", async () => {
    const exports = await compileStandalone(`
      export function test(): number {
        var arr = [5, 6];
        let n = 0;
        for (var k in arr) { n = n + 1; }
        return n;
      }
    `);
    expect(exports.test!()).toBe(2);
  });

  it("for-in keys are the decimal index strings, ascending", async () => {
    const exports = await compileStandalone(`
      export function test(): number {
        var arr = new Array();
        arr[0] = 10; arr[1] = 20; arr[2] = 30;
        let s = '';
        for (var k in arr) { s = s + k; }
        return s === '012' ? 1 : 0;
      }
    `);
    expect(exports.test!()).toBe(1);
  });

  it("the 15.12.2-2-* JSON.parse shape completes (trap escaped assert.throws before)", async () => {
    const exports = await compileStandalone(`
      export function test(): number {
        var nullChars = new Array();
        nullChars[0] = "\\u0000";
        nullChars[1] = "\\u0001";
        let count = 0;
        for (var index in nullChars) {
          try {
            const v: any = JSON.parse('{ "name' + nullChars[index] + '" : "John" }');
          } catch (e) {
            count = count + 1;
          }
        }
        return count;
      }
    `);
    // both raw control chars inside the JSON string throw SyntaxError (#3176)
    expect(exports.test!()).toBe(2);
  });

  it("for-in over an empty new Array() yields zero iterations", async () => {
    const exports = await compileStandalone(`
      export function test(): number {
        var arr = new Array();
        let n = 0;
        for (var k in arr) { n = n + 1; }
        return n;
      }
    `);
    expect(exports.test!()).toBe(0);
  });
});
