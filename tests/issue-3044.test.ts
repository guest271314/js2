// #3044 — `Math.<inheritedObjectMethod>()` crashed codegen with
// "op.endsWith is not a function".
//
// Root cause: `compileMathCall` dispatched its six native-unary opcodes
// (`abs`/`sqrt`/`floor`/`ceil`/`trunc`/`nearest`) through
// `if (method in nativeUnary) …`. The `in` operator walks the prototype chain,
// so an inherited `Object.prototype` name reaching this call —
// `Math.hasOwnProperty("prop")`, `Math.toString()`, `Math.valueOf()`,
// `Math.isPrototypeOf(x)`, `Math.propertyIsEnumerable(x)`, `Math.constructor` —
// spuriously matched the table and pushed `{ op: nativeUnary[method] }`, where
// `nativeUnary["hasOwnProperty"]` is the *inherited function*, not a string.
// That non-string `op` survived into the stack-balance pass, whose
// `op.endsWith(".load")` then threw, aborting the whole module compile
// (test262 `built-ins/Object/defineProperty/15.2.3.6-4-{411,587}.js`,
// `defineProperties/15.2.3.7-6-a-17.js` — all `compile_error`).
//
// Fix: dispatch with `Object.hasOwn(nativeUnary, method)` (own-property
// semantics) so only the six genuine native-unary methods match; every other
// name falls through to `return undefined` → generic call handling, which
// resolves `Math.hasOwnProperty` etc. correctly. This is strictly a narrowing —
// the real math methods (own props) still match, and the inherited-name path it
// removes only ever produced an invalid module — so it cannot regress a
// previously-passing test.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileOk(src: string, target?: "standalone") {
  const r = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    ...(target ? { target } : {}),
  });
  // The crux of the regression: compilation must not throw or fail internally.
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("; ")).toBe(true);
  expect(WebAssembly.validate(r.binary), "emitted a valid Wasm binary").toBe(true);
  return r;
}

async function runStandalone(body: string): Promise<unknown> {
  const r = await compileOk(`export function test(): number {\n${body}\n}`, "standalone");
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#3044 Math.<inherited Object.prototype method>() no longer crashes codegen", () => {
  // Each of these previously pushed a non-string `op` and crashed the compiler.
  const inheritedCalls: Array<[string, string]> = [
    ["hasOwnProperty", `export function test(): number { return Math.hasOwnProperty("prop") ? 1 : 0; }`],
    ["toString", `export function test(): number { return typeof Math.toString === "function" ? 1 : 0; }`],
    ["valueOf", `export function test(): number { return typeof Math.valueOf === "function" ? 1 : 0; }`],
    ["isPrototypeOf", `export function test(): number { return Math.isPrototypeOf(Math) ? 1 : 0; }`],
    ["propertyIsEnumerable", `export function test(): number { return Math.propertyIsEnumerable("PI") ? 1 : 0; }`],
  ];

  for (const [name, src] of inheritedCalls) {
    it(`compiles Math.${name}(...) to a valid binary in the host lane`, async () => {
      await compileOk(src);
    });
    it(`compiles Math.${name}(...) to a valid binary in the standalone lane`, async () => {
      await compileOk(src, "standalone");
    });
  }

  // §19.2 — `prop` is defined on `Object.prototype`, so `Math` does not own it.
  // This is exactly test262 `15.2.3.6-4-411.js`, which flips compile_error→pass.
  it("Math.hasOwnProperty returns false for a non-own (inherited) property", async () => {
    expect(await runStandalone(`return Math.hasOwnProperty("no_such_own_prop") ? 1 : 0;`)).toBe(0);
  });

  // Guard: the genuine native-unary Math methods (own props of the table) still
  // dispatch to their f64 opcodes — the narrowing must not touch them.
  it("keeps the native-unary Math opcodes working", async () => {
    expect(await runStandalone(`return Math.abs(-5);`)).toBe(5);
    expect(await runStandalone(`return Math.sqrt(16);`)).toBe(4);
    expect(await runStandalone(`return Math.floor(3.9);`)).toBe(3);
    expect(await runStandalone(`return Math.ceil(3.1);`)).toBe(4);
  });
});
