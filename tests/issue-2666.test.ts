// #2666 — `base[prop]` evaluation order in compound assignment: ToPropertyKey
// applied EXACTLY ONCE for a read-modify-write.
//
// For `o[key] op= rhs` with a computed, side-effecting key, ECMAScript evaluates
// the LHS Reference once (§13.15.2) → the key's ToPropertyKey (§7.1.19) fires
// once. The compiler used to pass the raw key object to both __extern_get and
// __extern_set (each ToPropertyKeys internally), firing `key.toString` twice and
// producing the wrong value. The fix coerces the key once (the new
// __to_property_key host import / native helper) and reuses the primitive for
// both the read and the write.
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

describe("#2666 — base[prop] compound-assign ToPropertyKey once + eval order", () => {
  it("a side-effecting computed key is ToPropertyKey'd exactly ONCE", async () => {
    const exp = await run(
      `var n = 0; var o: any = { x: 1 };
       var key = { toString() { n++; return "x"; } };
       o[key] += 10;
       return n;`,
    );
    expect(exp.test()).toBe(1); // was 2 (read + write both coerced)
  });

  it("the compound write through a computed key produces the correct value", async () => {
    const exp = await run(
      `var o: any = { x: 1 }; var key = { toString() { return "x"; } };
       o[key] += 10; return o.x;`,
    );
    expect(exp.test()).toBe(11); // was null (broken)
  });

  it("base, prop, rhs are evaluated left-to-right (base before prop before rhs)", async () => {
    const exp = await run(
      `var log = ""; var o: any = { x: 0 };
       function B() { log += "B"; return o; }
       function K() { log += "K"; return "x"; }
       function R() { log += "R"; return 3; }
       B()[K()] += R(); return log;`,
    );
    expect(exp.test()).toBe("BKR");
  });

  it("the computed-key compound op computes on the current value (+=)", async () => {
    const exp = await run(
      `var o: any = { n: 4 }; var key = { toString() { return "n"; } };
       o[key] += 6; return o.n;`,
    );
    expect(exp.test()).toBe(10);
  });

  it("a string-literal / string-variable key still works (no regression)", async () => {
    const exp1 = await run(`var o: any = { x: 1 }; o["x"] += 10; return o.x;`);
    expect(exp1.test()).toBe(11);
    const exp2 = await run(`var o: any = { x: 1 }; var k = "x"; o[k] += 10; return o.x;`);
    expect(exp2.test()).toBe(11);
  });

  it("array index compound assignment still works (no regression)", async () => {
    const exp = await run(`var a = [10]; a[0] += 5; return a[0];`);
    expect(exp.test()).toBe(15);
  });

  it("a numeric-key compound coerces the key once to its string form", async () => {
    const exp = await run(
      `var n = 0; var o: any = { "1": 7 };
       var key = { toString() { n++; return "1"; } };
       o[key] += 3;
       return n * 100 + o["1"];`,
    );
    // toString once (n=1) → 100 + 10 = 110.
    expect(exp.test()).toBe(110);
  });
});
