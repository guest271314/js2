// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3253 — standalone `Object.create(proto, descriptors)` with an INLINE
// descriptor object literal silently dropped the property `value` AND the
// ToBoolean-coerced writable/enumerable/configurable flags whenever a flag was
// NON-static (anything `staticToBoolean` cannot fold at compile time — e.g. a
// `new Boolean(...)` wrapper, an identifier, or a call).
//
// Root cause: a non-static flag disqualifies the static-expansion fast path, so
// the property falls to the runtime applier `__obj_define_from_desc(obj, key,
// descObj)` which runs ToPropertyDescriptor over `descObj` GUARDED by
// `ref.test $Object`. The inline descriptor literal `{ value: 9, configurable:
// … }` has a CONCRETE contextual type (`PropertyDescriptor`, not `any`), so it
// compiled to a CLOSED struct — `ref.test $Object` fails on a closed struct, the
// applier reads nothing, `value` stays unset and every flag defaults to false.
//
// Fix (expressions/calls.ts, Object.create runtime-descriptor branch): in
// standalone mode build the inline descriptor object literal directly as a
// native `$Object` via compileObjectLiteralAsExternref, so the applier's
// `ref.test $Object` succeeds. Mirrors the closed-struct-vs-$Object diversion
// fixed for Object.assign args / Object.create protos in #2076 / #2580.
//
// Each test compiles with `target: "standalone"`, asserts ZERO host imports
// (pure Wasm), and runs against the WASI polyfill. Pre-fix every case below
// returned 0.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

async function runStandalone(source: string): Promise<{ value: number; hostImports: number }> {
  const result = await compile(source, { fileName: "test.ts", target: "standalone" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const module = await WebAssembly.compile(result.binary);
  // Standalone must be host-import-free: only the WASI snapshot module is allowed.
  const hostImports = WebAssembly.Module.imports(module).filter((i) => i.module !== "wasi_snapshot_preview1").length;
  const wasi = buildWasiPolyfill();
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  if (exports.memory) wasi.setMemory(exports.memory as WebAssembly.Memory);
  const value = (exports.test as () => number)();
  return { value, hostImports };
}

describe("#3253 — standalone Object.create inline descriptor built as $Object", () => {
  it("the repro: a non-static flag no longer drops the descriptor's value", async () => {
    // `configurable: flag` (an identifier) is non-static → routes to the runtime
    // applier. Pre-fix the inline descriptor was a closed struct so `value` was
    // dropped and `o.p` read 0. Post-fix it reads 9.
    const { value, hostImports } = await runStandalone(
      `export function test(): number {
         const flag: boolean = true;
         const o: any = Object.create({}, { p: { value: 9, configurable: flag } });
         return o.p as number;
       }`,
    );
    expect(hostImports).toBe(0);
    expect(value).toBe(9);
  });

  it("the non-static configurable flag is honored (was read as false pre-fix)", async () => {
    const { value, hostImports } = await runStandalone(
      `export function test(): number {
         const flag: boolean = true;
         const o: any = Object.create({}, { p: { value: 9, configurable: flag } });
         const d: any = Object.getOwnPropertyDescriptor(o, 'p');
         return d.configurable ? 1 : 0;
       }`,
    );
    expect(hostImports).toBe(0);
    expect(value).toBe(1);
  });

  it("configurable:true makes the property deletable", async () => {
    // Pre-fix configurable defaulted to false so the delete failed; the property
    // remained and `o.p === undefined` was false → returned 0.
    const { value } = await runStandalone(
      `export function test(): number {
         const flag: boolean = true;
         const o: any = Object.create({}, { p: { value: 9, configurable: flag } });
         delete o.p;
         return (o.p === undefined) ? 1 : 0;
       }`,
    );
    expect(value).toBe(1);
  });

  it("multiple inline descriptors each keep their value", async () => {
    const { value } = await runStandalone(
      `export function test(): number {
         const w: boolean = true;
         const o: any = Object.create({}, { a: { value: 3, writable: w }, b: { value: 4, writable: w } });
         return (o.a as number) * 10 + (o.b as number);
       }`,
    );
    expect(value).toBe(34);
  });

  it("writable:true from a non-static flag allows reassignment", async () => {
    const { value } = await runStandalone(
      `export function test(): number {
         const w: boolean = true;
         const o: any = Object.create({}, { p: { value: 5, writable: w } });
         o.p = 7;
         return o.p as number;
       }`,
    );
    expect(value).toBe(7);
  });

  it("a value-only static descriptor (fast path) still works — no regression", async () => {
    // All-static flags use the static-expansion path, which was never broken;
    // guards the fix against disturbing that lane.
    const { value } = await runStandalone(
      `export function test(): number {
         const o: any = Object.create({}, { p: { value: 42 } });
         return o.p as number;
       }`,
    );
    expect(value).toBe(42);
  });
});
