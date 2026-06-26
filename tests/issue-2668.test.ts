// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2668 Slice A — Object.defineProperty data-descriptor fidelity (host mode).
//
// Targets the `var d = { value: 1 }; Object.defineProperty(o, k, d)` shape (a
// descriptor in a local whose initializer is an object literal — the dominant
// `built-ins/Object/defineProperty/15.2.3.6-3-*` ES5 pattern). Two fixes:
//
//  1. DYNAMIC-DESCRIPTOR ROUTING (src/codegen/object-ops.ts). The inline fast
//     paths only fire for a *syntactic* object-literal descriptor at the call
//     site. A descriptor supplied as a local previously fell through to
//     `emitExternDefinePropertyNoValue`, which had no descriptor to read and
//     silently dropped the value + every attribute. Host mode now routes a
//     descriptor identifier whose declaration initializer is an object literal
//     through `emitDefinePropertyDescRuntime` → `__defineProperty_desc` (full
//     ToPropertyDescriptor + `_validatePropertyDescriptor`, §10.1.6.3).
//
//     SCOPE: only LITERAL-resolvable descriptor identifiers are routed.
//     Arbitrary host-object descriptors (`Math`, a `Date` instance, an
//     `Object.create(proto)` whose attributes live on a sidecar-backed
//     prototype) are deliberately left on their prior path — the runtime
//     ToPropertyDescriptor reader resolves a WasmGC-struct descriptor's
//     attributes only on its OWN level, so routing them would drop a
//     prototype-inherited `enumerable`/`configurable` (a deeper Object.create +
//     proto-sidecar gap, out of Slice A scope).
//
//  2. TYPED-FIELD VALUE WRITEBACK (src/runtime.ts `_structFieldWriteback`). A
//     `const o: any = {}` whose property is later defined gets a *typed* struct
//     shape, so `o.<key>` ref-tests as that struct and lowers to a static
//     `struct.get` that never consults the sidecar. The runtime descriptor
//     appliers now mirror the defined VALUE into the real struct field via the
//     compiled `__sset_<key>` export, so static reads see the defined value.
//
// Accessors (Slice B), array-`length` exotic (Slice C), for-in
// enumerable-honoring (needs the proto-read fix first), and standalone
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

