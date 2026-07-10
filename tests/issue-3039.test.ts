import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #3039 — object/class method shorthand, class methods, and class get/set
// accessors that read or WRITE a variable captured *transitively* from a
// grandparent scope emitted garbage when that variable was BOXED (a sibling
// closure mutates it → it lives in a ref cell). The accessor/method body
// promoted the box into a captured global but never deref'd it. Fixed by
// registering such captures in ctx.capturedBoxGlobals (with the inner valType)
// and dereffing at the read/write sites.
//
// These cases are all validated WITHOUT #2664: they are direct capture
// read/writes, not iterator-close (which needs #2664's runtime exposure — see
// #3038's it.skip and the full-stack 12/12 iter-close win).
async function run(src: string): Promise<unknown> {
  const result = await compile(src);
  if (!result.success) {
    throw new Error("Compile failed: " + result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n"));
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as never);
  (imports as { setExports?: (e: object) => void }).setExports?.(instance.exports as object);
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("#3039 — boxed transitively-captured var read/write in method/accessor bodies", () => {
  it("transitive object-literal METHOD write reaches the boxed captured var", async () => {
    expect(
      await run(`export function test(): number {
        let c = 0;
        const make = function () { return { bump() { c += 1; } }; };
        const o: any = make(); o.bump(); o.bump();
        return c;
      }`),
    ).toBe(2);
  });

  it("transitive CLASS METHOD write reaches the boxed captured var", async () => {
    expect(
      await run(`export function test(): number {
        let c = 0;
        const make = function () { class K { bump() { c += 1; } } return new K(); };
        const o: any = make(); o.bump(); o.bump();
        return c;
      }`),
    ).toBe(2);
  });

  it("fn-expr-property writer stays correct (control)", async () => {
    expect(
      await run(`export function test(): number {
        let c = 0;
        const make = function () { return { bump: function () { c += 1; } }; };
        const o: any = make(); o.bump(); o.bump();
        return c;
      }`),
    ).toBe(2);
  });

  it("object-literal method POSTFIX c++ writes through the box", async () => {
    expect(
      await run(`export function test(): number {
        let c = 0;
        const make = function () { return { bump() { c++; } }; };
        const o: any = make(); o.bump(); o.bump();
        return c;
      }`),
    ).toBe(2);
  });

  it("class method PREFIX --c writes through the box and returns the new value", async () => {
    expect(
      await run(`export function test(): number {
        let c = 0;
        const make = function () { class K { bump(): number { return --c; } } return new K(); };
        const o: any = make(); o.bump(); return o.bump();
      }`),
    ).toBe(-2);
  });

  it("boxed-capture getter READ derefs the box (static dispatch)", async () => {
    expect(
      await run(`
        let c = 0;
        const bumper = function () { c += 5; };
        class K { get v(): number { return c; } }
        export function test(): number { const o = new K(); bumper(); return o.v; }`),
    ).toBe(5);
  });

  it("boxed-capture class method READ derefs the box (via any receiver)", async () => {
    expect(
      await run(`export function test(): number {
        let c = 0;
        const bumper = function () { c += 5; };
        const make = function () { class K { v(): number { return c; } } return new K(); };
        const o: any = make(); bumper(); return o.v();
      }`),
    ).toBe(5);
  });
});
