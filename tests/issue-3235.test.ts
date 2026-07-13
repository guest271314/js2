// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3235 — standalone spurious `env::__make_callback` import leak.
//
// Root cause: `collectCallbackImports` (declarations.ts) sets
// `state.callbackFound = true` for ANY arrow / function-expression anywhere in
// the module, then the finalize step registered `env::__make_callback`
// UNCONDITIONALLY — with no standalone gate (unlike the JSON imports above it or
// the async-CPS detector below it). In standalone / WASI mode there is no JS
// host, so the import can never be satisfied; but the native callback-dispatch
// substrate (#3098 `__apply_closure` / `__hof_*` / `__iter_hof_*`) already
// services every EXERCISED callback host-free, so the eager registration only
// ever DECLARED a never-called import that failed the host-free-pass metric.
//
// Fix (standalone/WASI-gated, JS-host lane byte-identical):
//  1. declarations.ts — gate the `__make_callback` registration on
//     `!(ctx.standalone || ctx.wasi)`.
//  2. closures.ts `compileArrowAsCallback` — if the bridge is unavailable in
//     standalone/WASI, degrade to the native first-class closure struct
//     (`compileArrowAsClosure`) instead of hard-erroring, so no dangling call.
//
// Each assertion instantiates with an EMPTY import object and first asserts the
// module declares ZERO imports — the behaviour is truly HOST-FREE.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile host-free (`target: standalone`), assert 0 imports, run test(). */
async function runStandaloneHostFree(source: string): Promise<unknown> {
  const result: any = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  if (!result.success) {
    throw new Error("compile: " + result.errors.map((e: any) => e.message).join("; "));
  }
  const mod = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(mod);
  // The point of the fix: no `__make_callback` (or any host import) may sneak in.
  expect(imports.map((i) => `${i.module}.${i.name}`)).toEqual([]);
  const instance: any = await WebAssembly.instantiate(mod, {});
  return instance.exports.test();
}

/** Compile host-free and return the declared import names (no run). */
async function standaloneImports(source: string): Promise<string[]> {
  const result: any = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  if (!result.success) {
    throw new Error("compile: " + result.errors.map((e: any) => e.message).join("; "));
  }
  const mod = await WebAssembly.compile(result.binary);
  return WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);
}

const t = (body: string) => `export function test(): number { ${body} }`;

describe("#3235 — standalone spurious __make_callback import leak", () => {
  it("a never-invoked callback argument does NOT declare __make_callback", async () => {
    // The predicate is never called (the value is unused), yet the coarse
    // callbackFound scan used to register the host import defensively.
    const imports = await standaloneImports(t(`const a: any = [1, 2, 3]; const c = (x: any) => x; return a.length;`));
    expect(imports).not.toContain("env.__make_callback");
    expect(imports).toEqual([]);
  });

  it("a plain arrow bound to a variable leaks no host import", async () => {
    expect(await runStandaloneHostFree(t(`const f = (x: number) => x + 1; return f(41);`))).toBe(42);
  });

  it("a function-expression bound to a variable leaks no host import", async () => {
    expect(await runStandaloneHostFree(t(`const f = function (x: number) { return x * 2; }; return f(21);`))).toBe(42);
  });

  it("exercised iterator-helper callbacks stay correct AND host-free (not vacuous)", async () => {
    // find/reduce predicates are genuinely invoked — they must dispatch natively
    // (via #3098 substrate), proving the flip is honest, not a vacuous pass.
    expect(
      await runStandaloneHostFree(
        t(`
          function* gen() { yield 1; yield 2; yield 3; }
          const r = gen().find((x: number) => x === 2);
          const s = gen().reduce((a: number, b: number) => a + b, 0);
          return (r === 2 && s === 6) ? 1 : 0;
        `),
      ),
    ).toBe(1);
  });

  it("array map with a real callback stays correct AND host-free", async () => {
    expect(
      await runStandaloneHostFree(
        t(`const a = [10, 20, 30]; const m = a.map((x) => x * 2); return m[0] + m[1] + m[2];`),
      ),
    ).toBe(120);
  });
});
