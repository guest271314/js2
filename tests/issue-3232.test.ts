// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3232 — Standalone: static private ACCESSOR setter emitted invalid Wasm.
//
// A `static set #name(v)` accessor invoked via `this.#name = value` inside a
// static method lowered the setter-call RECEIVER (`this` in a static method →
// an `externref` static-class carrier) WITHOUT coercing it to the accessor's
// declared self-param struct ref. On the standalone / `nativeStrings` lane the
// call then pushed an `externref` where the callee declared `(ref null $Class)`,
// so instantiation failed with:
//
//   Compiling function "C_setPrivateReference" failed:
//   call[0] expected type (ref …), found global.get of type externref
//
// The getter side (`this.#name` read) already coerced its receiver, so only the
// setter callsite was asymmetric. The fix (assignment.ts) coerces the receiver
// to the setter's self-param type before the call, standalone/wasi-gated so the
// gc/host lane stays byte-identical. Matches the 10 test262 cases in
// language/statements/class/elements/private-accessor-name/static-private-*.
//
// The bug needs the test262 harness VALUE-TYPE flow to reproduce: an untyped
// `var stringSet;` (→ `any`) with untyped accessor params makes both the
// receiver and value cross the externref channel. A fully string-typed shape
// compiles clean on both lanes even without the fix.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// The exact minimal shape derived from static-private-name-common.js: untyped
// module var, untyped accessor params, a static private get+set accessor, and
// both a getter-reading and a setter-writing static method.
const SOURCE = `
var stringSet;
class C {
  static get #test262() { return 'get string'; }
  static set #test262(param) { stringSet = param; }
  static getPrivateReference() { return this.#test262; }
  static setPrivateReference(value) { this.#test262 = value; }
}
export function test(): number {
  const g = C.getPrivateReference();
  C.setPrivateReference('set string');
  return (g === 'get string' && stringSet === 'set string') ? 1 : 0;
}`;

describe("#3232 static private accessor setter — standalone valid Wasm", () => {
  it("compiles to valid Wasm on the wasi (nativeStrings) lane", async () => {
    const result = await compile(SOURCE, { target: "wasi", fileName: "issue-3232.ts" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    // The regression was invalid Wasm at the C_setPrivateReference callsite.
    await expect(WebAssembly.compile(result.binary)).resolves.toBeDefined();
  });

  it("runs correctly on the standalone lane (getter reads, setter writes)", async () => {
    const result = await compile(SOURCE, { target: "standalone", fileName: "issue-3232.ts" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const value = (instance.exports as Record<string, () => number>).test();
    expect(value).toBe(1);
  });

  it("gc/host lane still compiles the same shape", async () => {
    const result = await compile(SOURCE, { fileName: "issue-3232.ts" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    await expect(WebAssembly.compile(result.binary)).resolves.toBeDefined();
  });
});
