// #2906 Gap 3 — try/finally across await, on the general N-state resume machine.
//
// Host-free (`--target wasi`, the native-`$Promise` carrier lane). Validates the
// finally runs on ALL completion paths of a `try { …awaits… } finally { F }`
// (single, non-nested, await-free F, no catch, no return-in-try — richer shapes
// fall back to the legacy path). gc/host + standalone byte-inertness is proven by
// hash in the PR notes; non-try async stays byte-identical to slice 1.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function instantiateWasi(src: string): Promise<WebAssembly.Exports> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports;
}

describe("#2906 Gap 3 — try/finally across await", () => {
  it("NORMAL path: finally runs after the try body completes", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function g(): Promise<number> { return 5; }
      async function f(): Promise<void> {
        try {
          const x = await g();
          cap = x;
        } finally {
          cap = cap + 100;
        }
      }
      export function test(): number { f() as any; return cap; }
    `)) as { test: () => number };
    expect(ex.test()).toBe(105); // x=5 then finally +100
  });

  it("SYNCHRONOUS-THROW path: a throw after the await (inside try) still runs finally", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function g(): Promise<number> { return 5; }
      async function f(): Promise<void> {
        try {
          const x = await g();
          cap = x;
          throw x;          // synchronous throw inside the try, after the await
        } finally {
          cap = cap + 100;  // must run despite the throw
        }
      }
      export function test(): number { f() as any; return cap; }
    `)) as { test: () => number };
    expect(ex.test()).toBe(105); // cap=5, finally +100; the throw rejects f()'s promise (ignored)
  });

  it("SYNCHRONOUS-THROW-BEFORE-AWAIT path: a throw in the in-try lead runs finally", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      let flag: number = 0;
      async function g(): Promise<number> { return 5; }
      async function f(): Promise<void> {
        try {
          cap = 1;
          if (flag === 0) { throw cap; }  // throws before ever awaiting
          await g();
        } finally {
          cap = cap + 100;
        }
      }
      export function test(): number { f() as any; return cap; }
    `)) as { test: () => number };
    expect(ex.test()).toBe(101); // cap=1, throw, finally +100
  });

  it("PENDING-then-REJECTED path: a rejected pending await runs finally on resume", async () => {
    // The awaited promise is PENDING (a .then), and its handler throws → the
    // promise rejects on a later microtask. The frame resumes in MODE_THROW; the
    // finally must run before the result promise rejects.
    const ex = (await instantiateWasi(`
      let ran: number = 0;
      async function f(): Promise<void> {
        try {
          const x = await Promise.resolve(1).then((v: number) => { throw v; });
          ran = x; // not reached
        } finally {
          ran = 99;
        }
      }
      export function kick(): number { f() as any; return ran; }
      export function getRan(): number { return ran; }
    `)) as { kick: () => number; getRan: () => number; __drain_microtasks: () => void };
    expect(ex.kick()).toBe(0); // suspended at the pending await
    for (let i = 0; i < 8; i++) ex.__drain_microtasks();
    expect(ex.getRan()).toBe(99); // finally ran even though the await rejected
  });

  it("PENDING-then-FULFILLED path: normal finally after a genuine suspension", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function f(): Promise<void> {
        try {
          const x = await Promise.resolve(2).then((v: number) => v + 3);
          cap = x;
        } finally {
          cap = cap + 100;
        }
      }
      export function kick(): number { f() as any; return cap; }
      export function getCap(): number { return cap; }
    `)) as { kick: () => number; getCap: () => number; __drain_microtasks: () => void };
    expect(ex.kick()).toBe(0);
    for (let i = 0; i < 8; i++) ex.__drain_microtasks();
    expect(ex.getCap()).toBe(105); // x=5 then finally +100
  });

  it("finally runs after code that follows the try (normal path, post-try statements)", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function g(): Promise<number> { return 5; }
      async function f(): Promise<void> {
        try {
          const x = await g();
          cap = x;
        } finally {
          cap = cap + 100;
        }
        cap = cap + 1000;   // runs AFTER the finally on the normal path
      }
      export function test(): number { f() as any; return cap; }
    `)) as { test: () => number };
    expect(ex.test()).toBe(1105); // 5 + 100 + 1000
  });
});
