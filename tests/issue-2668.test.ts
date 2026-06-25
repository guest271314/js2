// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2668 Slice A — Object.defineProperty data-descriptor fidelity (host mode).
//
// Two convergence fixes land here, both targeting the largest ES5
// `built-ins/Object/defineProperty` cluster (the `15.2.3.6-3-*` family where
// the descriptor is supplied as a non-literal expression):
//
//  1. DYNAMIC-DESCRIPTOR ROUTING (src/codegen/object-ops.ts). The inline fast
//     paths only fire when the descriptor is a *syntactic* object literal at
//     the call site. A descriptor supplied as a variable (`var d = {...}`), as
//     an arbitrary host object (`Math`), or as any other expression previously
//     fell through to `emitExternDefinePropertyNoValue`, which had no descriptor
//     to read and silently dropped the value + every attribute. Host mode now
//     routes those through `emitDefinePropertyDescRuntime` → the runtime
//     `__defineProperty_desc` applier (full ToPropertyDescriptor +
//     `_validatePropertyDescriptor`, §10.1.6.3), mirroring the standalone lane.
//
//  2. TYPED-FIELD VALUE WRITEBACK (src/runtime.ts `_structFieldWriteback`). A
//     `const o: any = {}` whose property is later defined gets a *typed* struct
//     shape, so `o.<key>` ref-tests as that struct and lowers to a static
//     `struct.get` that never consults the sidecar. The runtime descriptor
//     appliers now mirror the defined VALUE into the real struct field via the
//     compiled `__sset_<key>` export, so static reads see the defined value.
//
//  3. FOR-IN ENUMERABILITY (src/runtime.ts `__for_in_keys`). A typed struct
//     field defined with `enumerable: false` is now hidden from for-in /
//     EnumerateObjectProperties (the field-name list now consults
//     `_wasmPropDescs`).
//
// Accessors (Slice B), array-`length` exotic (Slice C), and standalone
// descriptor fidelity (gated on #2580) are out of scope for Slice A.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

async function run(src: string, fn = "test"): Promise<unknown> {
  const result = await compile(src);
  if (!result.success) {
    throw new Error("Compile failed: " + result.errors.map((e) => `L${e.line}: ${e.message}`).join("; "));
  }
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]!();
}

describe("#2668 Slice A — dynamic data-descriptor application", () => {
  it("descriptor variable: value is applied and readable (15.2.3.6-3-126)", async () => {
    expect(
      await run(`
        export function test(): number {
          const obj: any = {};
          const attr: any = { value: 100 };
          Object.defineProperty(obj, "property", attr);
          return obj.property;
        }
      `),
    ).toBe(100);
  });

  it("descriptor variable: GOPD round-trips the value", async () => {
    expect(
      await run(`
        export function test(): number {
          const obj: any = {};
          const attr: any = { value: 42 };
          Object.defineProperty(obj, "property", attr);
          const d: any = Object.getOwnPropertyDescriptor(obj, "property");
          return d ? d.value : -1;
        }
      `),
    ).toBe(42);
  });

  it("arbitrary host object as descriptor (Math) — 15.2.3.6-3-144", async () => {
    expect(
      await run(`
        export function test(): string {
          const obj: any = {};
          (Math as any).value = "Math";
          Object.defineProperty(obj, "property", Math as any);
          return obj.property;
        }
      `),
    ).toBe("Math");
  });

  it("descriptor with non-boolean attribute coerces via ToBoolean", async () => {
    // { configurable: <truthy> } via a variable descriptor → configurable true.
    expect(
      await run(`
        export function test(): number {
          const obj: any = {};
          const attr: any = { value: 7, configurable: 1 };
          Object.defineProperty(obj, "property", attr);
          const d: any = Object.getOwnPropertyDescriptor(obj, "property");
          return (d.value === 7 ? 1 : 0) + (d.configurable === true ? 10 : 0);
        }
      `),
    ).toBe(11);
  });

  it("dynamic descriptor: omitted attrs default to false on a new define", async () => {
    expect(
      await run(`
        export function test(): number {
          const obj: any = {};
          const attr: any = { value: 5 };
          Object.defineProperty(obj, "property", attr);
          const d: any = Object.getOwnPropertyDescriptor(obj, "property");
          let r = 0;
          if (d.value === 5) r += 1;
          if (d.writable === false) r += 10;
          if (d.enumerable === false) r += 100;
          if (d.configurable === false) r += 1000;
          return r;
        }
      `),
    ).toBe(1111);
  });
});

describe("#2668 Slice A — runtime honors defineProperty'd flags on typed struct fields", () => {
  it("enumerable:false hides a typed struct field from for-in (inline desc)", async () => {
    expect(
      await run(`
        export function test(): number {
          const o: any = { x: 0 };
          Object.defineProperty(o, "x", { value: 1, enumerable: false });
          o.y = 2;
          let count = 0;
          for (const k in o) count++;
          return count;
        }
      `),
    ).toBe(1);
  });

  it("enumerable:false hides a typed struct field from for-in (dynamic desc)", async () => {
    expect(
      await run(`
        export function test(): number {
          const o: any = { x: 0 };
          const d: any = { value: 1, enumerable: false };
          Object.defineProperty(o, "x", d);
          o.y = 2;
          let count = 0;
          for (const k in o) count++;
          return count;
        }
      `),
    ).toBe(1);
  });

  it("inline value-only define still readable (no regression)", async () => {
    expect(
      await run(`
        export function test(): number {
          const obj: any = {};
          Object.defineProperty(obj, "property", { value: 100 });
          return obj.property;
        }
      `),
    ).toBe(100);
  });

  it("plain assignment after value-only struct define still reads back", async () => {
    expect(
      await run(`
        export function test(): number {
          const obj: any = { a: 1 };
          Object.defineProperty(obj, "a", { value: 9 });
          return obj.a;
        }
      `),
    ).toBe(9);
  });
});
