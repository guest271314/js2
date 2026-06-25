// #2675 — `obj[keyExpr]++` / `--obj[keyExpr]` on an object element.
//
// Carved from #2666 (which fixed the compound-assignment half). The prefix/
// postfix ++/-- half on a computed/dynamic OBJECT key (`o:any`/externref base)
// hit the externref element arm in `compileMemberIncDec`, which dropped the
// write and returned NaN — so `o[k]++` left `o.x` unchanged and returned the
// wrong value. The fix routes the externref element arm through a real
// read-modify-write (`emitExternrefElementIncDec`) mirroring the working
// compound path `o[k] += 1`: read via __extern_get, unbox, ±1, box, write back
// via the #2659 symmetric struct.set dispatch (static literal key) or
// __extern_set (dynamic key), with ToPropertyKey fired ONCE (§7.1.19) and §13.4
// prefix(new)/postfix(old) return semantics.
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

describe("#2675 — obj[key]++ / --obj[key] on object elements", () => {
  it("postfix ++ with a variable key updates the slot", async () => {
    const exp = await run(`var o: any = { x: 5 }; var k = "x"; o[k]++; return o.x;`);
    expect(exp.test()).toBe(6);
  });

  it("postfix ++ with a string-literal key updates the slot", async () => {
    const exp = await run(`var o: any = { x: 5 }; o["x"]++; return o.x;`);
    expect(exp.test()).toBe(6);
  });

  it("prefix ++ updates the slot", async () => {
    const exp = await run(`var o: any = { x: 5 }; var k = "x"; ++o[k]; return o.x;`);
    expect(exp.test()).toBe(6);
  });

  it("postfix ++ returns the OLD value (§13.4)", async () => {
    const exp = await run(`var o: any = { x: 5 }; var k = "x"; var r = o[k]++; return r;`);
    expect(exp.test()).toBe(5);
  });

  it("prefix ++ returns the NEW value (§13.4)", async () => {
    const exp = await run(`var o: any = { x: 5 }; var k = "x"; var r = ++o[k]; return r;`);
    expect(exp.test()).toBe(6);
  });

  it("postfix -- decrements and returns the old value", async () => {
    const exp = await run(`var o: any = { x: 5 }; var k = "x"; var r = o[k]--; return r === 5 && o.x === 4 ? 1 : 0;`);
    expect(exp.test()).toBe(1);
  });

  it("prefix -- decrements the slot", async () => {
    const exp = await run(`var o: any = { x: 5 }; var k = "x"; --o[k]; return o.x;`);
    expect(exp.test()).toBe(4);
  });

  it("a side-effecting {toString} key has ToPropertyKey fire exactly once", async () => {
    const exp = await run(
      `var n = 0; var key: any = { toString() { n++; return "x"; } }; var o: any = { x: 5 }; o[key]++; return n;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("a {toString} key updates the resolved property", async () => {
    const exp = await run(
      `var key: any = { toString() { return "x"; } }; var o: any = { x: 5 }; o[key]++; return o.x;`,
    );
    expect(exp.test()).toBe(6);
  });

  it("a string-valued property is ToNumber-coerced before ±1", async () => {
    const exp = await run(`var o: any = { x: "5" }; var k = "x"; o[k]++; return o.x;`);
    expect(exp.test()).toBe(6);
  });

  it("repeated ++ accumulate", async () => {
    const exp = await run(`var o: any = { x: 5 }; var k = "x"; o[k]++; o[k]++; return o.x;`);
    expect(exp.test()).toBe(7);
  });

  it("nested obj[a][b]++ updates the inner slot", async () => {
    const exp = await run(
      `var o: any = { inner: { x: 5 } }; var a = "inner"; var b = "x"; o[a][b]++; return o.inner.x;`,
    );
    expect(exp.test()).toBe(6);
  });

  it("compound element assignment still works (no regression)", async () => {
    const exp = await run(`var o: any = { x: 5 }; var k = "x"; o[k] += 10; return o.x;`);
    expect(exp.test()).toBe(15);
  });

  it("array element arr[i]++ still works (no regression)", async () => {
    const exp = await run(`var a = [5]; var i = 0; a[i]++; return a[i];`);
    expect(exp.test()).toBe(6);
  });

  it("member name o.prop++ still works (no regression)", async () => {
    const exp = await run(`var o: any = { x: 5 }; o.x++; return o.x;`);
    expect(exp.test()).toBe(6);
  });
});
