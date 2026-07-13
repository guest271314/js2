// #3228 — native async-iterator drive for `for await` with a DESTRUCTURING
// binding (#3178 slice S4). Before this, `for await (const {a} of …)` /
// `for await (const [a,b] of …)` was rejected by `analyzeForAwait` (identifier
// heads only), so the whole async function fell to the legacy host-CPS lowering
// that pulls in `__make_callback` + `Promise_*` + `__get_caught_exception`
// host imports — a leaky pass standalone. The fix delivers the settled element
// into a synthetic carrier (unchanged resume machinery) and runs the SYNC
// for-of IteratorBindingInitialization helper (`compileForOfDestructuring`)
// against it via a post-deliver hook. Host-free: the module requests NO imports.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Compile a host-free async program and instantiate it (imports must be empty). */
async function instantiateWasi(src: string): Promise<Record<string, () => number>> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  // The de-leak proof: the driven module must request no host imports.
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, () => number>;
}

describe("#3228 — for-await-of with a destructuring head, host-free native drive", () => {
  it("THE de-leak proof: object-pattern head over an object array sums host-free", async () => {
    const ex = await instantiateWasi(`
      let cap: number = 0;
      async function loop(): Promise<void> {
        let sum: number = 0;
        for await (const { a } of [{ a: 1 }, { a: 2 }, { a: 3 }]) { sum = sum + a; }
        cap = sum;
      }
      export function kick(): number { loop() as any; return cap; }
      export function getCap(): number { return cap; }
    `);
    expect(ex.kick()).toBe(6); // 1 + 2 + 3
  });

  it("array-pattern head over a tuple array binds each element", async () => {
    const ex = await instantiateWasi(`
      let cap: number = 0;
      async function loop(): Promise<void> {
        let sum: number = 0;
        for await (const [a, b] of [[1, 2], [3, 4]]) { sum = sum + a * 10 + b; }
        cap = sum;
      }
      export function kick(): number { loop() as any; return cap; }
      export function getCap(): number { return cap; }
    `);
    expect(ex.kick()).toBe(46); // (1*10+2) + (3*10+4) = 12 + 34
  });

  it("object-pattern head over an array of settled Promises awaits then destructures", async () => {
    const ex = await instantiateWasi(`
      let cap: number = 0;
      async function loop(): Promise<void> {
        let sum: number = 0;
        for await (const { a } of [Promise.resolve({ a: 5 }), Promise.resolve({ a: 7 })]) { sum = sum + a; }
        cap = sum;
      }
      export function kick(): number { loop() as any; return cap; }
      export function getCap(): number { return cap; }
    `);
    expect(ex.kick()).toBe(12); // 5 + 7
  });

  it("the accumulator survives per-element suspension across the back-edge", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function loop(): Promise<void> {
        let sum: number = 0;
        for await (const { a } of [
          Promise.resolve(1).then((v: number) => ({ a: v + 10 })),
          Promise.resolve(2).then((v: number) => ({ a: v + 10 })),
        ]) { sum = sum + a; }
        cap = sum;
      }
      export function kick(): number { loop() as any; return cap; }
      export function getCap(): number { return cap; }
    `)) as Record<string, () => number> & { __drain_microtasks: () => void };
    expect(ex.kick()).toBe(0); // suspended on the first pending element
    ex.__drain_microtasks();
    expect(ex.getCap()).toBe(23); // 11 + 12 — sum survived every suspension (frame spill)
  });
});
