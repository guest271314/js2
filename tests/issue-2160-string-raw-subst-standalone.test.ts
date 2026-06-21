import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2160 — `String.raw` WITH substitutions produced an invalid standalone binary.
//
// `compileStringRaw` (src/codegen/string-ops.ts) built the accumulator from a
// native `ref $AnyString` literal but stringified a numeric substitution via
// `number_toString` and concatenated through the host-concat path, mixing
// representations under native-strings mode → `any.convert_extern expected
// externref, found f64` at instantiate (an INVALID standalone binary for
// `String.raw\`a${1}b\``). The no-substitution case already worked (generic
// template-vec fix); only the WITH-substitution path was broken.
//
// Fix: in noJsHost / nativeStrings mode, coerce every operand to `ref $AnyString`
// via the proven `compileNativeConcatOperand` helper and concat with native
// `__str_concat` — mirroring `compileTemplateExpression`'s native branch.
// JS-host mode is unchanged (wasm:js-string concat).

async function compileStandalone(src: string) {
  return compile(src, { fileName: "test.ts", target: "standalone", skipSemanticDiagnostics: true });
}

async function runStandalone(src: string): Promise<number> {
  const r = await compileStandalone(src);
  if (!r.success) throw new Error("compile failed: " + (r.errors[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#2160 String.raw with substitutions (standalone)", () => {
  it("numeric substitution compiles + instantiates standalone (was: invalid binary)", async () => {
    // String.raw`a${1}b` === "a1b"
    expect(
      await runStandalone(`
        export function test(): number {
          const s = String.raw\`a\${1}b\`;
          return (s.length === 3 && s.charCodeAt(0) === 97 && s.charCodeAt(1) === 49 && s.charCodeAt(2) === 98) ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("string substitution standalone", async () => {
    // String.raw`a${"X"}b` === "aXb"
    expect(await runStandalone(`export function test(): number { return String.raw\`a\${"X"}b\`.length; }`)).toBe(3);
  });

  it("multiple numeric substitutions standalone", async () => {
    // String.raw`${1}-${2}` === "1-2"
    expect(await runStandalone(`export function test(): number { return String.raw\`\${1}-\${2}\`.length; }`)).toBe(3);
  });

  it("no-substitution String.raw still works standalone (regression guard)", async () => {
    expect(await runStandalone(`export function test(): number { return String.raw\`hello\`.length; }`)).toBe(5);
  });

  it("raw escapes are preserved (backslash not interpreted)", async () => {
    // String.raw`x\ny` === "x\\ny" (4 chars: x, backslash, n, y)
    expect(await runStandalone(`export function test(): number { return String.raw\`x\\ny\`.length; }`)).toBe(4);
  });

  it("boolean substitution standalone", async () => {
    // String.raw`v=${true}` === "v=true"
    expect(await runStandalone(`export function test(): number { return String.raw\`v=\${true}\`.length; }`)).toBe(6);
  });

  it("does not leak a JS-host string import standalone", async () => {
    const r = await compileStandalone(`export function test(): number { return String.raw\`a\${1}b\`.length; }`);
    expect(r.success).toBe(true);
    const names = r.imports.map((i) => i.name);
    expect(names.some((n) => n.startsWith("string_") || n === "concat")).toBe(false);
  });
});
