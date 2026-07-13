import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #3062 — `.byteLength` / `.byteOffset` on a DataView returned NaN in JS-host
// mode: the native windowed-accessor computation was gated to standalone/WASI
// only. In host mode `new DataView(buf, offset, length)` returns the raw
// i32_byte buffer struct (no `$__dv_window` wrapper) and the view window lives
// in the `_dvViewMeta` sidecar. The host `__extern_get` fallback returns
// `undefined` for these accessors on the opaque struct → NaN. This reads the
// recorded window via the `__dv_view_byte_attr` host helper. Follow-up to #3061
// (ArrayBuffer host byteLength/byteOffset).
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

describe("#3062 host-mode DataView byteLength/byteOffset", () => {
  it("default-length view reports full buffer byteLength", async () => {
    expect(
      await run(
        `export function test(): number { const b = new ArrayBuffer(12); const d = new DataView(b); return d.byteLength; }`,
      ),
    ).toBe(12);
  });

  it("offset view byteLength = bufferByteLength - offset (test262 return-bytelength sample2)", async () => {
    expect(
      await run(
        `export function test(): number { const b = new ArrayBuffer(12); const d = new DataView(b, 4); return d.byteLength; }`,
      ),
    ).toBe(8);
  });

  it("explicit windowed byteLength honored (offset 6, length 4)", async () => {
    expect(
      await run(
        `export function test(): number { const b = new ArrayBuffer(12); const d = new DataView(b, 6, 4); return d.byteLength; }`,
      ),
    ).toBe(4);
  });

  it("offset at end of buffer → byteLength 0", async () => {
    expect(
      await run(
        `export function test(): number { const b = new ArrayBuffer(12); const d = new DataView(b, 12); return d.byteLength; }`,
      ),
    ).toBe(0);
  });

  it("byteOffset reflects constructor offset", async () => {
    expect(
      await run(
        `export function test(): number { const b = new ArrayBuffer(12); const d = new DataView(b, 4); return d.byteOffset; }`,
      ),
    ).toBe(4);
  });

  it("byteOffset of a default view is 0", async () => {
    expect(
      await run(
        `export function test(): number { const b = new ArrayBuffer(12); const d = new DataView(b); return d.byteOffset; }`,
      ),
    ).toBe(0);
  });

  it("byteOffset with explicit length still reflects offset (sample3)", async () => {
    expect(
      await run(
        `export function test(): number { const b = new ArrayBuffer(12); const d = new DataView(b, 6, 4); return d.byteOffset; }`,
      ),
    ).toBe(6);
  });

  it("byteLength used in a comparison (test262 idiom) is exact", async () => {
    expect(
      await run(
        `export function test(): number { const b = new ArrayBuffer(8); const d = new DataView(b, 2); if (d.byteLength === 6) { return 1; } return 0; }`,
      ),
    ).toBe(1);
  });

  it("does not intercept a plain object's own byteLength property", async () => {
    expect(
      await run(
        `export function test(): number { const o: any = { byteLength: 5, byteOffset: 3 }; return o.byteLength + o.byteOffset; }`,
      ),
    ).toBe(8);
  });

  // #3062 regression: the getter's `this` = DataView.prototype has no
  // [[DataView]] internal slot, so `DataView.prototype.byteLength` must throw a
  // TypeError (§25.3.4.1) — the native arm must NOT read a bogus 0 off the
  // prototype (test262 built-ins/DataView/prototype/{byteLength,byteOffset}/
  // invoked-as-accessor.js).
  async function throws(source: string): Promise<boolean> {
    const result = await compile(source);
    if (!result.success) return false;
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as unknown as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
      instance.exports as Record<string, Function>,
    );
    try {
      (instance.exports as Record<string, () => unknown>).test!();
      return false;
    } catch {
      return true;
    }
  }

  it("DataView.prototype.byteLength throws (not a DataView instance)", async () => {
    expect(await throws(`export function test(): number { return DataView.prototype.byteLength; }`)).toBe(true);
  });

  it("DataView.prototype.byteOffset throws (not a DataView instance)", async () => {
    expect(await throws(`export function test(): number { return DataView.prototype.byteOffset; }`)).toBe(true);
  });
});
