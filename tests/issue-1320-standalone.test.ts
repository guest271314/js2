// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #1320 Slice 1 — standalone (no-JS-host) iterator bridge.
// `arr.values()`/`.keys()` reaching the generic for-of consumer (i.e. stored in
// a variable, escaping the direct #681 recognizer) now lower to a pure-Wasm
// canonical-vec iterator record + native __iterator/__iterator_next, with NO
// __iterator*/__array_* host imports. `.entries()` (pair-shaped) is deferred.

const ITER_HOST_IMPORT_RE = /__(?:async_)?iterator|__array_(?:entries|keys|values)/;

function noIterHostImports(result: Awaited<ReturnType<typeof compile>>) {
  // Assert NO iterator-protocol *host imports* are present. The standalone
  // bridge emits NATIVE Wasm functions with the SAME names (`$__iterator` etc.),
  // so checking the WAT text would false-positive on the legitimate native fn
  // names — assert on the import list only (the meaningful "no JS host" check).
  const names = result.imports.map((i) => `${i.module}::${i.name}`);
  expect(names.filter((n) => ITER_HOST_IMPORT_RE.test(n))).toEqual([]);
}

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  noIterHostImports(r);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#1320 Slice 1 standalone iterator bridge", () => {
  it("drives a stored arr.values() through native for-of (no host import)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const it = [10, 20, 30].values();
          let s: number = 0;
          for (const v of it) { s = s + v; }
          return s;
        }
      `),
    ).toBe(10 + 20 + 30);
  });

  it("drives a stored arr.keys() through native for-of (yields indices)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const it = [10, 20, 30].keys();
          let s: number = 0;
          for (const k of it) { s = s + k; }
          return s;
        }
      `),
    ).toBe(0 + 1 + 2);
  });

  it("honors break in a native values() for-of", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const it = [5, 6, 7, 8].values();
          let s: number = 0;
          for (const v of it) { if (v === 7) break; s = s + v; }
          return s;
        }
      `),
    ).toBe(5 + 6);
  });

  it("honors continue in a native keys() for-of", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const it = [9, 9, 9, 9].keys();
          let s: number = 0;
          for (const k of it) { if (k === 1) continue; s = s + k; }
          return s;
        }
      `),
    ).toBe(0 + 2 + 3);
  });

  it("handles an empty array values() for-of", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const it = ([] as number[]).values();
          let s: number = 0;
          for (const v of it) { s = s + v; }
          return s;
        }
      `),
    ).toBe(0);
  });

  it("works under --target wasi too", async () => {
    const r = await compile(
      `
        export function f(): number {
          const it = [3, 4, 5].values();
          let s: number = 0;
          for (const v of it) { s = s + v; }
          return s;
        }
      `,
      { target: "wasi" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    noIterHostImports(r);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { f: () => number }).f()).toBe(3 + 4 + 5);
  });

  it("still refuses arr.entries() in standalone (pair-shaped, deferred to a later slice)", async () => {
    const r = await compile(
      `
        export function f(): number {
          const it = [1, 2].entries();
          let s: number = 0;
          for (const e of it) { s = s + 1; }
          return s;
        }
      `,
      { target: "standalone" },
    );
    expect(r.success).toBe(false);
    expect(r.errors.some((e) => /#1320.*entries/.test(e.message))).toBe(true);
  });
});
