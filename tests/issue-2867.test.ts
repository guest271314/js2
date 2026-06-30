// #2867 Gap 1 — recursive thenable assimilation in the native `$Promise` carrier.
//
// When a `.then`/`.catch` handler RETURNS a promise (or a passthrough value that
// is itself a promise), the chained promise must ADOPT that inner promise's
// eventual state instead of fulfilling with the promise object. Before this fix
// the chained promise fulfilled with the promise OBJECT, so the next handler saw
// a promise where the spec requires the settled value (the dominant regressor in
// the standalone async-function corpus — see the #2895 −16/−29 breakdown).
//
// The carrier is active under `--target wasi` today (it widens to `standalone`
// in lockstep at #2895 slice 1d); these tests pin the behaviour on the lane where
// the native carrier is live. They are host-free: instantiate with no imports and
// drive settlement with the module's own `__drain_microtasks` export.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runWasi(body: string): Promise<number> {
  const src = `
let result = 0;
export function run(): void { ${body} }
export function getResult(): number { return result; }
`;
  const r = await compile(src, { fileName: "t.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as Record<string, CallableFunction>;
  ex.run!();
  // settlement happens on microtasks; drive them to completion host-free.
  ex.__drain_microtasks?.();
  return ex.getResult!() as number;
}

describe("#2867 Gap 1 — native Promise thenable assimilation (wasi carrier)", () => {
  it("a .then handler that returns a Promise is adopted (inferred return type)", async () => {
    // retFn returns Promise.resolve(11); the chain must settle with 11, not the promise.
    expect(
      await runWasi(
        `Promise.resolve(1).then((v: number) => Promise.resolve(v + 10)).then((v: number) => { result = v; });`,
      ),
    ).toBe(11);
  });

  it("a .then handler returning a Promise is adopted (explicit Promise<number> annotation)", async () => {
    expect(
      await runWasi(
        `Promise.resolve(1).then((v: number): Promise<number> => Promise.resolve(v + 10)).then((v: number) => { result = v; });`,
      ),
    ).toBe(11);
  });

  it("assimilation recurses through a pending inner promise", async () => {
    // The inner promise is itself produced by a prior .then, so it is pending when
    // adopted — the reaction must be registered and fire on drain.
    expect(
      await runWasi(
        `Promise.resolve(1)
           .then((v: number) => Promise.resolve(v).then((w: number) => w + 10))
           .then((v: number) => { result = v; });`,
      ),
    ).toBe(11);
  });

  it("does not perturb a plain (non-promise-returning) chain", async () => {
    expect(await runWasi(`Promise.resolve(1).then((v: number) => v + 10).then((v: number) => { result = v; });`)).toBe(
      11,
    );
    expect(await runWasi(`Promise.resolve(7).then((v: number) => { result = v; });`)).toBe(7);
  });
});
