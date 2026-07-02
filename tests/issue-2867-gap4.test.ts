// #2867 Gap 4 — native, host-free `Promise.all` / `Promise.race` combinators on
// the native-`$Promise` carrier (`isStandalonePromiseActive`, wasi-only today →
// widens to standalone at #2895 slice 1d). Currently `Promise.all`/`race` leak
// the unsatisfiable `Promise_all`/`Promise_race` host imports even on the carrier
// target; these lower to the existing `$Promise` + reaction + microtask substrate
// instead — composing the same primitives the native `.then` machinery uses.
//
// Host-free: instantiate with no imports and drive settlement with the module's
// own `__drain_microtasks` export — the test262 `asyncTest(fn)` shape.
//
// Inert on gc/host + still-host-backed standalone lanes (the gate is wasi-only).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runWasi(body: string, reads: string[]): Promise<Record<string, number>> {
  const src = `
let ff = 0;
let rj = 0;
let val = 0;
${body}
export function getFf(): number { return ff; }
export function getRj(): number { return rj; }
export function getVal(): number { return val; }
`;
  const r = await compile(src, { fileName: "t.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
  // The carrier is host-free under wasi: the native combinators must request no imports.
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as Record<string, CallableFunction>;
  ex.run!();
  ex.__drain_microtasks?.();
  const out: Record<string, number> = {};
  for (const n of reads) out[n] = ex[n]!() as number;
  return out;
}

describe("#2867 Gap 4 — native Promise.all/race (wasi carrier)", () => {
  it("Promise.all over already-fulfilled promises fulfils with the values array", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        Promise.all([Promise.resolve(1), Promise.resolve(2)])
          .then((arr: any[]) => { val = arr[0] + arr[1]; }, (e: number) => { rj = -1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 3, getRj: 0 });
  });

  it("Promise.all rejects as soon as one input rejects", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        Promise.all([Promise.resolve(1), Promise.reject(9)])
          .then((arr: any[]) => { ff = 1; }, (e: number) => { rj = e; });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 9 });
  });

  it("Promise.all([]) fulfils immediately", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        Promise.all([]).then((arr: any[]) => { ff = 1; }, (e: number) => { rj = -1; });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 1, getRj: 0 });
  });

  it("Promise.all waits for genuinely-pending inputs before fulfilling", async () => {
    // Both inputs settle only on a later microtask (via .then), so the aggregate
    // must suspend and resume across the drain — the case the host import cannot
    // serve host-free.
    const r = await runWasi(
      `
      export function run(): void {
        Promise.all([
          Promise.resolve(1).then((v: number) => v + 10),
          Promise.resolve(2).then((v: number) => v + 20),
        ]).then((arr: any[]) => { val = arr[0] + arr[1]; }, (e: number) => { rj = -1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 33, getRj: 0 });
  });

  it("Promise.race fulfils with the first settled value", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        Promise.race([Promise.resolve(5), Promise.resolve(6)])
          .then((v: number) => { val = v; }, (e: number) => { rj = -1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 5, getRj: 0 });
  });

  it("Promise.race rejects when the first settled input rejects", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        Promise.race([Promise.reject(7), Promise.resolve(6)])
          .then((v: number) => { ff = 1; }, (e: number) => { rj = e; });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 7 });
  });
});

// #2919 arm 1 — native `Promise.all`/`race` over an ARRAY-TYPED (non-literal)
// argument. The receiver was previously routed to the host `Promise_all`/`race`
// import, which is suppressed host-free under wasi → left `ref.null.extern` on
// the stack → the subsequent `.then`'s `ref.cast $Promise` trapped ("illegal
// cast"). These loop over the argument vec at runtime feeding the shared
// `__combinator_subscribe`, keeping the chain host-free and valid.
describe("#2919 arm 1 — native Promise.all/race over array-typed args (wasi carrier)", () => {
  it("Promise.all(arrVar) fulfils with the values array", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const a = [Promise.resolve(1), Promise.resolve(2)];
        Promise.all(a).then((arr: any[]) => { val = arr[0] + arr[1]; }, (e: number) => { rj = -1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 3, getRj: 0 });
  });

  it("Promise.all(arrVar) preserves element order", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const a = [Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)];
        Promise.all(a).then((arr: any[]) => { val = arr[0]*100 + arr[1]*10 + arr[2]; }, (e: number) => { rj = -1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 123, getRj: 0 });
  });

  it("Promise.all(arrVar) rejects as soon as one input rejects", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const a = [Promise.resolve(1), Promise.reject(7)];
        Promise.all(a).then((arr: any[]) => { ff = 1; }, (e: number) => { rj = e; });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 7 });
  });

  it("Promise.all(emptyArrVar) fulfils immediately", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const a: Promise<number>[] = [];
        Promise.all(a).then((arr: any[]) => { ff = 42; }, (e: number) => { rj = -1; });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 42, getRj: 0 });
  });

  it("Promise.all([...spread]) lowers natively", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const a = [Promise.resolve(4), Promise.resolve(5)];
        Promise.all([...a]).then((arr: any[]) => { val = arr[0] + arr[1]; }, (e: number) => { rj = -1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 9, getRj: 0 });
  });

  it("Promise.race(arrVar) fulfils with the first settled value", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const a = [Promise.resolve(5), Promise.resolve(9)];
        Promise.race(a).then((v: number) => { val = v; }, (e: number) => { rj = -1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 5, getRj: 0 });
  });
});
