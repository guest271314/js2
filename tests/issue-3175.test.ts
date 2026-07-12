// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3175 — standalone Number.prototype method spec semantics.
 *
 * Closes the dominant standalone gap under `built-ins/Number/prototype/`:
 *  - `Number.prototype.<m>(...)` receiver: the prototype object's [[NumberData]]
 *    is +0 (§21.1.3), so `Number.prototype.toString(radix)` / `.valueOf()` /
 *    `.toFixed(d)` behave as if invoked on +0. Standalone previously routed the
 *    `Number` wrapper receiver through the boxed-wrapper `__to_primitive`
 *    recovery → no [[PrimitiveValue]] slot → NaN. (S15.7.4.2 A1/A2 corpus, 35
 *    tests open with exactly this assertion.)
 *  - `toString(undefined)` radix (§21.1.3.6 step 2): undefined means base 10, NOT
 *    a RangeError / trap.
 *  - `toFixed` ToIntegerOrInfinity(fractionDigits): truncate toward zero, NaN → 0
 *    (`toFixed(-0.1)`/`toFixed(NaN)`/`toFixed("x")` no longer trap).
 *  - RangeError INSTANCES (not bare strings) from the toString-radix and toFixed
 *    out-of-range gates, so raw-`try`/`catch` + `assert(e instanceof RangeError)`
 *    passes (S15.7.4.5 A1.3/A1.4).
 *
 * All assertions run under `--target standalone` (no JS host).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `expr` (a string-valued expression) in standalone mode and read the
 * resulting native WasmGC string back out. */
async function stringResult(expr: string): Promise<string> {
  const src = `export function len(): number { return (${expr}).length; }
export function at(i: number): number { return (${expr}).charCodeAt(i); }`;
  const r = await compile(src, { fileName: "issue-3175.ts", target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as { len(): number; at(i: number): number };
  const len = exports.len();
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(exports.at(i));
  return out;
}

/** Compile `body` (a numeric-returning function body) in standalone mode. */
async function numResult(body: string): Promise<number> {
  const src = `export function test(): number {\n${body}\n}`;
  const r = await compile(src, { fileName: "issue-3175.ts", target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#3175 — standalone Number.prototype receiver + arg-coercion", () => {
  it("Number.prototype.toString(radix) uses [[NumberData]] +0", async () => {
    expect(await stringResult("Number.prototype.toString(2)")).toBe("0");
    expect(await stringResult("Number.prototype.toString(3)")).toBe("0");
    expect(await stringResult("Number.prototype.toString(16)")).toBe("0");
    expect(await stringResult("Number.prototype.toString()")).toBe("0");
    expect(await stringResult("Number.prototype.toString(undefined)")).toBe("0");
  });

  it("Number.prototype.valueOf() / toFixed(d) use [[NumberData]] +0", async () => {
    expect(await numResult("return Number.prototype.valueOf();")).toBe(0);
    expect(await stringResult("Number.prototype.toFixed(2)")).toBe("0.00");
    expect(await stringResult("Number.prototype.toFixed()")).toBe("0");
  });

  it("boxed new Number(x) receivers still unwrap", async () => {
    expect(await stringResult("(new Number(255)).toString(16)")).toBe("ff");
    expect(await stringResult("(new Number(-1)).toString(2)")).toBe("-1");
    expect(await numResult("return (new Number(42)).valueOf();")).toBe(42);
  });

  it("toString(undefined) is base 10, not a RangeError/trap", async () => {
    expect(await stringResult("(5).toString(undefined)")).toBe("5");
    expect(await stringResult("(255).toString(undefined)")).toBe("255");
    expect(await stringResult("(255).toString()")).toBe("255");
  });

  it("primitive toString(radix) is unaffected", async () => {
    expect(await stringResult("(255).toString(16)")).toBe("ff");
    expect(await stringResult("(5).toString(2)")).toBe("101");
  });

  it("toFixed ToIntegerOrInfinity: truncate toward zero, NaN -> 0", async () => {
    // -0.1 truncates to -0 (in [0,100]) -> "5", NOT a RangeError.
    expect(await stringResult("(5).toFixed(-0.1)")).toBe("5");
    // 1.9 truncates to 1.
    expect(await stringResult("(0).toFixed(1.9)")).toBe("0.0");
    // NaN / non-numeric string -> 0 (no i32.trunc(NaN) trap).
    expect(await stringResult("(5).toFixed(Number.NaN)")).toBe("5");
    expect(await stringResult('(5).toFixed("some string")')).toBe("5");
    expect(await stringResult('(5).toFixed("1")')).toBe("5.0");
  });

  it("out-of-range radix throws a RangeError INSTANCE", async () => {
    expect(
      await numResult("try { (5).toString(1); return 0; } catch (e) { return e instanceof RangeError ? 1 : 2; }"),
    ).toBe(1);
    expect(
      await numResult("try { (5).toString(37); return 0; } catch (e) { return e instanceof RangeError ? 1 : 2; }"),
    ).toBe(1);
  });

  it("out-of-range toFixed digits throws a RangeError INSTANCE", async () => {
    expect(
      await numResult("try { (5).toFixed(101); return 0; } catch (e) { return e instanceof RangeError ? 1 : 2; }"),
    ).toBe(1);
    expect(
      await numResult("try { (5).toFixed(-1); return 0; } catch (e) { return e instanceof RangeError ? 1 : 2; }"),
    ).toBe(1);
  });
});
