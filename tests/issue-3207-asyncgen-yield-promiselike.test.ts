// #3207 — async-generator implicit yield-await (§27.6.3.8) for PromiseLike operands.
//
// §27.6.3.8 `AsyncGeneratorYield(value)` runs `value = ? Await(value)` — it awaits
// ANY thenable before yielding it, not only the `Promise` builtin. #3120 landed the
// static classifier for `Promise`-typed (and union-with-Promise) operands, so a plain
// `yield <Promise>` routes through the same suspend+settleYield(fromSent) lane as
// `yield await <Promise>`. This slice extends that classifier to `PromiseLike<T>`-typed
// operands (structural thenables), which §27.6.3.8 must also await.
//
// Root cause before this fix: `yieldOperandIsPromiseTyped` only recognised the
// `Promise` builtin (via the receiver heuristic) + unions containing it. A
// `PromiseLike<T>`-typed operand classified as PLAIN → the un-awaited thenable was
// yielded verbatim → the consumer saw the promise OBJECT (NaN when read as a number).
//
// The fix is correct-or-inert: when the PromiseLike operand is backed by a native
// `$Promise` at runtime the suspend arm adopts it (delivers the resolved value); a
// non-native thenable fails the suspend's `ref.test $Promise` and falls through to the
// plain delivery — the exact pre-fix raw-yield behaviour — so no shape regresses.
//
// Native (wasi) drive lane only; gc/host + standalone stay byte-identical (the classifier
// is gated on the native-`$Promise` carrier, which is wasi-only for async-gen modules).
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

describe("#3207 — async-gen implicit yield-await for PromiseLike operands (§27.6.3.8)", () => {
  it("THE proof: a PromiseLike-typed plain yield is AWAITED (delivers the resolved value, not the thenable)", async () => {
    const ex = await instantiateAsyncGen(`
      export async function* g(): AsyncGenerator<number> {
        const t: PromiseLike<number> = Promise.resolve(5);
        yield t;
      }
    `);
    const frame = ex.g();
    const s1 = step(ex, frame);
    // Was NaN before the fix (the un-awaited thenable object was yielded).
    expect([s1.done, s1.value]).toEqual([0, 5]);
    expect(step(ex, frame).done).toBe(1);
  });

  it("GENUINE suspension: a genuinely-pending PromiseLike yield suspends at kick=0 and resumes on drain", async () => {
    const ex = await instantiateAsyncGen(`
      export async function* g(): AsyncGenerator<number> {
        const t: PromiseLike<number> = Promise.resolve(2).then((v: number) => v + 40);
        yield t;
      }
    `);
    const frame = ex.g();
    const s1 = step(ex, frame);
    expect(s1.pendingBeforeDrain).toBe(true); // the value is not present until the drain
    expect([s1.done, s1.value]).toEqual([0, 42]);
    expect(step(ex, frame).done).toBe(1);
  });

  it("mixed: a PromiseLike yield followed by a plain yield delivers both in order", async () => {
    const ex = await instantiateAsyncGen(`
      export async function* g(): AsyncGenerator<number> {
        const t: PromiseLike<number> = Promise.resolve(7);
        yield t;
        yield 8;
      }
    `);
    const frame = ex.g();
    expect(step(ex, frame).value).toBe(7);
    expect(step(ex, frame).value).toBe(8);
    expect(step(ex, frame).done).toBe(1);
  });

  it("parity: a plain (non-thenable) yield stays plain — the classifier does not touch it", async () => {
    const ex = await instantiateAsyncGen(`
      export async function* g(): AsyncGenerator<number> {
        yield 3;
        yield 4;
      }
    `);
    const frame = ex.g();
    expect(step(ex, frame).value).toBe(3);
    expect(step(ex, frame).value).toBe(4);
    expect(step(ex, frame).done).toBe(1);
  });
});
