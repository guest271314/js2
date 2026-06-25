// #2663 Slice 1 — `with` statement Tier 2: dynamic-scope READ.
//
// Tier 1 (#1387) only handles `with(target)` when `target` is a statically
// closed object literal. Tier 2 adds the dynamic case — `with(variable)`,
// `with(fn())`, etc. — where a bare identifier inside the block is resolved at
// runtime: HasBinding (value-independent `__extern_has`, own+proto) gates a
// `Get` (`emitDynGet`, the #2580 substrate); absent ⇒ fall through to the outer
// (next `with`, then lexical) binding. §14.11 / §9.1.1.2.
//
// Slice 1 is READ-only: writes/compound/inc-dec/typeof/delete and @@unscopables
// are later slices. A body with a nested function/class boundary is still
// rejected (the closure can't capture the object environment yet).
//
// These tests compile with `inferModuleStrictArguments: false` + the runner's
// `skipSemanticDiagnostics: true` — `with` is sloppy-only, and the TS frontend
// already de-stricts it under skipSemanticDiagnostics (see the #2663 Slice-0
// audit: 0 with-tests are TS1101-blocked; the real gate was codegen, fixed here).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(body: string): Promise<any> {
  const src = `export function test(): any { ${body} }`;
  const result: any = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#2663 Slice 1 — dynamic with READ", () => {
  it("reads a present property off a non-literal `with` target (variable)", async () => {
    const exp = await run(`var o = { x: 42 }; var r; with (o) { r = x; } return r;`);
    expect(exp.test()).toBe(42);
  });

  it("falls through to the outer lexical binding when the property is absent", async () => {
    const exp = await run(`var x = 7; var o = { y: 1 }; var r; with (o) { r = x; } return r;`);
    expect(exp.test()).toBe(7);
  });

  it("nested with: a name absent on the inner object cascades to the outer with", async () => {
    const exp = await run(`var a = { p: 1 }; var b = { q: 2 }; var r; with (a) { with (b) { r = p; } } return r;`);
    expect(exp.test()).toBe(1);
  });

  it("nested with: inner object shadows the outer for a shared name", async () => {
    const exp = await run(`var a = { v: 1 }; var b = { v: 2 }; var r; with (a) { with (b) { r = v; } } return r;`);
    expect(exp.test()).toBe(2);
  });

  it("a body-declared lexical (let) shadows the with object's property", async () => {
    const exp = await run(`var o = { x: 99 }; var r; with (o) { let x = 5; r = x; } return r;`);
    expect(exp.test()).toBe(5);
  });

  it("the `with` target is computed by a call expression", async () => {
    const exp = await run(`function mk() { return { z: 11 }; } var r; with (mk()) { r = z; } return r;`);
    expect(exp.test()).toBe(11);
  });

  it("absent on object, absent in scope → cascades to a true outer global read", async () => {
    const exp = await run(
      `var g = 3; function inner() { var o = { nope: 0 }; var r; with (o) { r = g; } return r; } return inner();`,
    );
    expect(exp.test()).toBe(3);
  });

  it("Tier-1 static closed-literal `with` read still works (no regression)", async () => {
    const exp = await run(`var r; with ({ a: 5 }) { r = a; } return r;`);
    expect(exp.test()).toBe(5);
  });

  it("Tier-1 static closed-literal `with` write still works (no regression)", async () => {
    const exp = await run(`var o2; with ({ a: 0 }) { a = 9; o2 = a; } return o2;`);
    expect(exp.test()).toBe(9);
  });

  it("ToObject(undefined) throws a TypeError (§14.11.7)", async () => {
    const exp = await run(
      `var u; var threw = 0; try { with (u) { var z = 1; } } catch (e) { threw = 1; } return threw;`,
    );
    // u is undefined → entering the with must throw; caught → threw === 1.
    expect(exp.test()).toBe(1);
  });
});

describe("#2663 Slice 2 — dynamic with WRITE", () => {
  it("writes a present property through the with object", async () => {
    const exp = await run(`var o = { x: 1 }; with (o) { x = 9; } return o.x;`);
    expect(exp.test()).toBe(9);
  });

  it("an assignment expression in a with yields the RHS value", async () => {
    const exp = await run(`var o = { x: 1 }; var r; with (o) { r = (x = 5); } return r;`);
    expect(exp.test()).toBe(5);
  });

  it("an absent name writes the outer binding, not the object", async () => {
    // "x" must NOT become an own key of o (HasBinding miss → outer var write).
    const exp = await run(`var x = 1; var o = { y: 0 }; with (o) { x = 7; } return (("x" in o) ? 0 : x);`);
    expect(exp.test()).toBe(7);
  });

  it("nested write cascades to the outer with object", async () => {
    const exp = await run(`var a = { p: 1 }; var b = { q: 2 }; with (a) { with (b) { p = 8; } } return a.p;`);
    expect(exp.test()).toBe(8);
  });

  it("the RHS is evaluated exactly once", async () => {
    const exp = await run(
      `var n = 0; function inc() { n = n + 1; return n; } var o = { x: 0 }; with (o) { x = inc(); } return n;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("inner-object write shadows the outer for a shared name", async () => {
    const exp = await run(
      `var a = { v: 1 }; var b = { v: 2 }; with (a) { with (b) { v = 9; } } return a.v * 10 + b.v;`,
    );
    // a.v stays 1 (inner b shadows), b.v becomes 9 → 1*10 + 9 = 19.
    expect(exp.test()).toBe(19);
  });
});
