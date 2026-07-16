// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3174 — standalone Date receiver brand checks + coercion order.
 *
 * Three fixes under test, all `--target standalone` (host lane byte-identical):
 *
 * 1. `__extern_strict_eq` NaN identity (any-helpers.ts): §7.2.16
 *    IsStrictlyEqual routes both-Number operands to Number::equal, where
 *    `NaN === NaN` is FALSE even for the very same `$BoxedNumber` reference.
 *    The #2734 `ref.eq` identity fast path answered true for a self-compared
 *    boxed NaN (`a !== a` with `a: any = NaN`) — the exact probe the test262
 *    harness `isSameValue` uses — silently failing every standalone
 *    `assert.sameValue(x, NaN)` (~68 built-ins/Date rows).
 *
 * 2. Reflective `Date.prototype.set*` / `toISOString` closure bodies
 *    (date-reflective-setters.ts): §21.4.4.20–27 step 1 `thisTimeValue` must
 *    throw TypeError on a non-Date receiver BEFORE any argument ToNumber runs
 *    ("validation precedes input coercion"), and a genuine Date receiver must
 *    actually mutate + return the new time value. §21.4.4.36 toISOString:
 *    TypeError on a non-Date receiver, RangeError on an Invalid Date.
 *
 * 3. `Date.prototype.toLocale{,Date,Time}String.length === 0`
 *    (§21.4.4.38–40; PROTO_METHOD_LENGTH, array-object-proto.ts).
 */

async function runStandalone(src: string): Promise<{ ret: unknown; envImports: string[] }> {
  const r = await compile(src, { fileName: "t.ts", target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const envImports = (r.imports ?? []).filter((i) => i.module === "env").map((i) => i.name);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  const ret = (instance.exports.test as () => unknown)();
  return { ret, envImports };
}

describe("#3174 — standalone strict-eq NaN identity (§7.2.16 / §6.1.6.1.13)", () => {
  it("a !== a is true for an any-typed NaN (same boxed reference)", async () => {
    const { ret, envImports } = await runStandalone(
      `export function test(): number { const a: any = NaN; return a !== a ? 1 : 0; }`,
    );
    expect(ret).toBe(1);
    expect(envImports).toEqual([]);
  });

  it("harness isSameValue(NaN, NaN) answers true through any params", async () => {
    const { ret } = await runStandalone(`
function isSameValue(a: any, b: any): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  return 0;
}
export function test(): number { return isSameValue(new Date(NaN).getDate(), NaN); }`);
    expect(ret).toBe(1);
  });

  it("same-reference non-NaN number box stays === (falls to f64.eq)", async () => {
    const { ret } = await runStandalone(`export function test(): number { const a: any = 5; return a === a ? 1 : 0; }`);
    expect(ret).toBe(1);
  });

  it("object reference identity (#2734) is preserved", async () => {
    const { ret } = await runStandalone(
      `export function test(): number { const o = {}; const a: any = [o]; return a.indexOf(o) === 0 ? 1 : 0; }`,
    );
    expect(ret).toBe(1);
  });
});

describe("#3174 — reflective Date.prototype set* brand checks (§21.4.4 thisTimeValue)", () => {
  it("setTime.call({}) throws TypeError BEFORE coercing the argument", async () => {
    const { ret, envImports } = await runStandalone(`
var callCount = 0;
var arg: any = { valueOf: function() { callCount += 1; return 1; } };
export function test(): number {
  var setTime = Date.prototype.setTime;
  try {
    (setTime as any).call({}, arg);
    return 10;
  } catch (e) {
    if (!(e instanceof TypeError)) return 11;
  }
  return callCount === 0 ? 1 : 12; // validation precedes input coercion
}`);
    expect(ret).toBe(1);
    expect(envImports).toEqual([]);
  });

  it("setDate.call on primitive receivers throws TypeError", async () => {
    const { ret } = await runStandalone(`
export function test(): number {
  var setDate = Date.prototype.setDate;
  var throws = 0;
  for (const recv of [undefined, null, 5, "s", true] as any[]) {
    try { (setDate as any).call(recv, 1); } catch (e) { if (e instanceof TypeError) throws++; }
  }
  return throws === 5 ? 1 : throws;
}`);
    expect(ret).toBe(1);
  });

  it("setTime.call(genuineDate, v) mutates and returns the time value", async () => {
    const { ret } = await runStandalone(`
export function test(): number {
  var st = Date.prototype.setTime;
  var d = new Date(0);
  var r = (st as any).call(d, 5000);
  if (d.getTime() !== 5000) return 20;
  if (r !== 5000) return 21;
  return 1;
}`);
    expect(ret).toBe(1);
  });

  it("setHours.call keeps unsupplied trailing components (§21.4.4.23)", async () => {
    const { ret } = await runStandalone(`
export function test(): number {
  var sh = Date.prototype.setHours;
  var d = new Date(45296789); // 12:34:56.789 UTC
  (sh as any).call(d, 3);
  if (d.getHours() !== 3) return 22;
  if (d.getMinutes() !== 34) return 23;
  if (d.getSeconds() !== 56) return 24;
  if (d.getMilliseconds() !== 789) return 25;
  return 1;
}`);
    expect(ret).toBe(1);
  });

  it("setFullYear.call re-validates an Invalid Date receiver (§21.4.4.21 t → +0)", async () => {
    const { ret } = await runStandalone(`
export function test(): number {
  var sfy = Date.prototype.setFullYear;
  var d = new Date(NaN);
  (sfy as any).call(d, 1975);
  return d.getFullYear() === 1975 ? 1 : 26;
}`);
    expect(ret).toBe(1);
  });

  it("setMonth.call(invalidDate, m) returns NaN without re-validating", async () => {
    const { ret } = await runStandalone(`
export function test(): number {
  var sm = Date.prototype.setMonth;
  var d = new Date(NaN);
  var r = (sm as any).call(d, 3);
  if (r === r) return 27; // must be NaN
  var t = d.getTime();
  return t !== t ? 1 : 28; // still invalid
}`);
    expect(ret).toBe(1);
  });
});

describe("#3174 — reflective toISOString (§21.4.4.36)", () => {
  it("toISOString.call(new Date(0)) renders host-free", async () => {
    const { ret, envImports } = await runStandalone(`
export function test(): number {
  var f = Date.prototype.toISOString;
  return (f as any).call(new Date(0)) === "1970-01-01T00:00:00.000Z" ? 1 : 0;
}`);
    expect(ret).toBe(1);
    expect(envImports).toEqual([]);
  });

  it("toISOString.call([]) throws TypeError; on an Invalid Date throws RangeError", async () => {
    const { ret } = await runStandalone(`
export function test(): number {
  var f = Date.prototype.toISOString;
  try { (f as any).call([]); return 30; } catch (e) { if (!(e instanceof TypeError)) return 31; }
  try { (f as any).call(new Date(NaN)); return 32; } catch (e) { if (!(e instanceof RangeError)) return 33; }
  return 1;
}`);
    expect(ret).toBe(1);
  });
});

describe("#3174 — Date.prototype.toLocale* arity (§21.4.4.38–40)", () => {
  it("toLocaleDateString/.toLocaleTimeString/.toLocaleString .length === 0", async () => {
    const { ret } = await runStandalone(`
export function test(): number {
  if ((Date.prototype.toLocaleDateString as any).length !== 0) return 40;
  if ((Date.prototype.toLocaleTimeString as any).length !== 0) return 41;
  if ((Date.prototype.toLocaleString as any).length !== 0) return 42;
  return 1;
}`);
    expect(ret).toBe(1);
  });
});
