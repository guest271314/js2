// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3215 — Array.prototype HOF sparse-array read trap-safety. Analog of the
 * #3201 read/copy family (#2968/#2970/#2973/#2980). On a sparse array (logical
 * `.length` beyond the physical WasmGC backing) the callback HOFs iterate to
 * the LOGICAL length via the shared `setupArrayLoop` and read `data[i]` past
 * the backing → uncatchable "array element access out of bounds" trap. The fix
 * clamps the shared loop bound to `min(len, array.len(data))`; per spec these
 * HOFs skip absent (hole) indices, so iterating only the physical prefix is
 * spec-correct. map keeps its LOGICAL result length (holes beyond the visited
 * prefix stay default-initialised).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function numResult(body: string, target?: "standalone"): Promise<number> {
  const src = `export function test(): number {\n${body}\n}`;
  const r = await compile(src, { fileName: "issue-3215-hof-sparse.ts", target, skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

for (const target of ["standalone"] as const) {
  describe(`#3215 HOF trap-safety on sparse arrays (${target})`, () => {
    it("forEach on a sparse array visits only the defined prefix (no OOB trap)", async () => {
      expect(
        await numResult(
          `const a = [1, 2, 3]; a.length = 6; let s = 0; a.forEach((x) => { s += x; }); return s;`,
          target,
        ),
      ).toBe(6);
    });

    it("map on a sparse array does not trap and keeps the logical length", async () => {
      expect(await numResult(`const a = [1, 2, 3]; a.length = 6; return a.map((x) => x * 2).length;`, target)).toBe(6);
      expect(
        await numResult(`const a = [1, 2, 3]; a.length = 6; const b = a.map((x) => x * 2); return b[0];`, target),
      ).toBe(2);
    });

    it("filter on a sparse array skips holes (no OOB trap)", async () => {
      expect(await numResult(`const a = [1, 2, 3]; a.length = 6; return a.filter((x) => x > 1).length;`, target)).toBe(
        2,
      );
    });

    it("reduce on a sparse array folds only the defined prefix (no OOB trap)", async () => {
      expect(await numResult(`const a = [1, 2, 3]; a.length = 6; return a.reduce((p, x) => p + x, 0);`, target)).toBe(
        6,
      );
    });

    it("every on a sparse array does not trap", async () => {
      expect(await numResult(`const a = [1, 2, 3]; a.length = 6; return a.every((x) => x > 0) ? 1 : 0;`, target)).toBe(
        1,
      );
    });

    it("some on a sparse array does not trap", async () => {
      expect(await numResult(`const a = [1, 2, 3]; a.length = 6; return a.some((x) => x > 2) ? 1 : 0;`, target)).toBe(
        1,
      );
    });

    it("find on a sparse array does not trap", async () => {
      expect(
        await numResult(`const a = [1, 2, 3]; a.length = 6; return a.find((x) => x === 2) as number;`, target),
      ).toBe(2);
    });

    it("findIndex on a sparse array does not trap", async () => {
      expect(await numResult(`const a = [1, 2, 3]; a.length = 6; return a.findIndex((x) => x === 3);`, target)).toBe(2);
    });

    it("reduceRight on a sparse array folds the defined prefix (init + no-init, no OOB trap)", async () => {
      expect(
        await numResult(`const a = [1, 2, 3]; a.length = 6; return a.reduceRight((p, x) => p + x, 0);`, target),
      ).toBe(6);
      expect(await numResult(`const a = [1, 2, 3]; a.length = 6; return a.reduceRight((p, x) => p + x);`, target)).toBe(
        6,
      );
    });

    it("findLast on a sparse array does not trap (reverse-loop clamp)", async () => {
      expect(
        await numResult(`const a = [1, 2, 3]; a.length = 6; return a.findLast((x) => x === 2) as number;`, target),
      ).toBe(2);
    });

    // --- dense controls (behaviourally unchanged) ---
    it("dense forEach/map/filter/reduce unchanged", async () => {
      expect(await numResult(`const a = [1, 2, 3]; let s = 0; a.forEach((x) => { s += x; }); return s;`, target)).toBe(
        6,
      );
      expect(await numResult(`return [1, 2, 3].map((x) => x * 2).length;`, target)).toBe(3);
      expect(await numResult(`return [1, 2, 3].filter((x) => x > 1).length;`, target)).toBe(2);
      expect(await numResult(`return [1, 2, 3].reduce((p, x) => p + x, 0);`, target)).toBe(6);
    });
  });
}
