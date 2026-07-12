/**
 * #3165 — array-HOF callback `arguments[0]` dropped the element (standalone).
 *
 * The inlined array-method callback dispatch (#820l) plumbs the spec-arity
 * extras through `__argc`/`__extras_argv` so a 0-formal callback's
 * `arguments` still sees (value, index, array). But the extras builder's
 * element slot went through `emitElemBoxToExternref` — a STUB that dropped
 * the loaded element and pushed a null externref, on the (false) claim that
 * a 0-formal callback never reads `arguments[0]`. The test262
 * `predicate-call-parameters` / callbackfn-arguments family does exactly
 *
 *   sample.findIndex(function() { results.push(arguments); return false; });
 *   assert.sameValue(results[0][0], <element>);
 *
 * so `arguments[0]` read as undefined→0 even DIRECTLY inside the callback —
 * the readback was never the bug (the issue's original hypothesis; corrected
 * by WAT diagnosis: `array.get → drop → ref.null.extern` at the extras build,
 * while the index right after it IS boxed via `__box_number`).
 *
 * Fix: box by the backing array's element ValType — f64 via `__box_number`,
 * i32/packed(i8/i16 via array.get_s/u) via convert+box, GC refs via
 * `extern.convert_any`, externref as-is.
 *
 * Residual (separate slice): TypedArray HOFs route through the host
 * `__make_callback` bridge, which cannot set the wasm-side argc/extras
 * globals — the TypedArray predicate-call-parameters family stays failing
 * until that bridge is retired (#2903 family).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHostFree(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "t.ts", target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("; ")).toBe(true);
  if (!r.success) return undefined;
  const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(envImports, `unexpected env imports: ${envImports.join(",")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

async function runHost(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "t.ts", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("; ")).toBe(true);
  if (!r.success) return undefined;
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: unknown) => void }).setExports?.(instance.exports);
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#3165 — HOF callback arguments[0] carries the element (standalone, host-free)", () => {
  it("the test262 predicate-call-parameters shape: element via arguments[0]", async () => {
    expect(
      await runHostFree(`
        var results: any = [];
        var sample = [39, 40, 41];
        sample.findIndex(function() { results.push(arguments); return false; });
        var r0: any = results[0];
        export function test(): number { return r0[0]; }
      `),
    ).toBe(39);
  });

  it("direct read inside the callback (every invocation sees its element)", async () => {
    expect(
      await runHostFree(`
        var sample = [39, 40, 41];
        var sum: any = 0;
        sample.forEach(function() { sum = sum + arguments[0]; });
        export function test(): number { return sum; }
      `),
    ).toBe(120);
  });

  it("index slot (arguments[1]) still correct alongside the element", async () => {
    expect(
      await runHostFree(`
        var results: any = [];
        var sample = [39, 40, 41];
        sample.findIndex(function() { results.push(arguments); return false; });
        var r1: any = results[1];
        export function test(): number { return r1[0] * 10 + r1[1]; }
      `),
    ).toBe(401);
  });

  it("arguments.length stays 3 (spec arity) for a 0-formal callback", async () => {
    expect(
      await runHostFree(`
        var results: any = [];
        var sample = [39, 40, 41];
        sample.findIndex(function() { results.push(arguments); return false; });
        var r0: any = results[0];
        export function test(): number { return r0.length; }
      `),
    ).toBe(3);
  });

  it("typeof arguments[0] is number (not undefined)", async () => {
    expect(
      await runHostFree(`
        var results: any = [];
        var sample = [7, 8];
        sample.every(function() { results.push(arguments); return true; });
        var r0: any = results[0];
        export function test(): number { return typeof r0[0] === "number" ? 1 : 2; }
      `),
    ).toBe(1);
  });

  it("host (gc) lane parity", async () => {
    expect(
      await runHost(`
        var results: any = [];
        var sample = [39, 40, 41];
        sample.findIndex(function() { results.push(arguments); return false; });
        var r0: any = results[0];
        export function test(): number { return r0[0]; }
      `),
    ).toBe(39);
  });
});
