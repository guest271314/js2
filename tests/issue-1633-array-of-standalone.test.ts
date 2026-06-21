// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1633 (standalone slice) — `Array.of(...items)` (§23.1.2.3) leaked the host
// imports `__array_of` / `__js_array_new` / `__js_array_push` under
// `--target standalone` and returned a wrong/empty array (length 0, elements
// NaN), while `Array(a,b,c)` and `[a,b,c]` already built a native vec.
//
// Fix: in no-JS-host mode, lower `Array.of(a, b, c)` to a native vec directly
// (mirroring the multi-arg `Array(a,b,c)` branch of `compileArrayConstructorCall`)
// — every argument is an element (unlike `Array(n)`, a single numeric arg is NOT
// a length). JS-host mode keeps the `__array_of` path unchanged. Spread args
// keep the host/general path (a standalone spread of Array.of falls through).
//
// This is the contained standalone-construction slice of #1633; the hard
// subclassing / iterable-bridge semantics (Array.from/of via `this`) stay in the
// parent issue.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Mode = { label: string; opts: Record<string, unknown> };
const MODES: Mode[] = [
  { label: "host", opts: {} },
  { label: "standalone", opts: { target: "standalone" } },
];

async function run(src: string, opts: Record<string, unknown>): Promise<unknown> {
  const result = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, ...opts });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "binary should validate").toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

describe("#1633 — Array.of native construction", () => {
  for (const { label, opts } of MODES) {
    describe(`[${label}]`, () => {
      it("Array.of(1,2,3).length === 3", async () => {
        expect(await run("export function test(): number { return Array.of(1, 2, 3).length; }", opts)).toBe(3);
      });

      it("Array.of(5,6,7)[1] === 6", async () => {
        expect(await run("export function test(): number { const a = Array.of(5, 6, 7); return a[1]; }", opts)).toBe(6);
      });

      it("Array.of(5) is [5] (length 1, NOT a length-5 sparse array)", async () => {
        expect(await run("export function test(): number { return Array.of(5).length; }", opts)).toBe(1);
        expect(await run("export function test(): number { return Array.of(9)[0]; }", opts)).toBe(9);
      });

      it("Array.of() is empty", async () => {
        expect(await run("export function test(): number { return Array.of().length; }", opts)).toBe(0);
      });

      it("typed Array.of preserves fractional values", async () => {
        expect(
          await run(
            "export function test(): number { const a: number[] = Array.of(1.5, 2.5); return a[0] * 10; }",
            opts,
          ),
        ).toBe(15);
      });

      it("Array.of of strings", async () => {
        expect(
          await run(
            'export function test(): number { const a = Array.of("a", "bb", "ccc"); return a[2].length; }',
            opts,
          ),
        ).toBe(3);
      });
    });
  }

  it("standalone Array.of emits no __array_of / __js_array_* host import", async () => {
    const result = await compile("export function test(): number { return Array.of(1, 2, 3).length; }", {
      fileName: "test.ts",
      target: "standalone",
    });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const leaked = (result.imports ?? [])
      .filter((i) => i.module === "env")
      .map((i) => i.name)
      .filter((n) => n === "__array_of" || n === "__js_array_new" || n === "__js_array_push");
    expect(leaked).toEqual([]);
  });
});
