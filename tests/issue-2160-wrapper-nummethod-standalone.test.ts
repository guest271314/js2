// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2160 (number-wrapper slice) — Number.prototype METHOD dispatch on a
 * `new Number(x)` WRAPPER receiver, standalone. Direct mirror of the #1878
 * String-wrapper fix.
 *
 * A Number wrapper (`new Number(3.14)`) lowers to a `$Object` externref carrying
 * the primitive in the reserved FLAG_INTERNAL [[PrimitiveValue]] slot (#1910 S2),
 * NOT a native boxed number. The numeric method arms (`toFixed` / `toString` /
 * `toPrecision` / `toExponential` / `toLocaleString`) gate on `isNumberType`,
 * which matches only the primitive — so a wrapper receiver fell through to a
 * generic path that returned null / trapped ("null pointer") standalone.
 *
 * Fix (no new coercion site): the numeric arms now also accept a standalone
 * Number-wrapper receiver and recover its f64 via the existing §7.1.1.1
 * `__to_primitive(hint "number")` engine helper (reads the internal slot first)
 * → `__unbox_number`, then dispatch the same native `number_*` helper as a
 * primitive. The which-natives pre-pass (declarations.ts) was also taught to
 * recognize the wrapper receiver so the native helper is actually emitted (it
 * keyed on `isNumberType` only → the helper was never registered → null result).
 * `.valueOf()` already worked via the cs-2160 slice. Gated on `ctx.standalone`;
 * gc/host and WASI keep their existing object paths.
 *
 * Each case returns 1 on the spec-correct result, and the standalone module is
 * instantiated with an EMPTY import object, so any host-import leak (or the old
 * trap) fails the test.
 */

// Each body returns 1 iff the wrapper method produced the spec-correct value.
const CASES: ReadonlyArray<[string, string]> = [
  ["toFixed", `return new Number(3.14159).toFixed(2) === "3.14" ? 1 : 0;`],
  ["toFixed round", `return new Number(3.7).toFixed(0) === "4" ? 1 : 0;`],
  ["toFixed noarg", `return new Number(3.9).toFixed() === "4" ? 1 : 0;`],
  ["toFixed int", `return new Number(42).toFixed(0) === "42" ? 1 : 0;`],
  ["toFixed neg", `return new Number(-3.14159).toFixed(2) === "-3.14" ? 1 : 0;`],
  ["toString", `return new Number(255).toString() === "255" ? 1 : 0;`],
  ["toString radix16", `return new Number(255).toString(16) === "ff" ? 1 : 0;`],
  ["toString radix2", `return new Number(5).toString(2) === "101" ? 1 : 0;`],
  ["toString radix10", `return new Number(42).toString(10) === "42" ? 1 : 0;`],
  ["toPrecision", `return new Number(123.456).toPrecision(4) === "123.5" ? 1 : 0;`],
  ["toExponential", `return new Number(12345).toExponential(2) === "1.23e+4" ? 1 : 0;`],
  ["toLocaleString", `return new Number(42).toLocaleString() === "42" ? 1 : 0;`],
  ["valueOf", `return new Number(42).valueOf() === 42 ? 1 : 0;`],
  // via a wrapper local (not only inline) — exercises the bound-local path too.
  ["local toFixed", `const n = new Number(7.5); return n.toFixed(1) === "7.5" ? 1 : 0;`],
  ["local toString16", `const n = new Number(255); return n.toString(16) === "ff" ? 1 : 0;`],
  // RangeError still throws for an out-of-range fractionDigits on the wrapper.
  ["toFixed range throws", `try { new Number(1).toFixed(200); return 0; } catch (e) { return 1; }`],
];

const fn = (i: number) => `t${i}`;
const MODULE = CASES.map(([, body], i) => `export function ${fn(i)}(): number { ${body} }`).join("\n");

describe("#2160 Number.prototype method dispatch on a wrapper receiver — standalone", () => {
  it("every Number method works on a new Number() wrapper (no host-import leak)", async () => {
    const r = await compile(MODULE, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // No leaked host import for the wrapper method-dispatch path: number_* helpers
    // are emitted as native WasmGC functions, not env imports.
    const labels = r.imports.map((im) => `${im.module}::${im.name}`);
    for (const re of [/^env::number_/, /^env::__new_Number$/, /^env::__extern_/, /^wasm:js-string::/]) {
      expect(
        labels.filter((l) => re.test(l)),
        `leaked ${re.source}`,
      ).toEqual([]);
    }
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    CASES.forEach(([name], i) => {
      expect(ex[fn(i)]!(), `standalone wrapper ${name}`).toBe(1);
    });
  });

  // gc / JS-host mode is untouched (the fix is `ctx.standalone`-gated). This
  // guard proves the default backend still compiles + runs wrapper methods.
  it("default (gc / JS-host) mode still compiles wrapper number methods", async () => {
    const r = await compile(MODULE, {});
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
    const ex = instance.exports as Record<string, () => number>;
    CASES.forEach(([name], i) => {
      expect(ex[fn(i)]!(), `gc wrapper ${name}`).toBe(1);
    });
  });

  // Primitive number methods must remain byte-correct (the arms changed shape).
  it("primitive number methods unaffected (standalone)", async () => {
    const src = `export function test(): number {
      const a = (3.14159).toFixed(2) === "3.14" ? 1 : 0;
      const b = (255).toString(16) === "ff" ? 1 : 0;
      const c = (12345).toExponential(2) === "1.23e+4" ? 1 : 0;
      const d = (123.456).toPrecision(4) === "123.5" ? 1 : 0;
      return a + b + c + d;
    }`;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test: () => number }).test()).toBe(4);
  });
});
