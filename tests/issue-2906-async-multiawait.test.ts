// #2906 slice 1 — the general multi-state CFG-aware CPS resume machine.
//
// Validates the multi-await-in-linear-code generalization of the host-free async
// drive layer: ≥2 sequential awaits (previously demoted to the AG0 one-level
// unwrap) are now driven by a general N-state `br`-table-style resume machine.
// All tests are host-free (`--target wasi`, the native-`$Promise` carrier lane);
// the module must request NO imports. The gc/host + standalone byte-inertness of
// this change is proven separately by binary hash (see the PR notes).
import { describe, it, expect } from "vitest";
// Import the top compiler entry first so the codegen module graph initializes in
// the correct order (matches issue-2895-async-frame.test.ts).
import { compile } from "../src/index.js";

/** Compile a host-free async program and instantiate it (imports must be empty). */
async function instantiateWasi(src: string): Promise<WebAssembly.Exports> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports;
}

describe("#2906 multi-await linear drive — synchronous fast path", () => {
  it("two sequential fulfilled awaits; the first binding is live across the second", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function g(): Promise<number> { return 41; }
      async function h(): Promise<number> { return 1; }
      async function f(): Promise<number> {
        const a = await g();
        const b = await h();
        cap = a + b;   // 'a' must survive await h() → spilled into the frame
        return a + b;
      }
      export function test(): number { f() as any; return cap; }
    `)) as { test: () => number };
    expect(ex.test()).toBe(42);
  });

  it("three sequential awaits chain all three delivered values", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function g(): Promise<number> { return 10; }
      async function f(): Promise<number> {
        const a = await g();
        const b = await g();
        const c = await g();
        cap = a + b + c;
        return a + b + c;
      }
      export function test(): number { f() as any; return cap; }
    `)) as { test: () => number };
    expect(ex.test()).toBe(30);
  });

  it("bare awaits (no binding) with statements between them run in order", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function g(): Promise<number> { return 5; }
      async function f(): Promise<void> {
        await g();
        cap = cap + 1;
        await g();
        cap = cap + 10;
      }
      export function test(): number { f() as any; return cap; }
    `)) as { test: () => number };
    expect(ex.test()).toBe(11);
  });

  it("`return await P` as the final segment after a prior await", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function g1(): Promise<number> { return 3; }
      async function g2(): Promise<number> { return 7; }
      async function f(): Promise<number> {
        const a = await g1();
        cap = a;
        return await g2();
      }
      export function test(): number { f() as any; return cap; }
    `)) as { test: () => number };
    expect(ex.test()).toBe(3); // cap = a (3); f's own result is 7
  });
});

describe("#2906 multi-await linear drive — genuinely-pending suspension", () => {
  it("two genuinely-pending awaits each suspend + resume via the microtask drain", async () => {
    // await#0 is PENDING until the drain runs its `.then`; await#1 is likewise
    // PENDING and is scheduled DURING the resume of state 1 — the drain loop must
    // process the newly-enqueued reaction too. 'a' (41) is live across await#1's
    // suspend, so it must be spilled and reloaded intact.
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function f(): Promise<void> {
        const a = await Promise.resolve(1).then((v: number) => v + 40);
        const b = await Promise.resolve(a).then((v: number) => v + 1);
        cap = a * 100 + b;
      }
      export function kick(): number { f() as any; return cap; }
      export function getCap(): number { return cap; }
    `)) as { kick: () => number; getCap: () => number; __drain_microtasks: () => void };
    expect(ex.kick()).toBe(0); // suspended at the first await — nothing has run
    for (let i = 0; i < 8; i++) ex.__drain_microtasks();
    expect(ex.getCap()).toBe(4142); // a=41, b=42 → 41*100 + 42
  });

  it("a pending await followed by a synchronous await threads both values", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function g(): Promise<number> { return 100; }
      async function f(): Promise<void> {
        const a = await Promise.resolve(2).then((v: number) => v + 3);
        const b = await g();
        cap = a + b;
      }
      export function kick(): number { f() as any; return cap; }
      export function getCap(): number { return cap; }
    `)) as { kick: () => number; getCap: () => number; __drain_microtasks: () => void };
    expect(ex.kick()).toBe(0);
    for (let i = 0; i < 8; i++) ex.__drain_microtasks();
    expect(ex.getCap()).toBe(105); // a=5, b=100
  });
});
