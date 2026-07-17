// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3311 (G4) — `string[]` push/pop must work under `--target standalone`.
//
// The carrier-generic `__vec_push` / `__vec_pop` / `__vec_set_elem` helpers
// (src/codegen/vec-access-exports.ts, vec-define-writeback.ts) covered only the
// externref / f64 / i32 element carriers. The native-string vec carrier — the
// standalone rep of `string[]`, a WasmGC `(array (mut (ref null $AnyString)))`
// keyed `ref_${anyStrTypeIdx}` — was absent from the `mutEntries` set, so
// `__vec_push` returned the `-1` unsupported sentinel (mapped to `undefined` by
// the `$__vec_base` brand arm) and `(a as any).push("x")` on a `string[]` was a
// SILENT NO-OP standalone; `__vec_pop` returned `undefined`.
//
// Fix: admit the native-string carrier (`nativeStrVecElemTypeIdx`) — push casts
// the boxed externref value back to `ref $AnyString` (`any.convert_extern` +
// `ref.cast`, no numeric unbox) before `array.set`; pop boxes the popped
// `ref $AnyString` via `extern.convert_any`. The gc-host lane is unaffected
// (`string[]` there uses the `wasm:js-string` push path, not this vec carrier).
//
// A standalone module instantiates against an EMPTY import object, and a string
// export is an opaque `ref $AnyString` from JS, so every assertion is checked
// IN-WASM and returned as a number/boolean.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "standalone module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

async function runGc(src: string): Promise<unknown> {
  const r = await compile(src, {});
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: object) => void }).setExports?.(instance.exports as object);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#3311 — standalone string[] push", () => {
  it("push grows the length", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = ["a", "b"];
        a.push("c");
        return a.length;
      }`),
    ).toBe(3);
  });

  it("push returns the new length", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = ["a", "b"];
        return a.push("c");
      }`),
    ).toBe(3);
  });

  it("the pushed element is readable at its index", async () => {
    expect(
      await runStandalone(`export function test(): boolean {
        const a: any = ["a", "b"];
        a.push("c");
        return a[2] === "c";
      }`),
    ).toBe(1);
  });

  it("multiple pushes append in order", async () => {
    expect(
      await runStandalone(`export function test(): boolean {
        const a: any = ["a"];
        a.push("b");
        a.push("c");
        return a.length === 3 && a[1] === "b" && a[2] === "c";
      }`),
    ).toBe(1);
  });

  it("push onto an empty string array works (grow from 0)", async () => {
    expect(
      await runStandalone(`export function test(): boolean {
        const a: string[] = [];
        (a as any).push("x");
        return a.length === 1 && a[0] === "x";
      }`),
    ).toBe(1);
  });
});

describe("#3311 — standalone string[] pop", () => {
  it("pop returns the last element", async () => {
    expect(
      await runStandalone(`export function test(): boolean {
        const a: any = ["a", "b", "c"];
        return a.pop() === "c";
      }`),
    ).toBe(1);
  });

  it("pop shrinks the length", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = ["a", "b", "c"];
        a.pop();
        return a.length;
      }`),
    ).toBe(2);
  });

  it("push then pop round-trips", async () => {
    expect(
      await runStandalone(`export function test(): boolean {
        const a: any = ["a", "b"];
        a.push("z");
        const popped = a.pop();
        return popped === "z" && a.length === 2 && a[1] === "b";
      }`),
    ).toBe(1);
  });
});

describe("#3311 — standalone string[] push/pop is host-import-free", () => {
  it("no env imports for a push/pop program", async () => {
    const r = await compile(
      `export function test(): number {
         const a: any = ["a", "b"];
         a.push("c");
         a.pop();
         return a.length;
       }`,
      { target: "standalone" },
    );
    expect(r.success).toBe(true);
    const env = WebAssembly.Module.imports(new WebAssembly.Module(r.binary))
      .filter((i) => i.module === "env")
      .map((i) => i.name);
    expect(env, `unexpected env imports: ${env.join(", ")}`).toEqual([]);
  });
});

describe("#3311 — gc-host string[] push/pop unaffected", () => {
  it("gc-host push/pop still works (different, js-string path)", async () => {
    expect(
      await runGc(`export function test(): number {
        const a: string[] = ["a", "b"];
        a.push("c");
        a.pop();
        a.push("d");
        return a.length;
      }`),
    ).toBe(3);
  });
});
