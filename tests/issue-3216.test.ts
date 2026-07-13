import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3216 — `__any_to_string` must bake the real `number_toString` for its number
// arms even when a reflective `String.prototype.<m>.call(<primitive>)` body's
// `ToString(this)` is the FIRST `__any_to_string` consumer in the module.
// Before the fix, `number_toString` was registered lazily by later consumers, so
// when the reflective body triggered the first `ensureAnyToStringHelper` the
// number arms baked the literal "[object Object]" — a cached, module-wide
// mis-compile of every boxed number/boolean. A `boolean` export lowers to i32
// (0/1) in standalone.
async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  if (!r.success) throw new Error("CE: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#3216 __any_to_string number arm when first consumer is reflective String.proto.<m>.call(<primitive>)", () => {
  it('charCodeAt.call(<number>, i) reads the decimal string, not "[object Object]"', async () => {
    // "12345".charCodeAt(0) === 49 ('1'); pre-fix returned 91 ('[' of "[object Object]").
    expect(
      await runStandalone(
        `export function test(): number { return String.prototype.charCodeAt.call(12345 as any, 0) as number; }`,
      ),
    ).toBe(49);
  });

  it("charAt.call(<number>, i) === the correct digit", async () => {
    // "12345".charAt(2) === "3"; pre-fix "[object Object]"[2] === 'b' → false.
    expect(
      await runStandalone(
        `export function test(): boolean { return (String.prototype.charAt.call(12345 as any, 2) as any) === "3"; }`,
      ),
    ).toBe(1);
  });

  it("charCodeAt.call(<boolean>, 0) stringifies the boolean, not the wrapper", async () => {
    // String(true) === "true"; "true".charCodeAt(0) === 116 ('t').
    expect(
      await runStandalone(
        `export function test(): number { return String.prototype.charCodeAt.call(true as any, 0) as number; }`,
      ),
    ).toBe(116);
  });

  it("does not regress the ordinary number-stringify consumers", async () => {
    // Array join / String() / template literals must still be exact.
    expect(
      await runStandalone(
        `export function test(): boolean { return [1,2,3].join(",") === "1,2,3" && String(3.14) === "3.14" && \`\${42}\` === "42" && String(NaN) === "NaN"; }`,
      ),
    ).toBe(1);
  });
});
