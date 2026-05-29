import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// String.prototype.substring()/slice() with NO arguments must default the
// missing `end` to the string length and return the whole string
// (§22.1.3.24 substring: end defaults to len; §22.1.3.21 slice:
// ToIntegerOrInfinity(end ?? len)). Previously the missing-`end` length
// default only fired for the single-arg case, so the no-arg call padded BOTH
// start and end to 0 → "s".substring(0,0) → "" instead of the whole string.

async function evalStr(expr: string): Promise<unknown> {
  const exports = await compileToWasm(`export function test(): string { return ${expr}; }`);
  return (exports as { test: () => unknown }).test();
}

describe("String.prototype.substring/slice missing-end default", () => {
  it("substring() with no args returns the whole string", async () => {
    expect(await evalStr(`"hello".substring()`)).toBe("hello");
  });

  it("slice() with no args returns the whole string", async () => {
    expect(await evalStr(`"hello".slice()`)).toBe("hello");
  });

  it("substring()/slice() on an empty string returns empty", async () => {
    expect(await evalStr(`"".substring()`)).toBe("");
    expect(await evalStr(`"".slice()`)).toBe("");
  });

  it("does not regress the single-arg missing-end default (#1248)", async () => {
    expect(await evalStr(`"hello".substring(1)`)).toBe("ello");
    expect(await evalStr(`"hello".slice(1)`)).toBe("ello");
  });

  it("does not regress the two-arg or swapped-arg cases", async () => {
    expect(await evalStr(`"hello".substring(1, 3)`)).toBe("el");
    expect(await evalStr(`"hello".slice(1, 3)`)).toBe("el");
    expect(await evalStr(`"hello".substring(3, 1)`)).toBe("el"); // substring swaps
  });
});
