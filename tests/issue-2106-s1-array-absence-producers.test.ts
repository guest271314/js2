// #2106 S1 — array-absence producer completion (flag ON, standalone/wasi).
//
// The complete `$undefined` tag-1 singleton sweep flipped the OBJECT missing-key
// producer (`__extern_get` miss) and explicit-`undefined` producers, and the
// undefined-specific CONSUMERS (`__extern_is_undefined` is singleton-only under
// the flag). But three ARRAY-absence producers still emitted raw
// `ref.null.extern` for an absent element, which the flag-on singleton-only
// consumer does NOT treat as undefined → the destructuring/param default
// spuriously failed to fire:
//
//   1. array-pattern OOB element read in decl/param destructuring
//      (`const [x=9]=[]`, `[,y=9]=[1]`, `[a,b=9]=[1]`)  — emitBoundsCheckedArrayGetUndef
//   2. absent optional/default parameter padding (`function f(x=9){}; f()`)
//      — emitUndefinedValue (via pushDefaultValue)
//   3. for-of loop-head array destructuring (`for (const [a=9] of [[]]) …`)
//      — emitBoundsCheckedArrayGet's useUndefinedSentinel arm
//
// This test pins all three flip to the singleton under the flag (default fires),
// while the present-value and present-`null` cases are unaffected (default does
// NOT fire on a present `null` — §13.15.5.3). Each case is a distinct producer,
// so a future default-flip A/B measures the whole array-absence cluster at once.
//
// Flag OFF is the legacy conflated regime and stays byte-identical (a partial
// producer flip is what breached the standalone floor at −1245/−1890 before;
// this completion is byte-inert until a deliberate, fork-A/B-measured flip).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

async function run(source: string, undefinedSingleton: boolean): Promise<number> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi", undefinedSingleton });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  const wasi = buildWasiPolyfill();
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  if (exports.memory) wasi.setMemory(exports.memory as WebAssembly.Memory);
  return (exports.test as () => number)();
}

const P1 = `export function test(): number {
  const [x = 9] = [] as any[];             // OOB index 0 on []
  const [, y = 9] = [1] as any[];          // OOB index 1 (elision)
  const [a, b = 9] = [1] as any[];         // OOB index 1 (past-end)
  return (x === 9 && y === 9 && b === 9) ? 1 : 0;
}`;

const P2 = `function f(x: any = 9) { return x; }
function g(a: any, b: any = 9) { return b; }
export function test(): number {
  return (f() === 9 && g(1) === 9) ? 1 : 0;      // absent default param → default fires
}`;

const P3 = `export function test(): number {
  let s = 0;
  for (const [a = 9] of [[]] as any[][]) { s = a === 9 ? 1 : 0; }   // for-of OOB element
  return s;
}`;

const PRESENT = `export function test(): number {
  const [x = 9] = [5] as any[];            // present value → NO default
  const [u = 9] = [undefined] as any[];    // explicit undefined → default
  const n: any = ([null] as any[])[0];     // present null (via [x=9]=[null])
  const [m = 9] = [null] as any[];
  return (x === 5 && u === 9 && m === null) ? 1 : 0;
}`;

describe("#2106 S1 array-absence producers (flag ON)", () => {
  it("array-pattern OOB decl destructuring defaults fire (was raw null → default skipped)", async () => {
    expect(await run(P1, true)).toBe(1);
  });

  it("absent optional/default parameter padding fires the default", async () => {
    expect(await run(P2, true)).toBe(1);
  });

  it("for-of loop-head array-destructuring default fires on an OOB element", async () => {
    expect(await run(P3, true)).toBe(1);
  });

  it("present value / explicit undefined / present null are unaffected (§13.15.5.3)", async () => {
    expect(await run(PRESENT, true)).toBe(1);
  });

  it("flag OFF control: legacy path still applies OOB defaults (byte-inert regime)", async () => {
    // Under the legacy conflated regime the OOB default also fires (ref.is_null
    // catches the raw null) — this proves the fix is additive, not a behavior
    // change for flag-off.
    expect(await run(P1, false)).toBe(1);
    expect(await run(P2, false)).toBe(1);
    expect(await run(P3, false)).toBe(1);
  });
});
