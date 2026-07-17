// (#3333) standalone: whole-pattern param default OBJECT LITERAL never bound.
// For an `any`-typed object binding pattern no struct hint resolves
// (getTypeAtLocation(pattern) is `any`), so the default literal compiled
// against the bare externref hint into a typed ANONYMOUS struct (f64 fields,
// extern.convert_any-boxed) that the destructure's dynamic `__extern_get`
// reader cannot reflect — every binding read NaN. Fix: on host-free lanes,
// materialize such defaults via compileObjectLiteralAsExternref (the
// `__new_plain_object` dynamic carrier), at BOTH the function-declaration
// site (function-body.ts) and the closure site (closures.ts).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const mod = await WebAssembly.compile(r.binary!);
  const envImports = WebAssembly.Module.imports(mod).filter((i) => i.module === "env");
  expect(envImports, "must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#3333 standalone pattern-param default literal", () => {
  it("function EXPRESSION: `{a,b}: any = {a:5,b:3}` binds when the default fires", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  let got = -1;
  const f = function({a, b}: any = {a: 5, b: 3}) { got = (a === 5 && b === 3) ? 1 : 0; };
  f();
  return got;
}
`),
    ).toBe(1);
  });

  it("function DECLARATION form, with ...rest exclusion", async () => {
    expect(
      await runStandalone(`
function f({a, b, ...rest}: any = {x: 1, a: 5, b: 3}): number {
  return (a === 5 && rest.a === undefined && rest.x === 1) ? 1 : 0;
}
export function test(): number { return f(); }
`),
    ).toBe(1);
  });

  it("explicit undefined arg also takes the default", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  let got = -1;
  const f = function({a, b}: any = {a: 5, b: 3}) { got = (a === 5 && b === 3) ? 1 : 0; };
  f(undefined);
  return got;
}
`),
    ).toBe(1);
  });

  it("controls stay green: passed arg, module-var default, ident-param default", async () => {
    expect(
      await runStandalone(`
const D: any = {a: 7};
export function test(): number {
  let n = 0;
  const f1 = function({a, ...rest}: any = {z: 9}) { n = n + ((a === 5 && rest.x === 1) ? 1 : 0); };
  f1({x: 1, a: 5});
  const f2 = function({a}: any = D) { n = n + ((a === 7) ? 10 : 0); };
  f2();
  const f3 = function(o: any = {a: 3}) { n = n + ((o.a === 3) ? 100 : 0); };
  f3();
  return n;
}
`),
    ).toBe(111);
  });
});
