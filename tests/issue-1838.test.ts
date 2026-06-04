// #1838 — the linear/standalone backend silently miscompiled try/catch: it
// inlined the try body and DISCARDED the catch clause, so
// `try { throw e } catch (e) { handler }` ran the (unreachable) throw and never
// the handler — silent divergence from JS with no diagnostic.
//
// Until a Wasm-EH try/catch lowering lands, the backend now raises a clear
// compile error for try/catch instead of miscompiling. A try/finally (no
// catch handler to lose) still compiles and inlines both blocks.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#1838 — linear backend try/catch", () => {
  it("raises a compile error for try/catch instead of silently dropping the handler", async () => {
    const src = `export function test(): number { try { return 1; } catch (e) { return 2; } }`;
    const r = await compile(src, { fileName: "t.ts", target: "linear" });
    expect(r.success).toBe(false);
    expect(r.errors.some((e) => /try\/catch is not yet supported by the linear/.test(e.message))).toBe(true);
  });

  it("raises a compile error for try/catch/finally too", async () => {
    const src = `export function test(): number { try { return 1; } catch (e) { return 2; } finally { } }`;
    const r = await compile(src, { fileName: "t.ts", target: "linear" });
    expect(r.success).toBe(false);
  });

  it("still compiles try/finally (no catch handler to lose) and runs both blocks", async () => {
    const src = `
      export function test(): number {
        let x = 0;
        try { x = 5; } finally { x = x + 1; }
        return x;
      }
    `;
    const r = await compile(src, { fileName: "t.ts", target: "linear" });
    expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
    const importObject = (r as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(r.binary, importObject);
    expect((instance.exports.test as () => number)()).toBe(6);
  });

  it("WasmGC (default) backend still compiles try/catch normally", async () => {
    // Guard: the fix is scoped to the linear backend; the default WasmGC path
    // (which has real EH) must be unaffected.
    const src = `export function test(): number { try { return 1; } catch (e) { return 2; } }`;
    const r = await compile(src, { fileName: "t.ts" });
    expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});
