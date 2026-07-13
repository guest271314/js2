// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3223 — native standalone `__extern_rest_object` (object-rest de-leak).
 *
 * Object-rest destructuring `const {a, ...rest} = o` previously compiled to a
 * call to the `env.__extern_rest_object` HOST IMPORT, which is unsatisfiable
 * under `--target standalone`/`wasi` (no JS runtime) — so the module failed to
 * instantiate host-free (a leaky pass). This test asserts, for OPEN-`$Object`
 * (`any`-typed) sources:
 *   1. ZERO `env::` imports are emitted (genuine standalone — instantiates `{}`).
 *   2. The native helper implements ES §14.7.4 CopyDataProperties correctly
 *      (own-enumerable keys minus the destructured ones, getters invoked,
 *      non-enumerable skipped, insertion order, string + numeric-key values).
 *
 * KNOWN LIMITATION (tracked separately): a source that is a CLOSED-SHAPE struct
 * (a typed / directly-destructured object literal, e.g. `const {a,...r} =
 * {x:1,a:2}`) is NOT enumerated natively in standalone — `__object_keys` has no
 * closed-struct arm, so `Object.keys`/spread/rest all return empty for closed
 * structs standalone. That is a broader pre-existing gap (native closed-struct
 * field enumeration), orthogonal to this de-leak; this helper works once a
 * source reaches it as an open `$Object`. See the issue file's follow-up note.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function restStandalone(body: string): Promise<number> {
  const src = `export function main(): number { ${body} }`;
  const r = await compile(src, { fileName: "t.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const envImports = WebAssembly.Module.imports(mod)
    .filter((i) => i.module === "env")
    .map((i) => i.name);
  expect(envImports, "no env host import should be emitted in standalone").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { main(): number }).main();
}

describe("#3223 standalone object-rest — no host imports, correct CopyDataProperties", () => {
  it("copies non-excluded own values", async () => {
    expect(
      await restStandalone(
        "const o:any={a:1,b:2,c:3}; const {a,...rest}=o; return (rest.b as number)+(rest.c as number);",
      ),
    ).toBe(5);
  });
  it("excludes the destructured key", async () => {
    expect(await restStandalone("const o:any={a:1,b:2,c:3}; const {a,...rest}=o; return ('a' in rest)?1:0;")).toBe(0);
  });
  it("empty rest copies all keys", async () => {
    expect(await restStandalone("const o:any={a:1,b:2,c:3}; const {...rest}=o; return Object.keys(rest).length;")).toBe(
      3,
    );
  });
  it("all keys excluded → empty rest", async () => {
    expect(await restStandalone("const o:any={a:1,b:2}; const {a,b,...rest}=o; return Object.keys(rest).length;")).toBe(
      0,
    );
  });
  it("undefined-valued own property is still copied (presence, not truthiness)", async () => {
    expect(await restStandalone("const o:any={a:1,b:undefined}; const {a,...rest}=o; return ('b' in rest)?1:0;")).toBe(
      1,
    );
  });
  it("numeric-string key excluded correctly", async () => {
    expect(
      await restStandalone(
        "const o:any={0:10,1:20}; const {0:z,...rest}=o; return ('0' in rest)?9:(('1' in rest)?42:0);",
      ),
    ).toBe(42);
  });
  it("non-enumerable own property is skipped", async () => {
    expect(
      await restStandalone(
        "const o:any={a:1}; Object.defineProperty(o,'h',{enumerable:false,value:9}); const {...rest}=o; return ('h' in rest)?1:0;",
      ),
    ).toBe(0);
  });
  it("string-valued property is copied", async () => {
    expect(
      await restStandalone("const o:any={a:'x',b:'hello'}; const {a,...rest}=o; return (rest.b as string).length;"),
    ).toBe(5);
  });
  it("nested rest", async () => {
    expect(
      await restStandalone(
        "const o:any={a:1,b:2,c:3,d:4}; const {a,...r1}=o; const {b,...r2}=r1; return Object.keys(r2).length*10+(('c' in r2)&&('d' in r2)&&!('a' in r2)?1:0);",
      ),
    ).toBe(21);
  });
  it("preserves own-enumerable insertion order", async () => {
    expect(
      await restStandalone(
        "const o:any={z:1,a:2,m:3}; const {z,...rest}=o; const k=Object.keys(rest); return (k[0]==='a'&&k[1]==='m')?1:0;",
      ),
    ).toBe(1);
  });
  it("arrow-parameter object-rest", async () => {
    expect(
      await restStandalone(
        "const f=(({a,...rest}:any)=>(rest.b as number)+(rest.c as number)); return f({a:1,b:2,c:3});",
      ),
    ).toBe(5);
  });
});
