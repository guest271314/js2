// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1797 — native Error `.name` / `.message` read into a native string op
// emitted invalid Wasm.
//
// After #1536 materialized the `$name` field, reading `e.name` (or
// `e.message`) and feeding the result into a native string operation
// (`=== `, `.length`, concat) failed to instantiate in standalone / WASI mode:
//
//   any.convert_extern[0] expected type externref, found ref.cast null of
//   type (ref null 5)
//
// Two root causes, both fixed here:
//   1. The `.name`/`.message` Error fast-path reader (property-access.ts)
//      returned `externref`; in nativeStrings mode the call-argument fixup
//      then re-coerced that one value to `(ref null $AnyString)` once per link
//      of the reader's `local.get; any.convert_extern; ref.cast; struct.get`
//      chain (the backward walk in `fixCallArgTypesInBody` treats each delta-0
//      transformer as a separate producer for the same arg slot). The 2nd+
//      `any.convert_extern` then received an already-cast `(ref null
//      $AnyString)` operand → invalid Wasm. Fixed by (a) deduping coercion
//      insertions per insert-position in `fixCallArgTypesInBody`, and (b)
//      having the Error reader return a `$AnyString` ref directly so consumers
//      need no externref coercion.
//   2. The `string.length` reader did a bare `struct.get $AnyString 0` on the
//      receiver; with an externref receiver that validated against the wrong
//      operand type. It now coerces an externref receiver first.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "wasi" });
  expect(r.success).toBe(true);
  // Standalone / WASI Error path requires no host imports — instantiate clean.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => number }).test!();
}

describe("#1797 — native Error `.name`/`.message` read into string ops", () => {
  it('`new TypeError(x).name === "TypeError"` evaluates to true (valid Wasm)', async () => {
    const got = await runStandalone(
      `export function test(): number { const e = new TypeError("oops"); return e.name === "TypeError" ? 1 : 0; }`,
    );
    expect(got).toBe(1);
  });

  it('distinct error names do not cross-talk (RangeError.name !== "TypeError")', async () => {
    const got = await runStandalone(
      `export function test(): number { const e = new RangeError("x"); return e.name === "TypeError" ? 1 : 0; }`,
    );
    expect(got).toBe(0);
  });

  it('each subclass reports its own name (RangeError.name === "RangeError")', async () => {
    const got = await runStandalone(
      `export function test(): number { const e = new RangeError("x"); return e.name === "RangeError" ? 1 : 0; }`,
    );
    expect(got).toBe(1);
  });

  it("`new Error(x).name.length` evaluates to 5 (host-free)", async () => {
    const got = await runStandalone(
      `export function test(): number { const e = new Error("x"); return e.name.length; }`,
    );
    expect(got).toBe(5);
  });

  it("`.message` composes with `===` the same way", async () => {
    const got = await runStandalone(
      `export function test(): number { const e = new TypeError("oops"); return e.message === "oops" ? 1 : 0; }`,
    );
    expect(got).toBe(1);
  });

  it('`.name` composes with concat (`e.name + "!"`)', async () => {
    // "TypeError" (9) + "!" (1) = 10
    const got = await runStandalone(
      `export function test(): number { const e = new TypeError("oops"); const s = e.name + "!"; return s.length; }`,
    );
    expect(got).toBe(10);
  });

  it("emits no env.* host imports for the error string-op path", async () => {
    const r = await compile(
      `export function test(): number { const e = new TypeError("oops"); return e.name === "TypeError" ? 1 : 0; }`,
      { target: "wasi" },
    );
    expect(r.success).toBe(true);
    const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
    expect(envImports).toEqual([]);
  });
});
