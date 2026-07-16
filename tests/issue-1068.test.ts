import { describe, it, expect } from "vitest";
import { compileAndRunTestSyncJoined as compileAndRun } from "./helpers/compile.js";

describe("#1068 — await as label identifier in non-async contexts", () => {
  it("await: label in regular function should compile", async () => {
    const result = await compileAndRun(`
      function foo(): number {
        let sum = 0;
        await: for (let i = 0; i < 5; i++) {
          if (i === 3) break await;
          sum += i;
        }
        return sum;
      }
      export function test(): number { return foo(); }
    `);
    // 0 + 1 + 2 = 3
    expect(result).toBe(3);
  });

  it("await: label in regular function inside module should compile", async () => {
    const result = await compileAndRun(`
      function bar(): number {
        await: while (true) {
          break await;
        }
        return 99;
      }
      export function test(): number { return bar(); }
    `);
    expect(result).toBe(99);
  });
});
