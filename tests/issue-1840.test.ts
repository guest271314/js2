// #1840 — the linker's `rewriteCode` patched resolved indices back at the
// ORIGINAL byte width: an index that was 1 LEB byte (<128) in the input but
// resolves to ≥128 was silently truncated. It also offset the `call_indirect`
// table index without `resolveIndex`, and overwrote the `memory.size`/`grow`
// immediate as a single raw byte. These tests pin the natural-width re-encode,
// the table-index offset, and the memory-immediate rewrite.
import { describe, expect, it } from "vitest";
import { rewriteCodeForTest } from "../src/link/linker.js";

const ZERO_OFF = { funcOffset: 0, globalOffset: 0, typeOffset: 0, tableOffset: 0, memoryOffset: 0 };

describe("#1840 — linker LEB-width + rewrite gaps", () => {
  it("grows a 1-byte call index to 2 bytes when it crosses 128", () => {
    // call 0 ; end  — funcOffset 200 makes the resolved index 200 (needs 2 LEB bytes).
    const body = new Uint8Array([0x10, 0x00, 0x0b]);
    const out = rewriteCodeForTest(body, { ...ZERO_OFF, funcOffset: 200 });
    // Expected: 0x10, LEB(200)=0xc8 0x01, 0x0b  → 4 bytes, not truncated to 0xc8.
    expect(Array.from(out)).toEqual([0x10, 0xc8, 0x01, 0x0b]);
  });

  it("global.get index grows naturally past 128", () => {
    const body = new Uint8Array([0x23, 0x05, 0x0b]); // global.get 5 ; end
    const out = rewriteCodeForTest(body, { ...ZERO_OFF, globalOffset: 130 });
    // 5 + 130 = 135 → LEB 0x87 0x01.
    expect(Array.from(out)).toEqual([0x23, 0x87, 0x01, 0x0b]);
  });

  it("call_indirect offsets BOTH the type index and the table index", () => {
    // call_indirect type=1 table=0 ; end
    const body = new Uint8Array([0x11, 0x01, 0x00, 0x0b]);
    const out = rewriteCodeForTest(body, { ...ZERO_OFF, typeOffset: 3, tableOffset: 2 });
    // type 1+3=4, table 0+2=2 (previously the table index was offset but with a
    // hardcoded path; this asserts it is resolveIndex-resolved → +tableOffset).
    expect(Array.from(out)).toEqual([0x11, 0x04, 0x02, 0x0b]);
  });

  it("memory.size / memory.grow rewrite the memidx as a real LEB, not a raw byte", () => {
    // memory.size 0 ; memory.grow 0 ; end
    const body = new Uint8Array([0x3f, 0x00, 0x40, 0x00, 0x0b]);
    const out = rewriteCodeForTest(body, { ...ZERO_OFF, memoryOffset: 0 });
    // memoryOffset 0 → identical bytes, but routed through read/appendLEB128.
    expect(Array.from(out)).toEqual([0x3f, 0x00, 0x40, 0x00, 0x0b]);
  });

  it("memory immediate grows correctly when the memory offset pushes it past 127", () => {
    const body = new Uint8Array([0x3f, 0x00, 0x0b]); // memory.size 0 ; end
    const out = rewriteCodeForTest(body, { ...ZERO_OFF, memoryOffset: 200 });
    // 0 + 200 = 200 → LEB 0xc8 0x01 (the old raw-byte write would have stored
    // 0xc8 alone, losing the high bits and producing invalid Wasm).
    expect(Array.from(out)).toEqual([0x3f, 0xc8, 0x01, 0x0b]);
  });

  it("leaves non-rewritten opcodes verbatim", () => {
    // i32.const 5 ; drop ; end — none of these are rewrite targets.
    const body = new Uint8Array([0x41, 0x05, 0x1a, 0x0b]);
    const out = rewriteCodeForTest(body, ZERO_OFF);
    expect(Array.from(out)).toEqual([0x41, 0x05, 0x1a, 0x0b]);
  });
});
