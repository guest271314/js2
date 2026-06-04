// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1858 P0.6 — the unsigned-LEB128 `u32` encoder is the last line of defense
// before bytes hit the wasm binary. Previously a value >= 2^32 silently
// truncated and a negative value encoded as 0xFFFFFFFF — plausible-but-wrong
// bytes that produce an invalid module. The guard now throws a RangeError on
// out-of-range / non-integer input instead. These checks are purely additive:
// they only fire on already-broken input.
import { describe, it, expect } from "vitest";
import { WasmEncoder } from "../src/emit/encoder.js";

describe("#1858 P0.6 — u32 LEB128 range guard", () => {
  it("encodes valid values across the full u32 range", () => {
    for (const v of [0, 1, 127, 128, 300, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff]) {
      const enc = new WasmEncoder();
      expect(() => enc.u32(v)).not.toThrow();
      // Round-trip: decode the LEB128 we just wrote and confirm it matches.
      const bytes = enc.finish();
      let result = 0;
      let shift = 0;
      for (const b of bytes) {
        result += (b & 0x7f) * 2 ** shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
      }
      expect(result).toBe(v);
    }
  });

  it("throws on negative input (previously encoded -1 as 0xFFFFFFFF)", () => {
    const enc = new WasmEncoder();
    expect(() => enc.u32(-1)).toThrow(RangeError);
    expect(() => enc.u32(-1)).toThrow(/u32 out of range/);
  });

  it("throws on values >= 2^32 (previously silently truncated)", () => {
    const enc = new WasmEncoder();
    expect(() => enc.u32(0x1_0000_0000)).toThrow(RangeError);
    expect(() => enc.u32(2 ** 40)).toThrow(/u32 out of range/);
  });

  it("throws on non-integer input", () => {
    const enc = new WasmEncoder();
    expect(() => enc.u32(1.5)).toThrow(RangeError);
    expect(() => enc.u32(NaN)).toThrow(RangeError);
  });
});
