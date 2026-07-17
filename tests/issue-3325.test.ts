// #3325 — `declare function` host-dep call silently dropped.
//
// A user-level ambient host function (`declare function f(...)`) is compiled to
// an `env.f` import and the call site DOES emit `call $f_import` (codegen never
// dropped the call). But `buildImports` classified the import as a `builtin`
// intent, fell through every internal-helper special-case, and resolved it to a
// no-op — silently ignoring any `deps` the embedder supplied. This is the
// natural FFI for embedders, so a dropped call is worse than a compile error.
//
// The fix wires the fallback to `deps[name]` when present, and turns a missing
// dep for a user-facing (non-`__`) ambient name into a lazy, clear TypeError
// (thrown WHEN CALLED, so a declared-but-unused import can't break linking).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runWithDeps(src: string, deps: Record<string, unknown>): Promise<number | undefined> {
  const result = await compile(src, { fileName: "t.ts" });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const imports = buildImports(result.imports, deps, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return (instance.exports.test as (() => number) | undefined)?.();
}

describe("#3325 — ambient declare function host-dep wiring", () => {
  it("runs the supplied dep with the marshaled numeric arg", async () => {
    let captured: unknown = null;
    const ret = await runWithDeps(
      `declare function inspect(u: any): void;
       export function test(): number { inspect(7); return 5; }`,
      {
        inspect: (v: unknown) => {
          captured = v;
        },
      },
    );
    expect(ret).toBe(5);
    expect(captured).toBe(7);
  });

  it("runs the supplied dep with a string arg", async () => {
    let captured: unknown = null;
    const ret = await runWithDeps(
      `declare function log(s: any): void;
       export function test(): number { log("hi"); return 1; }`,
      {
        log: (v: unknown) => {
          captured = v;
        },
      },
    );
    expect(ret).toBe(1);
    expect(captured).toBe("hi");
  });

  it("invokes the dep once per call site", async () => {
    const seen: unknown[] = [];
    const ret = await runWithDeps(
      `declare function sink(u: any): void;
       export function test(): number { sink(1); sink(2); sink(3); return 9; }`,
      {
        sink: (v: unknown) => {
          seen.push(v);
        },
      },
    );
    expect(ret).toBe(9);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("a missing dep for a called ambient function throws a clear error (not a silent no-op)", async () => {
    await expect(
      runWithDeps(
        `declare function frobnicate(u: any): void;
         export function test(): number { frobnicate(1); return 9; }`,
        {},
      ),
    ).rejects.toThrow(/Missing host dependency for ambient declaration "frobnicate"/);
  });

  it("a declared-but-unused ambient function with no dep does NOT break instantiation", async () => {
    const ret = await runWithDeps(
      `declare function unused(u: any): void;
       export function test(): number { return 42; }`,
      {},
    );
    expect(ret).toBe(42);
  });

  it("a non-function dep value is exposed rather than dropped", async () => {
    // `Number(dep())`-style: the ambient function returns the injected value.
    const ret = await runWithDeps(
      `declare function answer(): number;
       export function test(): number { return answer(); }`,
      { answer: 42 },
    );
    expect(ret).toBe(42);
  });
});
