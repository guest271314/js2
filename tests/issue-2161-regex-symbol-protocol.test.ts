// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2161 — standalone `re[Symbol.match/matchAll/search](str)` protocol calls.
 *
 * The explicit well-known-symbol READ protocol forms (§22.2.6) are the
 * operand-swapped duals of `String.prototype.match/matchAll/search`: the RegExp
 * is the **receiver** and the string is the **argument**. They were blanket-
 * refused in `--target standalone` (calls.ts) even though the native engine is
 * operand-order agnostic. This slice routes the static / backend-created RegExp
 * forms to the exact same native cores that back the String.prototype methods —
 * NO JS host import (`__regex_symbol_call` must not leak).
 *
 * Deferred (still narrowed — refused, not silently wrong):
 *   - `@@replace` / `@@split` (carry extra replacement / limit operands);
 *   - dynamic-flag / `any`-typed receivers (fall through to the host path);
 *   - string-coercion arguments (`re[Symbol.match](42)`).
 */
async function standaloneExports(source: string) {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // No JS-host string / regex protocol import may leak in standalone.
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  for (const re of [/^env::__extern_toString$/, /^wasm:js-string::/, /^env::__regex_symbol_call$/, /^env::__extern_get$/]) {
    expect(labels.filter((l) => re.test(l)), `leaked ${re}`).toEqual([]);
  }
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, (...a: unknown[]) => number>;
}

describe("#2161 — standalone re[Symbol.search](str)", () => {
  it("returns the match index", async () => {
    const ex = await standaloneExports(`
      export function idx(): number { return /abc/[Symbol.search]("xyabc"); }
    `);
    expect(ex.idx()).toBe(2);
  });

  it("returns -1 on no match", async () => {
    const ex = await standaloneExports(`
      export function miss(): number { return /zzz/[Symbol.search]("xyabc"); }
    `);
    expect(ex.miss()).toBe(-1);
  });
});

describe("#2161 — standalone re[Symbol.match](str)", () => {
  it("non-global: exposes capture group m[1]", async () => {
    const ex = await standaloneExports(`
      export function cap(): number {
        let m = /a(b)c/[Symbol.match]("xabc");
        return m ? m[1].length : -9;
      }
    `);
    expect(ex.cap()).toBe(1); // "b".length
  });

  it("non-global: exposes .index", async () => {
    const ex = await standaloneExports(`
      export function where(): number {
        let m = /a(b)c/[Symbol.match]("xabc");
        return m ? (m.index as number) : -9;
      }
    `);
    expect(ex.where()).toBe(1);
  });

  it("non-global: null on no match (not a stray ref)", async () => {
    const ex = await standaloneExports(`
      export function none(): number {
        let m = /zzz/[Symbol.match]("xabc");
        return m ? 1 : 0;
      }
    `);
    expect(ex.none()).toBe(0);
  });

  it("global: collects every [0] substring (length)", async () => {
    const ex = await standaloneExports(`
      export function count(): number {
        let m = /X/g[Symbol.match]("aXbXcX");
        return m ? m.length : -9;
      }
    `);
    expect(ex.count()).toBe(3);
  });
});

describe("#2161 — standalone re[Symbol.matchAll](str)", () => {
  it("iterates every match, exposing capture groups", async () => {
    const ex = await standaloneExports(`
      export function sumDigits(): number {
        let sum = 0;
        for (const m of /(\\d)/g[Symbol.matchAll]("a1b2c3")) { sum = sum + Number(m[1]); }
        return sum;
      }
    `);
    expect(ex.sumDigits()).toBe(6); // 1 + 2 + 3
  });

  it("yields one iterator entry per match", async () => {
    const ex = await standaloneExports(`
      export function count(): number {
        let c = 0;
        for (const m of /X/g[Symbol.matchAll]("aXbX")) { c = c + 1; }
        return c;
      }
    `);
    expect(ex.count()).toBe(2);
  });
});
