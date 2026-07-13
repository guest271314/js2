// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3224 — Array join/toString/for-of sparse-array bounds-checked-read trap-safety.
 *
 * Bounds-checked-read analog of the #3201 clamp family (#2968/#2970/#2973/#2980/
 * #2982). On a sparse array (logical `.length` set beyond the physical WasmGC
 * backing) join/toString/for-of read `data[i]` up to the LOGICAL length and TRAP
 * ("array element access out of bounds"). Unlike sort/includes/HOFs (which SKIP
 * absent indices → a clamp is correct), these VISIT every index and materialise
 * the absent ones: join/toString → "" (§23.1.3.18), for-of → undefined. So the
 * fix keeps iterating to the logical length but makes the element READ
 * bounds-checked (`if i < array.len(data): data[i] else <absent>`). Dense arrays
 * are unchanged.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function numResult(body: string, target?: "standalone"): Promise<number> {
  const src = `export function test(): number {\n${body}\n}`;
  const r = await compile(src, { fileName: "issue-3224-join-forof-sparse.ts", target, skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

for (const target of ["standalone"] as const) {
  describe(`#3224 join/toString/for-of trap-safety on sparse arrays (${target})`, () => {
    // --- join / toString: absent index → "" (trailing empties preserved) ---
    it('join(",") on a sparse array yields the trailing empty slots (no OOB trap)', async () => {
      // [1,2,3]; a.length=6  →  "1,2,3,,,"  (length 8)
      expect(await numResult(`const a = [1, 2, 3]; a.length = 6; return a.join(",").length;`, target)).toBe(8);
    });

    it('join(",") on a dense array is unchanged', async () => {
      expect(await numResult(`return [1, 2, 3].join(",").length;`, target)).toBe(5);
    });

    it("toString() on a sparse array yields the trailing empty slots", async () => {
      expect(await numResult(`const a = [1, 2, 3]; a.length = 6; return a.toString().length;`, target)).toBe(8);
    });

    it("join on a sparse string array preserves the hole slots", async () => {
      // ['x','y']; a.length=4  →  "x-y-"... "x" "-" "y" "-" "" "-" "" = "x-y--" (length 5)
      expect(await numResult(`const a = ["x", "y"]; a.length = 4; return a.join("-").length;`, target)).toBe(5);
    });

    it("join on a length-extended single element", async () => {
      // [5]; a.length=3  →  "5,,"  (length 3)
      expect(await numResult(`const a = [5]; a.length = 3; return a.join(",").length;`, target)).toBe(3);
    });

    // --- for-of: visits every index, holes → undefined ---
    it("for-of over a sparse array visits every index (no OOB trap)", async () => {
      expect(
        await numResult(`const a = [1, 2, 3]; a.length = 6; let c = 0; for (const x of a) { c++; } return c;`, target),
      ).toBe(6);
    });

    it("for-of over a sparse array sums the defined elements (holes → undefined → 0)", async () => {
      expect(
        await numResult(
          `const a = [1, 2, 3]; a.length = 6; let s = 0; for (const x of a) { s += (x as number) || 0; } return s;`,
          target,
        ),
      ).toBe(6);
    });

    it("for-of over a dense array is unchanged", async () => {
      expect(await numResult(`const a = [1, 2, 3]; let s = 0; for (const x of a) { s += x; } return s;`, target)).toBe(
        6,
      );
    });

    it("for-of over arr.values() on a sparse array does not trap", async () => {
      expect(
        await numResult(
          `const a = [1, 2, 3]; a.length = 6; let c = 0; for (const x of a.values()) { c++; } return c;`,
          target,
        ),
      ).toBe(6);
    });

    it("for-of over arr.keys() on a sparse array visits every index", async () => {
      expect(
        await numResult(
          `const a = [1, 2, 3]; a.length = 6; let c = 0; for (const i of a.keys()) { c++; } return c;`,
          target,
        ),
      ).toBe(6);
    });

    it("for-of over arr.entries() on a sparse array does not trap", async () => {
      expect(
        await numResult(
          `const a = [1, 2, 3]; a.length = 6; let c = 0; for (const [i, x] of a.entries()) { c++; } return c;`,
          target,
        ),
      ).toBe(6);
    });
  });
}
