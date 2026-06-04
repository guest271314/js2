// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1856 — bump/arena allocator mode for the linear backend.
//
// The linear backend's allocator is a bump/arena: every __malloc advances a
// single heap pointer and nothing is ever freed (allocate-and-exit). These
// tests pin three behaviours added by #1856:
//   1. __malloc grows linear memory on demand instead of overflowing the
//      initial single page (the previous behaviour silently corrupted memory
//      for any program that allocated more than ~63 KiB).
//   2. The optional arena-management exports (__arena_reset / __arena_used)
//      appear only when explicitly requested.
//   3. __arena_reset rewinds the whole arena in O(1).
import { describe, it, expect } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { addRuntime } from "../src/codegen-linear/runtime.js";

const PAGE = 65536;
const HEAP_START = 1024;

/** Build a module with the linear runtime and __malloc + the arena exports
 *  exported so tests can drive them directly. */
async function buildArenaModule(opts?: { exposeArenaReset?: boolean }) {
  const mod = createEmptyModule();
  addRuntime(mod, opts);
  // Export __malloc (it is internal by default).
  const mallocFuncIdx = mod.functions.findIndex((f) => f.name === "__malloc");
  mod.exports.push({ name: "__malloc", desc: { kind: "func", index: mallocFuncIdx } });
  const binary = emitBinary(mod);
  const { instance } = await WebAssembly.instantiate(binary);
  return instance.exports as Record<string, unknown>;
}

describe("#1856 bump/arena allocator", () => {
  it("aligns to 8 bytes and starts at HEAP_START (unchanged contract)", async () => {
    const ex = await buildArenaModule();
    const malloc = ex.__malloc as (n: number) => number;
    expect(malloc(10)).toBe(HEAP_START); // 1024
    expect(malloc(4)).toBe(1040); // align8(1024 + 10) = 1040
    expect(malloc(16)).toBe(1048); // align8(1040 + 4)  = 1048
  });

  it("grows linear memory when an allocation exceeds the current page(s)", async () => {
    const ex = await buildArenaModule();
    const malloc = ex.__malloc as (n: number) => number;
    const memory = ex.memory as WebAssembly.Memory;

    // Starts at exactly one page.
    expect(memory.buffer.byteLength).toBe(PAGE);

    // Allocate ~1.5 pages worth in one shot — must trigger growth, not
    // silently hand back an address past the addressable region.
    const big = Math.floor(PAGE * 1.5);
    const ptr = malloc(big);
    expect(ptr).toBe(HEAP_START);
    // Memory grew to hold HEAP_START + big bytes → at least 2 pages.
    expect(memory.buffer.byteLength).toBeGreaterThanOrEqual(2 * PAGE);

    // The returned region is fully writable (no trap), proving it is backed.
    const view = new Uint8Array(memory.buffer);
    view[ptr] = 0xaa;
    view[ptr + big - 1] = 0xbb;
    expect(view[ptr]).toBe(0xaa);
    expect(view[ptr + big - 1]).toBe(0xbb);
  });

  it("keeps growing across many sub-page allocations that cross page lines", async () => {
    const ex = await buildArenaModule();
    const malloc = ex.__malloc as (n: number) => number;
    const memory = ex.memory as WebAssembly.Memory;
    const view = () => new Uint8Array(memory.buffer);

    // 200 × 1 KiB = ~200 KiB > 3 pages. Write a sentinel into each block and
    // confirm none traps and the buffer ends well past one page.
    let last = 0;
    for (let i = 0; i < 200; i++) {
      const p = malloc(1024);
      expect(p).toBeGreaterThanOrEqual(last);
      view()[p] = i & 0xff;
      last = p;
    }
    expect(memory.buffer.byteLength).toBeGreaterThan(3 * PAGE);
  });

  it("does NOT export __arena_reset / __arena_used by default", async () => {
    const ex = await buildArenaModule();
    expect(ex.__arena_reset).toBeUndefined();
    expect(ex.__arena_used).toBeUndefined();
  });

  it("exports __arena_reset / __arena_used when requested, and reset rewinds the arena", async () => {
    const ex = await buildArenaModule({ exposeArenaReset: true });
    const malloc = ex.__malloc as (n: number) => number;
    const arenaReset = ex.__arena_reset as () => void;
    const arenaUsed = ex.__arena_used as () => number;

    expect(typeof arenaReset).toBe("function");
    expect(typeof arenaUsed).toBe("function");

    expect(arenaUsed()).toBe(0);
    malloc(100); // bumps to align8(1124) = 1128
    malloc(50); // bumps to align8(1178) = 1184
    expect(arenaUsed()).toBe(1184 - HEAP_START); // 160

    arenaReset();
    expect(arenaUsed()).toBe(0);
    // After reset the next allocation reuses HEAP_START — the whole arena
    // was reclaimed in O(1).
    expect(malloc(8)).toBe(HEAP_START);
  });
});
