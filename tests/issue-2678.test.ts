// #2678 — Date.parse / new Date(str) in HOST mode.
//
// The native string-date parser (#2164) works on standalone/WASI but was gated
// OFF for host mode (calls.ts / new-super.ts emitted a NaN stub) because wiring
// the helper lazily mid-body tripped the #2043 late-import shift. Host strings
// are real wasm:js-string externrefs, so this routes Date.parse / new Date(str)
// through a host import (`__date_parse_host`) delegating to JS Date.parse —
// registered UP-FRONT (collectDateParseHostImports) so the funcidx is stable.
// Standalone/WASI keep the native parser (verified: no host-import leak).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(body: string): Promise<any> {
  const src = `export function test(): any { ${body} }`;
  const result: any = await compile(src, { fileName: "test.ts" } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#2678 — Date.parse / new Date(str) in host mode", () => {
  it("Date.parse of an ISO 8601 string returns the epoch ms", async () => {
    const exp = await run(`return Date.parse("2000-01-01T00:00:00.000Z");`);
    expect(exp.test()).toBe(946684800000);
  });

  it("new Date(isoString).getTime() returns the epoch ms", async () => {
    const exp = await run(`return new Date("1970-01-01T00:00:00.000Z").getTime();`);
    expect(exp.test()).toBe(0);
  });

  it("Date.parse of a later ISO date", async () => {
    const exp = await run(`return Date.parse("2020-06-15T12:00:00.000Z");`);
    expect(exp.test()).toBe(1592222400000);
  });

  it("Date.parse of an unparseable string returns NaN", async () => {
    const exp = await run(`var r = Date.parse("not a date"); return r !== r ? 1 : 0;`);
    expect(exp.test()).toBe(1);
  });

  it("Date.parse() with no argument returns NaN", async () => {
    const exp = await run(`var r = Date.parse(); return r !== r ? 1 : 0;`);
    expect(exp.test()).toBe(1);
  });

  it("Date.parse reads through a variable", async () => {
    const exp = await run(`var s = "2000-01-01T00:00:00.000Z"; return Date.parse(s);`);
    expect(exp.test()).toBe(946684800000);
  });

  it("new Date(ms) numeric construction is unaffected", async () => {
    const exp = await run(`return new Date(1000).getTime();`);
    expect(exp.test()).toBe(1000);
  });

  it("Date.parse of a date-only string (host JS Date.parse format coverage)", async () => {
    const exp = await run(`return Date.parse("2000-01-01");`);
    expect(exp.test()).toBe(946684800000);
  });

  it("new Date(str) of an invalid string yields an Invalid Date (NaN getTime)", async () => {
    const exp = await run(`var t = new Date("nope").getTime(); return t !== t ? 1 : 0;`);
    expect(exp.test()).toBe(1);
  });
});
