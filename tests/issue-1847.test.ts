// #1847 — for-of tentative rollback must restore fctx.localMap, not just
// truncate fctx.locals.
//
// The tentative for-of paths (compileForOfArrayTentative, the .values()
// receiver probe, the standalone iterator fallback) compile the iterable
// expression to discover its type, then roll back. They truncated
// `fctx.locals.length` but left `fctx.localMap` entries pointing past the
// truncated vector — an unbalanced state. `snapshotLocals`/`restoreLocals`
// (src/codegen/context/locals.ts) keep the two in sync. These tests pin the
// helper's contract plus an end-to-end compile that exercises the rollback.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { allocLocal, snapshotLocals, restoreLocals } from "../src/codegen/context/locals.js";
import type { FunctionContext } from "../src/codegen/context/types.js";

function makeFctx(): FunctionContext {
  // Minimal fctx shape for the locals helpers (they only touch
  // params/locals/localMap/tempFreeList).
  return {
    params: [],
    locals: [],
    localMap: new Map<string, number>(),
    body: [],
    labelMap: new Map(),
  } as unknown as FunctionContext;
}

describe("#1847 — snapshotLocals/restoreLocals keep locals + localMap in sync", () => {
  it("restore drops localMap entries for locals allocated after the snapshot", () => {
    const fctx = makeFctx();
    allocLocal(fctx, "outer", { kind: "i32" }); // index 0 — pre-snapshot
    const snap = snapshotLocals(fctx);

    // Tentative allocations.
    allocLocal(fctx, "__forof_vec_1", { kind: "externref" });
    allocLocal(fctx, "__forof_idx_2", { kind: "i32" });
    expect(fctx.locals.length).toBe(3);
    expect(fctx.localMap.has("__forof_vec_1")).toBe(true);

    restoreLocals(fctx, snap);

    // locals truncated back to the snapshot length...
    expect(fctx.locals.length).toBe(1);
    // ...and the post-snapshot localMap entries are gone (no stale slots).
    expect(fctx.localMap.has("__forof_vec_1")).toBe(false);
    expect(fctx.localMap.has("__forof_idx_2")).toBe(false);
    // ...while the pre-snapshot entry is intact.
    expect(fctx.localMap.get("outer")).toBe(0);
  });

  it("re-allocating the same name after restore reuses a valid (in-range) slot", () => {
    const fctx = makeFctx();
    const snap = snapshotLocals(fctx);
    const first = allocLocal(fctx, "__forof_vec", { kind: "externref" }); // 0
    restoreLocals(fctx, snap);
    const second = allocLocal(fctx, "__forof_vec", { kind: "externref" }); // 0 again
    // Without the localMap restore the map would still point at the stale slot;
    // with it, the re-allocation gets a fresh, in-range index and the map agrees.
    expect(second).toBe(first);
    expect(fctx.localMap.get("__forof_vec")).toBe(second);
    expect(second).toBeLessThan(fctx.params.length + fctx.locals.length);
  });

  it("restore prunes tempFreeList entries that point past the truncated vector", () => {
    const fctx = makeFctx();
    const snap = snapshotLocals(fctx);
    const idx = allocLocal(fctx, "__tmp_0", { kind: "i32" }); // index 0
    // Simulate a temp released during the tentative compile.
    fctx.tempFreeList = new Map([["i32", [idx]]]);
    restoreLocals(fctx, snap);
    // The freed slot (0) is now past the truncated locals length (0), so it
    // must be pruned — otherwise allocTempLocal could hand out a dead slot.
    expect(fctx.tempFreeList.get("i32")).toEqual([]);
  });

  it("end-to-end: two consecutive for-of loops over the same array compile to valid Wasm", async () => {
    // Exercises the tentative for-of path twice with the same temp names — if
    // localMap held stale entries, the second loop's slot indices would be
    // wrong and the module would fail Wasm validation.
    const src = `
      export function test(): number {
        const arr: number[] = [10, 20, 30];
        let sum = 0;
        for (const x of arr) { sum += x; }
        for (const y of arr) { sum += y * 2; }
        return sum;
      }
    `;
    const r = await compile(src, { fileName: "t.ts" });
    expect(r.success).toBe(true);
    const importObject = (r as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(r.binary, importObject);
    expect((instance.exports.test as () => number)()).toBe(180);
  });
});
