// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2703 — delete throw semantics (ECMA-262 §13.5.1.2). The delete operator must
// THROW (not return false) in three cases, all caught by test262's
// `assert.throws` (which accepts any thrown value):
//   - `delete super.x`        → ReferenceError, always (step 5.b)
//   - `delete null.x` / `delete undefined[k]` → TypeError via
//                               RequireObjectCoercible (step 5.b → ToObject)
//   - strict-mode `delete <non-configurable own prop>` → TypeError (step 6.b)
//
// These tests compile each form with a Wasm-level try/catch that returns 1 when
// the delete throws and 0 otherwise, plus sloppy-mode controls proving the
// throw is gated (a sloppy non-configurable delete returns false, and a normal
// configurable delete still succeeds and removes the property).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(source: string): Promise<Record<string, (...a: number[]) => unknown>> {
  const result = await compile(source);
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return instance.exports as unknown as Record<string, (...a: number[]) => unknown>;
}

describe("#2703 delete throw semantics", () => {
  it("delete super.x throws (ReferenceError)", async () => {
    const e = await runHost(`
      class Base { x: number = 1; }
      class C extends Base {
        m(): number { try { delete (super.x as any); return 0; } catch (err) { return 1; } }
      }
      export function test(): number { return new C().m(); }
    `);
    expect(e.test()).toBe(1);
  });

  it("delete on a null base throws (TypeError)", async () => {
    const e = await runHost(`
      export function test(): number {
        const base: any = null;
        try { delete base.prop; return 0; } catch (err) { return 1; }
      }
    `);
    expect(e.test()).toBe(1);
  });

  it("delete on an undefined base (computed) throws (TypeError)", async () => {
    const e = await runHost(`
      export function test(): number {
        const base: any = undefined;
        try { delete base[0]; return 0; } catch (err) { return 1; }
      }
    `);
    expect(e.test()).toBe(1);
  });

  it("strict-mode delete of a non-configurable property throws (TypeError)", async () => {
    // The delete lives in a class method — class bodies are always strict.
    const e = await runHost(`
      class K { del(o: any): number { try { delete o.prop; return 0; } catch (err) { return 1; } } }
      export function test(): number {
        const o: any = {};
        Object.defineProperty(o, "prop", { value: 1, configurable: false });
        return new K().del(o);
      }
    `);
    expect(e.test()).toBe(1);
  });

  it("sloppy-mode delete of a non-configurable property returns false (no throw)", async () => {
    const e = await runHost(`
      export function test(): number {
        const o: any = {};
        Object.defineProperty(o, "prop", { value: 1, configurable: false });
        return delete o.prop ? 1 : 0;
      }
    `);
    expect(e.test()).toBe(0);
  });

  it("delete this.x at top level does not throw (this is object-coercible)", async () => {
    const e = await runHost(`
      export function test(): number {
        try { delete (this as any).x; return 0; } catch (err) { return 1; }
      }
    `);
    expect(e.test()).toBe(0);
  });

  it("normal configurable delete succeeds and removes the property", async () => {
    const e = await runHost(`
      export function test(): number {
        const o: any = {};
        Object.defineProperty(o, "prop", { value: 1, configurable: true });
        const ok = delete o.prop ? 1 : 0;
        const gone = o.hasOwnProperty("prop") ? 0 : 1;
        return ok + gone; // 2 when delete returned true AND property is gone
      }
    `);
    expect(e.test()).toBe(2);
  });
});
