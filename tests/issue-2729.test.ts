// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2729 — WasmGC backend: `new Uint8Array(n)` element store skips ToUint8.
//
// On the default WasmGC (host/gc) backend a `new Uint8Array(n)` (no explicit
// ArrayBuffer) lowers to an f64-backed vec — the i8 packed storage is
// wasi/standalone-only (see `typedArrayVecStorage`). The f64 store path applied
// NO conversion, so an out-of-range or non-integer assignment read back the raw
// value (`u[0]=257`→257, `u[0]=-1`→-1, `u[0]=NaN`→NaN) instead of the §7.1.10
// ToUint8 byte. The fix applies ToUint8 (ToInt32 then & 0xFF; NaN/±Inf→0) before
// the f64 store, matching the linear backend (#2715) and the wasi/standalone
// i8-packed truncation.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

/** Compile + run a single `test()` body on the default WasmGC backend. */
async function runGc(body: string): Promise<number> {
  const result = await compile(`export function test(): number { ${body} }`);
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  const built = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => number }).test();
}

describe("#2729 WasmGC Uint8Array element store applies ToUint8", () => {
  // Acceptance criteria (issue body): out-of-range wraps, non-integer truncates,
  // NaN/±Infinity → 0.
  const cases: Array<[string, number]> = [
    // Wrap modulo 256.
    ["const u = new Uint8Array(1); u[0] = 257; return u[0];", 1],
    ["const u = new Uint8Array(1); u[0] = 256; return u[0];", 0],
    ["const u = new Uint8Array(1); u[0] = -1; return u[0];", 255],
    ["const u = new Uint8Array(1); u[0] = -256; return u[0];", 0],
    ["const u = new Uint8Array(1); u[0] = -257; return u[0];", 255],
    ["const u = new Uint8Array(1); u[0] = 1e20; return u[0];", 0],
    // Truncate toward zero, then wrap.
    ["const u = new Uint8Array(1); u[0] = 3.7; return u[0];", 3],
    ["const u = new Uint8Array(1); u[0] = 255.9; return u[0];", 255],
    ["const u = new Uint8Array(1); u[0] = 511.5; return u[0];", 255],
    // NaN / ±Infinity → 0.
    ["const u = new Uint8Array(1); u[0] = 0 / 0; return u[0];", 0],
    ["const u = new Uint8Array(1); u[0] = 1 / 0; return u[0];", 0],
    ["const u = new Uint8Array(1); u[0] = -1 / 0; return u[0];", 0],
    // In-range happy paths are unchanged.
    ["const u = new Uint8Array(1); u[0] = 0; return u[0];", 0],
    ["const u = new Uint8Array(1); u[0] = 200; return u[0];", 200],
    ["const u = new Uint8Array(1); u[0] = 255; return u[0];", 255],
  ];
  for (const [body, expected] of cases) {
    it(`${body} === ${expected}`, async () => {
      expect(await runGc(body)).toBe(expected);
    });
  }

  it("variable RHS is coerced (300 → 44)", async () => {
    expect(await runGc("const u = new Uint8Array(1); let x = 300; u[0] = x; return u[0];")).toBe(44);
  });

  it("multiple distinct elements wrap independently", async () => {
    expect(
      await runGc("const u = new Uint8Array(3); u[0] = 10; u[1] = 20; u[2] = 257; return u[0] + u[1] + u[2];"),
    ).toBe(10 + 20 + 1);
  });

  it("loop-written elements each apply ToUint8", async () => {
    // i*100: 0, 100, 200, 300→44
    expect(
      await runGc(
        "const u = new Uint8Array(4); for (let i = 0; i < 4; i++) { u[i] = i * 100; } return u[0] + u[1] + u[2] + u[3];",
      ),
    ).toBe(0 + 100 + 200 + 44);
  });
});
