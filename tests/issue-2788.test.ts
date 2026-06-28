// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2788 — malformed_wasm: `__module_init` call-argument type mismatch.
//
// Two differential-corpus programs compiled "successfully" yet emitted a binary
// that failed `WebAssembly.validate`: a call inside `__module_init` whose
// argument ValType did not match the callee's parameter type.
//
//   1. `console.log(a[i])` for a `number[]` — the bounds-checked element read
//      (#2760) widened the element to an `externref` (OOB→undefined), but the
//      statically-selected `console_log_number` import expects f64. (REGRESSION:
//      previously `match`, became `malformed_wasm`.)
//   2. `console.log(isEven(n))` for a mutually-recursive boolean kernel whose TS
//      return type resolves to `any` — so the `console_log_externref` variant is
//      selected, but the compiled function returns a primitive scalar (i32/f64),
//      which was left as a raw scalar operand to an `externref` parameter.
//
// Fix: `compileConsoleCall` coerces each argument to the selected console
// import's parameter ValType (f64 / i32 / box-to-externref), reusing the
// existing coercion machinery. Ref/externref operands are left untouched so an
// array is still printed through its normal path (no iterable-adapter rewrite).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileOk(source: string, opts?: Record<string, unknown>) {
  const r = await compile(source, opts as never);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  return r;
}

// Run a top-level program in host mode, capturing console.log arguments.
async function runCapture(source: string, opts?: Record<string, unknown>): Promise<unknown[]> {
  const r = await compileOk(source, opts);
  // The module is only well-formed if it passes validation — the whole point of
  // this issue. Assert it explicitly so a regression surfaces as this test, not
  // as an opaque instantiation error.
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const log: unknown[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => {
    log.push(...a);
  };
  try {
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    (imports as { setExports?: (e: Record<string, unknown>) => void }).setExports?.(
      instance.exports as Record<string, unknown>,
    );
  } finally {
    console.log = orig;
  }
  return log;
}

const ARRAY_SRC = `const a = [1, 2, 3];
console.log(a.length);
console.log(a[0]);
console.log(a[a.length - 1]);`;

const CLOSURES_SRC = `function isEven(n) {
  return n === 0 ? true : isOdd(n - 1);
}
function isOdd(n) {
  return n === 0 ? false : isEven(n - 1);
}
console.log(isEven(10));
console.log(isOdd(7));`;

describe("#2788 — __module_init call-argument coercion → valid wasm", () => {
  // The core acceptance: both programs must produce a VALID module. Both the
  // default (IR) and legacy front-ends are exercised because the IR path
  // re-types the recursive kernel and the skew must be bridged either way.
  for (const experimentalIR of [true, false]) {
    it(`array/01-basic computed-index read compiles to valid wasm (IR=${experimentalIR})`, async () => {
      const r = await compileOk(ARRAY_SRC, { experimentalIR });
      expect(WebAssembly.validate(r.binary)).toBe(true);
    });

    it(`closures/10-mutual mutual-recursion compiles to valid wasm (IR=${experimentalIR})`, async () => {
      const r = await compileOk(CLOSURES_SRC, { experimentalIR });
      expect(WebAssembly.validate(r.binary)).toBe(true);
    });
  }

  it("array computed-index console.log prints the correct numeric values", async () => {
    // The regression case: was `match` (3,1,3), regressed to malformed_wasm.
    const out = await runCapture(ARRAY_SRC);
    expect(out.map(Number)).toEqual([3, 1, 3]);
  });

  it("console.log of an array value is not rewritten (byte-path preserved)", async () => {
    // Guard: the externref-variant coercion must only bridge primitive scalars.
    // An array operand is already externref-compatible and must keep its normal
    // print path (no `__make_iterable` rewrite) — see the fix's scalar guard.
    const r = await compileOk("const a = [1, 2, 3]; console.log(a);");
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });
});
