import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #1782: standalone numeric / BigInt separator literals evaluated to wrong
// values in test262. Root cause was NOT literal lowering (TypeScript already
// resolves `NumericLiteral.text` to the decimal value) but the standalone
// `isSameValue` externref-equality path emitting a comparison that mismatched
// when both operands were separator literals boxed to externref through an
// `any`-typed parameter (the shape of test262's `assert.sameValue(a, b)`
// harness). Fixed by #1776 / commit 1ff16008d. These tests pin the
// separator-literal half of that behavior so it can't silently regress.

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, {
    fileName: "t.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, `Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(true);
  const importResult: any = buildImports(r.imports, undefined, r.stringPool, {});
  const { instance } = await WebAssembly.instantiate(r.binary, importResult.imports ?? importResult);
  if (importResult.setExports) importResult.setExports(instance.exports);
  return (instance.exports as Record<string, () => number>).test();
}

// Mirror the test262 harness: separator literals are passed through an
// `any`-typed comparison (boxes to externref in standalone), and the function
// reports the 1-based index of the first failing comparison, or 0 if all pass.
const SAME_VALUE_DRIVER = `
function sv(a: any, b: any): boolean { return a === b; }
export function test(): number {
  let n = 0;
`;

describe("#1782 standalone numeric separator literal equality", () => {
  it("decimal / hex / octal / binary integer separators compare equal (any-boxed)", async () => {
    const fail = await runStandalone(
      SAME_VALUE_DRIVER +
        `  n++; if (!sv(1_000, 1000)) return n;
  n++; if (!sv(0o0_1, 0o01)) return n;
  n++; if (!sv(0O0_1, 0O01)) return n;
  n++; if (!sv(0x01_00, 0x0100)) return n;
  n++; if (!sv(0X01_00, 0X0100)) return n;
  n++; if (!sv(0b1010_0001, 0b10100001)) return n;
  n++; if (!sv(0B1010_0001, 0B10100001)) return n;
  return 0;
}`,
    );
    expect(fail).toBe(0);
  });

  it("decimal / exponent float separators compare equal (any-boxed)", async () => {
    const fail = await runStandalone(
      SAME_VALUE_DRIVER +
        `  n++; if (!sv(1_000.50, 1000.5)) return n;
  n++; if (!sv(1.0e+1_0, 1.0e+10)) return n;
  n++; if (!sv(1.0E+1_0, 1.0E+10)) return n;
  return 0;
}`,
    );
    expect(fail).toBe(0);
  });

  it("BigInt separators (decimal / hex / octal / binary, lower+upper prefix) compare equal", async () => {
    const fail = await runStandalone(
      SAME_VALUE_DRIVER +
        `  n++; if (!sv(1_0n, 10n)) return n;
  n++; if (!sv(0o0_1n, 0o01n)) return n;
  n++; if (!sv(0O0_1n, 0O01n)) return n;
  n++; if (!sv(0x01_00n, 0x0100n)) return n;
  n++; if (!sv(0X01_00n, 0X0100n)) return n;
  n++; if (!sv(0b0_1n, 0b01n)) return n;
  n++; if (!sv(0B0_1n, 0B01n)) return n;
  return 0;
}`,
    );
    expect(fail).toBe(0);
  });
});

describe("#1782 numeric separator literal values (JS-host, no regression)", () => {
  async function runHost(source: string): Promise<number> {
    const r = await compile(source, { fileName: "t.ts" });
    expect(r.success).toBe(true);
    const importResult: any = buildImports(r.imports, undefined, r.stringPool, {});
    const { instance } = await WebAssembly.instantiate(r.binary, importResult.imports ?? importResult);
    if (importResult.setExports) importResult.setExports(instance.exports);
    return (instance.exports as Record<string, () => number>).test();
  }

  it("uppercase radix prefixes lower to correct values in JS-host mode", async () => {
    const fail = await runHost(
      `export function test(): number {
        let n = 0;
        n++; if (0O0_1 !== 1) return n;
        n++; if (0X01_00 !== 256) return n;
        n++; if (0B1010_0001 !== 161) return n;
        n++; if (1.0E+1_0 !== 1.0e+10) return n;
        return 0;
      }`,
    );
    expect(fail).toBe(0);
  });
});
