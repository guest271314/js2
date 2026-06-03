// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1749 — Array spread `[...arr]` must honor an overridden
// `Array.prototype[Symbol.iterator]` / `Array.prototype.values`.
//
// Split out of #1719 (CPR — Compiled Prototype Record): #1719 landed the
// read-drive for the four array-DESTRUCTURING contexts; spread is a distinct
// GetIterator consumer (§12.2.5.3) that still took the static backing-store
// fast path. This drives the captured override at the spread-element emit site
// via the same in-Wasm `__drive_proto_iterator` driver, draining the
// (WasmGC) override iterator through `__iterator_next` into the spread target.
//
// Acceptance:
//   - `Array.prototype[Symbol.iterator] = function*(){ yield 42 }; [...[1,2,3]]`
//     reflects the override, not `[1,2,3]`.
//   - override-free spread is byte-identical (no drive / no override global /
//     no iterator import emitted) — guarded structurally below + by the
//     equivalence suite.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports as buildRuntimeImports } from "../src/runtime.js";

async function run(source: string, opts?: { fileName?: string }): Promise<Record<string, Function>> {
  const result = await compile(source, (opts ?? { fileName: "t.js" }) as never);
  if (!result.success) {
    throw new Error("Compile failed: " + result.errors.map((e) => `L${e.line}: ${e.message}`).join("; "));
  }
  const rt = buildRuntimeImports(result.imports ?? [], undefined, result.stringPool) as Record<string, unknown> & {
    setExports?: (e: Record<string, Function>) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, rt as never);
  if (rt.setExports) rt.setExports(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

describe("#1749 — array spread drives the overridden Array.prototype[@@iterator]", () => {
  it("[...[1,2,3]] reflects a single-yield override (length 1, value 42)", async () => {
    const ex = await run(
      `
      Array.prototype[Symbol.iterator] = function* () { yield 42; };
      function test() {
        var a = [...[1, 2, 3]];
        return a.length === 1 && a[0] === 42 ? 1 : 0;
      }
      export { test };
      `,
      { fileName: "t.js" },
    );
    expect(ex.test()).toBe(1);
  });

  it("override reading `this[i]` yields the array's own elements + an extra value", async () => {
    const ex = await run(
      `
      Array.prototype[Symbol.iterator] = function* () { yield this[0]; yield this[1]; yield 99; };
      function test() {
        var a = [...[1, 2, 3]];
        // a === [1, 2, 99]
        return a.length * 1000 + a[0] * 100 + a[1] * 10 + a[2];
      }
      export { test };
      `,
      { fileName: "t.js" },
    );
    expect(ex.test()).toBe(3219);
  });

  it("spread mixes with literal elements (head + override-spread + tail)", async () => {
    const ex = await run(
      `
      Array.prototype[Symbol.iterator] = function* () { yield 7; yield 8; };
      function test() {
        var a = [0, ...[1, 2, 3], 9];
        // a === [0, 7, 8, 9]
        return a.length * 100 + a[0] * 10 + a[1] + a[a.length - 1];
      }
      export { test };
      `,
      { fileName: "t.js" },
    );
    expect(ex.test()).toBe(416);
  });

  it("Array.prototype.values override drives spread (§23.1.3.36 alias of @@iterator)", async () => {
    const ex = await run(
      `
      Array.prototype.values = function* () { yield 5; yield 6; };
      function test() {
        var a = [...[1, 2, 3]];
        // a === [5, 6]
        return a.length * 10 + a[0] + a[1];
      }
      export { test };
      `,
      { fileName: "t.js" },
    );
    expect(ex.test()).toBe(31);
  });

  it("terminates — the override fires once at the spread boundary (no re-entrancy)", async () => {
    // The override body reads `this[0]`/`this[1]`; if the brand re-routed every
    // internal array read, driving the override would recurse forever. The test
    // simply completing proves the brand only fires at the observation site.
    const ex = await run(
      `
      Array.prototype[Symbol.iterator] = function* () { yield this[0]; yield this[1]; yield this[2]; };
      function test() {
        var a = [...[10, 20, 30]];
        return a[0] + a[1] + a[2];
      }
      export { test };
      `,
      { fileName: "t.js" },
    );
    expect(ex.test()).toBe(60);
  });

  it("override-free spread reads the backing store (byte-identical fast path)", async () => {
    const ex = await run(
      `
      function test(): number {
        const a = [...[1, 2, 3], 4, ...[5, 6]];
        let s = 0;
        for (let i = 0; i < a.length; i++) s += a[i];
        return a.length * 100 + s;
      }
      export { test };
      `,
      { fileName: "t.ts" },
    );
    // [1,2,3,4,5,6] → len 6, sum 21 → 621
    expect(ex.test()).toBe(621);
  });

  it("override-free spread emits NO drive / override global / iterator import", async () => {
    // Structural byte-identity guard: the whole read-drive branch is gated
    // behind `arrayIteratorMaybeOverridden && override-captured`, both false
    // here, so none of the override machinery is emitted.
    const result = await compile(`function test() { var a = [...[1, 2, 3]]; return a.length; } export { test };`, {
      fileName: "t.js",
    } as never);
    expect(result.success).toBe(true);
    const wat = (result as unknown as { wat: string }).wat;
    expect(/__drive_proto_iterator/.test(wat)).toBe(false);
    expect(/__iterator_next/.test(wat)).toBe(false);
    expect(/array_proto_iterator_override/.test(wat)).toBe(false);
  });
});
