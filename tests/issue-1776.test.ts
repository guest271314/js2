// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#1776 standalone isSameValue externref equality", () => {
  it("validates test262-shaped isSameValue with any parameters", async () => {
    const r = await compile(
      `
        let __fail: number = 0;
        let __assert_count: number = 1;

        function isSameValue(a: any, b: any): number {
          if (a === b) { return 1; }
          if (a !== a && b !== b) { return 1; }
          return 0;
        }

        function assert_sameValue(actual: any, expected: any): void {
          __assert_count = __assert_count + 1;
          if (!isSameValue(actual, expected)) {
            if (!__fail) __fail = __assert_count;
          }
        }

        export function test(): number {
          assert_sameValue(1, 1);
          assert_sameValue(NaN, NaN);
          assert_sameValue(true, true);
          return __fail;
        }
      `,
      { fileName: "issue-1776.ts", target: "standalone" },
    );

    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    try {
      await WebAssembly.compile(r.binary);
    } catch (err) {
      const start = r.wat.indexOf("(func $isSameValue");
      const next = start >= 0 ? r.wat.indexOf("(func ", start + 1) : -1;
      const fnWat = start >= 0 ? r.wat.slice(start, next >= 0 ? next : undefined) : r.wat;
      throw new Error(`${String(err)}\n${fnWat}`);
    }
  });
});
