// #2906 slice 3d-i — async-generator PRODUCER core (host-free drive).
//
// `async function* g(){ yield await P; yield E }` previously routed through the
// generator-buffer path and failed at the #680 native-generator gate in
// standalone/wasi — it never reached the async drive machine. Slice 3d-i
// intercepts a BOUNDED async-gen body BEFORE that gate and drives it host-free on
// the #2906 CFG resume machine with two new terminators:
//   - `settleYield` — `yield E`: fulfil the current `next()`-promise with
//     `{value: E, done: false}` and SUSPEND (no reaction; the next `next()` kick
//     resumes). `yield await P` splits into a `suspend` on P (genuine microtask
//     suspension) + a `settleYield` of the delivered value.
//   - `settleDone` — body end: fulfil `{value: undefined, done: true}`.
//
// The producer object is the `$AsyncFrame` itself (a bare externref carrier — NO
// prototype methods). The re-entrant driver is the per-gen
// `__async_gen_next_<name>(frame) -> Promise<IteratorResult>` helper. This proves
// the producer host-free via DIRECT drive (next-helper → __drain_microtasks →
// read IteratorResult), WITHOUT the for-await consumer (3d-ii). Native (wasi)
// drive lane only; gc/host + standalone stay byte-identical (legacy path).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface GenExports {
  g: () => unknown;
  __async_gen_next_g: (frame: unknown) => unknown;
  __async_gen_p_state: (p: unknown) => number;
  __async_gen_result_done: (p: unknown) => number;
  __async_gen_result_value: (p: unknown) => number;
  __drain_microtasks: () => void;
}

async function instantiateAsyncGen(src: string): Promise<GenExports> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  // Host-free: the module must request no imports.
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as unknown as GenExports;
}

/** Drive one `next()`, drain microtasks, read the settled IteratorResult. */
function step(ex: GenExports, frame: unknown): { pendingBeforeDrain: boolean; done: number; value: number } {
  const p = ex.__async_gen_next_g(frame);
  const pendingBeforeDrain = ex.__async_gen_p_state(p) === 0;
  ex.__drain_microtasks();
  expect(ex.__async_gen_p_state(p)).toBe(1); // FULFILLED
  return { pendingBeforeDrain, done: ex.__async_gen_result_done(p), value: ex.__async_gen_result_value(p) };
}

describe("#2906 slice 3d-i — async-generator producer core", () => {
  it("THE proof: async function* g(){ yield await P; yield 2 } drives host-free to 1, 2, done", async () => {
    const ex = await instantiateAsyncGen(`
      export async function* g(): AsyncGenerator<number> {
        yield await Promise.resolve(1);
        yield 2;
      }
    `);
    const frame = ex.g();
    const s1 = step(ex, frame);
    expect([s1.done, s1.value]).toEqual([0, 1]); // {value: 1, done: false}
    const s2 = step(ex, frame);
    expect([s2.done, s2.value]).toEqual([0, 2]); // {value: 2, done: false}
    const s3 = step(ex, frame);
    expect(s3.done).toBe(1); // {value: undefined, done: true}
  });

  it("GENUINE suspension: a genuinely-pending awaited yield suspends at kick=0 and resumes on drain", async () => {
    const ex = await instantiateAsyncGen(`
      export async function* g(): AsyncGenerator<number> {
        yield await Promise.resolve(1).then((v: number) => v + 10);
        yield await Promise.resolve(2).then((v: number) => v + 10);
      }
    `);
    const frame = ex.g();
    const s1 = step(ex, frame);
    expect(s1.pendingBeforeDrain).toBe(true); // suspended — value not present until the drain
    expect([s1.done, s1.value]).toEqual([0, 11]);
    const s2 = step(ex, frame);
    expect(s2.pendingBeforeDrain).toBe(true);
    expect([s2.done, s2.value]).toEqual([0, 12]);
    expect(step(ex, frame).done).toBe(1);
  });

  it("plain (await-free) yields settle synchronously in sequence", async () => {
    const ex = await instantiateAsyncGen(`
      export async function* g(): AsyncGenerator<number> {
        yield 41;
        yield 42;
        yield 43;
      }
    `);
    const frame = ex.g();
    expect(step(ex, frame).value).toBe(41);
    expect(step(ex, frame).value).toBe(42);
    expect(step(ex, frame).value).toBe(43);
    expect(step(ex, frame).done).toBe(1);
  });

  it("LAZY: calling g() runs NO body code; the first next() produces the first yield", async () => {
    const ex = await instantiateAsyncGen(`
      export async function* g(): AsyncGenerator<number> {
        yield 7;
        yield 8;
      }
    `);
    const frame = ex.g();
    // No next() yet → draining must not produce anything (body never ran).
    ex.__drain_microtasks();
    expect(step(ex, frame).value).toBe(7);
  });

  it("INJECT-THROW proof: a rejected awaited yield REJECTS the next() promise (suspend/reject arm exercised)", async () => {
    const ex = await instantiateAsyncGen(`
      export async function* g(): AsyncGenerator<number> {
        yield await Promise.reject(99);
        yield 2;
      }
    `);
    const frame = ex.g();
    const p1 = ex.__async_gen_next_g(frame);
    ex.__drain_microtasks();
    expect(ex.__async_gen_p_state(p1)).toBe(2); // REJECTED — not vacuously fulfilled
  });

  it("params are captured in frame fields (no spill) and readable across yields", async () => {
    const ex = await instantiateAsyncGen(`
      export async function* g(base: number): AsyncGenerator<number> {
        yield base;
        yield base;
      }
    `);
    const frame = (ex.g as unknown as (b: number) => unknown)(100);
    expect(step(ex, frame).value).toBe(100);
    expect(step(ex, frame).value).toBe(100);
    expect(step(ex, frame).done).toBe(1);
  });

  it("gc lane unchanged; standalone drives host-free under the carrier (#3132 PR-2)", async () => {
    const src = `export async function* g(): AsyncGenerator<number> { yield await Promise.resolve(1); yield 2; }`;
    // gc: compiles via the legacy __create_async_generator path (host imports) — UNCHANGED.
    const gc = await compile(src, { fileName: "test.ts" });
    expect(gc.success).toBe(true);
    expect((gc.imports ?? []).length).toBeGreaterThan(0); // legacy host-backed
    // standalone (non-wasi): this module's ONLY async gen is drive-lowerable
    // under the native `$Promise` carrier (a bounded body, awaited yields
    // included), so #3132 PR-2 keeps the carrier ON (widenAsyncGenFallback →
    // moduleHasNonDrivableAsyncGen is false: no legacy `__gen_*` buffer to mix
    // into). The awaited yield now drives host-free instead of hitting the #680
    // gate — the intended flip. (Pre-PR-2 this asserted `success === false`.)
    const standalone = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(standalone.success).toBe(true);
    // Fully host-free: no legacy gen imports AND no host Promise imports.
    const imps = (standalone.imports ?? []).map((i) => String((i as { name?: string }).name ?? ""));
    expect(imps.filter((n) => /__gen_|__create_async_generator|Promise_|__get_caught_exception/.test(n))).toEqual([]);
  });
});
