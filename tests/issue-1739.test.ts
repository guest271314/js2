import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #1739 — String.prototype method function-object invariants.
//
// Smoke-tested 2026-05-30: BOTH the A7 (not-a-constructor → TypeError) and the
// A8 (.length is an own, non-enumerable property) invariants are ALREADY GREEN
// on main — the jsonl baseline that listed ~40 fails was STALE (A8 already
// passed; A7 was closed by the not-a-constructor work, #930 + #1528 + #1732-S1's
// new-site IsConstructor check, which routes `new String.prototype.<m>` through
// the __construct guard that throws a real TypeError instance).
//
// This pin LOCKS that green state so it can't silently regress. It mirrors the
// exact test262 `S15.5.4.*_A7` / `_A8` assertion shapes (which is why it uses
// `var f = String.prototype.<m>` then `new f`, NOT an inner `as any` cast — the
// cast shape defeats the prototype-method detection and is not what test262
// does).

// test262 `assert.throws(TypeError, fn)` shape: the TypeError-type check is
// retained here (unlike the #930 pin's stripped variant) because A7's WHOLE
// point is that the thrown error is a TypeError, not just any throw.
const ASSERT_THROWS_TYPEERROR = `
  let passed = 0;
  function assert_throws_typeerror(fn: () => void): void {
    try { fn(); } catch (e) { if (e instanceof TypeError) passed++; }
  }
`;

// A representative slice of the String.prototype methods the A7/A8 clusters
// cover. Same root cause across all of them, so a sample pins the row.
const METHODS = [
  "indexOf",
  "lastIndexOf",
  "charAt",
  "charCodeAt",
  "slice",
  "substring",
  "substr",
  "toLowerCase",
  "toUpperCase",
  "concat",
  "includes",
  "split",
  "trim",
  "valueOf",
];

describe("#1739 — String.prototype function-object invariants (A7/A8)", () => {
  // A7: `new String.prototype.<m>` must throw a TypeError (no [[Construct]]).
  for (const m of METHODS) {
    it(`A7: new String.prototype.${m} throws TypeError`, async () => {
      const exports = await compileToWasm(`
        ${ASSERT_THROWS_TYPEERROR}
        export function test(): number {
          const __FACTORY: any = String.prototype.${m};
          assert_throws_typeerror(() => { const i = new __FACTORY(); });
          return passed;
        }
      `);
      expect(exports.test!()).toBe(1);
    });
  }

  // A8: String.prototype.<m>.length is an own, non-enumerable property — present
  // via hasOwnProperty, false under propertyIsEnumerable, and not surfaced by
  // for-in.
  for (const m of METHODS) {
    it(`A8: String.prototype.${m}.length is own + non-enumerable`, async () => {
      const exports = await compileToWasm(`
        export function test(): number {
          const f: any = String.prototype.${m};
          if (!f.hasOwnProperty("length")) return 10;
          if (f.propertyIsEnumerable("length")) return 11;
          let count = 0;
          for (const p in f) { if (p === "length") count++; }
          if (count !== 0) return 12;
          return 1;
        }
      `);
      expect(exports.test!()).toBe(1);
    });
  }
});
