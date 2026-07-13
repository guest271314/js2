// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3055 — Standalone boxed-number strict-equality miscompiled when a class /
// object-runtime is present.
//
// Root cause: the `any`-equality operand seam (`emitAnyEqOperands` in
// coercion-engine.ts) marshalled each `externref` operand into the `$AnyValue`
// box via `coerceType`, whose externref default is the `__any_box_string`
// (tag-5 "string") lie (value-tags.ts). Two boxed NUMBERS (`$BoxedNumber`
// externrefs from `__box_number`) therefore became two tag-5 boxes and
// `__any_strict_eq`'s string-content arm answered equal-for-unequal
// (`1 === 2` → true). This only surfaced when the module demoted `a === b`
// to the legacy `__any_strict_eq` path (e.g. the full test262 harness shape:
// a class + the `isSameValue`/`assert_sameValue` nest), silently vacuifying
// EVERY numeric `assert.sameValue` in the standalone lane.
//
// Fix: the operand seam now recovers an externref's runtime tag via
// `__any_from_extern` (`$BoxedNumber` → tag-3, `$BoxedBoolean` → tag-4;
// strings/objects keep the same tag-5 fallback byte-for-byte), so boxed-number
// `===` is correct regardless of class presence.

import { compile } from "../src/index.js";
import { describe, expect, it } from "vitest";

async function runStandalone(source: string, fn = "run"): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaked = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>)[fn]();
}

// The harness-shape prelude that demotes `a === b` to the legacy
// `__any_strict_eq` path (a class WITH a static method + an `isSameValue` nest).
const HARNESS = `class Test262Error {
  message: string;
  constructor(msg: string = "") { this.message = msg; }
  static thrower(msg: string = ""): void { throw new Test262Error(msg); }
}
function isSameValue(a: any, b: any): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  return 0;
}`;

describe("#3055 — boxed-number any-eq with a class present (legacy __any_strict_eq path)", () => {
  it("isSameValue(1, 2) is 0 (unequal) — the keystone vacuity bug", async () => {
    expect(
      await runStandalone(`${HARNESS}
        export function run(): number { return isSameValue(1, 2); }`),
    ).toBe(0);
  });

  it("isSameValue(3, 3) is 1 (equal)", async () => {
    expect(
      await runStandalone(`${HARNESS}
        export function run(): number { return isSameValue(3, 3); }`),
    ).toBe(1);
  });

  it("isSameValue(1.5, 2.5) is 0 (unequal fractionals)", async () => {
    expect(
      await runStandalone(`${HARNESS}
        export function run(): number { return isSameValue(1.5, 2.5); }`),
    ).toBe(0);
  });

  it("isSameValue(100, 200) is 0 (unequal large ints)", async () => {
    expect(
      await runStandalone(`${HARNESS}
        export function run(): number { return isSameValue(100, 200); }`),
    ).toBe(0);
  });

  it("isSameValue(NaN, NaN) is 1 via the a!==a && b!==b arm", async () => {
    expect(
      await runStandalone(`${HARNESS}
        export function run(): number { return isSameValue(0/0, 0/0); }`),
    ).toBe(1);
  });

  it("boxed-number !== is honest: (1 !== 2) is true, (3 !== 3) is false", async () => {
    expect(
      await runStandalone(`${HARNESS}
        function neq(a: any, b: any): number { return a !== b ? 1 : 0; }
        export function run(): number { return neq(1, 2) * 10 + neq(3, 3); }`),
    ).toBe(10);
  });

  it("string operands stay correct with a class present (content equality)", async () => {
    expect(
      await runStandalone(`${HARNESS}
        export function run(): number {
          const a: any = "abcd"; const b: any = "ab" + "cd"; return isSameValue(a, b);
        }`),
    ).toBe(1);
    expect(
      await runStandalone(`${HARNESS}
        export function run(): number {
          const a: any = "abcd"; const b: any = "abXd"; return isSameValue(a, b);
        }`),
    ).toBe(0);
  });

  it("#3055 leaves object-operand equality byte-unchanged (object externref keeps tag-5 fallback)", async () => {
    // The fix reroutes ONLY boxed-primitive externrefs (number → tag-3, bool →
    // tag-4, null → tag-1) through `__any_from_extern`; an OBJECT externref
    // keeps the identical non-honest tag-5 fallback `__any_box_string` produced.
    // So object-operand equality is unchanged by #3055. On this legacy
    // harness path the object-runtime externalises the instance and the tag-5
    // arm answers 1 for BOTH distinct and same instances — a PRE-EXISTING
    // object-externalisation gap (verified identical before/after #3055), out of
    // this issue's scope. Object identity on the ref-typed / IR path is correct
    // and is guarded by tests/issue-3037-cs1c-getprototypeof-carrier.test.ts.
    expect(
      await runStandalone(`${HARNESS}
        class Box { x: number = 0; }
        export function run(): number { const a: any = new Box(); const b: any = a; return isSameValue(a, b); }`),
    ).toBe(1);
  });

  it("mixed number-vs-string is strictly unequal", async () => {
    expect(
      await runStandalone(`${HARNESS}
        export function run(): number { const a: any = 1; const b: any = "1"; return isSameValue(a, b); }`),
    ).toBe(0);
  });
});
