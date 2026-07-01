// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2915 — Native ToBoolean on the property-descriptor-attribute path (and the
 * `Boolean(x)` conversion function) under `--target standalone`.
 *
 * The dynamic descriptor-flag lowering (`emitRuntimeFlagsF64` in
 * `src/codegen/object-ops.ts`) and the `Boolean(externref)` call handler
 * (`src/codegen/expressions/calls.ts`) both coerced their operand to a boolean
 * via the bodyless `env::__to_boolean` HOST import. In standalone mode that
 * import has no native body, so it *leaked*: every otherwise-passing
 * `Object.defineProperty` / `Object.defineProperties` / `Boolean()` test
 * (44 in test262) stayed host-dependent even though it ran correctly.
 *
 * The fix routes the standalone lane through the existing native `__is_truthy`
 * union helper — a real Wasm body that applies the identical ES §7.1.2
 * ToBoolean lowering over the boxed value structs (number / boolean / bigint /
 * string) and treats any other non-null ref (e.g. a `new Boolean(false)`
 * `$Object` wrapper) as truthy. The GC/host lane is untouched (gated on
 * `ctx.standalone`), so its emitted bytes are unchanged.
 *
 * These modules instantiate with an EMPTY import object, proving no JS host is
 * needed.
 */

function envLabels(imports: { module: string; name: string }[]): string[] {
  return imports.filter((i) => i.module === "env").map((i) => i.name);
}

async function runStandalone(source: string, target: "standalone" | "wasi" = "standalone") {
  const r = await compile(source, { target });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // The __to_boolean host import must NOT leak.
  expect(envLabels(r.imports)).not.toContain("__to_boolean");
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, () => number>;
}

describe("#2915 — native ToBoolean on descriptor + Boolean() path (standalone)", () => {
  it("Object.defineProperty enumerable = new Boolean(false) is treated as truthy (host-free)", async () => {
    // ES §6.2.5.6 step 5.b: an object descriptor value ToBoolean-coerces; a
    // `new Boolean(false)` wrapper is an object → truthy → the property IS
    // enumerable. Mirrors test262 15.2.3.6-3-72.
    const src = `
      export function test(): number {
        const obj: any = {};
        Object.defineProperty(obj, "property", { enumerable: new Boolean(false) as any });
        let accessed = 0;
        for (const prop in obj) { if (prop === "property") accessed = 1; }
        return accessed;
      }
    `;
    const exports = await runStandalone(src);
    expect(exports.test()).toBe(1);
  });

  it("Object.defineProperty enumerable = 0 (dynamic) is falsy (host-free)", async () => {
    // A boxed-number 0 must ToBoolean to false → the property is NOT enumerable.
    const src = `
      export function test(): number {
        const obj: any = {};
        const flag: any = 0;
        Object.defineProperty(obj, "property", { enumerable: flag });
        let accessed = 0;
        for (const prop in obj) { if (prop === "property") accessed = 1; }
        return accessed === 0 ? 1 : 0;
      }
    `;
    const exports = await runStandalone(src);
    expect(exports.test()).toBe(1);
  });

  it("Boolean() conversion function covers the ToBoolean edge cases (host-free)", async () => {
    const src = `
      export function test(): number {
        const u: any = undefined;
        const z: any = 0;
        const s: any = "";
        const o: any = new Boolean(false);
        // undefined/0/"" → false ; wrapper object → true
        if (Boolean(u)) return 2;
        if (Boolean(z)) return 3;
        if (Boolean(s)) return 4;
        if (!Boolean(o)) return 5;
        return 1;
      }
    `;
    const exports = await runStandalone(src);
    expect(exports.test()).toBe(1);
  });
});
