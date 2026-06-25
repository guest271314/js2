// #2679 — ToPrimitive/ToNumber must invoke valueOf / toString / @@toPrimitive
// with the RECEIVER as `this` (§7.1.1.1 OrdinaryToPrimitive step 4.b
// `Call(method, O)`).
//
// The host coercion funnel (_toPrimitive / _hostToPrimitive in runtime.ts)
// dispatched a compiled method closure via __call_fn_0 / __call_valueOf without
// installing __current_this, so a compiled `valueOf(){…this…}` saw a stale
// receiver. Fix: thread the receiver via the __call_fn_method_0/_1 callers and
// install __current_this around the __call_valueOf / __call_toString dispatch.
//
// PARTIAL (this PR): the STRING-hint path (toString / String(x) / template) and
// @@toPrimitive now bind `this` correctly. The NUMBER/default-hint valueOf path
// (`+a`, `Number(a)`, `a*1`) still binds the wrong `this` — tracked as the
// residual in #2679 (bottoms out in the deeper __current_this / object-literal
// method-this machinery).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(body: string): Promise<any> {
  const src = `export function test(): any { ${body} }`;
  const result: any = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#2679 — ToPrimitive binds `this` to the receiver (string hint + @@toPrimitive)", () => {
  it("`'' + a` calls toString with this === a", async () => {
    const exp = await run(
      `var tv; var a = { toString() { tv = this; return "x"; } }; var s = "" + a; return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("String(a) calls toString with this === a", async () => {
    const exp = await run(
      `var tv; var a = { toString() { tv = this; return "x"; } }; var s = String(a); return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("@@toPrimitive is called with this === a", async () => {
    const exp = await run(
      `var tv; var a = { [Symbol.toPrimitive](h) { tv = this; return 5; } }; var x = +a; return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("toString still returns the correct value (no regression)", async () => {
    const exp = await run(`var a = { toString() { return "hi"; } }; return "" + a;`);
    expect(exp.test()).toBe("hi");
  });

  it("valueOf still returns the correct value (number coercion unaffected)", async () => {
    const exp = await run(`var a = { valueOf() { return 7; } }; return +a;`);
    expect(exp.test()).toBe(7);
  });
});
