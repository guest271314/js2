// #742 — extract early-guard handlers from compileCallExpression into
// calls-guards.ts. These tests pin the behaviour of the extracted guards
// (namespace-non-callable, Object(x) coercion, RegExp(...) constructor) so the
// decomposition stays behaviour-preserving: the wasm output must match JS.
//
// Functions return numbers (not bare booleans) because assertEquivalent does a
// strict `toBe`, and a wasm boolean export is an i32 (1/0) while JS returns
// true/false. Mapping booleans through `? 1 : 0` keeps the comparison clean.
import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("#742 compileCallExpression guard extraction", () => {
  it("Math()/JSON() as a function throw TypeError (namespace non-callable)", async () => {
    await assertEquivalent(
      `export function mathCall(): number { try { (Math as any)(); return 0; } catch { return 1; } }
       export function jsonCall(): number { try { (JSON as any)(); return 0; } catch { return 1; } }`,
      [
        { fn: "mathCall", args: [] },
        { fn: "jsonCall", args: [] },
      ],
    );
  });

  it("Object(x) coercion matches JS", async () => {
    await assertEquivalent(
      `export function boxNumber(): number { const o = Object(42) as any; return o.valueOf(); }
       export function boxFresh(): number { return Object() ? 1 : 0; }
       export function boxNullFresh(): number { return Object(null) ? 1 : 0; }`,
      [
        { fn: "boxNumber", args: [] },
        { fn: "boxFresh", args: [] },
        { fn: "boxNullFresh", args: [] },
      ],
    );
  });

  it("RegExp(pattern) without new matches a literal regex", async () => {
    await assertEquivalent(
      `export function reMatch(): number { return RegExp("a.c").test("axc") ? 1 : 0; }
       export function reNoMatch(): number { return RegExp("a.c").test("zzz") ? 1 : 0; }`,
      [
        { fn: "reMatch", args: [] },
        { fn: "reNoMatch", args: [] },
      ],
    );
  });
});

// Step 2 (#742 Wave B): the identifier-callee dispatch family — global builtins
// (parseInt / parseFloat / isNaN / isFinite), Array(...) as a call, and direct
// named-function calls — was moved verbatim out of compileCallExpression into
// the sibling module call-identifier.ts (compileIdentifierCall). These tests
// pin the behaviour of those moved paths so the relocation stays
// behaviour-preserving (wasm output must match JS).
describe("#742 identifier-callee dispatch (compileIdentifierCall)", () => {
  it("global numeric builtins: parseInt / parseFloat / isNaN / isFinite", async () => {
    await assertEquivalent(
      `export function pi(): number { return parseInt("42px", 10); }
       export function piHex(): number { return parseInt("0x1F", 16); }
       export function pf(): number { return parseFloat("3.14abc"); }
       export function nan(): number { return isNaN(0 / 0) ? 1 : 0; }
       export function finite(): number { return isFinite(1e300 * 1e300) ? 1 : 0; }`,
      [
        { fn: "pi", args: [] },
        { fn: "piHex", args: [] },
        { fn: "pf", args: [] },
        { fn: "nan", args: [] },
        { fn: "finite", args: [] },
      ],
    );
  });

  it("Array(...) as a call — length form and element form", async () => {
    await assertEquivalent(
      `export function arrLen(): number { const a = Array(5) as number[]; return a.length; }
       export function arrElems(): number { const a = Array(3, 7, 9) as number[]; return a[0] + a[1] + a[2]; }`,
      [
        { fn: "arrLen", args: [] },
        { fn: "arrElems", args: [] },
      ],
    );
  });

  it("direct named-function call resolves through funcMap", async () => {
    await assertEquivalent(
      `function add(a: number, b: number): number { return a + b; }
       function fib(n: number): number { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
       export function callAdd(): number { return add(3, 4); }
       export function callFib(): number { return fib(10); }`,
      [
        { fn: "callAdd", args: [] },
        { fn: "callFib", args: [] },
      ],
    );
  });
});
