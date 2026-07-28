// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Target = "gc" | "standalone";

async function run(source: string, target: Target): Promise<number> {
  const result = await compile(source, {
    ...(target === "standalone" ? { target: "standalone" as const } : {}),
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  if (target === "standalone") expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return (instance.exports.test as () => number)();
}

describe.each<Target>(["gc", "standalone"])("#3766 String receiver coercion (%s)", (target) => {
  it("treats a void toString result as the primitive undefined", async () => {
    expect(
      await run(
        `
          var value = { toString: function () {} };
          var observed = String(value).indexOf(void 0);
          export function test(): number { return observed; }
        `,
        target,
      ),
    ).toBe(0);
  });

  it("falls through a non-callable toString to a void valueOf", async () => {
    expect(
      await run(
        `
          var value = { valueOf: function () {}, toString: void 0 };
          var observed = new String(value).indexOf(function () {}());
          export function test(): number { return observed; }
        `,
        target,
      ),
    ).toBe(0);
  });

  it("invokes the successful conversion method exactly once", async () => {
    expect(
      await run(
        `
          var calls = 0;
          var value = {
            toString: function () {
              calls++;
            }
          };
          var text = String(value);
          export function test(): number {
            return text.indexOf(void 0) === 0 && calls === 1 ? 1 : 0;
          }
        `,
        target,
      ),
    ).toBe(1);
  });

  it("keeps ordinary string-returning toString precedence", async () => {
    expect(
      await run(
        `
          var calls = 0;
          var valueOfCalls = 0;
          var value = {
            toString: function () {
              calls++;
              return "ok";
            },
            valueOf: function () {
              valueOfCalls++;
              return "wrong";
            }
          };
          var observed = new String(value).indexOf("ok");
          export function test(): number {
            return observed === 0 && calls === 1 && valueOfCalls === 0 ? 1 : 0;
          }
        `,
        target,
      ),
    ).toBe(1);
  });
});
