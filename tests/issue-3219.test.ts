// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3219 — standalone reflective Date.prototype.<getter>.call:
//   - [[DateValue]]-brand check: a non-Date receiver throws TypeError
//     (§21.4.4 thisTimeValue step 2), matching the test262
//     Date/prototype/*/this-value-non-date.js + this-value-non-object.js rows;
//   - a genuine Date receiver runs the native getter HOST-FREE (no dropped
//     thisArg → 0, the pre-fix bug), returning the correct value;
//   - Invalid Date (new Date(NaN)) → NaN through the reflective path;
//   - the direct-call Date getter path is unchanged (control).
//
// Each case compiles a self-contained module with `--target standalone`
// (zero imports — the standalone floor) and asserts the exported probe value.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, JSON.stringify(r.errors?.slice(0, 2))).toBe(true);
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary));
  expect(imports, "standalone module must not leak host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  (instance.exports as { _start?: () => void })._start?.();
  return (instance.exports as { test(): unknown }).test();
}

describe("#3219 standalone reflective Date.prototype getter", () => {
  it("brand: getter .call on a non-Date receiver throws TypeError; on a Date runs native", async () => {
    const result = await runStandalone(`
      const getTime = Date.prototype.getTime;
      const getFullYear = Date.prototype.getFullYear;
      let ok = 0;
      // §thisTimeValue step 2 — no [[DateValue]] slot → TypeError.
      try { (getTime as any).call({}); } catch (e) { ok += 1; }        // ordinary object
      try { (getTime as any).call([]); } catch (e) { ok += 2; }        // array exotic
      try { (getFullYear as any).call(undefined); } catch (e) { ok += 4; } // non-object
      try { (getFullYear as any).call(0 as any); } catch (e) { ok += 8; }  // primitive number
      // Genuine Date receiver runs the native getter host-free.
      const d = new Date(1000);
      if ((getTime as any).call(d) === 1000) ok += 16;
      export function test(): number { return ok; }
    `);
    expect(result).toBe(31);
  });

  it("value: happy-path reflective getters return the correct component (host-free)", async () => {
    const result = await runStandalone(`
      const d = new Date(3661000); // 1970-01-01T01:01:01.000Z
      const getUTCHours = Date.prototype.getUTCHours;
      const getUTCMinutes = Date.prototype.getUTCMinutes;
      const getUTCSeconds = Date.prototype.getUTCSeconds;
      const getFullYear = Date.prototype.getFullYear;
      const getUTCMonth = Date.prototype.getUTCMonth;
      const getUTCDate = Date.prototype.getUTCDate;
      let ok = 0;
      if ((getUTCHours as any).call(d) === 1) ok += 1;
      if ((getUTCMinutes as any).call(d) === 1) ok += 2;
      if ((getUTCSeconds as any).call(d) === 1) ok += 4;
      if ((getFullYear as any).call(d) === 1970) ok += 8;
      if ((getUTCMonth as any).call(d) === 0) ok += 16;
      if ((getUTCDate as any).call(d) === 1) ok += 32;
      export function test(): number { return ok; }
    `);
    expect(result).toBe(63);
  });

  it("meta + invalid: typeof getter is 'function'; Invalid Date reflective getter → NaN", async () => {
    const result = await runStandalone(`
      let ok = 0;
      if (typeof Date.prototype.getTime === 'function') ok += 1;
      const getTime = Date.prototype.getTime;
      const v = (getTime as any).call(new Date(NaN));
      if (v !== v) ok += 2; // NaN
      const getFullYear = Date.prototype.getFullYear;
      const y = (getFullYear as any).call(new Date(NaN));
      if (y !== y) ok += 4; // NaN
      export function test(): number { return ok; }
    `);
    expect(result).toBe(7);
  });

  it("getTimezoneOffset reflective: 0 for a valid Date, NaN for Invalid Date", async () => {
    const result = await runStandalone(`
      const getTZ = Date.prototype.getTimezoneOffset;
      let ok = 0;
      if ((getTZ as any).call(new Date(0)) === 0) ok += 1;
      const n = (getTZ as any).call(new Date(NaN));
      if (n !== n) ok += 2; // NaN
      export function test(): number { return ok; }
    `);
    expect(result).toBe(3);
  });

  it("control: direct-call Date getters still return correct values (standalone)", async () => {
    const result = await runStandalone(`
      let ok = 0;
      if (new Date(12345).getTime() === 12345) ok += 1;
      if (new Date(1e12).getUTCFullYear() === 2001) ok += 2;
      if (new Date(1e12).getUTCMonth() === 8) ok += 4; // September (0-based)
      export function test(): number { return ok; }
    `);
    expect(result).toBe(7);
  });
});
