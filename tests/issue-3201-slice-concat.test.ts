// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3201 (slice 2) — Array.prototype structural-copy trap-safety on sparse arrays.
 *
 * Follow-up to the indexOf/lastIndexOf sparse-read fix (PR #2968). `slice` and
 * `concat` build their result with `array.copy` over the source range
 * `[start, start+len)`. On a sparse array — logical `.length` set beyond the
 * physical WasmGC backing (`a.length = N`, or a high-index write) — that range
 * runs past `array.len(data)` and the `array.copy` TRAPS ("array element access
 * out of bounds"), an uncatchable Wasm trap that aborts the whole program (the
 * #3185 §4 trap-first mandate).
 *
 * The fix (`emitBackingClampedCopyLen`) clamps the copy COUNT to the source's
 * physical backing while keeping the result its full logical length — the
 * beyond-backing tail stays a default-initialised hole (spec skips absent
 * indices in the copy). Pure-sparse `slice()`/`concat()` now return a correctly
 * sized result with no trap; dense arrays are byte-unchanged (backing capacity ≥
 * length ⇒ the clamp is a no-op).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function numResult(body: string, target?: "standalone"): Promise<number> {
  const src = `export function test(): number {\n${body}\n}`;
  const r = await compile(src, { fileName: "issue-3201-slice-concat.ts", target, skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

for (const target of ["standalone"] as const) {
  describe(`#3201 slice/concat trap-safety on sparse arrays (${target})`, () => {
    // --- slice ---
    it("slice() on a length-extended empty array keeps the length (no OOB trap)", async () => {
      expect(await numResult(`const a: any[] = []; a.length = 5; return a.slice().length;`, target)).toBe(5);
    });

    it("slice() on a partially-backed sparse array keeps the length", async () => {
      expect(await numResult(`const a: any[] = [0]; a.length = 3; return a.slice().length;`, target)).toBe(3);
    });

    it("slice() preserves the in-backing prefix on a sparse array", async () => {
      expect(
        await numResult(`const a: any[] = [9]; a.length = 4; const s = a.slice(); return s[0] === 9 ? 1 : 0;`, target),
      ).toBe(1);
    });

    it("slice(start,end) on a dense array is unchanged", async () => {
      expect(await numResult(`return [1, 2, 3, 4].slice(1, 3).length;`, target)).toBe(2);
      expect(await numResult(`return [1, 2, 3, 4].slice(1, 3)[0];`, target)).toBe(2);
      expect(await numResult(`return [1, 2, 3, 4, 5].slice(-2).length;`, target)).toBe(2);
      expect(await numResult(`return [5, 6, 7].slice().length;`, target)).toBe(3);
    });

    // --- concat (0-arg shallow copy) ---
    it("concat() on a length-extended empty array keeps the length (no OOB trap)", async () => {
      expect(await numResult(`const a: any[] = []; a.length = 4; return a.concat().length;`, target)).toBe(4);
    });

    it("concat() preserves the in-backing prefix on a sparse array", async () => {
      expect(
        await numResult(
          `const a: any[] = [7]; a.length = 3; const c = a.concat(); return (c.length === 3 && c[0] === 7) ? 1 : 0;`,
          target,
        ),
      ).toBe(1);
    });

    it("concat() (0-arg) on a dense array is unchanged", async () => {
      expect(await numResult(`return [1, 2, 3].concat().length;`, target)).toBe(3);
      expect(await numResult(`return [1, 2, 3].concat()[2];`, target)).toBe(3);
    });

    // --- concat (1-arg, matching vec type) ---
    it("concat(arr) on dense arrays is unchanged", async () => {
      expect(await numResult(`return [1, 2].concat([3, 4]).length;`, target)).toBe(4);
      expect(await numResult(`return [1, 2].concat([3, 4])[3];`, target)).toBe(4);
    });
  });
}
