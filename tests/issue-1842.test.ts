// #1842 — the WasmGC abstract heap-type byte encodings in `TYPE`
// (src/emit/opcodes.ts) must match the spec. `none` previously aliased `any`
// (both 0x6e), and the bottom types `noextern`/`nofunc` were missing entirely.
// Spec (WebAssembly GC, abstract heap types — single-byte forms):
//   func=0x70, extern=0x6f, any=0x6e, eq=0x6d, i31=0x6c, struct=0x6b,
//   array=0x6a, none=0x71, noextern=0x72, nofunc=0x73.
import { describe, expect, it } from "vitest";
import { TYPE } from "../src/emit/opcodes.js";

describe("#1842 — WasmGC abstract heap-type encodings", () => {
  it("none/noextern/nofunc use the spec bottom-type bytes", () => {
    expect(TYPE.none).toBe(0x71);
    expect((TYPE as Record<string, number>).noextern).toBe(0x72);
    expect((TYPE as Record<string, number>).nofunc).toBe(0x73);
  });

  it("none no longer collides with any (the original defect)", () => {
    expect(TYPE.none).not.toBe(TYPE.any);
    expect(TYPE.any).toBe(0x6e);
  });

  it("the abstract heap-type bytes match the spec table", () => {
    expect(TYPE.any).toBe(0x6e);
    expect(TYPE.eq).toBe(0x6d);
    expect(TYPE.i31).toBe(0x6c);
    expect(TYPE.struct_ht).toBe(0x6b);
    expect(TYPE.array_ht).toBe(0x6a);
    expect(TYPE.func).toBe(0x60); // heap-type form lives at 0x70; func type-def tag is 0x60
  });
});
