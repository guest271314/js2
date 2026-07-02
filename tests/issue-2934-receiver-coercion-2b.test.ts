// #2934 slice 2b — two "static type says X, compiled value is Y" receiver
// coercion gaps that produced invalid standalone Wasm (same class as slice 2a,
// object-ops.ts):
//
//   1. `String(42).concat(void 0)` — `number_toString` returns the native
//      string EXTERNALIZED (`extern.convert_any`), so a statically-string-typed
//      receiver COMPILES to externref; compileNativeStringMethodCall's
//      `emitReceiver` fed it uncoerced to `__str_concat((ref null $AnyString), …)`
//      → `call[0] expected (ref null $AnyString), found call of externref`.
//      Fixed: emitReceiver casts an externref result back via the established
//      `emitNativeStringRefFromExternref` inverse (all string-typed externrefs
//      wrap native string structs in the native-strings world).
//
//   2. `regObj.exec(str).toString()` — the static receiver type resolves to
//      externref, but standalone lowers exec natively to a capture-array vec
//      `(ref null $Vec)`; the generic `.toString()` fallback (calls.ts) passed
//      the raw ref to `__extern_toString(externref)` → `call[0] expected
//      externref, found if of (ref null …)`. Fixed: coerce the COMPILED type
//      (extern.convert_any), mirroring the 2a receiver fix.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(source: string) {
  return compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
}

describe("#2934 2b — receiver compiled-type coercion (standalone)", () => {
  it("String(42).concat(void 0) compiles to valid Wasm and runs per spec", async () => {
    // NOTE: keep the argument the raw JS shape (\`void 0\`, static type
    // undefined — skipSemanticDiagnostics permits the arg-type mismatch); an
    // \`as never\`/\`as any\` cast would reroute the ToString-arg lowering.
    const r = await compileStandalone(`
      export function test(): number {
        return String(42).concat(void 0) === "42undefined" ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("String(x) receiver works across other string methods", async () => {
    const r = await compileStandalone(`
      export function test(): number {
        const n = 3.5;
        if (String(n).charAt(0) !== "3") return 1;
        if (String(n).indexOf(".") !== 1) return 2;
        if (String(n).slice(1) !== ".5") return 3;
        return 0;
      }
    `);
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(0);
  });

  it("regObj.exec(str).toString() compiles to valid Wasm", async () => {
    // Validity-only: ToString of the native capture array has a separate,
    // pre-existing runtime semantics gap (join of the match vec), tracked
    // apart from this invalid-Wasm slice — same precedent as slice 2a.
    const r = await compileStandalone(`
      export function test(): number {
        const str = "Hello World!";
        const regObj = new RegExp("World");
        const s = regObj.exec(str).toString();
        return s.length > 0 ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  });
});
