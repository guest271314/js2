// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2903 — standalone `.then`/`.catch` bridge de-leak (sub-front 1).
//
// Post-#2980-flip, the `.then`/`.catch` receiver bridge
// (`emitStandaloneThenWithNativeFallback`, calls.ts) chained native `$Promise`
// receivers natively but ALWAYS baked a host `Promise_then*`/`__make_callback`
// fallback into its `ref.test` miss arm — keeping ~626 otherwise-passing
// standalone modules host-import-leaky (unscored under the honest #2879
// host_free_pass metric) even though the arm was never CALLED at runtime
// (measured 2026-07-10 over all 662 then-chain-only leaky passes).
//
// The fix: when the module provably cannot mint a HOST promise (no syntactic
// producer — dynamic import(), .finally(), allSettled/any/fromAsync, subclass
// all/race — and no producer host import registered), the miss arm becomes a
// native catchable TypeError (§27.2.5.4 step 2) instead, and the module goes
// fully host-free. Modules WITH a producer keep the exact pre-#2903 host arm.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const DRAIN = "declare function __drain_microtasks(): void;\n";

async function compileStandalone(source: string) {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  return result;
}

function importNames(result: { imports?: { name: string }[] }): string[] {
  return (result.imports ?? []).map((i) => i.name).sort();
}

describe("#2903 — standalone .then/.catch de-leak (no host-promise producer)", () => {
  it(".then(onFulfilled, onRejected) on a native promise is host-free and runs", async () => {
    const result = await compileStandalone(
      DRAIN +
        `
let hit = 0;
export function test(): number {
  const p = Promise.resolve(5);
  p.then((v: any) => { hit = v; }, (e: any) => { hit = -1; });
  __drain_microtasks();
  return hit === 5 ? 1 : 0;
}`,
    );
    expect(importNames(result)).toEqual([]); // host-free: no Promise_then2, no __make_callback
    const { instance } = await WebAssembly.instantiate(result.binary!, {}); // zero imports
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });

  it(".catch(onRejected) is host-free and runs", async () => {
    const result = await compileStandalone(
      DRAIN +
        `
let hit = 0;
export function test(): number {
  Promise.reject(new Error("x")).catch((e: any) => { hit = 7; });
  __drain_microtasks();
  return hit === 7 ? 1 : 0;
}`,
    );
    expect(importNames(result)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary!, {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });

  it("chained .then().then() (1-arg then) is host-free and runs", async () => {
    const result = await compileStandalone(
      DRAIN +
        `
let acc = 0;
export function test(): number {
  Promise.resolve(1).then((v: any) => { acc += v; return 2; }).then((v: any) => { acc += v; });
  __drain_microtasks();
  return acc === 3 ? 1 : 0;
}`,
    );
    expect(importNames(result)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary!, {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });

  it("new Promise(inline executor) + .then is host-free and runs", async () => {
    const result = await compileStandalone(
      DRAIN +
        `
let hit = 0;
export function test(): number {
  const p = new Promise<number>((resolve, reject) => { resolve(9); });
  p.then((v: any) => { hit = v; });
  __drain_microtasks();
  return hit === 9 ? 1 : 0;
}`,
    );
    expect(importNames(result)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary!, {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });

  it("miss arm is a CATCHABLE native TypeError (any-typed non-promise receiver)", async () => {
    const result = await compileStandalone(
      DRAIN +
        `
let hit = 0;
export function test(): number {
  const x: any = { then: 1 };
  try { x.then((v: any) => {}); } catch (e) { hit = e instanceof TypeError ? 1 : 2; }
  return hit === 1 ? 1 : 0;
}`,
    );
    expect(importNames(result)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary!, {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });
});

describe("#2903 — producer modules KEEP the host fallback arm (behavior preserved)", () => {
  it("(finally sub-front update) .finally is native now — the module goes fully host-free", async () => {
    // Pre-native this control asserted the host arm stayed (.finally was a
    // host-promise producer via the syntactic scan). The finally sub-front
    // lowers .finally natively (§27.2.5.3 on the then machinery,
    // tests/issue-2903-finally.test.ts), so the producer flag no longer fires
    // and the whole then-finally chain drops its host imports — the
    // compounding de-leak this gate was designed to enable.
    const result = await compileStandalone(
      DRAIN +
        `
let hit = 0;
export function test(): number {
  Promise.resolve(3).then((v: any) => { hit += v; }).finally(() => { hit += 10; });
  __drain_microtasks();
  return hit === 13 ? 1 : 0;
}`,
    );
    expect(importNames(result)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary!, {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });

  it("(#3137 update) Promise.allSettled is native now — the module goes fully host-free", async () => {
    // Pre-#3137 this control asserted the host arm stayed (allSettled was a
    // host-promise producer). #3137 lowers allSettled natively on the
    // combinator machinery, so the producer flag no longer fires and the
    // then-bridge miss arm is native too: zero imports (the compounding
    // de-leak this gate was designed to enable).
    const result = await compileStandalone(
      DRAIN +
        `
export function test(): number {
  Promise.allSettled([Promise.resolve(1)]).then((r: any) => {});
  __drain_microtasks();
  return 1;
}`,
    );
    expect(importNames(result)).toEqual([]);
  });
});

describe("#2903 — other lanes untouched", () => {
  it("gc/host lane still uses the host Promise_then2 import (no bridge)", async () => {
    const result = await compile(
      DRAIN +
        `
export function test(): number {
  Promise.resolve(5).then((v: any) => {}, (e: any) => {});
  __drain_microtasks();
  return 1;
}`,
      { fileName: "test.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const names = importNames(result);
    expect(names).toContain("Promise_then2");
  });

  it("wasi lane keeps the zero-Promise_then-import contract", async () => {
    const result = await compile(
      `
let hit = 0;
export function test(): number {
  Promise.resolve(5).then((v: number) => { hit = v; });
  return hit === 5 ? 1 : 0;
}`,
      { fileName: "test.ts", target: "wasi", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const names = importNames(result).filter((n) => n.startsWith("Promise_") || n === "__make_callback");
    expect(names).toEqual([]);
  });
});
