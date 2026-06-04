// #1843 — the LLVM-style relocation type numbers must agree between the
// emitter (`RELOC` in src/emit/opcodes.ts) and the linker reader
// (`R_WASM_*` constants in src/link/reader.ts).
//
// They had drifted on the tag relocation: the emitter wrote
// `R_WASM_TAG_INDEX_LEB = 11` while the reader expected `10` (the LLVM
// canonical, historically R_WASM_EVENT_INDEX_LEB). A tag relocation written
// by the emitter was therefore parsed as an unknown type by the reader.
// These tests pin the tag value and guard against any future drift across the
// whole shared reloc set.
import { describe, expect, it } from "vitest";
import { RELOC } from "../src/emit/opcodes.js";
import * as reader from "../src/link/reader.js";

describe("#1843 — emitter/reader relocation type numbers agree", () => {
  it("R_WASM_TAG_INDEX_LEB is 10 on both sides (LLVM canonical)", () => {
    expect(RELOC.R_WASM_TAG_INDEX_LEB).toBe(10);
    expect(reader.R_WASM_TAG_INDEX_LEB).toBe(10);
    expect(RELOC.R_WASM_TAG_INDEX_LEB).toBe(reader.R_WASM_TAG_INDEX_LEB);
  });

  it("every reloc type defined on both sides uses the same number", () => {
    const readerConsts = reader as unknown as Record<string, unknown>;
    const mismatches: string[] = [];
    for (const [name, emitterValue] of Object.entries(RELOC)) {
      const readerValue = readerConsts[name];
      if (typeof readerValue === "number" && readerValue !== emitterValue) {
        mismatches.push(`${name}: emitter=${emitterValue} reader=${readerValue}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
