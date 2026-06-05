// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1866 — a `--target standalone` build must NOT leak an `env::__extern_get`
// host import (it is undefined under a bare WASI runtime and breaks the
// zero-JS-host guarantee). The externref destructuring bypass sites
// (destructureParamObjectExternref, compileDestructuringAssignment,
// compileExternrefArrayDestructuringAssignment, the two for-of-assign
// helpers) previously registered `__extern_get` via a raw
// `addImport("env", …)`, which leaked the host import even under
// `ctx.standalone`. The fix routes them through `ensureLateImport`, which
// under `--target standalone` resolves to the Wasm-native object-runtime impl
// (in OBJECT_RUNTIME_HELPER_NAMES) — no `env::` import. Same residual-host-leak
// class as the just-landed #1203.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

function envImports(bytes: Uint8Array): string[] {
  const mod = new WebAssembly.Module(bytes);
  return WebAssembly.Module.imports(mod)
    .filter((i) => i.module === "env")
    .map((i) => i.name);
}

describe("#1866 standalone externref-destructuring does not leak env::__extern_get", () => {
  it("object-destructuring param over an `any` value compiles standalone with no env:: import", async () => {
    // Routes through destructureParamObjectExternref → the `__extern_get`
    // bypass site. The param is `any`, so codegen takes the externref
    // dynamic-read path that used to emit `env::__extern_get`.
    const src = `function f({ a, b }: any): number { return a + b; }
      export function test(): number { const x: any = { a: 5, b: 6 }; return f(x); }`;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, r.errors[0]?.message).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    expect(mod).toBeDefined();
    const env = envImports(r.binary);
    expect(env, `leaked env imports: ${env.join(", ")}`).not.toContain("__extern_get");
    // Stronger zero-JS-host assertion: NO env:: import at all.
    expect(env).toEqual([]);
  });
});
