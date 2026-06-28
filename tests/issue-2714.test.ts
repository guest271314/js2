import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2714 — an object literal containing a spread, evaluated in a NON-SPECIFIC
// contextual type (notably as a direct call argument like `Object.keys({...o})`,
// whose contextual type is the shapeless `object` param), used to take the
// struct-spread path. That path lays out fields from the literal's STATIC type
// only, so spread-copied keys (dynamic, CopyDataProperties-at-runtime) were
// absent from the key list `Object.keys` walks — and an INLINE spread source
// consumed directly (`Object.keys({ ...{ a, b } })`) underflowed the
// struct-spread `struct.new` and crashed Wasm validation. The fix routes such
// literals to the host plain-object path (which copies via __object_assign and
// produces a real enumerable object), matching what an assigned/`any`-context
// spread literal already did. A CONCRETE struct target keeps the struct path.
async function run(source: string, fn = "test"): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

describe("#2714 — object-spread keys are enumerable", () => {
  it("Object.keys of an inline-spread literal (was a struct.new crash)", async () => {
    expect(await run(`export function test(): number { return Object.keys({ ...{ a: 2, b: 3 } }).length; }`)).toBe(2);
  });

  it("Object.keys of a var-spread literal (was 0)", async () => {
    expect(
      await run(
        `export function test(): number { const o: any = { a: 2, b: 3 }; return Object.keys({ ...o }).length; }`,
      ),
    ).toBe(2);
  });

  it("Object.keys of spread-then-data", async () => {
    expect(
      await run(`export function test(): number { return Object.keys({ ...{ a: 2, b: 3 }, c: 5 }).length; }`),
    ).toBe(3);
  });

  it("Object.keys of data-then-spread", async () => {
    expect(
      await run(`export function test(): number { return Object.keys({ c: 5, ...{ a: 2, b: 3 } }).length; }`),
    ).toBe(3);
  });

  it("spread values are still read correctly", async () => {
    expect(
      await run(
        `export function test(): number { const o: any = { ...{ a: 2, b: 3 } }; return (o.a as number) + (o.b as number); }`,
      ),
    ).toBe(5);
  });

  it("getOwnPropertyNames matches Object.keys for a spread literal", async () => {
    expect(
      await run(
        `export function test(): number { const o: any = { ...{ a: 2, b: 3 } }; return Object.getOwnPropertyNames(o).length; }`,
      ),
    ).toBe(2);
  });

  // ── controls ──
  it("CONTROL: no-spread literal still enumerates", async () => {
    expect(await run(`export function test(): number { return Object.keys({ a: 2, b: 3 }).length; }`)).toBe(2);
  });

  it("CONTROL: spread into a CONCRETE struct target reads back (struct path retained)", async () => {
    expect(
      await run(
        `export function test(): number { const o = { a: 2, b: 3 }; const x: { a: number; b: number } = { ...o }; return x.a + x.b; }`,
      ),
    ).toBe(5);
  });
});
