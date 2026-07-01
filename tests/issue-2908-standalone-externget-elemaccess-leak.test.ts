import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2908 — a dynamic `obj[key]` / `obj.prop` read on an `any`/externref receiver
 * must NOT leak the `env::__extern_get` HOST import in `--target standalone`.
 *
 * Defect (the single largest standalone host-import leak class,
 * `dynamic_object_property`, ~4.5k test262 rows): the AST pre-scan
 * `collectUsedExternImports` (src/codegen/index.ts) eagerly registered
 * `env::__extern_get` as a HOST import for every `obj[idx]` element-access on an
 * externref-typed receiver, WITHOUT a host-free-mode guard. That seeded the name
 * into `funcMap` BEFORE any read-site ran. The compile-path
 * `ensureLateImport(ctx, "__extern_get", …)` routes `OBJECT_RUNTIME_HELPER_NAMES`
 * to the Wasm-NATIVE `ensureObjectRuntime` definition under
 * `ctx.standalone || ctx.wasi` — but it short-circuits on `funcMap.has(name)`, so
 * the pre-seeded host import pre-empted that native routing and the module
 * shipped an unsatisfiable `env::__extern_get`. Harness code
 * (`propertyHelper.js`'s `verifyProperty`, i.e. `obj[name]`) drives this pattern
 * into thousands of tests.
 *
 * Fix: skip the pre-scan host-import registration for `__extern_get` under
 * `ctx.standalone || ctx.wasi`, letting the compile-path `ensureLateImport`
 * bind the native `ensureObjectRuntime` `__extern_get`. Host/gc mode is
 * byte-identical (the guard wraps the unchanged `register(...)` call).
 */

async function buildStandalone(body: string): Promise<{
  result: number;
  envImports: string[];
}> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const envImports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary))
    .filter((i) => i.module === "env")
    .map((i) => i.name);
  const importObject: Record<string, unknown> = {};
  const { instance } = await WebAssembly.instantiate(r.binary, importObject);
  (importObject as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
  const result = (instance.exports as { test(): number }).test();
  return { result, envImports };
}

describe("#2908 — standalone dynamic obj[key] read is host-import-free", () => {
  it("computed key read on an any receiver does not leak env::__extern_get", async () => {
    const { result, envImports } = await buildStandalone(
      `const o: any = { a: 1, b: 2 }; const k: any = "b"; return o[k] as number;`,
    );
    expect(result).toBe(2);
    expect(envImports).not.toContain("__extern_get");
    expect(envImports).toEqual([]);
  });

  it("named property read on an any receiver does not leak env::__extern_get", async () => {
    const { result, envImports } = await buildStandalone(`const o: any = { code: 7 }; return o.code as number;`);
    expect(result).toBe(7);
    expect(envImports).toEqual([]);
  });

  it("verifyProperty-shaped read (obj[name] in a generic helper) is host-free", async () => {
    // Mirrors propertyHelper.js's `verifyProperty` core: an `any`-typed `obj`
    // indexed by an `any`-typed key — the exact harness shape that drove the
    // ~4.5k-row `dynamic_object_property` leak class.
    const { result, envImports } = await buildStandalone(
      `function read(obj: any, name: any): any { return obj[name]; }
       const o: any = { x: 5 };
       return read(o, "x") as number;`,
    );
    expect(result).toBe(5);
    expect(envImports).toEqual([]);
  });

  it("dynamic read of an absent property yields undefined, still host-free", async () => {
    const { result, envImports } = await buildStandalone(
      `const o: any = { a: 1 }; const v: any = o["missing"]; return (v === undefined) ? 1 : 99;`,
    );
    expect(result).toBe(1);
    expect(envImports).toEqual([]);
  });
});
