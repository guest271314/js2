import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2541 — standalone Object.prototype.propertyIsEnumerable native lowering.
//
// Before this slice, `o.propertyIsEnumerable("x")` under `--target standalone`
// refused with a `Codegen error: '__propertyIsEnumerable' (dynamic-shape …)` CE
// because the helper was never registered as a native (only a refused host
// import). It now lowers natively over the same $Object/$PropEntry runtime as
// the working `__hasOwnProperty`: own-property presence (no proto walk) AND the
// entry's FLAG_ENUMERABLE bit. §20.1.3.4.
async function runStandalone(body: string): Promise<unknown> {
  const r = await compile(body, { fileName: "test.ts", target: "standalone" });
  if (!r.success) {
    throw new Error(`Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

const MK = "function mk(): any { return {}; }";

describe("#2541 standalone Object.prototype.propertyIsEnumerable", () => {
  it("returns true for an enumerable own property", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { x: 1 };
        return o.propertyIsEnumerable("x") ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("returns false for a missing property", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { x: 1 };
        return o.propertyIsEnumerable("y") ? 1 : 0;
      }`),
    ).toBe(0);
  });

  it("returns false for a non-enumerable own property", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const o: any = mk();
          Object.defineProperty(o, "x", { value: 1, enumerable: false });
          return o.propertyIsEnumerable("x") ? 1 : 0;
        }`),
    ).toBe(0);
  });

  it("returns true for an explicitly enumerable defined property", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const o: any = mk();
          Object.defineProperty(o, "x", { value: 1, enumerable: true });
          return o.propertyIsEnumerable("x") ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("does not walk the prototype chain (inherited prop → false)", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const proto: any = mk();
          proto.p = 1;
          const o: any = Object.create(proto);
          // 'p' is inherited, not own → propertyIsEnumerable is own-only
          return o.propertyIsEnumerable("p") ? 1 : 0;
        }`),
    ).toBe(0);
  });

  it("hasOwnProperty still works (sibling helper unregressed)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { x: 1 };
        return o.hasOwnProperty("x") ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
