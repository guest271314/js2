import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

// #2050 — `a?.[i]` optional element access must short-circuit on a nullish base:
// the index expression (and its side effects) must NOT evaluate (§13.3.9
// Optional Chains). Before the fix, `compileElementAccess` ignored
// `expr.questionDotToken` and lowered `a?.[i]` identically to `a[i]`.
//
// These probes use a *directly* null-typed local (`const a: number[] | null =
// null`) rather than a `T[] | null` function return: a separate, pre-existing
// bug round-trips such returns through externref and loses the null identity
// (`getArr(false) === null` is already wrong on main with no optional chaining
// involved), which would confound this test. The undefined-result of a
// short-circuit is tracked separately in #2051.
describe("optional element access a?.[i] (#2050)", () => {
  it("nullish base: index side effect does not fire", async () => {
    await assertEquivalent(
      `let log = 0;
       function mark(k: number): number { log = log * 10 + k; return k; }
       export function test(): number {
         log = 0;
         const a: number[] | null = null;
         const r = a?.[mark(2)];
         return log;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("nullish base with i++: index is not evaluated", async () => {
    await assertEquivalent(
      `export function test(): number {
         let i = 0;
         const a: number[] | null = null;
         const r = a?.[i++];
         return i;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("non-null base: index fires and value is read", async () => {
    await assertEquivalent(
      `let log = 0;
       function mark(k: number): number { log = log * 10 + k; return k; }
       export function test(): number {
         log = 0;
         const a: number[] | null = [4, 5, 6];
         const r = a?.[mark(1)];
         return log * 100 + (r === undefined ? 0 : r);
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("non-null base: plain index read", async () => {
    await assertEquivalent(
      `export function test(): number {
         const a: number[] | null = [10, 20, 30];
         return a?.[2] ?? -1;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  // NOTE: `a?.[0] ?? 99` on a nullish base correctly short-circuits the index
  // (no side effects), but the short-circuit *value* is currently 0 rather than
  // `undefined`, so the `??` does not fall through. That undefined-representation
  // gap is tracked in #2051, not here.
});
