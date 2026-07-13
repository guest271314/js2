// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3201 (slice 3) — Array.prototype.sort / includes trap-safety on sparse arrays.
 *
 * Follow-up to the indexOf/lastIndexOf sparse-read fix (#2968) and the
 * slice/concat structural-copy fix (#2970). On a SPARSE array — logical
 * `.length` set beyond the physical WasmGC backing (`a.length = N`) — both
 * methods read past the backing and TRAP ("array element access out of
 * bounds"), an uncatchable Wasm trap that aborts the whole test262 program
 * (the #3185 §4 trap-first mandate).
 *
 *  - `sort`  — the default numeric Timsort, the default ToString insertion sort,
 *    and the comparator insertion sort all read/write `data[i]` up to the
 *    LOGICAL length. Clamping the sort length to the physical backing
 *    (`min(len, array.len(data))`) sorts exactly the defined prefix and leaves
 *    the beyond-backing holes at the end — spec-correct per §23.1.3.30
 *    (SortIndexedProperties moves holes to the end) AND trap-free.
 *  - `includes` — the SameValueZero scan is clamped to the physical backing
 *    (`effLen`); a beyond-backing hole read as `undefined` can never match a
 *    number/string search value, so the clamp is spec-correct there.
 *
 * Dense arrays are behaviourally unchanged (backing capacity ≥ length ⇒ the
 * clamp is a runtime no-op).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function numResult(body: string, target?: "standalone"): Promise<number> {
  const src = `export function test(): number {\n${body}\n}`;
  const r = await compile(src, { fileName: "issue-3201-sort-includes.ts", target, skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

for (const target of ["standalone"] as const) {
  describe(`#3201 sort/includes trap-safety on sparse arrays (${target})`, () => {
    // --- sort: default numeric ---
    it("sort() on a sparse numeric array does not trap and sorts the defined prefix", async () => {
      expect(await numResult(`const a = [3, 1, 2]; a.length = 6; a.sort(); return a[0];`, target)).toBe(1);
      expect(await numResult(`const a = [3, 1, 2]; a.length = 6; a.sort(); return a[2];`, target)).toBe(3);
    });

    it("sort() on a sparse array preserves the logical length (holes stay at the end)", async () => {
      expect(await numResult(`const a = [3, 1, 2]; a.length = 6; a.sort(); return a.length;`, target)).toBe(6);
    });

    it("sort() on a dense numeric array is unchanged", async () => {
      expect(await numResult(`const a = [3, 1, 2]; a.sort(); return a[0] * 100 + a[1] * 10 + a[2];`, target)).toBe(123);
    });

    // --- sort: comparator ---
    it("sort(cmp) on a sparse array does not trap and sorts the defined prefix", async () => {
      expect(await numResult(`const a = [3, 1, 2]; a.length = 6; a.sort((x, y) => x - y); return a[0];`, target)).toBe(
        1,
      );
    });

    it("sort(cmp) on a dense array is unchanged (descending)", async () => {
      expect(
        await numResult(`const a = [3, 1, 2]; a.sort((x, y) => y - x); return a[0] * 100 + a[1] * 10 + a[2];`, target),
      ).toBe(321);
    });

    // --- sort: default ToString (string element) ---
    it("sort() on a sparse string array does not trap and sorts the defined prefix", async () => {
      expect(
        await numResult(`const a = ["c", "a", "b"]; a.length = 6; a.sort(); return a[0] === "a" ? 1 : 0;`, target),
      ).toBe(1);
    });

    // --- includes ---
    it("includes(x) on a sparse array does not trap; absent value returns false", async () => {
      expect(await numResult(`const a = [3, 1, 2]; a.length = 6; return a.includes(9) ? 1 : 0;`, target)).toBe(0);
    });

    it("includes(x) on a sparse array finds an in-backing element", async () => {
      expect(await numResult(`const a = [3, 1, 2]; a.length = 6; return a.includes(2) ? 1 : 0;`, target)).toBe(1);
    });

    it("includes(x) on a sparse string array finds an in-backing element", async () => {
      expect(await numResult(`const a = ["x"]; a.length = 4; return a.includes("x") ? 1 : 0;`, target)).toBe(1);
    });

    it("includes(x, fromIndex) on a sparse array respects fromIndex without trapping", async () => {
      // 3 is at index 0; fromIndex 1 skips it → false, and the beyond-backing
      // holes never match a number.
      expect(await numResult(`const a = [3, 1, 2]; a.length = 6; return a.includes(3, 1) ? 1 : 0;`, target)).toBe(0);
    });

    it("includes(x) on a dense array is unchanged", async () => {
      expect(await numResult(`return [3, 1, 2].includes(2) ? 1 : 0;`, target)).toBe(1);
      expect(await numResult(`return [3, 1, 2].includes(9) ? 1 : 0;`, target)).toBe(0);
    });
  });
}
