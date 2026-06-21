// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2580 M1a) `.length` on a statically-`any`/`unknown` receiver.
//
// The host `.length`-on-`any` value-semantics fix (a plain object's absent
// `length` should read as `undefined`, not `0`) was attempted as M1a's dynamic
// read arm but EJECTED from the merge_group with 13 regressions, and the faithful
// test262 runner proved it is NOT a surgical slice: the genuinely-dynamic `any`
// receivers (host-builtin functions via Symbol-keyed prototype walks;
// `$AnyValue`-boxed for-await array-rest bindings) are RUNTIME-INDISTINGUISHABLE
// from a plain `{}`-absent-length at the bare-externref level — they all reach
// `__extern_get`→undefined→NaN where the prior numeric path returned a usable
// value, and the canary needs that SAME undefined to stay undefined. Only a
// TAG-AWARE reader (inspecting the boxed `$AnyValue` tag) can separate them, which
// is M2's first primitive. So M1a lands the M0 scaffold (`ensureDynReadHelpers` /
// `emitDynGet`, registered for M2 to call) with the host `.length`-on-`any` arm
// OFF — the value-semantics fix moves to M2.
//
// This suite therefore asserts what M1a ACTUALLY delivers: the TYPED `.length`
// hot-path is unchanged/correct, and the M0 scaffold is inert (no behavioral
// change vs origin). The `{}.length === undefined` value-semantics assertion lives
// in M2's acceptance, not here.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error("compile error: " + result.errors.map((e) => e.message).join("; "));
  }
  if (!WebAssembly.validate(result.binary)) throw new Error("invalid wasm");
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  // setExports wires host closures back to the instance (no-op when absent).
  (imports as { setExports?: (e: WebAssembly.Exports) => void }).setExports?.(instance.exports);
  return (instance.exports as { run: () => unknown }).run();
}

describe("#2580 M1a — typed .length hot-path unchanged (value-semantics deferred to M2)", () => {
  // Typed `.length` must remain correct — M1a's arm-off must not perturb the
  // typed hot-path (it never did; these are the byte-identical guards).
  it("typed number[].length", async () => {
    expect(await run(`const o: number[] = [1, 2, 3]; export function run(): number { return o.length; }`)).toBe(3);
  });

  it("typed string.length", async () => {
    expect(await run(`const o: string = "abc"; export function run(): number { return o.length; }`)).toBe(3);
  });

  it("arguments.length", async () => {
    expect(
      await run(
        `function f(): number { return arguments.length; } export function run(): number { return f(1, 2, 3); }`,
      ),
    ).toBe(3);
  });

  // An `any`-typed local holding a real array still reads its `.length` correctly
  // via the origin path (the compiled receiver is a vec struct → struct.get field
  // 0). This is the case the dynamic-read arm must NOT clobber — confirmed it
  // still works with the arm off.
  it("array-as-any .length reads the real numeric length (origin path)", async () => {
    expect(await run(`const o: any = [1, 2, 3]; export function run(): number { return o.length as number; }`)).toBe(3);
  });

  it("string-as-any .length reads the string length (origin path)", async () => {
    expect(await run(`const o: any = "abcd"; export function run(): number { return o.length as number; }`)).toBe(4);
  });

  it("array-like plain object with an own .length property reads it (origin path)", async () => {
    expect(
      await run(`const o: any = { length: 5 }; export function run(): number { return o.length as number; }`),
    ).toBe(5);
  });
});
