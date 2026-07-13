import { describe, it, expect } from "vitest";
import { compileAndRunImportObject as compileAndRun } from "./helpers/compile.js";

// #2067 — the generic for-of iterator lowering carried a hard `br_if` guard that
// silently `break`ed after 1,000,000 iterations, and its counter local was never
// reset across re-entries of the same compiled loop, so repeated executions
// accumulated toward the cap. The guard is removed: the loop runs to the
// iterator's own `done`. (The eager-generator buffer's separate `RangeError`
// cap is out of scope here.)

const GEN = `function* gen(n: number): Generator<number> { for (let i = 0; i < n; i++) yield 1; }`;

describe("#2067 for-of iterator has no silent 1M-iteration cap", () => {
  it("a single long iteration is not truncated", async () => {
    const e = await compileAndRun(
      GEN + `export function f(): number { let s = 0; for (const x of gen(200000)) { s += x; } return s; }`,
    );
    expect(e.f()).toBe(200000);
  });

  it("re-entering the same loop statement does not accumulate toward a cap", async () => {
    // 20 runs of 100k each. With the old per-statement counter (never reset),
    // the accumulated total would trip the 1M cap partway through.
    const e = await compileAndRun(
      GEN +
        `export function f(): number {
           let total = 0;
           for (let k = 0; k < 20; k++) { let s = 0; for (const x of gen(100000)) { s += x; } total += s; }
           return total;
         }`,
    );
    expect(e.f()).toBe(2000000);
  });
});
