// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3201 (write-path) — Array.prototype in-place WRITE/move trap-safety on sparse
 * arrays. Follow-up tail of the merged sparse-READ family (#2968 indexOf →
 * #2990 pop/splice). `fill` / `reverse` / `copyWithin` write or move elements
 * up to the LOGICAL `.length`. On a sparse array — logical `.length` set beyond
 * the physical WasmGC backing via the `a.length = N` setter — those indices run
 * past `array.len(data)` and the `array.set` / `array.copy` TRAPS ("array
 * element access out of bounds"), an uncatchable Wasm abort (#3185 §4
 * trap-first mandate).
 *
 * Unlike the read family (which CLAMPED copies down to the backing), the write
 * family must GROW the backing so the write itself lands in-bounds. The shared
 * `emitEnsureBackingCapacity` helper reallocates the backing to the needed
 * length (`array.new_default` + `array.copy` of the prefix + `struct.set`), the
 * same grow shape as `compileArrayPush`. Standalone/WASI-gated so the host/gc
 * lane stays byte-identical; a dense receiver (capacity ≥ needed) makes the
 * grow a runtime no-op.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function num(body: string, target: "standalone" = "standalone"): Promise<number> {
  const src = `export function test(): number {\n${body}\n}`;
  const r = await compile(src, { fileName: "issue-3201-writepath.ts", target, skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#3201 write-path sparse-array trap-safety (standalone)", () => {
  // --- fill ---
  it("fill() on a length-extended empty array materialises the range (no OOB trap)", async () => {
    expect(await num(`const a: any[] = []; a.length = 5; a.fill(7); return a[3] === 7 ? 1 : 0;`)).toBe(1);
  });
  it("fill() keeps the logical length on a partially-backed sparse array", async () => {
    expect(await num(`const a: any[] = [1]; a.length = 4; a.fill(9); return a.length;`)).toBe(4);
  });
  it("fill(value, start) with start past the backing does not trap", async () => {
    expect(
      await num(`const a: any[] = [1]; a.length = 5; a.fill(3, 2); return (a[3] === 3 && a.length === 5) ? 1 : 0;`),
    ).toBe(1);
  });
  it("fill(value, start, end) fills only the requested sub-range (lower edge respected)", async () => {
    // a[0] is below `start` so it keeps its original 0; a[1]/a[3] are in [start,end).
    // (a[4] is a beyond-grown-backing index read — the separate pre-existing sparse
    // index-READ trap, out of this write-path slice's scope.)
    expect(
      await num(
        `const a: number[] = [0]; a.length = 6; a.fill(2, 1, 4); return (a[0]===0 && a[1]===2 && a[3]===2) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  // --- reverse ---
  it("reverse() on a sparse array does not trap and keeps the length", async () => {
    expect(await num(`const a: any[] = [1]; a.length = 4; a.reverse(); return a.length;`)).toBe(4);
  });
  it("reverse() moves the in-backing value to the tail", async () => {
    expect(await num(`const a: any[] = [1]; a.length = 3; a.reverse(); return a[2] === 1 ? 1 : 0;`)).toBe(1);
  });

  // --- copyWithin ---
  it("copyWithin() on a sparse array does not trap and keeps the length", async () => {
    expect(await num(`const a: any[] = [1, 2]; a.length = 6; a.copyWithin(3, 0); return a.length;`)).toBe(6);
  });
  it("copyWithin(target, start, end) moves the in-backing prefix into a grown region", async () => {
    expect(
      await num(
        `const a: number[] = [5, 6]; a.length = 6; a.copyWithin(3, 0, 2); return (a[3]===5 && a[4]===6) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  // --- dense receivers: the standalone grow branch is present but never taken ---
  it("dense fill() is unchanged", async () => {
    expect(
      await num(`const a = [1, 2, 3, 4]; a.fill(0, 1, 3); return (a[1]===0 && a[2]===0 && a[3]===4) ? 1 : 0;`),
    ).toBe(1);
  });
  it("dense reverse() is unchanged", async () => {
    expect(await num(`return [1, 2, 3].reverse()[0];`)).toBe(3);
  });
  it("dense copyWithin() is unchanged", async () => {
    expect(await num(`const a = [1, 2, 3, 4, 5]; a.copyWithin(0, 3); return (a[0]===4 && a[1]===5) ? 1 : 0;`)).toBe(1);
  });
});
