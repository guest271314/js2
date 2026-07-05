// #2906 slice 3d-ii — `for await (const x of g())` over an async GENERATOR:
// the host-free async-iterator CONSUMER wired onto the 3d-i producer carrier.
//
// The 3d-i producer core (PR #2669) delivers a host-free async generator: `g()`
// returns a `$AsyncFrame` carrier and the per-gen `__async_gen_next_<g>(frame) ->
// Promise<IteratorResult>` driver settles each `next()`-promise via
// settleYield/settleDone. Slice 3d-ii is the CONSUMER: `for await (const x of
// g())` drives that producer on the SAME CFG resume machine (no new
// emitter/terminator) as
//
//   it = g();  loop { p = __async_gen_next_<g>(it); await p;
//              {done,value} = IteratorResult(p); if done break; x = value; body }
//
// Unlike the 3b sync-iterator carrier (synchronous `it.next()` → `(done,value)`,
// `await` on the ELEMENT), an async gen's `next()` returns a PROMISE — the
// consumer awaits the NEXT()-PROMISE first, then reads done/value from the
// resolved IteratorResult. A plain `yield E` fulfils that promise inside the
// `next()` call (fast-path advance); a genuinely-pending `yield await P` leaves
// it pending → the consumer suspends and `__drain_microtasks` resumes it (a
// two-level producer↔consumer microtask chain). Native (wasi) drive lane only —
// host-free (no imports); gc/host + standalone stay byte-identical (legacy path).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile a host-free async program and instantiate it (imports must be empty). */
async function instantiateWasi(
  src: string,
): Promise<Record<string, () => number> & { __drain_microtasks: () => void }> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  // The drive layer is host-free: the module must request no imports.
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, () => number> & { __drain_microtasks: () => void };
}

describe("#2906 slice 3d-ii — for-await over an async generator (consumer)", () => {
  it("THE proof: for await (const x of g()) over `yield 1; yield 2` sums to 3 host-free", async () => {
    const ex = await instantiateWasi(`
      async function* g(): AsyncGenerator<number> {
        yield 1;
        yield 2;
      }
      let cap: number = 0;
      async function consume(): Promise<void> {
        let sum: number = 0;
        for await (const x of g()) { sum = sum + x; }
        cap = sum;
      }
      export function kick(): number { consume() as any; return cap; }
      export function getCap(): number { return cap; }
    `);
    // Plain (await-free) yields settle synchronously inside each next() call, so
    // the whole loop runs on the fast-path advance within the first kick.
    expect(ex.kick()).toBe(3); // 1 + 2
  });

  it("GENUINE suspension: a genuinely-pending awaited yield suspends the consumer; drain resumes it", async () => {
    const ex = await instantiateWasi(`
      async function* g(): AsyncGenerator<number> {
        yield await Promise.resolve(1).then((v: number) => v + 10);
        yield await Promise.resolve(2).then((v: number) => v + 10);
      }
      let cap: number = 0;
      async function consume(): Promise<void> {
        let sum: number = 0;
        for await (const x of g()) { sum = sum + x; }
        cap = sum;
      }
      export function kick(): number { consume() as any; return cap; }
      export function getCap(): number { return cap; }
    `);
    expect(ex.kick()).toBe(0); // suspended on the first pending next()-promise
    ex.__drain_microtasks(); // resumes each iteration across the producer↔consumer chain
    expect(ex.getCap()).toBe(23); // 11 + 12 — the accumulator survived every suspension (frame spill)
  });

  it("mixed: a plain yield after an awaited yield drives to completion host-free", async () => {
    const ex = await instantiateWasi(`
      async function* g(): AsyncGenerator<number> {
        yield await Promise.resolve(5);
        yield 7;
        yield await Promise.resolve(9);
      }
      let cap: number = 0;
      async function consume(): Promise<void> {
        let sum: number = 0;
        for await (const x of g()) { sum = sum + x; }
        cap = sum;
      }
      export function kick(): number { consume() as any; return cap; }
      export function getCap(): number { return cap; }
    `);
    // await Promise.resolve(k) is statically settled → each next() fulfils
    // synchronously → the loop completes on the fast path within kick.
    expect(ex.kick()).toBe(21); // 5 + 7 + 9
  });

  it("pre-loop and post-loop statements run in order around the driven loop", async () => {
    const ex = await instantiateWasi(`
      async function* g(): AsyncGenerator<number> {
        yield 1;
        yield 2;
      }
      let cap: number = 0;
      async function consume(): Promise<void> {
        let sum: number = 100;
        for await (const x of g()) { sum = sum + x; }
        sum = sum + 1000;
        cap = sum;
      }
      export function kick(): number { consume() as any; return cap; }
      export function getCap(): number { return cap; }
    `);
    expect(ex.kick()).toBe(1103); // 100 + 1 + 2 + 1000
  });

  it("counts the iterations (done terminates the loop, no over-run)", async () => {
    const ex = await instantiateWasi(`
      async function* g(): AsyncGenerator<number> {
        yield 10;
        yield 20;
        yield 30;
      }
      let cap: number = 0;
      async function consume(): Promise<void> {
        let n: number = 0;
        for await (const x of g()) { n = n + 1; }
        cap = n;
      }
      export function kick(): number { consume() as any; return cap; }
      export function getCap(): number { return cap; }
    `);
    expect(ex.kick()).toBe(3); // exactly three yields, then settleDone breaks
  });

  it("legacy parity: for await over a plain-number array is unaffected (stays on legacy path)", async () => {
    // A `number[]` source has no async-gen next helper → the 3d-ii gate is false
    // and the 3b boxed-array gate is also false (unboxed primitives), so this
    // stays byte-identical on the legacy sync path (Await(v) = v).
    const ex = await instantiateWasi(`
      let cap: number = 0;
      async function consume(): Promise<void> {
        let sum: number = 0;
        for await (const x of [1, 2, 3]) { sum = sum + x; }
        cap = sum;
      }
      export function kick(): number { consume() as any; return cap; }
      export function getCap(): number { return cap; }
    `);
    expect(ex.kick()).toBe(6);
  });
});
