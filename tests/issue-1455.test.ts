// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1455 — Subclassing host builtins: `instance instanceof Sub` and
// `instance instanceof Parent` must both pass. Tests cover the externref-backed
// constructor path (`__new_<Parent>(...)`) plus the new `__set_subclass_proto`
// host import that splices `Sub.prototype` into the instance's [[Prototype]]
// chain so the JS engine's `instanceof` semantics produces the right answer.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports as buildRuntimeImports } from "../src/runtime.js";

async function compileAndInstantiate(source: string) {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  if (!WebAssembly.validate(result.binary)) {
    throw new Error(`Invalid Wasm binary (WebAssembly.validate failed)\nWAT:\n${result.wat}`);
  }
  const runtimeResult = buildRuntimeImports(result.imports ?? [], undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, runtimeResult);
  if (runtimeResult.setExports) {
    runtimeResult.setExports(instance.exports as Record<string, Function>);
  }
  return instance.exports as Record<string, Function>;
}

describe("#1455 — subclass builtins: instanceof Sub AND instanceof Parent", () => {
  it("class Subclass extends Map — `any` LHS instanceof Subclass", async () => {
    const source = `
      class Subclass extends Map {}
      function makeIt(): any { return new Subclass(); }
      const sub: any = makeIt();
      export function isSub(): number { return (sub instanceof Subclass) ? 1 : 0; }
      export function isMap(): number { return (sub instanceof Map) ? 1 : 0; }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.isSub!()).toBe(1);
    expect(exports.isMap!()).toBe(1);
  });

  it("class Subclass extends Map — typed LHS still works (regression for #1366a static path)", async () => {
    const source = `
      class Subclass extends Map {}
      const sub = new Subclass();
      export function isSub(): number { return (sub instanceof Subclass) ? 1 : 0; }
      export function isMap(): number { return (sub instanceof Map) ? 1 : 0; }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.isSub!()).toBe(1);
    expect(exports.isMap!()).toBe(1);
  });

  it("class Subclass extends Float32Array — instanceof Subclass AND Float32Array", async () => {
    const source = `
      class Subclass extends Float32Array {}
      function makeIt(): any { return new Subclass(); }
      const sub: any = makeIt();
      export function isSub(): number { return (sub instanceof Subclass) ? 1 : 0; }
      export function isFloat32Array(): number { return (sub instanceof Float32Array) ? 1 : 0; }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.isSub!()).toBe(1);
    expect(exports.isFloat32Array!()).toBe(1);
  });

  it("class Subclass extends WeakRef — instanceof Subclass AND WeakRef", async () => {
    const source = `
      class Subclass extends WeakRef<object> {
        constructor(target: object) { super(target); }
      }
      const target: any = {};
      const sub: any = new Subclass(target);
      export function isSub(): number { return (sub instanceof Subclass) ? 1 : 0; }
      export function isWeakRef(): number { return (sub instanceof WeakRef) ? 1 : 0; }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.isSub!()).toBe(1);
    expect(exports.isWeakRef!()).toBe(1);
  });

  // NOTE: `class Subclass extends DataView { ... new Subclass(new ArrayBuffer(1))}`
  // is tested via test262 directly. The compiler's `new ArrayBuffer(N)` short-circuit
  // (new-super.ts:2303) emits a Wasm-native vec struct rather than calling the
  // `__new_ArrayBuffer` host import, so the local-DataView buffer path doesn't
  // produce a real ArrayBuffer externref. The `__set_subclass_proto` machinery
  // is exercised by the other subclass tests; bridging the ArrayBuffer codegen
  // path is out of scope for #1455 (tracked separately).

  it("class Subclass extends Uint8ClampedArray — instanceof Subclass AND Uint8ClampedArray", async () => {
    const source = `
      class Subclass extends Uint8ClampedArray {}
      function makeIt(): any { return new Subclass(); }
      const sub: any = makeIt();
      export function isSub(): number { return (sub instanceof Subclass) ? 1 : 0; }
      export function isU8C(): number { return (sub instanceof Uint8ClampedArray) ? 1 : 0; }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.isSub!()).toBe(1);
    expect(exports.isU8C!()).toBe(1);
  });

  it("AC6 — instance method on subclass of Map still callable", async () => {
    const source = `
      class X extends Map {
        mine(): number { return 1; }
      }
      export function test(): number {
        const w = new X();
        return w.mine();
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("class Subclass extends Set — `any` LHS instanceof Subclass AND Set", async () => {
    const source = `
      class Subclass extends Set {}
      function makeIt(): any { return new Subclass(); }
      const sub: any = makeIt();
      export function isSub(): number { return (sub instanceof Subclass) ? 1 : 0; }
      export function isSet(): number { return (sub instanceof Set) ? 1 : 0; }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.isSub!()).toBe(1);
    expect(exports.isSet!()).toBe(1);
  });

  it("class Subclass extends WeakMap — `any` LHS instanceof Subclass AND WeakMap", async () => {
    const source = `
      class Subclass extends WeakMap<object, any> {}
      function makeIt(): any { return new Subclass(); }
      const sub: any = makeIt();
      export function isSub(): number { return (sub instanceof Subclass) ? 1 : 0; }
      export function isWeakMap(): number { return (sub instanceof WeakMap) ? 1 : 0; }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.isSub!()).toBe(1);
    expect(exports.isWeakMap!()).toBe(1);
  });

  it("regression #1366a — Error subclass still passes both instanceof checks", async () => {
    const source = `
      class MyError extends Error {
        constructor(msg: string) { super(msg); }
      }
      export function isMyError(): number {
        const e: any = new MyError("oops");
        return (e instanceof MyError) ? 1 : 0;
      }
      export function isError(): number {
        const e: any = new MyError("oops");
        return (e instanceof Error) ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.isMyError!()).toBe(1);
    expect(exports.isError!()).toBe(1);
  });
});
