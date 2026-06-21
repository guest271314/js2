import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2042 S4 (call-site layer) — the typed-struct / literal-receiver redefine path
// in `compileObjectDefineProperty` (object-ops.ts), distinct from the native
// `$Object` runtime layer (object-runtime.ts, sdev-reflect's #2042:s4-validate-apply).
//
// A `const o: any = {}` empty object literal lowers to an open typed struct, so
// `Object.defineProperty(o, "x", …)` takes the struct.set path with a
// `needsValueCompare` guard when the prior descriptor was non-writable /
// non-configurable. That guard emitted the "Cannot redefine property" throw as
// `global.get <stringGlobalMap.get(msg)>`. Under nativeStrings (auto-on for
// --target standalone/wasi) the map returns the `-1` sentinel, so a SECOND
// value-define on the same key reached binary emit as
// `global index out of range — -1` (the #2043 late-import-shift class). It also
// threw a bare string, so `assert.throws(TypeError, …)` never matched.
//
// The fix routes both compare branches (f64 / i32) through `emitThrowTypeError`,
// producing a real catchable TypeError instance and an inline `$NativeString`
// (no `-1` global) under standalone. Strings can't be read back from a standalone
// export without the host string glue, so these probes signal pass/fail via
// numeric return values.

async function runStandalone(body: string): Promise<unknown> {
  const r = await compile(body, { fileName: "test.ts", target: "standalone" });
  if (!r.success) {
    throw new Error(`Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#2042 S4 call-site — literal-receiver redefine (object-ops.ts)", () => {
  it("two value-defines on the same key compile (no #2043 `global index out of range -1`)", async () => {
    // Regression: this previously failed to COMPILE under --target standalone.
    expect(
      await runStandalone(
        `export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { value: 5 });
          Object.defineProperty(o, "x", { value: 5 });
          return 1;
        }`,
      ),
    ).toBe(1);
  });

  it("two value-defines with DIFFERENT numeric values compile", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { value: 5 });
          try { Object.defineProperty(o, "x", { value: 6 }); } catch (e) {}
          return 1;
        }`,
      ),
    ).toBe(1);
  });

  it("redefining a non-configurable property with a different value throws (caught)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { value: 5 });
          try { Object.defineProperty(o, "x", { value: 6 }); return 0; }
          catch (e) { return 1; }
        }`,
      ),
    ).toBe(1);
  });

  it("the thrown value is a real TypeError instance (not a bare string)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { value: 5 });
          try { Object.defineProperty(o, "x", { value: 6 }); return 0; }
          catch (e) { return (e instanceof TypeError) ? 1 : 2; }
        }`,
      ),
    ).toBe(1);
  });

  it("an uncaught invalid redefinition surfaces a catchable exception (not a silent success)", async () => {
    await expect(
      runStandalone(
        `export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { value: 5 });
          Object.defineProperty(o, "x", { value: 6 });
          return o.x;
        }`,
      ),
    ).rejects.toThrow();
  });

  it("redefining with the SAME value does not throw (SameValue, §10.1.6.3)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { value: 5 });
          try { Object.defineProperty(o, "x", { value: 5 }); return 0; }
          catch (e) { return 1; }
        }`,
      ),
    ).toBe(0);
  });

  it("a writable non-configurable property allows a value change (no throw)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { value: 5, writable: true });
          try { Object.defineProperty(o, "x", { value: 6 }); return 0; }
          catch (e) { return 1; }
        }`,
      ),
    ).toBe(0);
  });

  it("a single value-define on a fresh literal object is unregressed", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { value: 42 });
          return o.x;
        }`,
      ),
    ).toBe(42);
  });
});
