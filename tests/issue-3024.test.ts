// (#3024) Nested object-destructuring whose nested pattern DEFAULT is an object
// literal that SHARES an anonymous struct with the destructured RHS sub-object
// but carries MORE fields produced invalid Wasm ("struct.new need N, got N-1").
//
// Root cause: `ensureComputedPropertyFields` grows the shared struct when the
// larger default literal compiles, and the field-pad `patchStructNewForAddedField`
// walks only `fctx.body` + `savedBodies` + `liveBodies`. The RHS (or param OUTER
// default) `struct.new` sits in an ORPHANED outer body — swapped off `fctx.body`
// by a plain JS-local swap that never lands on `savedBodies` — so it was left one
// operand short of the grown field count. The fix registers that outer body in
// `ctx.liveBodies` for the destructure window (var-decl: statements/
// destructuring.ts; function/nested-function params: function-body.ts /
// statements/nested-declarations.ts), mirroring the #2503/#2158 param-branch
// fixes.
//
// `WebAssembly.compile` here is load-bearing: the bug was a *validation* failure,
// so a plain compile()-succeeds assertion would not catch it — the binary must
// pass Wasm validation. Runtime checks confirm the value semantics are correct,
// not merely that the module validates.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<number> {
  const r = await compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // The regression was invalid-Wasm emission — assert the binary VALIDATES.
  await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  const imports = buildImports(r.imports, undefined, r.stringPool) as WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: unknown) => void }).setExports?.(instance.exports);
  return (instance.exports as Record<string, () => number>).test();
}

describe("#3024 nested-object-destructuring shared-struct growth", () => {
  it("var-decl: nested pattern default omits a field the RHS sub-object also omits", async () => {
    // `w` is present, so the nested pattern default does NOT fire; z comes from
    // the RHS. `y` is absent from the RHS sub-object `{ x, z }`, whose 2-field
    // anonymous struct the 3-field default `{ x, y, z }` later GROWS — the exact
    // sequence that orphaned the RHS `struct.new` before this fix.
    const got = await run(`export function test(): number {
      const { w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: undefined, z: 7 } };
      return z;
    }`);
    expect(got).toBe(7);
  });

  it("var-decl: nested pattern default fires when the outer property is missing", async () => {
    const got = await run(`export function test(): number {
      const { w: { x, y, z } = { x: 4, y: 5, z: 6 } } = {} as any;
      return x + y + z; // 4 + 5 + 6
    }`);
    expect(got).toBe(15);
  });

  it("function param: outer default sub-object shares a struct with the nested default", async () => {
    // Argument omitted → the param OUTER default `{ w: { x, z } }` materialises
    // in the prologue; its 2-field sub-object shares the struct that the nested
    // 3-field default grows. z comes from the outer default's sub-object.
    const got =
      await run(`function f({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: undefined, z: 7 } }): number {
        return z;
      }
      export function test(): number { return f(); }`);
    expect(got).toBe(7);
  });

  it("function param: passing a full object bypasses both defaults", async () => {
    const got =
      await run(`function f({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: undefined, z: 7 } }): number {
        return x + y + z;
      }
      export function test(): number { return f({ w: { x: 1, y: 2, z: 9 } } as any); }`);
    expect(got).toBe(12); // 1 + 2 + 9
  });
});
