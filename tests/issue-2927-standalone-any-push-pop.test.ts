// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2927 (generic-built-in audit, Part 2) / #2784 residual — native-vec `.push` /
// `.pop` on a genuinely-`any` receiver under `--target standalone` / `--target
// wasi`.
//
// Root cause: the closed-method dispatcher `__call_m_push_1` / `__call_m_pop_0`
// (the path a standalone any-receiver method call with args takes, #2151) had NO
// native-vec brand arm, so an `any`/externref array receiver fell through to the
// open-`$Object` bottom arm and returned `undefined`. For `push` that also
// SILENTLY DROPPED the element — a host-free data-loss bug: on `--target
// standalone`, `const a:any=[1,2]; a.push(3)` returned 0 and left `a.length===2`.
// (The #2784 S3 native-vec push/pop fast path in calls.ts is JS-host/gc gated, so
// it never fired standalone.)
//
// Fix (#2927): the closed-method dispatcher grows a `$__vec_base` brand arm that
// routes `push` (arity 1) / `pop` (arity 0) to the carrier-generic `__vec_push` /
// `__vec_pop` helpers. These are shared with standalone AOT any-receiver dispatch
// (roadmap §4.2) and are a #2928 `CallBuiltin` prerequisite.
//
// The standalone assertions instantiate with an EMPTY import object and first
// assert the module declares ZERO function imports — i.e. the behaviour is truly
// HOST-FREE, not silently satisfied by a JS host bridge.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function runHost(source: string): Promise<unknown> {
  const result: any = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error("compile: " + result.errors.map((e: any) => e.message).join("; "));
  }
  const built = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as any).test();
}

/** Compile host-free (`target: standalone`), assert 0 function imports, run. */
async function runStandaloneHostFree(source: string): Promise<unknown> {
  const result: any = await compile(source, { fileName: "test.ts", target: "standalone" });
  if (!result.success) {
    throw new Error("compile: " + result.errors.map((e: any) => e.message).join("; "));
  }
  const mod = await WebAssembly.compile(result.binary);
  const fnImports = WebAssembly.Module.imports(mod).filter((i) => i.kind === "function");
  // The whole point of the fix: this dispatch is host-free. If a JS host bridge
  // import sneaks back in, the "standalone" result is a lie — fail loudly.
  expect(fnImports.map((i) => `${i.module}.${i.name}`)).toEqual([]);
  const instance: any = await WebAssembly.instantiate(mod, {});
  return instance.exports.test();
}

describe("#2927 — standalone any-receiver .push/.pop mutates the native vec (host-free)", () => {
  it("push returns the new length (was 0 standalone)", async () => {
    const src = `function f(x: any, y: any): number { return x.push(y); }
                 export function test(): number { return f([1, 2], 3); }`;
    expect(await runHost(src)).toBe(3);
    expect(await runStandaloneHostFree(src)).toBe(3);
  });

  it("push actually appends (x.length was stuck at 2 standalone)", async () => {
    const src = `function f(x: any, y: any): number { x.push(y); return x.length; }
                 export function test(): number { return f([1, 2], 3); }`;
    expect(await runHost(src)).toBe(3);
    expect(await runStandaloneHostFree(src)).toBe(3);
  });

  it("pushed element is readable at its index (x[2] was 0 standalone)", async () => {
    const src = `function f(x: any, y: any): number { x.push(y); return x[2]; }
                 export function test(): number { return f([1, 2], 3); }`;
    expect(await runHost(src)).toBe(3);
    expect(await runStandaloneHostFree(src)).toBe(3);
  });

  it("repeated push accumulates", async () => {
    const src = `function f(x: any): number { x.push(4); x.push(5); return x.length; }
                 export function test(): number { return f([1, 2, 3]); }`;
    expect(await runHost(src)).toBe(5);
    expect(await runStandaloneHostFree(src)).toBe(5);
  });

  it("pop returns the last element (was 0 standalone)", async () => {
    const src = `function f(x: any): number { return x.pop(); }
                 export function test(): number { return f([1, 2, 3]); }`;
    expect(await runHost(src)).toBe(3);
    expect(await runStandaloneHostFree(src)).toBe(3);
  });

  it("pop shrinks the array", async () => {
    const src = `function f(x: any): number { x.pop(); return x.length; }
                 export function test(): number { return f([1, 2, 3]); }`;
    expect(await runHost(src)).toBe(2);
    expect(await runStandaloneHostFree(src)).toBe(2);
  });

  // A closed object-literal with its OWN `push` method must still dispatch to
  // that method (the `entries` arms are checked before the vec brand arm), NOT
  // get hijacked by the native-vec arm.
  it("a user object with its own push() still wins over the vec arm", async () => {
    const src = `function f(o: any, n: any): number { return o.push(n); }
                 export function test(): number { return f({ n: 10, push(k: number): number { return this.n + k; } }, 5); }`;
    expect(await runHost(src)).toBe(15);
    expect(await runStandaloneHostFree(src)).toBe(15);
  });
});
