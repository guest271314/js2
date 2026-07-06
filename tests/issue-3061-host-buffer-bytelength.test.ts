import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #3061 — `.byteLength` / `.byteOffset` on an ArrayBuffer returned NaN in
// JS-host mode: the native accessor computation was gated to standalone/WASI
// only, and the host `__extern_get` fallback returns `undefined` for these on
// the opaque WasmGC byte-vec struct. Enable the representation-safe ArrayBuffer
// arm (`i32_byte`, field-0 = byte count) in host mode too.
async function run(source: string, fn = "test"): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as unknown as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]!();
}

describe("#3061 host-mode ArrayBuffer byteLength/byteOffset", () => {
  it("new ArrayBuffer(n).byteLength returns n", async () => {
    expect(await run(`export function test(): number { const b = new ArrayBuffer(8); return b.byteLength; }`)).toBe(8);
  });

  it("new ArrayBuffer(42).byteLength returns 42", async () => {
    expect(await run(`export function test(): number { const b = new ArrayBuffer(42); return b.byteLength; }`)).toBe(
      42,
    );
  });

  it("new ArrayBuffer(0).byteLength returns 0", async () => {
    expect(await run(`export function test(): number { const b = new ArrayBuffer(0); return b.byteLength; }`)).toBe(0);
  });

  it("new ArrayBuffer(n).byteOffset returns 0", async () => {
    expect(await run(`export function test(): number { const b = new ArrayBuffer(8); return b.byteOffset; }`)).toBe(0);
  });

  it("ArrayBuffer.prototype.slice result has correct byteLength", async () => {
    expect(
      await run(
        `export function test(): number { const b = new ArrayBuffer(4); const r = b.slice(0, 2); return r.byteLength; }`,
      ),
    ).toBe(2);
  });

  it("byteLength used in a comparison (test262 idiom) is exact", async () => {
    expect(
      await run(
        `export function test(): number { const b = new ArrayBuffer(16); if (b.byteLength === 16) { return 1; } return 0; }`,
      ),
    ).toBe(1);
  });

  it("does not intercept a plain object's own byteLength property", async () => {
    expect(await run(`export function test(): number { const o: any = { byteLength: 5 }; return o.byteLength; }`)).toBe(
      5,
    );
  });
});
