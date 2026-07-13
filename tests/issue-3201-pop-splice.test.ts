// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3201 (slice 3) — Array.prototype pop/splice trap-safety on sparse arrays,
 * plus the guarded-copy hardening for slice/concat.
 *
 * Follow-up to #2968 (indexOf/lastIndexOf read-clamp) and #2970 (slice/concat
 * array.copy-clamp). A sparse array — logical `.length` set beyond the physical
 * WasmGC backing (`a.length = N`, or a high-index write) — traps on:
 *   - `pop`   — reads `data[length-1]`, which lands past `array.len(data)`.
 *   - `splice`— its `array.copy`s over `data[start..]` / `data[tailStart..]`
 *     run past the backing.
 *
 * The fix guards `pop`'s read on `newLen < array.len(data)` (else the popped
 * slot is an absent index ⇒ `undefined`), and routes every splice/slice/concat
 * `array.copy` through `emitBackingClampedArrayCopy`. That helper clamps the
 * copy count to the source backing AND guards the copy on `count > 0` — the
 * guard is load-bearing because WasmGC `array.copy` traps when
 * `srcOffset + count > array.len(src)` *even at count 0*, so a `srcOffset` past
 * the backing (e.g. `slice(2)` on a 1-backed sparse array) would otherwise trap
 * despite a clamped-to-zero count.
 *
 * Pure-sparse pop/splice/slice/concat now return correct spec results with no
 * trap; dense arrays are byte-unchanged (the clamp is a no-op and the guard is
 * always taken).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function numResult(body: string, target?: "standalone"): Promise<number> {
  const src = `export function test(): number {\n${body}\n}`;
  const r = await compile(src, { fileName: "issue-3201-pop-splice.ts", target, skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

for (const target of ["standalone"] as const) {
  describe(`#3201 pop/splice trap-safety on sparse arrays (${target})`, () => {
    // --- pop ---
    it("pop() on a partially-backed sparse array returns undefined (no OOB trap)", async () => {
      expect(await numResult(`const a: any[] = [0]; a.length = 2; return a.pop() === undefined ? 0 : 1;`, target)).toBe(
        0,
      );
    });
    it("pop() on a length-extended empty array returns undefined (no OOB trap)", async () => {
      expect(await numResult(`const a: any[] = []; a.length = 5; return a.pop() === undefined ? 0 : 1;`, target)).toBe(
        0,
      );
    });
    it("pop() is unchanged on dense arrays", async () => {
      expect(await numResult(`return [1, 2, 3].pop();`, target)).toBe(3);
      expect(await numResult(`const a = [1, 2, 3]; a.pop(); return a.length;`, target)).toBe(2);
    });

    // --- splice (previously trapped on sparse) ---
    it("splice(start,deleteCount) on a sparse array keeps result length (no OOB trap)", async () => {
      expect(await numResult(`const a: any[] = [0]; a.length = 3; return a.splice(0, 3).length;`, target)).toBe(3);
      expect(await numResult(`const a: any[] = []; a.length = 5; return a.splice(1, 2).length;`, target)).toBe(2);
    });
    it("splice(start) on a sparse array deletes to the end (no OOB trap)", async () => {
      expect(await numResult(`const a: any[] = [0]; a.length = 3; return a.splice(0).length;`, target)).toBe(3);
      expect(await numResult(`const a: any[] = [0]; a.length = 3; a.splice(0, 2); return a.length;`, target)).toBe(1);
    });
    it("splice with insertion on a sparse array does not trap", async () => {
      expect(await numResult(`const a: any[] = [0]; a.length = 5; a.splice(1, 2, 9); return a.length;`, target)).toBe(
        4,
      );
    });
    it("splice is unchanged on dense arrays", async () => {
      expect(await numResult(`return [1, 2, 3, 4].splice(1, 2).length;`, target)).toBe(2);
      expect(await numResult(`const a = [1, 2, 3, 4]; a.splice(1, 2); return a[1];`, target)).toBe(4);
      expect(await numResult(`const a = [1, 2, 3]; a.splice(1, 1, 9, 8); return a[1];`, target)).toBe(9);
      expect(await numResult(`const a = [1, 2, 3]; a.splice(1, 1, 9, 8); return a.length;`, target)).toBe(4);
    });

    // --- slice/concat guarded-copy hardening (srcOffset past the backing) ---
    it("slice(start) with start past the backing does not trap", async () => {
      expect(await numResult(`const a: any[] = [0]; a.length = 5; return a.slice(2).length;`, target)).toBe(3);
    });
    it("slice/concat remain correct on dense arrays", async () => {
      expect(await numResult(`return [1, 2, 3, 4].slice(1, 3)[0];`, target)).toBe(2);
      expect(await numResult(`return [1, 2].concat([3, 4])[3];`, target)).toBe(4);
    });
  });
}
