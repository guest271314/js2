// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3201 — Array.prototype search-family trap-safety on sparse arrays.
 *
 * A sparse array (its logical `.length` set beyond the physical WasmGC backing
 * array, e.g. `a.length = 100` on a short/empty vec) has `vec.length` (field 0)
 * greater than `array.len(vec.data)` (field 1). Before this fix,
 * `indexOf`/`lastIndexOf` iterated `0 .. logicalLength` reading `data[i]` with a
 * raw `array.get`, which TRAPS ("array element access out of bounds") once `i`
 * passes the backing length — an uncatchable Wasm trap that aborts the whole
 * program (the #3185 §4 trap-first mandate: every such trap must become a spec
 * value or a thrown JS error).
 *
 * §23.1.3.14 (indexOf) / §23.1.3.20 (lastIndexOf) are HasProperty-driven, so the
 * absent beyond-backing indices are SKIPPED — they can never strict-equal the
 * search value. The fix clamps the iteration bound to the backing length, which
 * yields the correct `-1` for a purely-sparse search AND never traps. Normal
 * (non-sparse) arrays are byte-for-byte unaffected: the backing capacity is ≥
 * the logical length, so the clamp is a no-op.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function numResult(body: string, target?: "standalone"): Promise<number> {
  const src = `export function test(): number {\n${body}\n}`;
  const r = await compile(src, { fileName: "issue-3201.ts", target, skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

// The clamp is lane-agnostic (not gated on `ctx.standalone`); the standalone
// lane instantiates with a bare import object, so it is the reliable unit-test
// vehicle. The default (gc-host) lane is exercised by the CI test262 sweep over
// `built-ins/Array/prototype/{indexOf,lastIndexOf}` sparse-array tests.
for (const target of ["standalone"] as const) {
  const label = target;
  describe(`#3201 — Array.prototype search trap-safety on sparse arrays (${label})`, () => {
    it("indexOf on a length-extended empty array returns -1 (no OOB trap)", async () => {
      expect(await numResult(`const a: any[] = []; a.length = 100; return a.indexOf(true);`, target)).toBe(-1);
    });

    it("indexOf on a partially-backed sparse array returns -1 (no OOB trap)", async () => {
      expect(await numResult(`const a: any[] = [0]; a.length = 8; return a.indexOf(true);`, target)).toBe(-1);
    });

    it("lastIndexOf on a length-extended empty array returns -1 (no OOB trap)", async () => {
      expect(await numResult(`const a: any[] = []; a.length = 100; return a.lastIndexOf(true);`, target)).toBe(-1);
    });

    it("lastIndexOf on a partially-backed sparse array returns -1 (no OOB trap)", async () => {
      expect(await numResult(`const a: any[] = [0]; a.length = 8; return a.lastIndexOf(true);`, target)).toBe(-1);
    });

    it("indexOf still finds a present in-bounds element on a sparse array", async () => {
      // Index 0 is backed with 7; the search must find it before the clamp.
      expect(await numResult(`const a: any[] = [7]; a.length = 50; return a.indexOf(7);`, target)).toBe(0);
    });

    it("lastIndexOf still finds a present in-bounds element on a sparse array", async () => {
      expect(await numResult(`const a: any[] = [7]; a.length = 50; return a.lastIndexOf(7);`, target)).toBe(0);
    });

    // Regression guards: dense (non-sparse) arrays are unchanged.
    it("indexOf on a dense array is unchanged", async () => {
      expect(await numResult(`const a = [10, 20, 30]; return a.indexOf(20);`, target)).toBe(1);
      expect(await numResult(`const a = [10, 20, 30]; return a.indexOf(99);`, target)).toBe(-1);
      expect(await numResult(`const a = [5, 5, 5]; return a.indexOf(5, 1);`, target)).toBe(1);
      expect(await numResult(`const a = [1, 2, 3]; return a.indexOf(3, -1);`, target)).toBe(2);
    });

    it("lastIndexOf on a dense array is unchanged", async () => {
      expect(await numResult(`const a = [1, 2, 3, 2]; return a.lastIndexOf(2);`, target)).toBe(3);
      expect(await numResult(`const a = [1, 2]; return a.lastIndexOf(9);`, target)).toBe(-1);
      expect(await numResult(`const a = [2, 2, 2]; return a.lastIndexOf(2, 1);`, target)).toBe(1);
    });
  });
}
