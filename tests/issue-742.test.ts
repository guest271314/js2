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

// Slice 2 (#742 Wave B): the built-in static-method dispatch block — Math /
// BigInt / Number / Array / String / Object namespace statics — was moved
// verbatim out of compileCallExpression's property-access arm into the sibling
// module call-builtin-static.ts (compileBuiltinStaticCall). These tests pin the
// behaviour of those moved static-call paths (wasm output must match JS).
describe("#742 built-in static-method dispatch (compileBuiltinStaticCall)", () => {
  it("Math.* statics", async () => {
    await assertEquivalent(
      `export function mx(): number { return Math.max(3, 7, 2); }
       export function mmin(): number { return Math.min(3, 7, 2); }
       export function mfloor(): number { return Math.floor(3.9); }
       export function mpow(): number { return Math.pow(2, 10); }`,
      [
        { fn: "mx", args: [] },
        { fn: "mmin", args: [] },
        { fn: "mfloor", args: [] },
        { fn: "mpow", args: [] },
      ],
    );
  });

  it("Number.* statics", async () => {
    await assertEquivalent(
      `export function nInt(): number { return Number.isInteger(4.0) ? 1 : 0; }
       export function nNotInt(): number { return Number.isInteger(4.5) ? 1 : 0; }
       export function nFin(): number { return Number.isFinite(1 / 3) ? 1 : 0; }
       export function nNaN(): number { return Number.isNaN(0 / 0) ? 1 : 0; }`,
      [
        { fn: "nInt", args: [] },
        { fn: "nNotInt", args: [] },
        { fn: "nFin", args: [] },
        { fn: "nNaN", args: [] },
      ],
    );
  });

  it("Array.of / Array.from and String.fromCharCode statics", async () => {
    await assertEquivalent(
      `export function aof(): number { const a = Array.of(5, 6, 7); return a[0] + a[1] + a[2]; }
       export function afrom(): number { const a = Array.from([1, 2, 3]); return a.length; }
       export function sfcc(): number { return String.fromCharCode(65) === "A" ? 1 : 0; }`,
      [
        { fn: "aof", args: [] },
        { fn: "afrom", args: [] },
        { fn: "sfcc", args: [] },
      ],
    );
  });

  it("Object.keys / Object.values statics", async () => {
    await assertEquivalent(
      `export function okeys(): number { const o = { a: 1, b: 2, c: 3 }; return Object.keys(o).length; }
       export function ovals(): number { const o = { a: 10, b: 20 }; const v = Object.values(o); return v[0] + v[1]; }`,
      [
        { fn: "okeys", args: [] },
        { fn: "ovals", args: [] },
      ],
    );
  });
});

// Slice 3 (#742 Wave B): the remaining namespace static-method dispatch —
// Symbol / Reflect / Promise / JSON / Date statics — was moved verbatim out of
// compileCallExpression's property-access arm into the sibling module
// call-namespace-static.ts (compileNamespaceStaticCall). These tests pin the
// behaviour of those moved static-call paths (wasm output must match JS).
describe("#742 namespace static dispatch (compileNamespaceStaticCall)", () => {
  it("Symbol.for returns the same registered symbol", async () => {
    await assertEquivalent(
      `export function symSame(): number { return Symbol.for("k") === Symbol.for("k") ? 1 : 0; }
       export function symDiff(): number { return Symbol.for("a") === Symbol.for("b") ? 1 : 0; }`,
      [
        { fn: "symSame", args: [] },
        { fn: "symDiff", args: [] },
      ],
    );
  });

  it("Date.UTC static computes a fixed epoch", async () => {
    await assertEquivalent(`export function dutc(): number { return Date.UTC(2000, 0, 1); }`, [
      { fn: "dutc", args: [] },
    ]);
  });
});

// Slice 4 (#742 Wave B): the receiver-type method dispatch — the receiverType-
// keyed tail of compileCallExpression's property-access arm (user-class instance
// methods, Number wrapper methods, valueOf/toString) — was moved verbatim into
// the sibling module call-receiver-method.ts (compileReceiverMethodCall). These
// tests pin the behaviour of those moved method-call paths (wasm ≡ JS).
describe("#742 receiver-type method dispatch (compileReceiverMethodCall)", () => {
  it("user-class instance method dispatch", async () => {
    await assertEquivalent(
      `class Adder { base: number; constructor(b: number) { this.base = b; } add(x: number): number { return this.base + x; } twice(x: number): number { return this.add(x) + this.add(x); } }
       export function m1(): number { const a = new Adder(10); return a.add(5); }
       export function m2(): number { const a = new Adder(3); return a.twice(4); }`,
      [
        { fn: "m1", args: [] },
        { fn: "m2", args: [] },
      ],
    );
  });

  it("Number wrapper methods: toFixed / toString(radix)", async () => {
    await assertEquivalent(
      `export function nfix(): number { return (3.14159).toFixed(2) === "3.14" ? 1 : 0; }
       export function nhex(): number { return (255).toString(16) === "ff" ? 1 : 0; }`,
      [
        { fn: "nfix", args: [] },
        { fn: "nhex", args: [] },
      ],
    );
  });
});

// Slice 5 (#742 Wave B): the tail dispatch of compileCallExpression — IIFE, super
// method calls, element-access method calls, call-of-call, conditional callee,
// and the graceful fallback — was moved verbatim into the sibling module
// call-tail-dispatch.ts (compileTailDispatch). These tests pin the behaviour of
// the moved tail paths (wasm ≡ JS).
describe("#742 tail dispatch (compileTailDispatch)", () => {
  it("IIFE forms — function-expression and arrow", async () => {
    await assertEquivalent(
      `export function iifeFn(): number { return (function () { return 21; })() * 2; }
       export function iifeArrow(): number { return ((x: number) => x + 1)(41); }`,
      [
        { fn: "iifeFn", args: [] },
        { fn: "iifeArrow", args: [] },
      ],
    );
  });

  it("super method call dispatches to the base class", async () => {
    await assertEquivalent(
      `class Base { greet(): number { return 10; } }
       class Derived extends Base { greet(): number { return super.greet() + 5; } }
       export function sup(): number { return new Derived().greet(); }`,
      [{ fn: "sup", args: [] }],
    );
  });
});
