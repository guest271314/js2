// #2906 slice 3b — `for await (… of …)` on the host-free async drive machine
// (the native async-iterator carrier).
//
// A `for await` carries NO `ts.AwaitExpression` — the per-element suspension is
// implicit in the `awaitModifier` — so before this slice the whole
// `awaitPoints`-keyed suspension machinery treated a for-await-only body as
// non-suspending (AG0 unwrap → the loop var held the un-awaited Promise → NaN
// for `for await (x of [P.resolve(1), …])`). Slice 3b closes the two coupled
// blockers that sat BELOW the drive machine:
//   (1) implicit-await coupling — `analyzeAsyncBody` now reports `forAwaitPoints`
//       and `asyncFnNeedsDrive` recognises a bounded for-await as suspending;
//   (2) the async-iterator carrier — `planForAwaitCfg` lowers the loop onto the
//       CFG machine as `it = GetAsyncIterator(source); loop { {done,value} =
//       it.next(); if done break; x = await value; body }` (§7.4.3 +
//       §27.1.4.4 AsyncFromSyncIterator: Await(value) — a Promise element
//       double-resolves to its value). The iterator-protocol steps are injected
//       via emit hooks because they are runtime ops on wasm locals, not
//       checker-typed AST (synthesising that AST is the #2367 wall).
//
// Native (wasi) drive lane only — host-free (no imports). Gated on BOXED-element
// sources (Promise/object arrays); unboxed-primitive arrays (`number[]`) stay on
// the already-correct legacy sync path (Await(v)=v).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Compile a host-free async program and instantiate it (imports must be empty). */
async function instantiateWasi(src: string): Promise<Record<string, () => number>> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  // The drive layer is host-free: the module must request no imports.
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, () => number>;
}

describe("#2906 slice 3b — for-await-of async-iterator carrier", () => {
  it("THE proof: for await over an array of settled Promises sums the resolved values host-free", async () => {
    const ex = await instantiateWasi(`
      let cap: number = 0;
      async function loop(): Promise<void> {
        let sum: number = 0;
        for await (const x of [Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)]) { sum = sum + x; }
        cap = sum;
      }
      export function kick(): number { loop() as any; return cap; }
      export function getCap(): number { return cap; }
    `);
    expect(ex.kick()).toBe(6); // 1 + 2 + 3 — was NaN before 3b
  });

  it("GENUINELY-PENDING elements suspend each iteration; the drain resumes and the accumulator survives", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function loop(): Promise<void> {
        let sum: number = 0;
        for await (const x of [
          Promise.resolve(1).then((v: number) => v + 10),
          Promise.resolve(2).then((v: number) => v + 10),
        ]) { sum = sum + x; }
        cap = sum;
      }
      export function kick(): number { loop() as any; return cap; }
      export function getCap(): number { return cap; }
    `)) as Record<string, () => number> & { __drain_microtasks: () => void };
    expect(ex.kick()).toBe(0); // suspended on the first pending element
    ex.__drain_microtasks(); // resumes each iteration across the back-edge
    expect(ex.getCap()).toBe(23); // 11 + 12 — sum survived every suspension (frame spill)
  });

  it("pre-loop and post-loop statements run in order around the driven loop", async () => {
    const ex = await instantiateWasi(`
      let cap: number = 0;
      async function loop(): Promise<void> {
        let sum: number = 100;
        for await (const x of [Promise.resolve(1), Promise.resolve(2)]) { sum = sum + x; }
        sum = sum + 1000;
        cap = sum;
      }
      export function kick(): number { loop() as any; return cap; }
      export function getCap(): number { return cap; }
    `);
    expect(ex.kick()).toBe(1103); // 100 + 1 + 2 + 1000
  });

  it("a zero-element source runs the exit directly, never suspends", async () => {
    const ex = await instantiateWasi(`
      let cap: number = 0;
      async function loop(): Promise<void> {
        let sum: number = 7;
        const arr: Promise<number>[] = [];
        for await (const x of arr) { sum = sum + x; }
        cap = sum;
      }
      export function kick(): number { loop() as any; return cap; }
      export function getCap(): number { return cap; }
    `);
    expect(ex.kick()).toBe(7); // done true first → straight to exit
  });

  it("a bare body (no accumulator dependence) counts every element across suspensions", async () => {
    const ex = await instantiateWasi(`
      let cap: number = 0;
      async function loop(): Promise<void> {
        let n: number = 0;
        for await (const x of [
          Promise.resolve(1), Promise.resolve(2), Promise.resolve(3), Promise.resolve(4),
        ]) { n = n + 1; }
        cap = n;
      }
      export function kick(): number { loop() as any; return cap; }
      export function getCap(): number { return cap; }
    `);
    expect(ex.kick()).toBe(4);
  });

  it("a rejected element rejects the async result and skips the post-loop assignment (no trap)", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = -1;
      async function loop(): Promise<void> {
        let sum: number = 0;
        for await (const x of [Promise.resolve(1), Promise.reject(new Error("boom")) as any, Promise.resolve(3)]) {
          sum = sum + x;
        }
        cap = sum;
      }
      export function kick(): number { loop() as any; return 0; }
      export function getCap(): number { return cap; }
    `)) as Record<string, () => number> & { __drain_microtasks: () => void };
    ex.kick();
    ex.__drain_microtasks();
    expect(ex.getCap()).toBe(-1); // loop rejected on element 2 → `cap = sum` never runs
  });

  it("a for-await over an array of PLAIN numbers stays on the legacy path and still works", async () => {
    // Unboxed-primitive elements settle immediately (Await(v)=v), so the drive
    // gate keeps them on the legacy sync path — must remain correct (byte-inert
    // vs main), not regress to a vec-cast trap.
    const ex = await instantiateWasi(`
      let cap: number = 0;
      async function loop(): Promise<void> {
        let sum: number = 0;
        for await (const x of [10, 20, 30]) { sum = sum + x; }
        cap = sum;
      }
      export function kick(): number { loop() as any; return cap; }
      export function getCap(): number { return cap; }
    `);
    expect(ex.kick()).toBe(60);
  });
});
