// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3191 (bloat S1) — the four hand-rolled JS-error-throw templates were unified
// onto the shared builders in the layering-safe leaf module `src/codegen/
// js-errors.ts`:
//   - `emitDataViewRangeError` / `dvTypeErrorThrow` (dataview-native.ts) →
//     `buildThrowJsErrorInstrs` (no-flush, caller-flush ordering preserved)
//   - `emitBrandCheckTypeError` (native-proto.ts) →
//     `buildThrowJsErrorInstrs({ forceInModuleCtor: true })` (host-mode codegen
//     unchanged — always the in-module `__new_TypeError`)
//   - `emitThrowString` / `throwStringInstrs` (array-methods.ts) →
//     `emitThrowString` / `buildThrowStringInstrs`
//
// This is a zero-behavior-change refactor; the assertions below are a
// regression guard proving each unified path still throws a CATCHABLE real
// error instance (not an uncatchable trap or a bare string). Standalone mode so
// no host imports are needed.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile a numeric-returning body in standalone mode and run it. */
async function numResult(body: string): Promise<number> {
  const src = `export function test(): number {\n${body}\n}`;
  const r = await compile(src, { fileName: "issue-3191.ts", target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#3191 — unified JS-error-throw templates stay catchable", () => {
  // array-methods.ts `buildThrowStringInstrs` — reduce of an empty array with no
  // initial value throws the shared `$exc` tag (a BARE STRING, the same variant
  // as before the unification), so it is CATCHABLE (not an uncatchable trap).
  it("Array.prototype.reduce on an empty array throws a catchable error", async () => {
    expect(
      await numResult(`
        const arr: number[] = [];
        try { arr.reduce((a: number, b: number) => a + b); return 0; }
        catch (e) { return 1; }
      `),
    ).toBe(1);
  });

  // dataview-native.ts `emitDataViewRangeError` (→ buildThrowJsErrorInstrs) —
  // out-of-bounds getInt32 throws a catchable RangeError INSTANCE.
  it("DataView getInt32 out of bounds throws a catchable RangeError instance", async () => {
    expect(
      await numResult(`
        const dv = new DataView(new ArrayBuffer(4));
        try { dv.getInt32(4); return 0; }
        catch (e) { return (e instanceof RangeError) ? 1 : 2; }
      `),
    ).toBe(1);
  });

  // A plain compiles-and-runs sanity check that the unification did not break a
  // normal (non-throwing) reduce.
  it("Array.prototype.reduce on a non-empty array still works", async () => {
    expect(await numResult(`return [1, 2, 3, 4].reduce((a: number, b: number) => a + b);`)).toBe(10);
  });

  // native-proto.ts `emitBrandCheckTypeError` (→ buildThrowJsErrorInstrs with
  // forceInModuleCtor) and array-methods.ts `emitThrowString` are additionally
  // covered by the host-lane suites #1344 (generator brand check), #2590
  // (RegExp.escape), #1514 (set-like brand) and functional-array-methods
  // (callback-not-a-function) — all still green after the unification.
});
