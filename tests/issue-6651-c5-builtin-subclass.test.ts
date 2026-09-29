// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 lane C5 — subclassing built-in constructors.
 *
 * Each `describe` pins one mechanism, red on the base tree, plus a GUARD for
 * the neighbouring behaviour that must not move:
 *
 *  1. Promise — §27.2.3.1 step 2: a non-callable executor throws a TypeError
 *     before the promise exists. The standalone executor-VALUE lowering (which
 *     the implicit `constructor(...args) { super(...args) }` of `class P
 *     extends Promise {}` uses) dispatched a non-callable through
 *     `__apply_closure` instead, so `new P()` completed normally.
 *  2. Proxy — §15.7.14 step 5.g.ii: `%Proxy%` has no `prototype`, so
 *     `class P extends Proxy {}` throws at definition time. Both lanes.
 *  3. Symbol — §20.4.1.1 step 1: `super()` into `%Symbol%` has a NewTarget and
 *     throws. The class DEFINITION is legal. Both lanes.
 *  4. Number/Boolean/String — the standalone wrapper carrier honours its
 *     argument, and an INHERITED builtin method on a subclass-typed receiver
 *     dispatches as on the parent (see `builtin-subclass-receiver.ts`).
 *
 * test262 rows (2026-09-29, `--isolate`, QuickJS eval): standalone
 * `class/subclass/builtin-objects/{Promise,Proxy,Symbol,Number,Boolean,String}`
 * regular-subclassing / no-prototype-throws / new-symbol-with-super-throws —
 * 0/6 → 6/6; host `Proxy` + `Symbol` 0/2 → 2/2.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Target = "host" | "standalone";

/** Compile a JS module whose `test()` returns a number, run it, return it. */
async function run(source: string, target: Target): Promise<number> {
  const options: Record<string, unknown> = { fileName: "test.js", allowJs: true, skipSemanticDiagnostics: true };
  if (target === "standalone") options.target = "standalone";
  const result = await compile(source, options as never);
  expect(
    result.success,
    `[${target}] compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  if (target === "standalone") expect(result.imports, "[standalone] host imports").toEqual([]);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  imports.setInstance?.(instance);
  const test = (instance.exports as Record<string, () => number>).test;
  expect(test, `[${target}] module has no \`test\` export`).toBeTypeOf("function");
  return Number(test());
}

/** `1` when `f()` throws a TypeError, `0` when it completes, `2` for another throw. */
const THROWS_TYPE_ERROR = `function throwsTypeError(f) {
  try { f(); } catch (e) { return e instanceof TypeError ? 1 : 2; }
  return 0;
}`;

describe("#6651 C5 — Promise subclass: a non-callable executor throws (§27.2.3.1 step 2)", () => {
  const decl = `class P extends Promise {}
${THROWS_TYPE_ERROR}`;

  it("[standalone] `new P()` throws a TypeError", async () => {
    const src = `${decl}
export function test() { return throwsTypeError(function () { new P(); }); }`;
    expect(await run(src, "standalone")).toBe(1);
  });

  it("[standalone] GUARD: a callable executor still runs, with (resolve, reject)", async () => {
    const src = `${decl}
var n = -1, kinds = "";
export function test() {
  new P(function (a, b) { n = arguments.length; kinds = typeof a + typeof b; });
  return n === 2 && kinds === "functionfunction" ? 1 : 0;
}`;
    expect(await run(src, "standalone")).toBe(1);
  });
});

describe("#6651 C5 — `class P extends Proxy {}` throws at definition (§15.7.14 step 5.g.ii)", () => {
  for (const target of ["host", "standalone"] as Target[]) {
    it(`[${target}] the definition throws a TypeError`, async () => {
      const src = `${THROWS_TYPE_ERROR}
export function test() { return throwsTypeError(function () { class P extends Proxy {} }); }`;
      expect(await run(src, target)).toBe(1);
    });

    it(`[${target}] GUARD: \`extends Object\` still defines normally`, async () => {
      const src = `${THROWS_TYPE_ERROR}
export function test() { return throwsTypeError(function () { class O extends Object {} }); }`;
      expect(await run(src, target)).toBe(0);
    });
  }
});

describe("#6651 C5 — Symbol subclass: construction throws (§20.4.1.1 step 1)", () => {
  const decl = `class S1 extends Symbol {}
class S2 extends Symbol { constructor() { super(); } }
${THROWS_TYPE_ERROR}`;
  for (const target of ["host", "standalone"] as Target[]) {
    it(`[${target}] implicit and explicit super() both throw a TypeError`, async () => {
      const src = `${decl}
export function test() {
  return throwsTypeError(function () { new S1(); }) * 10 + throwsTypeError(function () { new S2(); });
}`;
      expect(await run(src, target)).toBe(11);
    });

    it(`[${target}] GUARD: the class definition itself is legal`, async () => {
      const src = `${THROWS_TYPE_ERROR}
export function test() { return throwsTypeError(function () { class S extends Symbol {} }); }`;
      expect(await run(src, target)).toBe(0);
    });
  }
});

describe("#6651 C5 — Number/Boolean/String subclass carriers and inherited methods (standalone)", () => {
  it("Number: the argument is the [[NumberData]]; toFixed / toExponential dispatch as on Number", async () => {
    const src = `class N extends Number {}
export function test() {
  var n = new N(42), z = new N();
  var ok = n.valueOf() === 42 && z.valueOf() === 0;
  ok = ok && n.toFixed(2) === "42.00" && n.toExponential(2) === "4.20e+1";
  return ok ? 1 : 0;
}`;
    expect(await run(src, "standalone")).toBe(1);
  });

  it("Boolean: the argument is the [[BooleanData]]", async () => {
    const src = `class B extends Boolean {}
export function test() {
  var t = new B(1), f = new B(0);
  return t.valueOf() === true && f.valueOf() === false && t !== true ? 1 : 0;
}`;
    expect(await run(src, "standalone")).toBe(1);
  });

  it("String: an inherited method reads the wrapped string", async () => {
    const src = `class S extends String {}
export function test() { var s = new S(" test262 "); return s.trim() === "test262" ? 1 : 0; }`;
    expect(await run(src, "standalone")).toBe(1);
  });

  it("GUARD: a user override on the subclass still wins over the inherited builtin", async () => {
    const src = `class N extends Number { toFixed() { return "own"; } }
export function test() { var n = new N(1); return n.toFixed(3) === "own" ? 1 : 0; }`;
    expect(await run(src, "standalone")).toBe(1);
  });
});
