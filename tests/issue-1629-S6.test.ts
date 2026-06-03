// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1629 S6 — standalone/WASI descriptor parity.
 *
 * `Object.defineProperty(obj, key, { value, writable?, enumerable?,
 * configurable? })` (a DATA descriptor) now lowers to the Wasm-native
 * `__defineProperty_value` helper on the #1472 Phase B `$Object`/`$PropEntry`
 * open-object runtime, instead of refusing under `--target standalone` (#1472
 * Phase A). The value + attribute flags are stored into the property entry and
 * read back by the existing native `__extern_get`. Zero `env::__defineProperty*`
 * host imports; the module instantiates with an empty import object.
 *
 * Accessor descriptors (`{ get, set }`) are NOT in this slice — they remain
 * refused under standalone (deferred S6 follow-up: $PropEntry accessor slots +
 * call_ref invocation).
 */

const DEFINE_PROP_IMPORTS = /^env::__defineProperty/;

function assertNoDefinePropertyHostImports(imports: ReadonlyArray<{ module: string; name: string }>): void {
  const labels = imports.map((i) => `${i.module}::${i.name}`);
  const hits = labels.filter((l) => DEFINE_PROP_IMPORTS.test(l));
  expect(hits, `--target standalone leaked ${hits.join(", ")}`).toEqual([]);
}

async function run(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  assertNoDefinePropertyHostImports(r.imports);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#1629 S6 — native Object.defineProperty (data descriptor) under --target standalone", () => {
  it("defines a data property with full attributes and reads it back", async () => {
    expect(
      await run(`
        export function run(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { value: 42, writable: true, enumerable: true, configurable: true });
          return o.x as number;
        }
      `),
    ).toBe(42);
  });

  it("defines a data property with omitted attributes (CompletePropertyDescriptor defaults)", async () => {
    expect(
      await run(`
        export function run(): number {
          const o: any = {};
          Object.defineProperty(o, "y", { value: 7 });
          return o.y as number;
        }
      `),
    ).toBe(7);
  });

  it("coexists with plain dynamic property set/get on the same object", async () => {
    expect(
      await run(`
        export function run(): number {
          const o: any = {};
          o.a = 10;
          Object.defineProperty(o, "b", { value: 32 });
          return (o.a as number) + (o.b as number);
        }
      `),
    ).toBe(42);
  });

  it("redefining an existing key via defineProperty overwrites the value", async () => {
    expect(
      await run(`
        export function run(): number {
          const o: any = {};
          o.k = 1;
          Object.defineProperty(o, "k", { value: 5 });
          return o.k as number;
        }
      `),
    ).toBe(5);
  });

  it("Object.defineProperty on null throws a catchable TypeError (native null-guard)", async () => {
    // The shared object-arg null guard materializes its message via
    // stringConstantExternrefInstrs (a nativeStrings-safe inline $NativeString),
    // not a host string_constants global — so the throw path is valid Wasm in
    // standalone. Returns 99 when the TypeError is caught.
    expect(
      await run(`
        export function run(): number {
          const o: any = null;
          try {
            Object.defineProperty(o, "x", { value: 1 });
            return 0;
          } catch (e) {
            return 99;
          }
        }
      `),
    ).toBe(99);
  });

  it("multiple defineProperty calls grow/rehash the native table correctly", async () => {
    expect(
      await run(`
        export function run(): number {
          const o: any = {};
          Object.defineProperty(o, "p0", { value: 0 });
          Object.defineProperty(o, "p1", { value: 1 });
          Object.defineProperty(o, "p2", { value: 2 });
          Object.defineProperty(o, "p3", { value: 3 });
          Object.defineProperty(o, "p4", { value: 4 });
          Object.defineProperty(o, "p5", { value: 5 });
          Object.defineProperty(o, "p6", { value: 6 });
          Object.defineProperty(o, "p7", { value: 7 });
          Object.defineProperty(o, "p8", { value: 8 });
          return (o.p0 as number) + (o.p7 as number) + (o.p8 as number);
        }
      `),
    ).toBe(15);
  });
});
