// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3244 — Standalone: any-boxed homogeneous reference-element array reads
 * elements as undefined/NaN (index access + destructuring).
 *
 * A homogeneous reference-element array — `[{ x: 777 }]` (element = object
 * struct ref) or a nested `[[10, 20, 30]]` (element = inner vec struct ref) —
 * compiles to a typed `__vec_<structKind>` carrier, NOT `__vec_externref`.
 * Under `--target standalone`, boxing that carrier to `any`/externref and reading
 * an element back (`(a as any)[0].x`, `(a as any)[0][1]`, or the destructure-param
 * inner object/array pattern) lost the element (read back undefined/NaN, or the
 * nested-pattern destructure saw null → "Cannot destructure null" throw).
 *
 * Two root fixes, both standalone-only:
 *  1. `boxVecElementToExternref` (object-runtime.ts) now boxes ANY GC struct/array
 *     element via `extern.convert_any` (was string-ref only), so the typed-vec
 *     element read-back through `__extern_get_idx` produces a dispatchable
 *     externref.
 *  2. Array-literal carrier widening (literals.ts) — an object-literal element in
 *     an `any`/`Array<any>` context is a dynamic `$Object`, but the carrier was a
 *     closed struct → the store lossily downcast `$Object → struct` to NULL.
 *     Widen the carrier to externref (as the numeric `any[]` case already does).
 *
 * Correct on the WasmGC host lane before this fix; these assert the standalone
 * lane now matches, host-free.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<{ val: unknown; hostImports: string[] }> {
  const r = await compile(src, { fileName: "issue-3244.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const hostImports = WebAssembly.Module.imports(mod)
    .filter((i) => i.module !== "wasi_snapshot_preview1")
    .map((i) => `${i.module}::${i.name}`);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return { val: (instance.exports as { main(): unknown }).main(), hostImports };
}

describe("#3244 — standalone any-boxed reference-element array element reads", () => {
  it("reads an object element property through an any param (index access)", async () => {
    const { val, hostImports } = await runStandalone(
      `function f(a: any): number { return a[0].x; }
       export function main(): number { return f([{ x: 777 }]); }`,
    );
    expect(val).toBe(777);
    expect(hostImports, "must be host-free").toEqual([]);
  });

  it("reads a nested array element through an any param (double index)", async () => {
    const { val } = await runStandalone(
      `function g(a: any): number { return a[0][1]; }
       export function main(): number { return g([[10, 20, 30]]); }`,
    );
    expect(val).toBe(20);
  });

  it("reads a deeply-nested array element", async () => {
    const { val } = await runStandalone(
      `function f(a: any): number { return a[0][0][0]; }
       export function main(): number { return f([[[42]]]); }`,
    );
    expect(val).toBe(42);
  });

  it("binds an object element through a destructuring param `[e]`", async () => {
    const { val } = await runStandalone(
      `function h([e]: any): number { return e.x; }
       export function main(): number { return h([{ x: 777 }]); }`,
    );
    expect(val).toBe(777);
  });

  it("binds a nested object-pattern destructuring param `[{ x }]` (was: 'Cannot destructure null')", async () => {
    const { val } = await runStandalone(
      `function k([{ x }]: any): number { return x; }
       export function main(): number { return k([{ x: 55 }]); }`,
    );
    expect(val).toBe(55);
  });

  it("reads multiple fields and multiple object elements", async () => {
    const { val } = await runStandalone(
      `function f(a: any): number { return a[0].x + a[0].y + a[1].x; }
       export function main(): number { return f([{ x: 3, y: 4 }, { x: 5 }]); }`,
    );
    expect(val).toBe(12);
  });

  it("reads a string field off an object element (string sub-value)", async () => {
    const { val } = await runStandalone(
      `function f(a: any): number { return a[0].s.length; }
       export function main(): number { return f([{ s: "hello" }]); }`,
    );
    expect(val).toBe(5);
  });

  it("reads a nested-object field off an object element", async () => {
    const { val } = await runStandalone(
      `function f(a: any): number { return a[0].p.q; }
       export function main(): number { return f([{ p: { q: 9 } }]); }`,
    );
    expect(val).toBe(9);
  });

  it("reads back through a genuinely-typed array that later crosses the any boundary", async () => {
    const { val } = await runStandalone(
      `export function main(): number { const arr: { x: number }[] = [{ x: 5 }]; const a: any = arr; return a[0].x; }`,
    );
    expect(val).toBe(5);
  });

  it("does not regress primitive / string / heterogeneous element reads", async () => {
    expect((await runStandalone(`export function main(): number { const a: any = [5, 6, 7]; return a[1]; }`)).val).toBe(
      6,
    );
    expect(
      (await runStandalone(`export function main(): number { const a: any = ["ab", "cd"]; return a[0].length; }`)).val,
    ).toBe(2);
    expect(
      (
        await runStandalone(`function f(a: any): number { return a[1].x; }
        export function main(): number { return f([1, { x: 777 }]); }`)
      ).val,
    ).toBe(777);
  });
});
