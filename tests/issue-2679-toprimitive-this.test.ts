// #2679 — ToPrimitive/ToNumber must invoke valueOf / toString / @@toPrimitive
// with the RECEIVER as `this` (§7.1.1.1 OrdinaryToPrimitive step 4.b
// `Call(method, O)`).
//
// The host coercion funnel (_toPrimitive / _hostToPrimitive in runtime.ts)
// dispatched a compiled method closure via __call_fn_0 / __call_valueOf without
// installing __current_this, so a compiled `valueOf(){…this…}` saw a stale
// receiver. Fix: thread the receiver via the __call_fn_method_0/_1 callers and
// install __current_this around the __call_valueOf / __call_toString dispatch.
//
// PARTIAL (this PR): the STRING-hint path (toString / String(x) / template) and
// @@toPrimitive now bind `this` correctly. The NUMBER/default-hint valueOf path
// (`+a`, `Number(a)`, `a*1`) still binds the wrong `this` — tracked as the
// residual in #2679 (bottoms out in the deeper __current_this / object-literal
// method-this machinery).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";
import { parseMeta, wrapTest } from "./test262-runner.js";

async function run(body: string): Promise<any> {
  const src = `export function test(): any { ${body} }`;
  const result: any = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#2679 — ToPrimitive binds `this` to the receiver (string hint + @@toPrimitive)", () => {
  it("`'' + a` calls toString with this === a", async () => {
    const exp = await run(
      `var tv; var a = { toString() { tv = this; return "x"; } }; var s = "" + a; return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("String(a) calls toString with this === a", async () => {
    const exp = await run(
      `var tv; var a = { toString() { tv = this; return "x"; } }; var s = String(a); return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("@@toPrimitive is called with this === a", async () => {
    const exp = await run(
      `var tv; var a = { [Symbol.toPrimitive](h) { tv = this; return 5; } }; var x = +a; return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("toString still returns the correct value (no regression)", async () => {
    const exp = await run(`var a = { toString() { return "hi"; } }; return "" + a;`);
    expect(exp.test()).toBe("hi");
  });

  it("valueOf still returns the correct value (number coercion unaffected)", async () => {
    const exp = await run(`var a = { valueOf() { return 7; } }; return +a;`);
    expect(exp.test()).toBe(7);
  });
});

// RESIDUAL (this PR): the NUMBER/default-hint `valueOf` path. `+a` / `Number(a)`
// / `a*1` etc. lower to an inline ToNumber dispatch in coerceType (ref→f64) that
// `call_ref`s the method's `__obj_meth_tramp_*` trampoline. That trampoline reads
// `this` from the `__current_this` module global (param-0 is the closure
// self/env, not the receiver), but the inline dispatch never installed
// `__current_this`, so `valueOf(){…this…}` saw a stale receiver. Fix: install
// `__current_this` = receiver around the dispatch (§7.1.1.1 step 4.b
// `Call(method, O)`) and restore it afterward (nesting-safe).
describe("#2679 — ToNumber binds `this` to the receiver (number/default hint valueOf)", () => {
  it("`+a` calls valueOf with this === a", async () => {
    const exp = await run(
      `var tv; var a = { valueOf() { tv = this; return 5; } }; var x = +a; return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("Number(a) calls valueOf with this === a", async () => {
    const exp = await run(
      `var tv; var a = { valueOf() { tv = this; return 5; } }; var x = Number(a); return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("`a * 1` calls valueOf with this === a", async () => {
    const exp = await run(
      `var tv; var a = { valueOf() { tv = this; return 5; } }; var x = a * 1; return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("`a - 1` calls valueOf with this === a", async () => {
    const exp = await run(
      `var tv; var a = { valueOf() { tv = this; return 5; } }; var x = a - 1; return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("relational `a < b` binds this on BOTH operands (no leakage)", async () => {
    const exp = await run(
      `var ta, tb; var a = { valueOf() { ta = this; return 1; } }; var b = { valueOf() { tb = this; return 2; } }; var x = a < b; return ta === a && tb === b ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("nested `a * b` binds this on both operands and returns the product", async () => {
    const exp = await run(
      `var ta, tb; var a = { valueOf() { ta = this; return 3; } }; var b = { valueOf() { tb = this; return 4; } }; var x = a * b; return ta === a && tb === b && x === 12 ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("valueOf via function-expression also binds this === a", async () => {
    const exp = await run(
      `var tv; var a = { valueOf: function () { tv = this; return 5; } }; var x = +a; return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("number-hint valueOf still returns the correct value", async () => {
    const exp = await run(`var a = { valueOf() { return 9; } }; return a * 1;`);
    expect(exp.test()).toBe(9);
  });

  it("Date.prototype.setSeconds ToNumbers its arg with this === a (#2671 cluster)", async () => {
    const exp = await run(
      `var tv; var a = { valueOf() { tv = this; return 30; } }; var d = new Date(2016, 6, 1); d.setSeconds(a); return tv === a ? 1 : 0;`,
    );
    expect(exp.test()).toBe(1);
  });
});

// (#2679 CI-fix / park-hold on #2078) The number-hint valueOf coercion threads
// `__current_this` around the valueOf dispatch by emitting a save/install before
// and a restore after `buildDispatch(0)`. `buildDispatch(0)` compiles the valueOf
// dispatch, which can flush a LATE string-constant import mid-stream and SHIFT the
// global index space (`ctx.currentThisGlobalIdx` 25→26, verified). The first cut
// cached the global index in a local and reused the STALE value for the restore,
// so the restore `global.set` targeted the pre-shift index — a now-f64-typed
// global — storing an externref into an f64 global → invalid Wasm
// ("global.set expected type f64, found externref"). That park-held #2078 with a
// 30-test merged-baseline regression (every binary-op / String / Number / Array
// ToNumber-of-object harness row that hits the wrapped-test harness structure
// that flushes the late import). The fix reads `ctx.currentThisGlobalIdx` FRESH at
// each global op so the restore stays aligned with the shifted save/install.
//
// This guard reproduces the EXACT trigger: the harness-wrapped form (via the
// runner's `wrapTest`, which supplies the `Test262Error` / assert string
// constants whose late flush causes the shift) of a representative regressed
// row (`language/expressions/addition/S11.6.1_A2.2_T1.js`). It asserts the binary
// INSTANTIATES (validates) — the simple in-body `run(...)` shapes above do NOT
// flush a mid-dispatch import, so only this harness-wrapped form catches the bug.
describe("#2679 — number-hint valueOf coercion emits VALID Wasm under global-index shift", () => {
  // The FULL test262 row (es5id 11.6.1_A2.2_T1, BSD-licensed). The complete
  // harness string-constant volume is load-bearing: it is what makes a late
  // string-constant import flush DURING the valueOf `buildDispatch`, shifting the
  // global index space mid-emission. A trimmed copy does not flush mid-dispatch
  // and so does not reproduce the bug.
  const ADDITION_A22_T1 = `// Copyright 2009 the Sputnik authors.  All rights reserved.
/*---
es5id: 11.6.1_A2.2_T1
description: If Type(value) is Object, evaluate ToPrimitive(value, Number)
---*/
if ({valueOf: function() {return 1}} + 1 !== 2) {
  throw new Test262Error('#1: {valueOf: function() {return 1}} + 1 === 2. Actual: ' + ({valueOf: function() {return 1}} + 1));
}
if ({valueOf: function() {return 1}, toString: function() {return 0}} + 1 !== 2) {
  throw new Test262Error('#2: {valueOf: function() {return 1}, toString: function() {return 0}} + 1 === 2. Actual: ' + ({valueOf: function() {return 1}, toString: function() {return 0}} + 1));
}
if ({valueOf: function() {return 1}, toString: function() {return {}}} + 1 !== 2) {
  throw new Test262Error('#3: {valueOf: function() {return 1}, toString: function() {return {}}} + 1 === 2. Actual: ' + ({valueOf: function() {return 1}, toString: function() {return {}}} + 1));
}
try {
  if ({valueOf: function() {return 1}, toString: function() {throw "error"}} + 1 !== 2) {
    throw new Test262Error('#4.1: {valueOf: function() {return 1}, toString: function() {throw "error"}} + 1 === 2. Actual: ' + ({valueOf: function() {return 1}, toString: function() {throw "error"}} + 1));
  }
}
catch (e) {
  if (e === "error") {
    throw new Test262Error('#4.2: {valueOf: function() {return 1}, toString: function() {throw "error"}} + 1 not throw "error"');
  } else {
    throw new Test262Error('#4.3: {valueOf: function() {return 1}, toString: function() {throw "error"}} + 1 not throw Error. Actual: ' + (e));
  }
}
if (1 + {toString: function() {return 1}} !== 2) {
  throw new Test262Error('#5: 1 + {toString: function() {return 1}} === 2. Actual: ' + (1 + {toString: function() {return 1}}));
}
if (1 + {valueOf: function() {return {}}, toString: function() {return 1}} !== 2) {
  throw new Test262Error('#6: 1 + {valueOf: function() {return {}}, toString: function() {return 1}} === 2. Actual: ' + (1 + {valueOf: function() {return {}}, toString: function() {return 1}}));
}
try {
  1 + {valueOf: function() {throw "error"}, toString: function() {return 1}};
  throw new Test262Error('#7.1: 1 + {valueOf: function() {throw "error"}, toString: function() {return 1}} throw "error". Actual: ' + (1 + {valueOf: function() {throw "error"}, toString: function() {return 1}}));
}
catch (e) {
  if (e !== "error") {
    throw new Test262Error('#7.2: 1 + {valueOf: function() {throw "error"}, toString: function() {return 1}} throw "error". Actual: ' + (e));
  }
}
try {
  1 + {valueOf: function() {return {}}, toString: function() {return {}}};
  throw new Test262Error('#8.1: 1 + {valueOf: function() {return {}}, toString: function() {return {}}} throw TypeError. Actual: ' + (1 + {valueOf: function() {return {}}, toString: function() {return {}}}));
}
catch (e) {
  if ((e instanceof TypeError) !== true) {
    throw new Test262Error('#8.2: 1 + {valueOf: function() {return {}}, toString: function() {return {}}} throw TypeError. Actual: ' + (e));
  }
}
`;

  it("compiles the harness-wrapped addition-A2.2 row to instantiable Wasm", async () => {
    const meta = parseMeta(ADDITION_A22_T1);
    const { source } = wrapTest(ADDITION_A22_T1, meta);
    const result: any = await compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true } as any);
    expect(result.success).toBe(true);
    expect(result.binary?.length).toBeGreaterThan(0);
    // The regression manifested ONLY at instantiation (compile reported success
    // but the binary failed Wasm validation). Assert it instantiates.
    await expect(WebAssembly.instantiate(result.binary, result.importObject ?? {})).resolves.toBeDefined();
  });
});
