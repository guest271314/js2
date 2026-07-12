// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3137 — native Promise.allSettled / Promise.any combinators (standalone).
//
// Post-#2980-flip every standalone-minted promise is a native `$Promise`
// struct, which the host `Promise_allSettled`/`Promise_any` imports cannot
// await — the aggregate never settled (the ~99-file vacuous class in
// built-ins/Promise). This extends the #2919/#2867-Gap-4 native combinator
// machinery: allSettled builds `{status, value|reason}` result objects (plain
// `$Object`) and never rejects; any resolves on the first fulfillment and
// rejects with a native AggregateError (tag-discriminated `$Error_struct`,
// `.errors` on `$props`) when every input rejects. All wrappers register
// lazily (ensureSettledAnyCombinators) so all/race-only modules stay
// byte-identical (prove-emit-identity 39/39 vs main).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const DRAIN = "declare function __drain_microtasks(): void;\n";

async function runStandaloneHostFree(source: string): Promise<number> {
  const result = await compile(DRAIN + source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  // Host-free: the whole point — no Promise_allSettled/Promise_any/then-chain imports.
  expect((result.imports ?? []).map((i) => i.name)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  return (instance.exports as { test(): number }).test();
}

describe("#3137 — native Promise.allSettled (standalone, host-free)", () => {
  it("mixed fulfilled/rejected inputs produce {status, value|reason} objects in order", async () => {
    const ret = await runStandaloneHostFree(`
let ok = 0;
export function test(): number {
  const p1 = Promise.resolve(3);
  const p2 = Promise.reject(new Error("boom"));
  Promise.allSettled([p1, p2]).then((rs: any) => {
    if (rs.length !== 2) { ok = -1; return; }
    const a = rs[0], b = rs[1];
    ok = a.status === "fulfilled" && a.value === 3 && b.status === "rejected" ? 1 : -2;
  });
  __drain_microtasks();
  return ok;
}`);
    expect(ret).toBe(1);
  });

  it("never rejects the aggregate; empty input fulfills with []", async () => {
    const ret = await runStandaloneHostFree(`
let ok = 0;
export function test(): number {
  Promise.allSettled([]).then((rs: any) => { ok = rs.length === 0 ? 1 : -1; }, (e: any) => { ok = -2; });
  __drain_microtasks();
  return ok;
}`);
    expect(ret).toBe(1);
  });

  it("non-promise elements count as fulfilled with their value", async () => {
    const ret = await runStandaloneHostFree(`
let ok = 0;
export function test(): number {
  Promise.allSettled([1, "x"]).then((rs: any) => {
    ok = rs[0].status === "fulfilled" && rs[0].value === 1 && rs[1].value === "x" ? 1 : -1;
  });
  __drain_microtasks();
  return ok;
}`);
    expect(ret).toBe(1);
  });

  it("array-typed (non-literal) argument takes the runtime loop", async () => {
    const ret = await runStandaloneHostFree(`
let ok = 0;
export function test(): number {
  const arr: Promise<number>[] = [Promise.resolve(4), Promise.resolve(5)];
  Promise.allSettled(arr).then((rs: any) => { ok = rs.length === 2 && rs[1].value === 5 ? 1 : -1; });
  __drain_microtasks();
  return ok;
}`);
    expect(ret).toBe(1);
  });
});

describe("#3137 — native Promise.any (standalone, host-free)", () => {
  it("first fulfillment wins over earlier rejections", async () => {
    const ret = await runStandaloneHostFree(`
let ok = 0;
export function test(): number {
  Promise.any([Promise.reject(new Error("a")), Promise.resolve(7), Promise.resolve(8)]).then(
    (v: any) => { ok = v === 7 ? 1 : -1; },
    (e: any) => { ok = -2; },
  );
  __drain_microtasks();
  return ok;
}`);
    expect(ret).toBe(1);
  });

  it("all-rejected rejects with an AggregateError carrying .errors in order", async () => {
    const ret = await runStandaloneHostFree(`
let ok = 0;
export function test(): number {
  Promise.any([Promise.reject("r1"), Promise.reject("r2")]).then(
    (v: any) => { ok = -1; },
    (e: any) => {
      const errs: any = e.errors;
      ok = e instanceof AggregateError && errs && errs.length === 2 && errs[0] === "r1" && errs[1] === "r2" ? 1 : -3;
    },
  );
  __drain_microtasks();
  return ok;
}`);
    expect(ret).toBe(1);
  });

  it("empty input rejects immediately with an AggregateError", async () => {
    const ret = await runStandaloneHostFree(`
let ok = 0;
export function test(): number {
  Promise.any([]).then((v: any) => { ok = -1; }, (e: any) => { ok = e instanceof AggregateError ? 1 : -2; });
  __drain_microtasks();
  return ok;
}`);
    expect(ret).toBe(1);
  });

  it("array-typed (non-literal) argument takes the runtime loop", async () => {
    const ret = await runStandaloneHostFree(`
let ok = 0;
export function test(): number {
  const arr: Promise<number>[] = [Promise.reject(new Error("z")), Promise.resolve(9)];
  Promise.any(arr).then((v: any) => { ok = v === 9 ? 1 : -1; }, (e: any) => { ok = -2; });
  __drain_microtasks();
  return ok;
}`);
    expect(ret).toBe(1);
  });
});

describe("#3137 — all/race controls unchanged", () => {
  it("Promise.all still fulfills in order and rejects on first rejection", async () => {
    const ret = await runStandaloneHostFree(`
let a = 0, b = 0, n = 0, rej = 0;
export function test(): number {
  Promise.all([Promise.resolve(1), Promise.resolve(2)]).then((vs: any) => { n = vs.length; a = vs[0]; b = vs[1]; });
  Promise.all([Promise.resolve(1), Promise.reject(new Error("x"))]).then((v: any) => { rej = -1; }, (e: any) => { rej = 1; });
  __drain_microtasks();
  return n === 2 && a === 1 && b === 2 && rej === 1 ? 1 : 0;
}`);
    expect(ret).toBe(1);
  });

  it("gc/host lane keeps the host Promise_allSettled import (no native arm)", async () => {
    const result = await compile(
      DRAIN +
        `
export function test(): number {
  Promise.allSettled([Promise.resolve(1)]).then((r: any) => {});
  __drain_microtasks();
  return 1;
}`,
      { fileName: "test.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    expect((result.imports ?? []).map((i) => i.name)).toContain("Promise_allSettled");
  });
});
