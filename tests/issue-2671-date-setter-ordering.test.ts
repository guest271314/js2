// #2671 (ES2015 Date residual) — Date setter [[DateValue]]-clobber on an
// Invalid-Date receiver.
//
// Per ECMA-262 §21.4.4 the time-of-day setters (setSeconds/setMinutes/
// setHours/setMilliseconds + UTC) and the calendar setters setDate/setMonth
// (+UTC) read `t = dateObject.[[DateValue]]` FIRST, then run ToNumber on each
// arg, then — "If t is NaN, return NaN" — return WITHOUT writing [[DateValue]].
// The compiler's invalid-branch previously wrote the Invalid-Date sentinel
// unconditionally, which CLOBBERED a [[DateValue]] that a ToNumber side-effect
// (`value.valueOf()` calling `this.setTime(0)`) had legitimately re-set —
// flipping 12 test262 `date-value-read-before-tonumber-when-date-is-invalid`
// files. setFullYear/setUTCFullYear are exempt: §21.4.4.21 re-validates an
// Invalid receiver to t=+0 and ALWAYS writes [[DateValue]] (step 8).
//
// NOTE: the receiver MUST be statically typed `Date` (the test262 source uses
// `var dt = new Date(NaN)`, which TS infers as Date) so the typed Date-method
// codegen path (compileDateMethodCall) fires. A `: any` annotation would route
// through generic host dispatch and not exercise this code.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(body: string): Promise<any> {
  const src = `export function test(): any { ${body} }`;
  const result: any = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

// A ToNumber side-effect object: calls `dt.setTime(0)` during coercion, then
// reports 1. Used to prove the setter does NOT clobber [[DateValue]] back to
// the sentinel after the side-effect ran. `dt` infers as Date (typed path).
const sideEffect = (call: string) => `
  var dt = new Date(NaN);
  var calls = 0;
  var value = { valueOf: function() { calls++; dt.setTime(0); return 1; } };
  var result = dt.${call};
`;

describe("#2671 — Date setter Invalid-Date [[DateValue]] preservation", () => {
  for (const m of [
    "setSeconds",
    "setMinutes",
    "setHours",
    "setMilliseconds",
    "setDate",
    "setMonth",
    "setUTCSeconds",
    "setUTCMinutes",
    "setUTCHours",
    "setUTCMilliseconds",
    "setUTCDate",
    "setUTCMonth",
  ]) {
    it(`${m}: ToNumber runs exactly once on an Invalid-Date receiver`, async () => {
      const exp = await run(sideEffect(`${m}(value)`) + `return calls;`);
      expect(exp.test()).toBe(1);
    });

    it(`${m}: returns NaN on an Invalid-Date receiver`, async () => {
      const exp = await run(sideEffect(`${m}(value)`) + `return (result !== result) ? 1 : 0;`);
      expect(exp.test()).toBe(1); // NaN !== NaN
    });

    it(`${m}: does NOT clobber [[DateValue]] re-set during ToNumber`, async () => {
      // The valueOf side-effect set the time to 0; the setter must leave it.
      const exp = await run(sideEffect(`${m}(value)`) + `return dt.getTime();`);
      expect(exp.test()).toBe(0);
    });
  }

  it("valid receiver + NaN arg DOES write the sentinel (date becomes Invalid)", async () => {
    // Receiver valid, arg coerces to NaN → [[DateValue]] is set to Invalid.
    const exp = await run(`
      var d = new Date(2016, 6, 1);
      var r = d.setSeconds(0, undefined); // ms = ToNumber(undefined) = NaN
      var t = d.getTime();
      return ((r !== r) && (t !== t)) ? 1 : 0;
    `);
    expect(exp.test()).toBe(1);
  });

  it("already-invalid receiver + valid arg, no side-effect: stays Invalid", async () => {
    const exp = await run(`
      var d = new Date(NaN);
      var r = d.setSeconds(5);
      var t = d.getTime();
      return ((r !== r) && (t !== t)) ? 1 : 0;
    `);
    expect(exp.test()).toBe(1);
  });

  it("setFullYear is exempt: re-validates Invalid receiver to t=+0 and writes", async () => {
    // valueOf side-effect sets time to 0; setFullYear(1) re-validates and
    // writes the new value, so the result is finite and getFullYear() === 1.
    const exp = await run(
      sideEffect(`setFullYear(value)`) +
        `return ((result === result) && dt.getTime() === result && dt.getFullYear() === 1) ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("setUTCFullYear is exempt: re-validates Invalid receiver and writes", async () => {
    const exp = await run(
      sideEffect(`setUTCFullYear(value)`) + `return ((result === result) && dt.getTime() === result) ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("normal valid-receiver setters are unaffected", async () => {
    const exp = await run(`
      var d = new Date(2016, 0, 1, 0, 0, 0, 0);
      d.setSeconds(30, 500);
      d.setDate(15);
      d.setMonth(5, 20);
      return (d.getSeconds() === 30 && d.getMilliseconds() === 500 && d.getDate() === 20 && d.getMonth() === 5) ? 1 : 0;
    `);
    expect(exp.test()).toBe(1);
  });
});
