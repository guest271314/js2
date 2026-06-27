// #2741 — `in` operator residual: non-object RHS TypeError + RHS/LHS evaluation
// order (ES2023 §13.10.1 `RelationalExpression : RelationalExpression in
// ShiftExpression`).
//
// TWO clean, spec-correct fixes (the rest of the issue's 7 fails are
// substrate/separate-bug blocked — see the issue file's residual breakdown):
//
//  (a) §13.10.1 step 5 — `key in rval` throws a **TypeError** when `Type(rval)`
//      is not Object. TypeScript hard-errors (TS2322) on a primitive RHS before
//      codegen, but `in` is a RUNTIME operation (test262 language/expressions/in
//      has no `negative` phase), so the 2322 on `in` operands is downgraded
//      (compiler.ts, mirroring the #2616 Proxy-trap downgrade) and the codegen
//      emits a runtime throw for an exclusively-primitive RHS.
//
//  (b) Evaluation order — §13.10.1 evaluates the LHS (key, steps 1-2) BEFORE the
//      RHS (object, steps 3-4). The `__extern_has` lowering evaluated the RHS
//      first; it now evaluates the key into a temp, then the object.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants, wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result: any = await compile(src, { fileName: "t.js" });
  expect(result.success).toBe(true);
  const importObject: any = { ...(result.importObject ?? {}) };
  // A module whose only host import is the string-constant pool gets an empty
  // `result.importObject` (the getter short-circuits when `result.imports` is
  // empty), so provision `string_constants` from the pool ourselves.
  if (!importObject.string_constants) {
    importObject.string_constants = buildStringConstants(result.stringPool ?? []);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#2741 — `in` operator: non-object RHS throws TypeError (§13.10.1 step 5)", () => {
  // S11.8.7_A3.js
  it("`key in boolean` throws TypeError", async () => {
    const exp = await run(
      `export function test(){ try { ("toString" in true); return 0; } catch(e){ return (e instanceof TypeError)?1:2; } }`,
    );
    expect(exp.test()).toBe(1);
  });

  it("`key in number` throws TypeError", async () => {
    const exp = await run(
      `export function test(){ try { ("MAX_VALUE" in 1); return 0; } catch(e){ return (e instanceof TypeError)?1:2; } }`,
    );
    expect(exp.test()).toBe(1);
  });

  it("`key in string` throws TypeError", async () => {
    const exp = await run(
      `export function test(){ try { ("length" in "string"); return 0; } catch(e){ return (e instanceof TypeError)?1:2; } }`,
    );
    expect(exp.test()).toBe(1);
  });

  it("`key in undefined` throws TypeError", async () => {
    const exp = await run(
      `export function test(){ try { ("x" in undefined); return 0; } catch(e){ return (e instanceof TypeError)?1:2; } }`,
    );
    expect(exp.test()).toBe(1);
  });

  it("`key in null` throws TypeError", async () => {
    const exp = await run(
      `export function test(){ try { ("x" in null); return 0; } catch(e){ return (e instanceof TypeError)?1:2; } }`,
    );
    expect(exp.test()).toBe(1);
  });

  it("an object RHS does NOT throw (regression guard — proto-chain HasProperty)", async () => {
    const exp = await run(
      `export function test(){ var o = { a: 1 }; return ("a" in o) && ("valueOf" in o) && !("zzz" in o) ? 1 : 0; }`,
    );
    expect(exp.test()).toBe(1);
  });
});

describe("#2741 — `in` operator: evaluation order (LHS key before RHS object)", () => {
  // S11.8.7_A2.4_T2 — `x() in y()` evaluates x() first, so it throws "x".
  it("LHS is evaluated before RHS (`x() in y()` throws from x())", async () => {
    const exp = await run(`export function test(){
      var x = function(){ throw "x"; };
      var y = function(){ throw "y"; };
      try { (x() in y()); return 0; }
      catch(e){ return e === "x" ? 1 : (e === "y" ? 2 : 3); }
    }`);
    expect(exp.test()).toBe(1);
  });

  // S11.8.7_A2.4_T3 — the LHS reference is resolved first; an unresolvable LHS
  // identifier throws ReferenceError BEFORE the RHS (which would otherwise define
  // it via the comma assignment) runs.
  it("unresolvable LHS identifier throws ReferenceError before RHS runs", async () => {
    const exp = await run(`export function test(){
      try { (max_value in (max_value = "MAX_VALUE", Number)); return 0; }
      catch(e){ return (e instanceof ReferenceError) ? 1 : (e instanceof TypeError ? 3 : 2); }
    }`);
    expect(exp.test()).toBe(1);
  });
});

describe("#2741 — `in` operator: hardening (no malformed module for non-string keys)", () => {
  // A value-typed key (number/boolean) on a struct receiver must not feed a
  // malformed `__str_eq` (which previously produced an invalid module). It now
  // yields a defined boolean result instead of failing wasm validation.
  it("a numeric key on an object compiles to a valid module", async () => {
    const exp = await run(
      `export function test(){ var o = {}; o.foo = 1; var present = (0 in o); return (present === true || present === false) ? 1 : 0; }`,
    );
    expect(exp.test()).toBe(1);
  });

  it("a boolean/null key on a dynamic object round-trips (key ToString)", async () => {
    const exp = await run(
      `export function test(){ var o = {}; o["true"] = 1; o["null"] = 1; return ((true in o) === ("true" in o)) && ((null in o) === ("null" in o)) ? 1 : 0; }`,
    );
    expect(exp.test()).toBe(1);
  });
});
