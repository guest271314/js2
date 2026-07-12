import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3076 — standalone destructuring (and every other dynamic read) must honor
// throwing accessor getters installed via `Object.defineProperty({}, …)`.
//
// Root cause: TS's generic `defineProperty<T>(o: T, …)` gives an inline `{}`
// receiver a CONCRETE empty contextual type, so the literal lowered to a
// closed struct (`struct.new_default`) instead of an open `$Object`. The
// standalone runtime store `__defineProperty_accessor` is a lenient no-op on
// a closed struct, so the accessor silently vanished: reads returned
// undefined, and the canonical test262 `dstr/*obj-ptrn-*get-value-err` shape
// (GetV during object-pattern binding must fire the poisoned getter,
// §13.3.3.7 KeyedBindingInitialization step 4) false-passed/failed.
//
// Fix: an empty `{}` receiver argument of Object/Reflect.defineProperty(ies)
// builds as an open `$Object` (standalone/wasi), so the native accessor store
// and the `__extern_get` accessor dispatch (#1888 S5b) service it end-to-end.
async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  if (!r.success) {
    throw new Error(`Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#3076 — defineProperty accessor on {} receiver honored by standalone reads/destructuring", () => {
  it("object-pattern var-decl destructure fires the poisoned getter (test262 obj-ptrn-id-get-value-err shape)", async () => {
    expect(
      await runStandalone(`
        var poisonedProperty = Object.defineProperty({}, "poisoned", {
          get: function () { throw "boom"; },
        });
        export function test(): number {
          try {
            var { poisoned } = poisonedProperty as any;
            return 3; // no throw = accessor dropped
          } catch (e) { return e === "boom" ? 1 : 2; }
        }`),
    ).toBe(1);
  });

  it("param-position object destructure fires the poisoned getter", async () => {
    expect(
      await runStandalone(`
        var poisonedProperty = Object.defineProperty({}, "poisoned", {
          get: function () { throw "boom"; },
        });
        function f({ poisoned }: any): number { return 5; }
        export function test(): number {
          try { f(poisonedProperty as any); return 3; } catch (e) { return e === "boom" ? 1 : 2; }
        }`),
    ).toBe(1);
  });

  it("plain member read fires the poisoned getter", async () => {
    expect(
      await runStandalone(`
        var poisonedProperty = Object.defineProperty({}, "poisoned", {
          get: function () { throw "boom"; },
        });
        export function test(): number {
          try { const v = (poisonedProperty as any).poisoned; return 3; } catch (e) { return e === "boom" ? 1 : 2; }
        }`),
    ).toBe(1);
  });

  it("non-throwing getter VALUE is read through the destructure (not undefined)", async () => {
    expect(
      await runStandalone(`
        var o = Object.defineProperty({}, "p", {
          get: function () { return 42; },
        });
        export function test(): number {
          const { p } = o as any;
          return p === 42 ? 1 : 9;
        }`),
    ).toBe(1);
  });

  it("Object.defineProperties({} …) accessor is honored too", async () => {
    expect(
      await runStandalone(`
        var o = Object.defineProperties({}, {
          p: { get: function () { throw "boom"; } },
        });
        export function test(): number {
          try { const { p } = o as any; return 3; } catch (e) { return e === "boom" ? 1 : 2; }
        }`),
    ).toBe(1);
  });

  it("data-descriptor defineProperty on {} still reads back (no regression)", async () => {
    expect(
      await runStandalone(`
        var o = Object.defineProperty({}, "d", { value: 7, enumerable: true });
        export function test(): number {
          const v = (o as any).d;
          return v === 7 ? 1 : 9;
        }`),
    ).toBe(1);
  });
});
