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

// RESIDUAL (this PR): the NUMBER/default-hint `valueOf` path. `+a` / `Number(a)`
// / `a*1` etc. lower to an inline ToNumber dispatch in coerceType (ref→f64) that
// `call_ref`s the method's `__obj_meth_tramp_*` trampoline. That trampoline reads
// `this` from the `__current_this` module global (param-0 is the closure
// self/env, not the receiver), but the inline dispatch never installed
// `__current_this`, so `valueOf(){…this…}` saw a stale receiver. Fix: install
// `__current_this` = receiver around the dispatch (§7.1.1.1 step 4.b
// `Call(method, O)`) and restore it afterward (nesting-safe).
describe("#2679 — ToNumber binds `this` to the receiver (number/default hint valueOf)", () => {
  it("`+a` calls valueOf with this === a", async () => {
    const exp = await run(
      `var tv; var a = { valueOf() { tv = this; return 5; } }; var x = +a; return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("Number(a) calls valueOf with this === a", async () => {
    const exp = await run(
      `var tv; var a = { valueOf() { tv = this; return 5; } }; var x = Number(a); return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("`a * 1` calls valueOf with this === a", async () => {
    const exp = await run(
      `var tv; var a = { valueOf() { tv = this; return 5; } }; var x = a * 1; return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("`a - 1` calls valueOf with this === a", async () => {
    const exp = await run(
      `var tv; var a = { valueOf() { tv = this; return 5; } }; var x = a - 1; return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("relational `a < b` binds this on BOTH operands (no leakage)", async () => {
    const exp = await run(
      `var ta, tb; var a = { valueOf() { ta = this; return 1; } }; var b = { valueOf() { tb = this; return 2; } }; var x = a < b; return ta === a && tb === b ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("nested `a * b` binds this on both operands and returns the product", async () => {
    const exp = await run(
      `var ta, tb; var a = { valueOf() { ta = this; return 3; } }; var b = { valueOf() { tb = this; return 4; } }; var x = a * b; return ta === a && tb === b && x === 12 ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("valueOf via function-expression also binds this === a", async () => {
    const exp = await run(
      `var tv; var a = { valueOf: function () { tv = this; return 5; } }; var x = +a; return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("number-hint valueOf still returns the correct value", async () => {
    const exp = await run(`var a = { valueOf() { return 9; } }; return a * 1;`);
    expect(exp.test()).toBe(9);
  });

  it("Date.prototype.setSeconds ToNumbers its arg with this === a (#2671 cluster)", async () => {
    const exp = await run(
      `var tv; var a = { valueOf() { tv = this; return 30; } }; var d = new Date(2016, 6, 1); d.setSeconds(a); return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });
});