describe("#2668 Slice A — literal-resolvable dynamic descriptor application", () => {
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

  it("descriptor variable: non-boolean attribute coerces via ToBoolean", async () => {
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

  it("descriptor variable: omitted attrs default to false on a new define", async () => {
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

  it("descriptor variable: explicit writable/enumerable applied", async () => {
    expect(
      await run(`
        export function test(): number {
          const obj: any = {};
          const attr: any = { value: 9, writable: true, enumerable: true };
          Object.defineProperty(obj, "property", attr);
          const d: any = Object.getOwnPropertyDescriptor(obj, "property");
          let r = 0;
          if (d.value === 9) r += 1;
          if (d.writable === true) r += 10;
          if (d.enumerable === true) r += 100;
          if (d.configurable === false) r += 1000;
          return r;
        }
      `),
    ).toBe(1111);
  });
});

describe("#2668 Slice A — no regression on existing fast paths", () => {
  it("inline value-only define still readable", async () => {
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

  it("for-in still lists a defined property whose attrs are prototype-inherited", async () => {
    // Mirrors the 15.2.3.6-3-23..45 family: descriptor's enumerable lives on a
    // prototype; the property must remain enumerable (Slice A must NOT regress
    // this — it does not route this non-literal descriptor).
    expect(
      await run(`
        export function test(): number {
          const obj: any = {};
          const proto: any = {};
          Object.defineProperty(proto, "enumerable", { value: true });
          const child: any = Object.create(proto);
          Object.defineProperty(obj, "property", child);
          let accessed = 0;
          for (const p in obj) { if (p === "property") accessed = 1; }
          return accessed;
        }
      `),
    ).toBe(1);
  });
});

// #2668 Slice B — own-property ACCESSOR descriptor identity (host mode).
//
// Root cause: `Object.defineProperty(o, k, { get: fnRef })` (an identifier-
// reference accessor half) re-synthesized a FRESH closure from `fnRef`'s
// *declaration* (`resolveExprToFuncNode` + `emitAccessorFn`) instead of using
// the value `fnRef` already denotes. The descriptor therefore stored a getter
// that was a DIFFERENT object than the one the user holds, so
// `Object.getOwnPropertyDescriptor(o, k).get === fnRef` failed (the largest
// residual accessor-descriptor bucket) even though the getter *worked*. Host
// mode now compiles the reference expression directly (`emitAccessorRefValue`);
// the runtime's `_wrapWasmClosure` bridge memoizes per source closure and
// `_hostEqComparableValue` unwraps it on `===`, so identity round-trips while
// the descriptor's get/set stay invocable JS functions.
//
// NOTE: these mirror the test262 regime where descriptor function values are
// `any`-typed (the harness is untyped JS) — `desc.get === fnRef` lowers to the
// JS-host `__host_eq` path. A *statically function-typed* `fnRef` compared
// against an `any` GOPD result lowers to WasmGC `ref.eq` across two
// representations (closure-ref vs the host bridge externref) and is a separate,
// deeper representation-canonicalization gap, out of this slice's scope.
// Proto-inherited accessor attribute reads remain deferred to #2680.
describe("#2668 Slice B — own-property accessor descriptor identity", () => {
  it("get/set identity round-trips through getOwnPropertyDescriptor", async () => {
    expect(
      await run(`
        export function test(): number {
          const obj: any = {};
          const getter: any = function () { return 1; };
          const setter: any = function (v: any) {};
          Object.defineProperty(obj, "prop", { get: getter, set: setter, enumerable: true, configurable: true });
          const d: any = Object.getOwnPropertyDescriptor(obj, "prop");
          if (d.get !== getter) return 10;
          if (d.set !== setter) return 11;
          if (typeof d.get !== "function") return 12;
          if (d.enumerable !== true) return 13;
          if (d.configurable !== true) return 14;
          return 1;
        }
      `),
    ).toBe(1);
  });

  it("redefining one half preserves the other (get redefined, set kept)", async () => {
    expect(
      await run(`
        export function test(): number {
          const obj: any = {};
          const getter: any = function () { return 1; };
          const setter: any = function (v: any) {};
          Object.defineProperty(obj, "prop", { get: getter, set: setter, configurable: true });
          const getter2: any = function () { return 2; };
          Object.defineProperty(obj, "prop", { get: getter2 });
          const d: any = Object.getOwnPropertyDescriptor(obj, "prop");
          if (d.get !== getter2) return 20;
          if (d.set !== setter) return 21;
          return 1;
        }
      `),
    ).toBe(1);
  });

  it("accessor getter stays invocable and identity-preserving after define", async () => {
    expect(
      await run(`
        export function test(): number {
          const obj: any = {};
          const getter: any = function () { return 42; };
          Object.defineProperty(obj, "p", { get: getter, configurable: true });
          if (obj.p !== 42) return 30;
          const d: any = Object.getOwnPropertyDescriptor(obj, "p");
          if (d.get !== getter) return 31;
          if (d.get() !== 42) return 32;
          return 1;
        }
      `),
    ).toBe(1);
  });

  it("data-property function value identity is NOT regressed (Slice A guard)", async () => {
    expect(
      await run(`
        export function test(): number {
          const obj: any = {};
          const f: any = function () { return 1; };
          obj.f = f;
          if (obj.f !== f) return 40;
          Object.defineProperty(obj, "g", { value: f });
          if (obj.g !== f) return 41;
          const d: any = Object.getOwnPropertyDescriptor(obj, "g");
          if (d.value !== f) return 42;
          return 1;
        }
      `),
    ).toBe(1);
  });
});

// #2668 Slice C — Array exotic [[DefineOwnProperty]] for `length`
// (ES §10.4.2.1 ArraySetLength). Scope: the spec-mandated rejections
// (RangeError on a non-uint32 length value; TypeError on an illegal
// attribute change / accessor descriptor) plus the simple length set on the
// valid path. Per-index configurability on shrink, frozen (non-writable)
// length blocking index adds, and object/string ToPrimitive value coercion
// are DEFERRED (need per-index descriptor tracking / full host ToNumber).
describe("#2668 Slice C — Array length exotic defineProperty", () => {
  it("RangeError on a fractional length value (15.2.3.6-4-style)", async () => {
    expect(
      await run(`
        export function test(): number {
          const arr = [0, 1];
          try {
            Object.defineProperty(arr, "length", { value: 4.5 });
            return 10;
          } catch (e) {
            return e instanceof RangeError ? 1 : 20;
          }
        }
      `),
    ).toBe(1);
  });

  it("RangeError on a negative length value", async () => {
    expect(
      await run(`
        export function test(): number {
          const arr = [0, 1];
          try {
            Object.defineProperty(arr, "length", { value: -1 });
            return 10;
          } catch (e) {
            return e instanceof RangeError ? 1 : 20;
          }
        }
      `),
    ).toBe(1);
  });

  it("RangeError on an undefined length value (15.2.3.6-4-125)", async () => {
    expect(
      await run(`
        export function test(): number {
          const arr: number[] = [];
          try {
            Object.defineProperty(arr, "length", { value: undefined });
            return 10;
          } catch (e) {
            return e instanceof RangeError ? 1 : 20;
          }
        }
      `),
    ).toBe(1);
  });

  it("TypeError making length configurable:true (15.2.3.6-4-120)", async () => {
    expect(
      await run(`
        export function test(): number {
          const arr: number[] = [];
          try {
            Object.defineProperty(arr, "length", { configurable: true });
            return 10;
          } catch (e) {
            return e instanceof TypeError ? 1 : 20;
          }
        }
      `),
    ).toBe(1);
  });

  it("TypeError making length enumerable:true", async () => {
    expect(
      await run(`
        export function test(): number {
          const arr: number[] = [];
          try {
            Object.defineProperty(arr, "length", { enumerable: true });
            return 10;
          } catch (e) {
            return e instanceof TypeError ? 1 : 20;
          }
        }
      `),
    ).toBe(1);
  });

  it("TypeError on an accessor descriptor for length", async () => {
    expect(
      await run(`
        export function test(): number {
          const arr: number[] = [];
          try {
            Object.defineProperty(arr, "length", { get: function () { return 0; } });
            return 10;
          } catch (e) {
            return e instanceof TypeError ? 1 : 20;
          }
        }
      `),
    ).toBe(1);
  });

  it("a valid uint32 length value updates arr.length", async () => {
    expect(
      await run(`
        export function test(): number {
          const arr = [10, 20, 30];
          Object.defineProperty(arr, "length", { value: 1 });
          return arr.length;
        }
      `),
    ).toBe(1);
  });

  it("does NOT throw for a valid integer length value", async () => {
    expect(
      await run(`
        export function test(): number {
          const arr: number[] = [];
          Object.defineProperty(arr, "length", { value: 2 });
          return arr.length === 2 ? 1 : 20;
        }
      `),
    ).toBe(1);
  });

  it("index-define length growth is NOT regressed (Slice C guard)", async () => {
    expect(
      await run(`
        export function test(): number {
          const arr = [0, 1];
          Object.defineProperty(arr, "5", { value: 99 });
          return arr.length === 6 ? 1 : arr.length;
        }
      `),
    ).toBe(1);
  });
});
