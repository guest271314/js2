// #3048 — "Missing __make_getter_callback import" CE (#1027 resurgence).
//
// The `__make_getter_callback` late-import (the `this`-binding closure maker for
// object-literal accessor/method values) is registered by the AST pre-pass
// `collectCallbackImports` (declarations.ts). Two families of bridge-routed
// object shapes were invisible to that scan, so the import was never added and
// the inline getter/method codegen (closures.ts) hit a hard compile error
// "Missing __make_getter_callback import":
//
//   1. Non-plain-literal computed-property METHODS — the well-known-`Symbol`
//      arm (`{ [Symbol.iterator]() {} }`) and the runtime-key arm
//      (`{ [ID(2)]() {} }`). The pre-pass only registered the bridge for the
//      `dispose`/`asyncDispose` arm. A plain numeric/string-literal key
//      (`{ [1]() {} }`) resolves to a static method name and takes the
//      bridge-free struct path, so it (correctly) needs no registration.
//   2. Accessors reached through a compiled `eval("o = {get foo(){…}}")`
//      constant string — the getter lives inside the eval SOURCE STRING, which
//      the outer-file pre-pass never sees. Fixed in the static-eval-inline path
//      (eval-inline.ts) by scanning the parsed eval AST and registering the
//      bridge before compiling the spliced statements.
//
// Both fixes are host/GC-only: under standalone/WASI the accessor/method lowers
// to a host-free closure (#1888 S5b / #2194), so the unsatisfiable `env::`
// bridge import must NOT be declared there.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileOk(src: string, target?: "standalone") {
  const r = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    ...(target ? { target } : {}),
  });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("; ")).toBe(true);
  expect(WebAssembly.validate(r.binary), "emitted a valid Wasm binary").toBe(true);
  return r;
}

function hasMakeGetterCallbackImport(r: Awaited<ReturnType<typeof compile>>): boolean {
  return r.imports.some((i) => i.module === "env" && i.name === "__make_getter_callback");
}

describe("#3048 __make_getter_callback registered for object-literal accessor/method shapes", () => {
  // Direct (non-eval) shapes — validated in BOTH lanes: they previously failed
  // with "Missing __make_getter_callback import" in host/GC, and must compile
  // host-free (no bridge import) in standalone.
  const directShapes: Array<[string, string]> = [
    ["object getter", `var o = { get foo() { return 1; } };`],
    ["object setter", `var o = { _v: 0, set foo(x: number) { this._v = x; } };`],
    ["well-known-symbol method", `var o = { [Symbol.iterator]() { return 0 as any; } };`],
    ["runtime computed method", `function ID(x: any) { return x; } var o = { [ID(2)]() { return 9; } };`],
  ];

  for (const [name, decl] of directShapes) {
    const src = `${decl}\nexport function test(): number { return 0; }`;
    it(`compiles the ${name} shape to a valid binary (host/GC lane)`, async () => {
      await compileOk(src);
    });
    it(`compiles the ${name} shape to a valid binary (standalone lane)`, async () => {
      // Standalone must NOT declare the unsatisfiable env bridge import.
      const r = await compileOk(src, "standalone");
      expect(hasMakeGetterCallbackImport(r), "standalone must not leak env::__make_getter_callback").toBe(false);
    });
  }

  // Eval-embedded shapes — the fix targets the JS-host / GC inline-eval path
  // (that is where the "Missing __make_getter_callback import" CE originated).
  // The standalone inline-eval lane has separate, pre-existing limitations for
  // accessor bodies, out of scope here, so these are host-lane only.
  const evalShapes: Array<[string, string]> = [
    ["getter inside eval", `eval("o2 = { get foo() { return 1; } };");`],
    ["computed method inside eval", `function ID(x: any) { return x; } eval("o3 = { [ID(2)]() { return 9; } };");`],
  ];

  for (const [name, decl] of evalShapes) {
    const src = `${decl}\nexport function test(): number { return 0; }`;
    it(`compiles the ${name} shape to a valid binary (host/GC lane)`, async () => {
      await compileOk(src);
    });
  }

  // Regression guard: a plain numeric/string-literal computed method key takes
  // the bridge-free struct path — it must still compile and must NOT drag in the
  // bridge import in either lane.
  it("does not over-register the bridge for a plain-literal computed key", async () => {
    const src = `var o = { [1]() { return 9; }, ["x"]() { return 8; } };\nexport function test(): number { return 0; }`;
    for (const target of [undefined, "standalone"] as const) {
      const r = await compileOk(src, target);
      expect(hasMakeGetterCallbackImport(r), `plain-literal keys need no bridge (${target ?? "host"})`).toBe(false);
    }
  });

  // Round-trip: in the standalone lane (empty imports) the getter value is
  // reachable and returns its computed result — the accessor path stays sound.
  it("object getter round-trips in the standalone lane", async () => {
    const r = await compileOk(
      `var o = { get foo() { return 42; } };\nexport function test(): number { return o.foo; }`,
      "standalone",
    );
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test?: () => unknown }).test?.()).toBe(42);
  });
});
