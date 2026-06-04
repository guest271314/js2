// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1858 C6 — value-asserting regression for the try/finally else-branch depth
// bug in `bumpOuterBranchDepths` (src/codegen/statements/exceptions.ts).
//
// The finally body is compiled once and CLONED into each control-flow path.
// When a clone is inserted at a deeper position (the inner try/catch_all that
// wraps a catch body, +1 depth), the branch depths of any `break`/`continue`
// targeting an OUTER label must be bumped. Two compounding defects produced an
// INFINITE LOOP (and an invalid module) for a `break outer` reached from the
// ELSE (or THEN) branch of an `if` inside a finally:
//
//   1. The walker recursed via `(instr as any).body` / `(instr as any).elseBody`,
//      but the IR `if` op stores its arms in `then` / `else` (ir/types.ts) — so
//      a branch nested inside an `if` was never even visited.
//   2. The membership test compared the branch's RAW depth against the outer
//      break/continue depths with no local-nesting correction, so a visited
//      nested branch (e.g. `br 4` one `if` deep, outer depths `{3,1}`) still
//      failed the test and was left un-bumped — landing on the `loop` label
//      ("continue") instead of the outer `block` label ("break") → endless loop.
//
// The CRITICAL cases below force execution through the inner catch_all clone by
// making the catch body re-throw. Without the fix these hang (caught by the
// per-test timeout) or produce a wrong value; with the fix they match Node.
// `assertEquivalent` also runs `WebAssembly.validate()` on the binary, so an
// out-of-range branch depth that yields an invalid module fails loudly too.
import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("#1858 C6 — try/finally else-branch break depth", () => {
  // --- CRITICAL: exercises the inner catch_all finally clone (the +1 site
  // where the bug bites). The catch body re-throws, so the finally runs on the
  // still-propagating-exception path; the nested `break outer` in the finally
  // must target the outer block, not the loop.
  it("catch re-throws; finally ELSE-branch breaks outer (nested if)", { timeout: 15000 }, async () => {
    await assertEquivalent(
      `
      export function test(n: number): number {
        let total = 0;
        let caught = 0;
        outer: for (let i = 0; i < 5; i++) {
          try {
            try {
              throw new Error("a");
            } catch (e) {
              total = total + 100;
              throw new Error("b");
            } finally {
              if (i < n) {
                total = total + 10;
              } else {
                total = total + 1000;
                break outer;
              }
            }
          } catch (e2) {
            caught = caught + 1;
          }
        }
        return total * 10 + caught;
      }
      `,
      [
        { fn: "test", args: [10] }, // else never taken -> falls through, outer catch runs each iter
        { fn: "test", args: [0] }, // else taken at i===0 -> break outer abandons the in-flight throw
        { fn: "test", args: [2] }, // else taken at i===2
        { fn: "test", args: [1] },
      ],
    );
  });

  it("catch re-throws; finally THEN-branch breaks outer (nested if)", { timeout: 15000 }, async () => {
    await assertEquivalent(
      `
      export function test(n: number): number {
        let total = 0;
        let caught = 0;
        outer: for (let i = 0; i < 5; i++) {
          try {
            try {
              throw new Error("a");
            } catch (e) {
              total = total + 100;
              throw new Error("b");
            } finally {
              if (i >= n) {
                total = total + 1000;
                break outer;
              } else {
                total = total + 10;
              }
            }
          } catch (e2) {
            caught = caught + 1;
          }
        }
        return total * 10 + caught;
      }
      `,
      [
        { fn: "test", args: [10] },
        { fn: "test", args: [0] },
        { fn: "test", args: [2] },
      ],
    );
  });

  it("catch re-throws; finally ELSE-branch CONTINUEs outer (nested if)", { timeout: 15000 }, async () => {
    await assertEquivalent(
      `
      export function test(n: number): number {
        let total = 0;
        let caught = 0;
        outer: for (let i = 0; i < 4; i++) {
          try {
            try {
              throw new Error("a");
            } catch (e) {
              total = total + 100;
              throw new Error("b");
            } finally {
              if (i < n) {
                total = total + 10;
              } else {
                total = total + 1000;
                continue outer;
              }
            }
          } catch (e2) {
            caught = caught + 1;
          }
          total = total + 5;
        }
        return total * 10 + caught;
      }
      `,
      [
        { fn: "test", args: [10] },
        { fn: "test", args: [0] },
        { fn: "test", args: [2] },
      ],
    );
  });

  // --- The normal-path try/catch/finally and try/finally cases (these already
  // worked before the fix; kept as guardrails so the common shapes stay green).
  it("normal-path: try/catch/finally with else-branch break outer", { timeout: 15000 }, async () => {
    await assertEquivalent(
      `
      export function test(n: number): number {
        let total = 0;
        outer: for (let i = 0; i < 5; i++) {
          try {
            if (i === 2) {
              throw new Error("boom");
            }
            total = total + 1;
          } catch (e) {
            total = total + 100;
          } finally {
            if (i < n) {
              total = total + 10;
            } else {
              total = total + 1000;
              break outer;
            }
          }
        }
        return total;
      }
      `,
      [
        { fn: "test", args: [10] },
        { fn: "test", args: [2] },
        { fn: "test", args: [0] },
        { fn: "test", args: [1] },
      ],
    );
  });

  it("normal-path: try/finally only with else-branch break outer", { timeout: 15000 }, async () => {
    await assertEquivalent(
      `
      export function test(n: number): number {
        let total = 0;
        outer: for (let i = 0; i < 5; i++) {
          try {
            total = total + 1;
          } finally {
            if (i < n) {
              total = total + 10;
            } else {
              total = total + 1000;
              break outer;
            }
          }
        }
        return total;
      }
      `,
      [
        { fn: "test", args: [10] },
        { fn: "test", args: [0] },
        { fn: "test", args: [1] },
        { fn: "test", args: [3] },
      ],
    );
  });
});
