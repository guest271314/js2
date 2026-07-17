// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2948 — standalone: chained dynamic add in lifted foreign bodies (regression lock).
//
// In a lifted foreign body (a `ts.createSourceFile` splice with no checker
// bindings — the #2923 constant-`eval` lift and the #2924 constant-`Function`
// compile-away), parameters degrade to externref (`any`). A single dynamic add
// of two such params worked, but the RESULT of one any-add used to be unable to
// feed a SECOND any-add — the second add saw an operand rep it could not
// ToNumber and produced NaN (standalone only; host mode always computed
// correctly). The #745 tagged-union value-rep substrate work (carrier-agnostic
// strict-eq / truthiness / concat / arithmetic for the $AnyValue union) closed
// that gap: chained any-add in lifted foreign bodies now computes correctly
// host-free. This test locks criteria 1 & 2 of #2948.
//
// (Acceptance criterion 3 — `typeof` on a boxed-number param inside a lifted
// foreign body still misreports "undefined" — is an INDEPENDENT value-rep layer
// and is tracked separately as #3345, as the issue anticipated.)
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  // Standalone modules must instantiate with NO import object (host-free).
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2948 — chained any-add in lifted foreign bodies (standalone)", () => {
  it("eval-lifted function body: a+b+c === 6", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return eval("function q(a,b,c){return a+b+c} q(1,2,3)") as number; }`,
      ),
    ).toBe(6);
  });

  it("new Function 3-arg chained add: return a+b+c === 6", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return (new Function("a","b","c","return a+b+c") as any)(1,2,3); }`,
      ),
    ).toBe(6);
  });

  it("new Function via local: var t=a+b; return t+c === 6", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return (new Function("a","b","c","var t=a+b; return t+c") as any)(1,2,3); }`,
      ),
    ).toBe(6);
  });

  it("new Function grouped: return a+(b+c) === 6", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return (new Function("a","b","c","return a+(b+c)") as any)(1,2,3); }`,
      ),
    ).toBe(6);
  });

  it("control: single any-add (a+b) still === 3", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return (new Function("a","b","return a+b") as any)(1,2); }`,
      ),
    ).toBe(3);
  });
});
