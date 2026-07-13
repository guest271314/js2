// #3220 — native `$Promise` struct-identity preservation through a
// `$Promise`-returning call consumed as a thenable.
//
// Root cause: `wrapAsyncReturn` (expressions.ts) wrapped an "async call" result
// in `Promise.resolve(...)`. `isAsyncCallExpression` classifies ANY call whose
// signature returns `Promise<T>` as async (#1151), including a PLAIN
// `function mk(): Promise<number>` that already returns a native `$Promise` on
// the standalone/wasi carrier lane. The standalone arm's UNCONDITIONAL
// fulfilled-mint then built a SECOND `$Promise{FULFILLED, <innerPromise>, null}`
// — a Promise-of-Promise. A later `ref.test $Promise` (the async-gen yield /
// await suspend arm) adopted the OUTER wrapper and delivered the inner promise
// OBJECT raw, which reads as NaN. `calleeIsDriveLowered` only un-wrapped
// drive-lowered async *declarations*, not a plain `$Promise`-returning fn.
//
// Fix: make the wrap idempotent (§25.6.4.5.1 / §27.2.4.7 PromiseResolve) — a
// value already a native `$Promise` passes through unchanged; a raw value takes
// the unchanged fulfilled-mint. So `yield mk()` and `const pv = mk(); yield pv`
// deliver the resolved value, matching the `yield await mk()` control.
//
// Native (wasi) drive lane; gc/host stays inert (`isStandalonePromiseActive`
// is false there), and unrelated non-async modules are byte-identical.
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

describe("#3220 — native $Promise identity through a Promise-returning call consumed as a thenable", () => {
  it("THE fix: `yield mk()` (call-return operand) awaits the returned $Promise → resolved value, not NaN", async () => {
    const ex = await instantiateAsyncGen(`
      function mk(): Promise<number> { return Promise.resolve(5); }
      export async function* g(): AsyncGenerator<number> {
        yield mk();
      }
    `);
    const frame = ex.g();
    const s = step(ex, frame);
    // Was NaN before the fix (the double-wrapped $Promise delivered the inner
    // promise object raw).
    expect([s.done, s.value]).toEqual([0, 5]);
    expect(step(ex, frame).done).toBe(1);
  });

  it("THE fix: `const pv = mk(); yield pv` (Promise-typed local) → resolved value, not NaN", async () => {
    const ex = await instantiateAsyncGen(`
      function mk(): Promise<number> { return Promise.resolve(5); }
      export async function* g(): AsyncGenerator<number> {
        const pv: Promise<number> = mk();
        yield pv;
      }
    `);
    const frame = ex.g();
    const s = step(ex, frame);
    expect([s.done, s.value]).toEqual([0, 5]);
    expect(step(ex, frame).done).toBe(1);
  });

  it("control parity: `yield await mk()` still delivers the resolved value", async () => {
    const ex = await instantiateAsyncGen(`
      function mk(): Promise<number> { return Promise.resolve(5); }
      export async function* g(): AsyncGenerator<number> {
        yield await mk();
      }
    `);
    const frame = ex.g();
    expect(step(ex, frame).value).toBe(5);
    expect(step(ex, frame).done).toBe(1);
  });

  it("genuine suspension: a Promise-returning call whose promise settles on a later microtask", async () => {
    const ex = await instantiateAsyncGen(`
      function mk(): Promise<number> { return Promise.resolve(2).then((v: number) => v + 40); }
      export async function* g(): AsyncGenerator<number> {
        yield mk();
      }
    `);
    const frame = ex.g();
    const s = step(ex, frame);
    expect(s.pendingBeforeDrain).toBe(true); // not resolved until the drain
    expect([s.done, s.value]).toEqual([0, 42]);
    expect(step(ex, frame).done).toBe(1);
  });

  it("mixed: a Promise-returning-call yield followed by a plain yield delivers both in order", async () => {
    const ex = await instantiateAsyncGen(`
      function mk(): Promise<number> { return Promise.resolve(7); }
      export async function* g(): AsyncGenerator<number> {
        yield mk();
        yield 8;
      }
    `);
    const frame = ex.g();
    expect(step(ex, frame).value).toBe(7);
    expect(step(ex, frame).value).toBe(8);
    expect(step(ex, frame).done).toBe(1);
  });

  it("control: direct `yield Promise.resolve(5)` unchanged (no call-return coercion)", async () => {
    const ex = await instantiateAsyncGen(`
      export async function* g(): AsyncGenerator<number> {
        yield Promise.resolve(5);
      }
    `);
    const frame = ex.g();
    expect(step(ex, frame).value).toBe(5);
    expect(step(ex, frame).done).toBe(1);
  });
});
